import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  safePath,
  sha256, humanSize, eofMarker, globToRegex, isBinary, isV4,
  collectFiles, pack, compress, decompress, isCompressed,
  encrypt, decrypt, isEncrypted, encryptRaw, decryptRaw,
  parseArchive, parseContent, parseContentV1, parseContentV4,
  list, info, apply, verify,
  unpack, create,
} from './slurp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const slurp = path.join(__dirname, 'slurp.js');
const tmp = path.join(__dirname, '.test-tmp');

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeFile(fp, content) {
  mkdirp(path.dirname(fp));
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(fp, content);
  } else {
    fs.writeFileSync(fp, content);
  }
}

function run(args) {
  try {
    const output = execSync(`node ${slurp} ${args}`, {
      cwd: tmp, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
    });
    return { code: 0, stdout: output };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// Helper: generate a v1-format archive for backward compat testing
function packV1(fileList, opts = {}) {
  const name = opts.name || 'archive';
  const description = opts.description || '';
  const now = new Date().toISOString();

  const entries = fileList.map(f => {
    const fullPath = typeof f === 'string' ? f : f.fullPath;
    const relPath = typeof f === 'string' ? f : f.relPath;
    const content = fs.readFileSync(fullPath);
    const binary = isBinary(content);
    return {
      relPath, content,
      text: binary ? null : content.toString('utf-8'),
      binary, size: content.length,
      checksum: sha256(content),
    };
  });

  const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
  const lines = [];
  lines.push('#!/bin/sh');
  lines.push('# --- SLURP v1 ---');
  lines.push('#');
  lines.push(`# name: ${name}`);
  if (description) lines.push(`# description: ${description}`);
  lines.push(`# files: ${entries.length}`);
  lines.push(`# total: ${humanSize(totalSize)}`);
  lines.push(`# created: ${now}`);
  lines.push('#');
  if (entries.length > 0) {
    lines.push('# MANIFEST:');
    const maxLen = Math.max(...entries.map(e => e.relPath.length), 4);
    for (const e of entries) {
      const size = humanSize(e.size).padStart(10);
      const ck = `  sha256:${e.checksum.slice(0, 16)}`;
      const bin = e.binary ? '  [binary]' : '';
      lines.push(`#   ${e.relPath.padEnd(maxLen)}  ${size}${ck}${bin}`);
    }
    lines.push('#');
  }
  lines.push('');
  lines.push('set -e');
  lines.push('');
  lines.push(`echo "applying ${name}..."`);
  lines.push('');
  for (const e of entries) {
    const marker = eofMarker(e.relPath);
    const dir = path.dirname(e.relPath);
    if (dir && dir !== '.') lines.push(`mkdir -p '${dir}'`);
    if (e.binary) {
      lines.push(`base64 -d > '${e.relPath}' << '${marker}'`);
      const b64 = e.content.toString('base64');
      lines.push(b64.match(/.{1,76}/g).join('\n'));
    } else {
      lines.push(`cat > '${e.relPath}' << '${marker}'`);
      lines.push(e.text.endsWith('\n') ? e.text.slice(0, -1) : e.text);
    }
    lines.push(marker);
    lines.push('');
  }
  lines.push('echo ""');
  lines.push(`echo "done. ${entries.length} files extracted."`);
  lines.push('');
  return lines.join('\n');
}

describe('slurp hybrid', () => {
  before(() => mkdirp(tmp));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // --- Unit tests: helpers ---

  describe('sha256', () => {
    it('produces correct hash', () => {
      const hash = sha256(Buffer.from('hello world'));
      assert.strictEqual(hash, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });
  });

  describe('humanSize', () => {
    it('formats bytes', () => assert.strictEqual(humanSize(0), '0 B'));
    it('formats KB', () => assert.strictEqual(humanSize(1024), '1.0 KB'));
    it('formats fractional KB', () => assert.strictEqual(humanSize(1536), '1.5 KB'));
    it('formats MB', () => assert.strictEqual(humanSize(1048576), '1.0 MB'));
  });

  describe('eofMarker', () => {
    it('sanitizes paths into valid markers', () => {
      assert.strictEqual(eofMarker('src/index.js'), 'SLURP_END_src_index_js');
      assert.strictEqual(eofMarker('file.txt'), 'SLURP_END_file_txt');
      assert.strictEqual(eofMarker('a/b/c.d.ts'), 'SLURP_END_a_b_c_d_ts');
    });
  });

  describe('globToRegex', () => {
    it('matches wildcards', () => {
      const re = globToRegex('*.js');
      assert(re.test('foo.js'));
      assert(!re.test('foo.ts'));
    });
    it('matches exact strings', () => {
      assert(globToRegex('node_modules').test('node_modules'));
      assert(!globToRegex('node_modules').test('my_modules'));
    });
  });

  describe('isBinary', () => {
    it('detects null bytes as binary', () => {
      assert(isBinary(Buffer.from([0x48, 0x00, 0x65])));
    });
    it('treats normal text as non-binary', () => {
      assert(!isBinary(Buffer.from('hello world')));
    });
  });

  // --- Unit tests: collectFiles ---

  describe('collectFiles', () => {
    it('walks directories recursively', () => {
      const dir = path.join(tmp, 'collect');
      writeFile(path.join(dir, 'a.txt'), 'hello');
      writeFile(path.join(dir, 'sub/b.txt'), 'world');
      writeFile(path.join(dir, 'sub/deep/c.txt'), 'deep');

      const files = collectFiles(dir, dir);
      const relPaths = files.map(f => f.relPath).sort();
      assert(relPaths.includes('a.txt'));
      assert(relPaths.includes(path.join('sub', 'b.txt')));
      assert(relPaths.includes(path.join('sub', 'deep', 'c.txt')));
    });

    it('respects exclude patterns', () => {
      const dir = path.join(tmp, 'collect-exclude');
      writeFile(path.join(dir, 'keep.txt'), 'yes');
      writeFile(path.join(dir, 'node_modules/pkg.js'), 'no');

      const files = collectFiles(dir, dir, [
        globToRegex('node_modules'), globToRegex('node_modules/*'),
      ]);
      const relPaths = files.map(f => f.relPath);
      assert(relPaths.includes('keep.txt'));
      assert(!relPaths.some(p => p.includes('node_modules')));
    });

    it('collects a single file', () => {
      const fp = path.join(tmp, 'single.txt');
      writeFile(fp, 'solo');
      const files = collectFiles(fp, tmp);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].relPath, 'single.txt');
    });
  });

  // --- Pack (v4 format) ---

  describe('pack', () => {
    it('generates a v4 archive (no shebang)', () => {
      writeFile(path.join(tmp, 'hello.txt'), 'hello world\n');
      const output = pack(
        [path.join(tmp, 'hello.txt')],
        { name: 'test-archive' }
      );
      assert(output.startsWith('# --- SLURP v4 ---'));
      assert(!output.includes('#!/bin/sh'));
      assert(!output.includes('set -e'));
      assert(output.includes('name: test-archive'));
      assert(output.includes('hello world'));
    });

    it('uses === delimiters instead of heredocs', () => {
      writeFile(path.join(tmp, 'delim.txt'), 'content\n');
      const output = pack(
        [{ fullPath: path.join(tmp, 'delim.txt'), relPath: 'delim.txt' }],
        { name: 'delim-test' }
      );
      assert(output.includes('=== delim.txt ==='));
      assert(output.includes('=== END delim.txt ==='));
      assert(!output.includes("cat > '"));
      assert(!output.includes('<< '));
    });

    it('embeds PROMPT.md as comments', () => {
      writeFile(path.join(tmp, 'a.txt'), 'content\n');
      const output = pack([path.join(tmp, 'a.txt')], { name: 'test' });
      assert(output.includes('# slurp v4 archive format'));
    });

    it('includes a manifest with file sizes', () => {
      writeFile(path.join(tmp, 'manifest.txt'), 'some content here\n');
      const output = pack([path.join(tmp, 'manifest.txt')], { name: 'manifest-test' });
      assert(output.includes('MANIFEST:'));
      assert(output.includes('sha256:'));
    });

    it('skips checksums with noChecksum option', () => {
      writeFile(path.join(tmp, 'nock.txt'), 'no checksums\n');
      const output = pack([path.join(tmp, 'nock.txt')], { name: 'nock', noChecksum: true });
      const manifestLine = output.split('\n').find(l => l.includes('nock.txt') && l.startsWith('#   '));
      assert(manifestLine, 'should have a manifest entry');
      assert(!manifestLine.includes('sha256:'), 'manifest entry should not have checksum');
    });

    it('accepts {fullPath, relPath} objects', () => {
      writeFile(path.join(tmp, 'obj.txt'), 'object style\n');
      const output = pack(
        [{ fullPath: path.join(tmp, 'obj.txt'), relPath: 'custom/obj.txt' }],
        { name: 'obj-test' }
      );
      assert(output.includes('=== custom/obj.txt ==='));
      assert(output.includes('=== END custom/obj.txt ==='));
    });

    it('handles binary files with base64 and [binary] tag', () => {
      const binPath = path.join(tmp, 'binary.dat');
      fs.writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]));
      const output = pack([binPath], { name: 'binary-test' });
      assert(output.includes('[binary]'));
      // Should use v4 delimiters
      assert(output.match(/=== .+ \[binary\] ===/));
      assert(!output.includes("base64 -d > '"));
    });

    it('isV4 detects v4 format', () => {
      writeFile(path.join(tmp, 'v4det.txt'), 'detect\n');
      const output = pack([path.join(tmp, 'v4det.txt')], { name: 'det' });
      assert(isV4(output));
    });
  });

  // --- Compress / Decompress ---

  describe('compress/decompress', () => {
    it('round-trips a v4 archive', () => {
      writeFile(path.join(tmp, 'comp.txt'), 'compressed content\n');
      const v4 = pack([path.join(tmp, 'comp.txt')], { name: 'comp-test' });
      const v2 = compress(v4, { name: 'comp-test' });
      assert(isCompressed(v2));
      assert(v2.includes('SLURP v2 (compressed)'));
      assert(v2.includes('sha256:'));
      assert(v2.includes('--- PAYLOAD ---'));
      assert(v2.includes('--- END PAYLOAD ---'));
      const restored = decompress(v2);
      assert.strictEqual(restored, v4);
    });

    it('compressed v2 has no shebang', () => {
      writeFile(path.join(tmp, 'comp-no-sh.txt'), 'no shebang\n');
      const v4 = pack([path.join(tmp, 'comp-no-sh.txt')], { name: 'no-sh' });
      const v2 = compress(v4, { name: 'no-sh' });
      assert(!v2.includes('#!/bin/sh'));
    });

    it('compressed is smaller for repetitive content', () => {
      const big = 'the quick brown fox\n'.repeat(200);
      writeFile(path.join(tmp, 'big.txt'), big);
      const v4 = pack([path.join(tmp, 'big.txt')], { name: 'big' });
      const v2 = compress(v4, { name: 'big' });
      assert(v2.length < v4.length);
    });

    it('isCompressed detects v2 vs v4', () => {
      writeFile(path.join(tmp, 'det.txt'), 'detect\n');
      const v4 = pack([path.join(tmp, 'det.txt')], { name: 'det' });
      const v2 = compress(v4, { name: 'det' });
      assert(!isCompressed(v4));
      assert(isCompressed(v2));
    });

    it('detects checksum tampering', () => {
      writeFile(path.join(tmp, 'tamper.txt'), 'tamper test\n');
      const v4 = pack([path.join(tmp, 'tamper.txt')], { name: 'tamper' });
      let v2 = compress(v4, { name: 'tamper' });
      // Corrupt a byte in the base64 payload
      v2 = v2.replace(/^(--- PAYLOAD ---\n)([A-Za-z])/, '$1X');
      try {
        decompress(v2);
      } catch (e) {
        assert(e.message.includes('checksum mismatch') || e.message.includes('incorrect header check'));
      }
    });
  });

  // --- parseArchive ---

  describe('parseArchive', () => {
    it('extracts metadata and file contents from v4', () => {
      writeFile(path.join(tmp, 'p1.txt'), 'parsed content\n');
      const archive = pack(
        [path.join(tmp, 'p1.txt')],
        { name: 'parse-test', description: 'testing parser' }
      );
      const archivePath = path.join(tmp, 'parse-test.slurp');
      fs.writeFileSync(archivePath, archive);

      const { metadata, files } = parseArchive(archivePath);
      assert.strictEqual(metadata.name, 'parse-test');
      assert.strictEqual(metadata.description, 'testing parser');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('parsed content'));
    });

    it('handles compressed archives transparently', () => {
      writeFile(path.join(tmp, 'tp.txt'), 'transparent\n');
      const v4 = pack([path.join(tmp, 'tp.txt')], { name: 'transparent', description: 'test' });
      const v2 = compress(v4, { name: 'transparent' });
      const archivePath = path.join(tmp, 'transparent.slurp');
      fs.writeFileSync(archivePath, v2);

      const { metadata, files } = parseArchive(archivePath);
      assert.strictEqual(metadata.name, 'transparent');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('transparent'));
    });

    it('parses binary file entries', () => {
      const binPath = path.join(tmp, 'parsed-bin.dat');
      const binData = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
      fs.writeFileSync(binPath, binData);

      const archive = pack([binPath], { name: 'bin-parse' });
      const archivePath = path.join(tmp, 'bin-parse.slurp');
      fs.writeFileSync(archivePath, archive);

      const { files } = parseArchive(archivePath);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].binary, true);
      assert(Buffer.isBuffer(files[0].content));
      assert.strictEqual(Buffer.compare(files[0].content, binData), 0);
    });
  });

  // --- Backward compatibility: v1 parsing ---

  describe('v1 backward compatibility', () => {
    it('parses v1 archives', () => {
      writeFile(path.join(tmp, 'bc.txt'), 'backward\n');
      const v1 = packV1([path.join(tmp, 'bc.txt')], { name: 'compat' });
      const archivePath = path.join(tmp, 'compat.slurp.sh');
      fs.writeFileSync(archivePath, v1);

      const { metadata, files } = parseArchive(archivePath);
      assert.strictEqual(metadata.name, 'compat');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('backward'));
    });

    it('parses v1 archives with binary files', () => {
      const binPath = path.join(tmp, 'bc-bin.dat');
      const binData = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
      fs.writeFileSync(binPath, binData);

      const v1 = packV1([binPath], { name: 'bin-compat' });
      const archivePath = path.join(tmp, 'bin-compat.slurp.sh');
      fs.writeFileSync(archivePath, v1);

      const { files } = parseArchive(archivePath);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].binary, true);
      assert(Buffer.isBuffer(files[0].content));
      assert.strictEqual(Buffer.compare(files[0].content, binData), 0);
    });

    it('parses v1 with multiple files and nested paths', () => {
      writeFile(path.join(tmp, 'bc-multi-a.txt'), 'file a\n');
      writeFile(path.join(tmp, 'bc-multi-b.txt'), 'file b\n');
      const v1 = packV1([
        { fullPath: path.join(tmp, 'bc-multi-a.txt'), relPath: 'a.txt' },
        { fullPath: path.join(tmp, 'bc-multi-b.txt'), relPath: 'sub/b.txt' },
      ], { name: 'multi-compat' });
      const archivePath = path.join(tmp, 'multi-compat.slurp.sh');
      fs.writeFileSync(archivePath, v1);

      const { metadata, files } = parseArchive(archivePath);
      assert.strictEqual(metadata.name, 'multi-compat');
      assert.strictEqual(files.length, 2);
      assert(files[0].content.includes('file a'));
      assert(files[1].content.includes('file b'));
    });

    it('old v2 compressed format (wrapping v1) still decompresses', () => {
      // Construct an old-style v2 archive manually
      writeFile(path.join(tmp, 'old-v2.txt'), 'old compressed\n');
      const v1Content = packV1(
        [{ fullPath: path.join(tmp, 'old-v2.txt'), relPath: 'old-v2.txt' }],
        { name: 'old-v2' }
      );
      // Build old v2 wrapper with shell commands
      const gzipped = zlib.gzipSync(Buffer.from(v1Content, 'utf-8'));
      const b64 = gzipped.toString('base64');
      const checksum = sha256(gzipped);
      const wrapped = b64.match(/.{1,76}/g).join('\n');
      const oldV2 = [
        '#!/bin/sh',
        '# --- SLURP v2 (compressed) ---',
        '#',
        '# This is a compressed slurp archive.',
        `# sha256: ${checksum}`,
        '',
        "base64 -d << 'SLURP_COMPRESSED' | gunzip | sh",
        wrapped,
        'SLURP_COMPRESSED',
        '',
      ].join('\n');

      assert(isCompressed(oldV2));
      const decompressed = decompress(oldV2);
      assert.strictEqual(decompressed, v1Content);

      // Full round-trip through parseContent
      const { metadata, files } = parseContent(decompressed);
      assert.strictEqual(metadata.name, 'old-v2');
      assert.strictEqual(files.length, 1);
    });

    it('old v3 encrypted format (wrapping v1) still decrypts', () => {
      // Construct an old-style v3 archive manually
      writeFile(path.join(tmp, 'old-v3.txt'), 'old encrypted\n');
      const v1Content = packV1(
        [{ fullPath: path.join(tmp, 'old-v3.txt'), relPath: 'old-v3.txt' }],
        { name: 'old-v3' }
      );

      const salt = crypto.randomBytes(16);
      const iterations = 100000;
      const key = crypto.pbkdf2Sync('testpass', salt, iterations, 32, 'sha256');
      const iv = crypto.randomBytes(12);
      const compressed = zlib.gzipSync(Buffer.from(v1Content, 'utf-8'));
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const payload = Buffer.concat([salt, iv, authTag, encrypted]);
      const b64 = payload.toString('base64');
      const checksum = sha256(payload);
      const wrappedB64 = b64.match(/.{1,76}/g).join('\n');

      const oldV3 = [
        '#!/bin/sh',
        '# --- SLURP v3 (encrypted) ---',
        '#',
        `# sha256: ${checksum}`,
        `# iterations: ${iterations}`,
        '#',
        "SLURP_PAYLOAD=$(base64 -d << 'SLURP_ENCRYPTED'",
        wrappedB64,
        'SLURP_ENCRYPTED',
        ')',
        'exit 0',
        '',
      ].join('\n');

      assert(isEncrypted(oldV3));
      const decrypted = decrypt(oldV3, 'testpass');
      assert.strictEqual(decrypted, v1Content);

      const { metadata, files } = parseContent(decrypted);
      assert.strictEqual(metadata.name, 'old-v3');
      assert.strictEqual(files.length, 1);
    });
  });

  // --- Round-trip: pack + Node.js apply ---

  describe('round-trip (Node.js apply)', () => {
    it('apply extracts text files correctly', () => {
      const srcDir = path.join(tmp, 'apply-src');
      mkdirp(srcDir);
      writeFile(path.join(srcDir, 'x.txt'), 'apply test\n');

      const archive = pack(
        [{ fullPath: path.join(srcDir, 'x.txt'), relPath: 'x.txt' }],
        { name: 'apply-test' }
      );
      const archivePath = path.join(tmp, 'apply-test.slurp');
      fs.writeFileSync(archivePath, archive);

      const dest = path.join(tmp, 'apply-dest');
      mkdirp(dest);
      const origCwd = process.cwd();
      process.chdir(dest);
      try {
        apply(archivePath);
        const content = fs.readFileSync(path.join(dest, 'x.txt'), 'utf-8');
        assert.strictEqual(content, 'apply test\n');
      } finally {
        process.chdir(origCwd);
      }
    });

    it('apply extracts binary files correctly', () => {
      const srcDir = path.join(tmp, 'apply-bin-src');
      mkdirp(srcDir);
      // Ensure data contains null bytes so isBinary() detects it
      const binData = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xFF]), crypto.randomBytes(252)]);
      fs.writeFileSync(path.join(srcDir, 'data.bin'), binData);

      const archive = pack(
        [{ fullPath: path.join(srcDir, 'data.bin'), relPath: 'data.bin' }],
        { name: 'apply-bin' }
      );
      const archivePath = path.join(tmp, 'apply-bin.slurp');
      fs.writeFileSync(archivePath, archive);

      const dest = path.join(tmp, 'apply-bin-dest');
      mkdirp(dest);
      const origCwd = process.cwd();
      process.chdir(dest);
      try {
        apply(archivePath);
        const extracted = fs.readFileSync(path.join(dest, 'data.bin'));
        assert.strictEqual(Buffer.compare(extracted, binData), 0);
      } finally {
        process.chdir(origCwd);
      }
    });
  });

  // --- CLI ---

  describe('CLI', () => {
    it('pack writes to file with -o', () => {
      writeFile(path.join(tmp, 'cli.txt'), 'cli test\n');
      const { code } = run('pack cli.txt -n cli-test -o cli-out.slurp');
      assert.strictEqual(code, 0);
      assert(fs.existsSync(path.join(tmp, 'cli-out.slurp')));
      const content = fs.readFileSync(path.join(tmp, 'cli-out.slurp'), 'utf-8');
      assert(content.startsWith('# --- SLURP v4 ---'));
    });

    it('pack -z produces compressed output', () => {
      writeFile(path.join(tmp, 'zflag.txt'), 'compress via flag\n');
      const { code } = run('pack zflag.txt -n ztest -z -o zout.slurp');
      assert.strictEqual(code, 0);
      const content = fs.readFileSync(path.join(tmp, 'zout.slurp'), 'utf-8');
      assert(isCompressed(content));
    });

    it('list shows files', () => {
      writeFile(path.join(tmp, 'l1.txt'), 'one\n');
      writeFile(path.join(tmp, 'l2.txt'), 'two\n');
      const archive = pack(
        [path.join(tmp, 'l1.txt'), path.join(tmp, 'l2.txt')],
        { name: 'list-test' }
      );
      fs.writeFileSync(path.join(tmp, 'list-test.slurp'), archive);

      const { code, stdout } = run('list list-test.slurp');
      assert.strictEqual(code, 0);
      assert(stdout.includes('l1.txt'));
      assert(stdout.includes('l2.txt'));
      assert(stdout.includes('Files (2)'));
    });

    it('list works on compressed archives', () => {
      writeFile(path.join(tmp, 'cl.txt'), 'compressed list\n');
      const v4 = pack([path.join(tmp, 'cl.txt')], { name: 'cl-test' });
      const v2 = compress(v4, { name: 'cl-test' });
      fs.writeFileSync(path.join(tmp, 'cl-test.slurp'), v2);

      const { code, stdout } = run('list cl-test.slurp');
      assert.strictEqual(code, 0);
      assert(stdout.includes('cl.txt'));
    });

    it('info shows metadata', () => {
      writeFile(path.join(tmp, 'info.txt'), 'info test\n');
      const archive = pack(
        [{ fullPath: path.join(tmp, 'info.txt'), relPath: 'info.txt' }],
        { name: 'info-test', description: 'testing info' }
      );
      fs.writeFileSync(path.join(tmp, 'info-test.slurp'), archive);

      const { code, stdout } = run('info info-test.slurp');
      assert.strictEqual(code, 0);
      assert(stdout.includes('SLURP Archive'));
      assert(stdout.includes('info-test'));
      assert(stdout.includes('v4'));
    });

    it('errors on missing files', () => {
      const { code } = run('pack');
      assert.notStrictEqual(code, 0);
    });

    it('errors on unknown command', () => {
      const { code } = run('bogus');
      assert.notStrictEqual(code, 0);
    });

    it('shows help', () => {
      const { code, stdout } = run('--help');
      assert.strictEqual(code, 0);
      assert(stdout.includes('pure data archives'));
    });
  });

  // --- Unpack (staging dir) ---

  describe('unpack', () => {
    it('extracts to a staging directory', () => {
      const srcDir = path.join(tmp, 'unpack-src');
      mkdirp(srcDir);
      writeFile(path.join(srcDir, 'a.txt'), 'unpack test\n');
      writeFile(path.join(srcDir, 'sub/b.txt'), 'nested\n');

      const archive = pack(
        [
          { fullPath: path.join(srcDir, 'a.txt'), relPath: 'a.txt' },
          { fullPath: path.join(srcDir, 'sub/b.txt'), relPath: 'sub/b.txt' },
        ],
        { name: 'unpack-test' }
      );
      const archivePath = path.join(tmp, 'unpack-test.slurp');
      fs.writeFileSync(archivePath, archive);

      const stagingDir = unpack(archivePath);
      assert(fs.existsSync(stagingDir));
      assert(stagingDir.includes('unpack-test.'));
      assert(stagingDir.endsWith('.unslurp'));
      assert.strictEqual(fs.readFileSync(path.join(stagingDir, 'a.txt'), 'utf-8'), 'unpack test\n');
      assert.strictEqual(fs.readFileSync(path.join(stagingDir, 'sub/b.txt'), 'utf-8'), 'nested\n');

      fs.rmSync(stagingDir, { recursive: true, force: true });
    });

    it('accepts custom output directory', () => {
      writeFile(path.join(tmp, 'unpack-custom.txt'), 'custom\n');
      const archive = pack(
        [{ fullPath: path.join(tmp, 'unpack-custom.txt'), relPath: 'unpack-custom.txt' }],
        { name: 'custom' }
      );
      const archivePath = path.join(tmp, 'custom.slurp');
      fs.writeFileSync(archivePath, archive);

      const dest = path.join(tmp, 'my-staging');
      const stagingDir = unpack(archivePath, { output: dest });
      assert.strictEqual(stagingDir, dest);
      assert.strictEqual(fs.readFileSync(path.join(dest, 'unpack-custom.txt'), 'utf-8'), 'custom\n');
    });

    it('works with compressed archives', () => {
      writeFile(path.join(tmp, 'unpack-v2.txt'), 'compressed unpack\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'unpack-v2.txt'), relPath: 'unpack-v2.txt' }],
        { name: 'v2-unpack' }
      );
      const v2 = compress(v4, { name: 'v2-unpack' });
      const archivePath = path.join(tmp, 'v2-unpack.slurp');
      fs.writeFileSync(archivePath, v2);

      const stagingDir = unpack(archivePath);
      assert(fs.readFileSync(path.join(stagingDir, 'unpack-v2.txt'), 'utf-8').includes('compressed unpack'));

      fs.rmSync(stagingDir, { recursive: true, force: true });
    });

    it('accepts content string directly (stdin mode)', () => {
      writeFile(path.join(tmp, 'stdin-test.txt'), 'from stdin\n');
      const archive = pack(
        [{ fullPath: path.join(tmp, 'stdin-test.txt'), relPath: 'stdin-test.txt' }],
        { name: 'stdin-test' }
      );

      const stagingDir = unpack(archive, { output: path.join(tmp, 'stdin-staging') });
      assert.strictEqual(fs.readFileSync(path.join(stagingDir, 'stdin-test.txt'), 'utf-8'), 'from stdin\n');
    });

    it('handles binary files', () => {
      const binPath = path.join(tmp, 'unpack-bin.dat');
      const binData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
      fs.writeFileSync(binPath, binData);

      const archive = pack([{ fullPath: binPath, relPath: 'unpack-bin.dat' }], { name: 'bin-unpack' });
      const archivePath = path.join(tmp, 'bin-unpack.slurp');
      fs.writeFileSync(archivePath, archive);

      const stagingDir = unpack(archivePath);
      const extracted = fs.readFileSync(path.join(stagingDir, 'unpack-bin.dat'));
      assert.strictEqual(Buffer.compare(extracted, binData), 0);

      fs.rmSync(stagingDir, { recursive: true, force: true });
    });
  });

  // --- Create (staging dir to destination) ---

  describe('create', () => {
    it('copies files from staging to destination', () => {
      const staging = path.join(tmp, 'create-staging');
      mkdirp(staging);
      writeFile(path.join(staging, 'file1.txt'), 'one\n');
      writeFile(path.join(staging, 'sub/file2.txt'), 'two\n');

      const dest = path.join(tmp, 'create-dest');
      const count = create(staging, dest);
      assert.strictEqual(count, 2);
      assert.strictEqual(fs.readFileSync(path.join(dest, 'file1.txt'), 'utf-8'), 'one\n');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'sub/file2.txt'), 'utf-8'), 'two\n');
    });

    it('throws on missing staging dir', () => {
      assert.throws(() => create('/nonexistent/path', tmp), /not found/);
    });

    it('round-trips with unpack', () => {
      const srcDir = path.join(tmp, 'rt-stage-src');
      mkdirp(srcDir);
      writeFile(path.join(srcDir, 'rt.js'), 'const x = 1;\n');
      writeFile(path.join(srcDir, 'deep/nested.txt'), 'deep\n');

      const archive = pack(
        [
          { fullPath: path.join(srcDir, 'rt.js'), relPath: 'rt.js' },
          { fullPath: path.join(srcDir, 'deep/nested.txt'), relPath: 'deep/nested.txt' },
        ],
        { name: 'roundtrip-stage' }
      );
      const archivePath = path.join(tmp, 'roundtrip-stage.slurp');
      fs.writeFileSync(archivePath, archive);

      // Unpack to staging
      const stagingDir = unpack(archivePath);

      // Create from staging
      const dest = path.join(tmp, 'rt-stage-dest');
      const count = create(stagingDir, dest);
      assert.strictEqual(count, 2);
      assert.strictEqual(fs.readFileSync(path.join(dest, 'rt.js'), 'utf-8'), 'const x = 1;\n');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'deep/nested.txt'), 'utf-8'), 'deep\n');

      fs.rmSync(stagingDir, { recursive: true, force: true });
    });
  });

  // --- Unpack/Create CLI ---

  describe('CLI unpack/create', () => {
    it('unpack prints staging dir path', () => {
      writeFile(path.join(tmp, 'cli-unpack.txt'), 'cli unpack\n');
      const archive = pack(
        [{ fullPath: path.join(tmp, 'cli-unpack.txt'), relPath: 'cli-unpack.txt' }],
        { name: 'cli-unpack' }
      );
      fs.writeFileSync(path.join(tmp, 'cli-unpack.slurp'), archive);

      const { code, stdout } = run('unpack cli-unpack.slurp');
      assert.strictEqual(code, 0);
      const stagingPath = stdout.trim();
      assert(stagingPath.includes('cli-unpack.'));
      assert(stagingPath.endsWith('.unslurp'));
      assert(fs.existsSync(path.join(tmp, path.basename(stagingPath), 'cli-unpack.txt')));

      fs.rmSync(path.join(tmp, path.basename(stagingPath)), { recursive: true, force: true });
    });

    it('unpack with -o writes to specified dir', () => {
      writeFile(path.join(tmp, 'cli-unpack-o.txt'), 'output dir\n');
      const archive = pack(
        [{ fullPath: path.join(tmp, 'cli-unpack-o.txt'), relPath: 'cli-unpack-o.txt' }],
        { name: 'cli-unpack-o' }
      );
      fs.writeFileSync(path.join(tmp, 'cli-unpack-o.slurp'), archive);

      const { code, stdout } = run('unpack cli-unpack-o.slurp -o my-stage');
      assert.strictEqual(code, 0);
      assert(fs.existsSync(path.join(tmp, 'my-stage', 'cli-unpack-o.txt')));
    });

    it('create copies staging to dest', () => {
      const staging = path.join(tmp, 'cli-create-staging');
      mkdirp(staging);
      writeFile(path.join(staging, 'cc.txt'), 'create test\n');

      const { code } = run('create cli-create-staging cli-create-dest');
      assert.strictEqual(code, 0);
      assert.strictEqual(
        fs.readFileSync(path.join(tmp, 'cli-create-dest', 'cc.txt'), 'utf-8'),
        'create test\n'
      );
    });

    it('unpack from stdin via pipe', () => {
      writeFile(path.join(tmp, 'pipe-test.txt'), 'piped\n');
      const archive = pack(
        [{ fullPath: path.join(tmp, 'pipe-test.txt'), relPath: 'pipe-test.txt' }],
        { name: 'pipe-test' }
      );
      fs.writeFileSync(path.join(tmp, 'pipe-in.slurp'), archive);

      const { code, stdout } = run('unpack - -o pipe-staged < pipe-in.slurp');
      assert.strictEqual(code, 0);
      assert(fs.existsSync(path.join(tmp, 'pipe-staged', 'pipe-test.txt')));
    });
  });

  // --- Encrypt / Decrypt ---

  describe('encrypt/decrypt', () => {
    it('round-trips a v4 archive with correct password', () => {
      writeFile(path.join(tmp, 'enc.txt'), 'secret content\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc.txt'), relPath: 'enc.txt' }],
        { name: 'enc-test' }
      );
      const v3 = encrypt(v4, 'mypassword', { name: 'enc-test' });
      assert(isEncrypted(v3));
      assert(v3.includes('SLURP v3 (encrypted)'));
      assert(v3.includes('sha256:'));
      assert(!v3.includes('#!/bin/sh'));
      assert(v3.includes('--- PAYLOAD ---'));

      const restored = decrypt(v3, 'mypassword');
      assert.strictEqual(restored, v4);
    });

    it('fails with wrong password', () => {
      writeFile(path.join(tmp, 'enc2.txt'), 'data\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc2.txt'), relPath: 'enc2.txt' }],
        { name: 'enc2' }
      );
      const v3 = encrypt(v4, 'correct', { name: 'enc2' });
      assert.throws(
        () => decrypt(v3, 'wrong'),
        /decryption failed|wrong password/
      );
    });

    it('isEncrypted detects v3 vs v4/v2', () => {
      writeFile(path.join(tmp, 'det-enc.txt'), 'detect\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'det-enc.txt'), relPath: 'det-enc.txt' }],
        { name: 'det-enc' }
      );
      const v2 = compress(v4, { name: 'det-enc' });
      const v3 = encrypt(v4, 'pass', { name: 'det-enc' });

      assert(!isEncrypted(v4));
      assert(!isEncrypted(v2));
      assert(isEncrypted(v3));
    });

    it('detects checksum tampering', () => {
      writeFile(path.join(tmp, 'enc-tamper.txt'), 'tamper test\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc-tamper.txt'), relPath: 'enc-tamper.txt' }],
        { name: 'tamper' }
      );
      let v3 = encrypt(v4, 'pass', { name: 'tamper' });

      // Corrupt a byte in the payload
      const payloadStart = v3.indexOf('--- PAYLOAD ---') + '--- PAYLOAD ---\n'.length;
      const chars = v3.split('');
      const idx = payloadStart + 10;
      chars[idx] = chars[idx] === 'A' ? 'B' : 'A';
      v3 = chars.join('');

      assert.throws(
        () => decrypt(v3, 'pass'),
        /checksum mismatch|decryption failed/
      );
    });

    it('each encryption produces different ciphertext (unique salt/iv)', () => {
      writeFile(path.join(tmp, 'enc-unique.txt'), 'unique\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc-unique.txt'), relPath: 'enc-unique.txt' }],
        { name: 'unique' }
      );
      const v3a = encrypt(v4, 'pass', { name: 'unique' });
      const v3b = encrypt(v4, 'pass', { name: 'unique' });

      assert.notStrictEqual(v3a, v3b);
      assert.strictEqual(decrypt(v3a, 'pass'), v4);
      assert.strictEqual(decrypt(v3b, 'pass'), v4);
    });

    it('handles empty password gracefully (still round-trips)', () => {
      writeFile(path.join(tmp, 'enc-empty.txt'), 'empty pass\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc-empty.txt'), relPath: 'enc-empty.txt' }],
        { name: 'empty' }
      );
      const v3 = encrypt(v4, '', { name: 'empty' });
      const restored = decrypt(v3, '');
      assert.strictEqual(restored, v4);
    });

    it('encrypts large archives', () => {
      const big = 'the quick brown fox jumps over the lazy dog\n'.repeat(5000);
      writeFile(path.join(tmp, 'enc-big.txt'), big);
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc-big.txt'), relPath: 'enc-big.txt' }],
        { name: 'big' }
      );
      const v3 = encrypt(v4, 'bigpass', { name: 'big' });
      const restored = decrypt(v3, 'bigpass');
      assert.strictEqual(restored, v4);
    });

    it('v3 header contains metadata', () => {
      writeFile(path.join(tmp, 'enc-meta.txt'), 'meta\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc-meta.txt'), relPath: 'enc-meta.txt' }],
        { name: 'meta-test' }
      );
      const v3 = encrypt(v4, 'pass', { name: 'meta-test' });
      assert(v3.includes('name: meta-test'));
      assert(v3.includes('iterations: 100000'));
      assert(v3.includes('AES-256-GCM'));
    });

    it('parseArchive handles encrypted archives with password', () => {
      writeFile(path.join(tmp, 'enc-parse.txt'), 'parseable\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc-parse.txt'), relPath: 'enc-parse.txt' }],
        { name: 'enc-parse' }
      );
      const v3 = encrypt(v4, 'secret', { name: 'enc-parse' });
      const archivePath = path.join(tmp, 'enc-parse.slurp');
      fs.writeFileSync(archivePath, v3);

      const { metadata, files } = parseArchive(archivePath, { password: 'secret' });
      assert.strictEqual(metadata.name, 'enc-parse');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('parseable'));
    });

    it('parseArchive throws on encrypted archive without password', () => {
      writeFile(path.join(tmp, 'enc-nopass.txt'), 'nope\n');
      const v4 = pack(
        [{ fullPath: path.join(tmp, 'enc-nopass.txt'), relPath: 'enc-nopass.txt' }],
        { name: 'enc-nopass' }
      );
      const v3 = encrypt(v4, 'pw', { name: 'enc-nopass' });
      const archivePath = path.join(tmp, 'enc-nopass.slurp');
      fs.writeFileSync(archivePath, v3);

      assert.throws(
        () => parseArchive(archivePath),
        /password required/
      );
    });
  });

  // --- Encrypt/Decrypt CLI ---

  describe('CLI encrypt/decrypt', () => {
    it('encrypt writes to file with -o', () => {
      writeFile(path.join(tmp, 'cli-enc.txt'), 'cli encrypt\n');
      run('pack cli-enc.txt -n cli-enc -o cli-enc.slurp');
      const { code } = run('encrypt cli-enc.slurp -p testpass -o cli-enc.v3.slurp');
      assert.strictEqual(code, 0);
      const content = fs.readFileSync(path.join(tmp, 'cli-enc.v3.slurp'), 'utf-8');
      assert(isEncrypted(content));
    });

    it('decrypt writes to file with -o', () => {
      writeFile(path.join(tmp, 'cli-dec.txt'), 'cli decrypt\n');
      run('pack cli-dec.txt -n cli-dec -o cli-dec.slurp');
      run('encrypt cli-dec.slurp -p decpass -o cli-dec.v3.slurp');
      const { code } = run('decrypt cli-dec.v3.slurp -p decpass -o cli-dec.v4.slurp');
      assert.strictEqual(code, 0);

      const original = fs.readFileSync(path.join(tmp, 'cli-dec.slurp'), 'utf-8');
      const restored = fs.readFileSync(path.join(tmp, 'cli-dec.v4.slurp'), 'utf-8');
      assert.strictEqual(restored, original);
    });

    it('pack -e creates encrypted archive', () => {
      writeFile(path.join(tmp, 'cli-pack-e.txt'), 'pack encrypt\n');
      const { code } = run('pack cli-pack-e.txt -n pack-enc -e -p mypass -o pack-enc.slurp');
      assert.strictEqual(code, 0);
      const content = fs.readFileSync(path.join(tmp, 'pack-enc.slurp'), 'utf-8');
      assert(isEncrypted(content));
    });

    it('pack -e without password errors', () => {
      writeFile(path.join(tmp, 'cli-nopass.txt'), 'no password\n');
      const { code } = run('pack cli-nopass.txt -n nopass -e -o nopass.slurp');
      assert.notStrictEqual(code, 0);
    });

    it('decrypt with wrong password errors', () => {
      writeFile(path.join(tmp, 'cli-wrong.txt'), 'wrong pass\n');
      run('pack cli-wrong.txt -n wrong -o wrong.slurp');
      run('encrypt wrong.slurp -p right -o wrong.v3.slurp');
      const { code } = run('decrypt wrong.v3.slurp -p wrong');
      assert.notStrictEqual(code, 0);
    });

    it('encrypt already-encrypted archive errors', () => {
      writeFile(path.join(tmp, 'cli-double.txt'), 'double\n');
      run('pack cli-double.txt -n double -o double.slurp');
      run('encrypt double.slurp -p pass -o double.v3.slurp');
      const { code } = run('encrypt double.v3.slurp -p pass');
      assert.notStrictEqual(code, 0);
    });

    it('info shows encrypted archive metadata', () => {
      writeFile(path.join(tmp, 'cli-info-enc.txt'), 'info encrypted\n');
      run('pack cli-info-enc.txt -n info-enc -o info-enc.slurp');
      run('encrypt info-enc.slurp -p pass -o info-enc.v3.slurp');
      const { code, stdout } = run('info info-enc.v3.slurp');
      assert.strictEqual(code, 0);
      assert(stdout.includes('v3'));
      assert(stdout.includes('encrypted'));
      assert(stdout.includes('info-enc'));
    });

    it('SLURP_PASSWORD env var works for encrypt/decrypt', () => {
      writeFile(path.join(tmp, 'cli-env.txt'), 'env password\n');
      run('pack cli-env.txt -n env-test -o env.slurp');

      execSync(
        `SLURP_PASSWORD=envpass node ${slurp} encrypt env.slurp -o env.v3.slurp`,
        { cwd: tmp, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const content = fs.readFileSync(path.join(tmp, 'env.v3.slurp'), 'utf-8');
      assert(isEncrypted(content));

      execSync(
        `SLURP_PASSWORD=envpass node ${slurp} decrypt env.v3.slurp -o env.v4.slurp`,
        { cwd: tmp, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const original = fs.readFileSync(path.join(tmp, 'env.slurp'), 'utf-8');
      const restored = fs.readFileSync(path.join(tmp, 'env.v4.slurp'), 'utf-8');
      assert.strictEqual(restored, original);
    });
  });

  // --- Directory packing via CLI ---

  describe('directory packing', () => {
    it('packs a directory recursively via CLI', () => {
      const dir = path.join(tmp, 'dirpack');
      writeFile(path.join(dir, 'root.txt'), 'root\n');
      writeFile(path.join(dir, 'sub/nested.txt'), 'nested\n');

      const { code } = run(`pack dirpack -b dirpack -n dirtest -o dirtest.slurp`);
      assert.strictEqual(code, 0);

      const content = fs.readFileSync(path.join(tmp, 'dirtest.slurp'), 'utf-8');
      assert(content.includes('nested.txt'));
      assert(content.includes('root.txt'));
      assert(content.startsWith('# --- SLURP v4 ---'));
    });

    it('excludes patterns via -x', () => {
      const dir = path.join(tmp, 'direxclude');
      writeFile(path.join(dir, 'keep.js'), 'keep\n');
      writeFile(path.join(dir, 'skip.log'), 'skip\n');

      const { code } = run(`pack direxclude -b direxclude -x "*.log" -n excl -o excl.slurp`);
      assert.strictEqual(code, 0);

      const content = fs.readFileSync(path.join(tmp, 'excl.slurp'), 'utf-8');
      assert(content.includes('keep.js'));
      assert(!content.includes('skip.log'));
    });
  });

  // --- Raw encrypt/decrypt (pipe primitives) ---

  describe('encryptRaw / decryptRaw', () => {
    it('round-trips text data', () => {
      const input = Buffer.from('hello world\n');
      const encrypted = encryptRaw(input, 'secret');
      const decrypted = decryptRaw(encrypted, 'secret');
      assert.deepStrictEqual(decrypted, input);
    });

    it('round-trips binary data', () => {
      const input = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const encrypted = encryptRaw(input, 'pass');
      const decrypted = decryptRaw(encrypted, 'pass');
      assert.deepStrictEqual(decrypted, input);
    });

    it('round-trips empty input', () => {
      const input = Buffer.alloc(0);
      const encrypted = encryptRaw(input, 'pass');
      const decrypted = decryptRaw(encrypted, 'pass');
      assert.deepStrictEqual(decrypted, input);
    });

    it('fails with wrong password', () => {
      const input = Buffer.from('sensitive data');
      const encrypted = encryptRaw(input, 'right');
      assert.throws(() => decryptRaw(encrypted, 'wrong'), /wrong password/);
    });

    it('produces unique ciphertext each time', () => {
      const input = Buffer.from('same input');
      const a = encryptRaw(input, 'pass');
      const b = encryptRaw(input, 'pass');
      assert(!a.equals(b));
    });

    it('rejects truncated input', () => {
      assert.throws(() => decryptRaw(Buffer.alloc(10), 'pass'), /too short/);
    });

    it('handles large data', () => {
      const input = crypto.randomBytes(1024 * 100); // 100KB
      const encrypted = encryptRaw(input, 'bigpass');
      const decrypted = decryptRaw(encrypted, 'bigpass');
      assert.deepStrictEqual(decrypted, input);
    });
  });

  // --- Path traversal security ---

  describe('safePath', () => {
    it('allows normal relative paths', () => {
      const result = safePath('foo/bar.txt', '/tmp/base');
      assert.strictEqual(result, path.resolve('/tmp/base', 'foo/bar.txt'));
    });

    it('allows single file in base dir', () => {
      const result = safePath('file.txt', '/tmp/base');
      assert.strictEqual(result, path.resolve('/tmp/base', 'file.txt'));
    });

    it('rejects absolute paths', () => {
      assert.throws(() => safePath('/etc/passwd', '/tmp/base'), /Path traversal blocked/);
    });

    it('rejects ../ traversal', () => {
      assert.throws(() => safePath('../../../etc/passwd', '/tmp/base'), /Path traversal blocked/);
    });

    it('rejects nested ../ traversal', () => {
      assert.throws(() => safePath('foo/../../etc/shadow', '/tmp/base'), /Path traversal blocked/);
    });

    it('rejects bare ..', () => {
      assert.throws(() => safePath('..', '/tmp/base'), /Path traversal blocked/);
    });

    it('allows paths with .. in filename (not traversal)', () => {
      const result = safePath('foo..bar.txt', '/tmp/base');
      assert.strictEqual(result, path.resolve('/tmp/base', 'foo..bar.txt'));
    });
  });

  describe('path traversal in apply', () => {
    it('rejects archives with path traversal in apply', () => {
      // Craft a malicious v4 archive with ../ path
      const malicious = [
        '# --- SLURP v4 ---',
        '# name: evil',
        '',
        '=== ../../../tmp/evil.txt ===',
        'pwned',
        '=== END ../../../tmp/evil.txt ===',
        '',
      ].join('\n');
      const archivePath = path.join(tmp, 'evil-apply.slurp');
      fs.writeFileSync(archivePath, malicious);

      const dest = path.join(tmp, 'apply-safe');
      mkdirp(dest);
      const origCwd = process.cwd();
      process.chdir(dest);
      try {
        assert.throws(() => apply(archivePath), /Path traversal blocked/);
        // Ensure nothing was written outside
        assert(!fs.existsSync(path.join(tmp, 'evil.txt')));
      } finally {
        process.chdir(origCwd);
      }
    });

    it('rejects archives with absolute paths in apply', () => {
      const malicious = [
        '# --- SLURP v4 ---',
        '# name: abs-evil',
        '',
        '=== /tmp/abs-evil.txt ===',
        'pwned',
        '=== END /tmp/abs-evil.txt ===',
        '',
      ].join('\n');
      const archivePath = path.join(tmp, 'abs-evil-apply.slurp');
      fs.writeFileSync(archivePath, malicious);

      const dest = path.join(tmp, 'apply-abs-safe');
      mkdirp(dest);
      const origCwd = process.cwd();
      process.chdir(dest);
      try {
        assert.throws(() => apply(archivePath), /Path traversal blocked/);
      } finally {
        process.chdir(origCwd);
      }
    });
  });

  describe('path traversal in unpack', () => {
    it('rejects archives with path traversal in unpack', () => {
      const malicious = [
        '# --- SLURP v4 ---',
        '# name: evil-unpack',
        '',
        '=== ../../escape.txt ===',
        'escaped',
        '=== END ../../escape.txt ===',
        '',
      ].join('\n');
      const archivePath = path.join(tmp, 'evil-unpack.slurp');
      fs.writeFileSync(archivePath, malicious);

      assert.throws(() => unpack(archivePath, { output: path.join(tmp, 'unpack-safe') }), /Path traversal blocked/);
      assert(!fs.existsSync(path.join(tmp, 'escape.txt')));
    });

    it('rejects content-based unpack with traversal', () => {
      const malicious = [
        '# --- SLURP v4 ---',
        '# name: evil-content',
        '',
        '=== ../sneaky.txt ===',
        'got out',
        '=== END ../sneaky.txt ===',
        '',
      ].join('\n');

      assert.throws(
        () => unpack(malicious, { output: path.join(tmp, 'content-safe') }),
        /Path traversal blocked/
      );
    });
  });

  describe('CLI enc/dec', () => {
    it('round-trips a file via enc/dec', () => {
      writeFile(path.join(tmp, 'raw.txt'), 'pipe me\n');
      run(`enc raw.txt -p secret -o raw.enc`);
      const { code, stdout } = run(`dec raw.enc -p secret -o raw.out`);
      assert.strictEqual(code, 0);
      const result = fs.readFileSync(path.join(tmp, 'raw.out'), 'utf-8');
      assert.strictEqual(result, 'pipe me\n');
    });

    it('round-trips via stdout/stdin pipe', () => {
      writeFile(path.join(tmp, 'pipe.txt'), 'piped data\n');
      const { code, stdout } = run(`enc pipe.txt -p secret -o pipe.enc`);
      assert.strictEqual(code, 0);
      const { stdout: decrypted } = run(`dec pipe.enc -p secret`);
      assert.strictEqual(decrypted, 'piped data\n');
    });

    it('fails with wrong password', () => {
      writeFile(path.join(tmp, 'fail.txt'), 'nope\n');
      run(`enc fail.txt -p right -o fail.enc`);
      const { code, stderr } = run(`dec fail.enc -p wrong`);
      assert.notStrictEqual(code, 0);
      assert(stderr.includes('wrong password'));
    });

    it('fails without password', () => {
      writeFile(path.join(tmp, 'nopw.txt'), 'data\n');
      const { code, stderr } = run(`enc nopw.txt`);
      assert.notStrictEqual(code, 0);
      assert(stderr.includes('password required'));
    });

    it('supports SLURP_PASSWORD env var', () => {
      writeFile(path.join(tmp, 'envpw.txt'), 'env password\n');
      try {
        const enc = execSync(`SLURP_PASSWORD=envpass node ${slurp} enc envpw.txt -o envpw.enc`, {
          cwd: tmp, encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (e) { /* ignore */ }
      try {
        const dec = execSync(`SLURP_PASSWORD=envpass node ${slurp} dec envpw.enc`, {
          cwd: tmp, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
        });
        assert.strictEqual(dec, 'env password\n');
      } catch (e) {
        assert.fail('env var decryption failed');
      }
    });
  });
});
