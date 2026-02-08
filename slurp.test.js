import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sha256, humanSize, eofMarker, globToRegex, isBinary,
  collectFiles, pack, compress, decompress, isCompressed,
  encrypt, decrypt, isEncrypted,
  parseArchive, parseContent, list, info, apply, verify,
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

  // --- Pack ---

  describe('pack', () => {
    it('generates a valid POSIX shell script', () => {
      writeFile(path.join(tmp, 'hello.txt'), 'hello world\n');
      const output = pack(
        [path.join(tmp, 'hello.txt')],
        { name: 'test-archive' }
      );
      assert(output.startsWith('#!/bin/sh'));
      assert(output.includes('SLURP v1'));
      assert(output.includes('name: test-archive'));
      assert(output.includes('hello world'));
    });

    it('embeds PROMPT.md as comments', () => {
      writeFile(path.join(tmp, 'a.txt'), 'content\n');
      const output = pack([path.join(tmp, 'a.txt')], { name: 'test' });
      assert(output.includes('# slurp format'));
    });

    it('includes a manifest with file sizes', () => {
      writeFile(path.join(tmp, 'manifest.txt'), 'some content here\n');
      const output = pack([path.join(tmp, 'manifest.txt')], { name: 'manifest-test' });
      assert(output.includes('MANIFEST:'));
      assert(output.includes('sha256:'));
    });

    it('includes sentinel check when specified', () => {
      writeFile(path.join(tmp, 'b.txt'), 'data\n');
      const output = pack(
        [path.join(tmp, 'b.txt')],
        { name: 'guarded', sentinel: 'package.json' }
      );
      assert(output.includes('if [ ! -f "package.json" ]'));
    });

    it('creates mkdir -p for nested paths', () => {
      const nested = path.join(tmp, 'sub/dir/file.js');
      writeFile(nested, 'nested\n');
      const output = pack([nested], { name: 'nested' });
      assert(output.includes("mkdir -p '"));
    });

    it('skips checksums with noChecksum option', () => {
      writeFile(path.join(tmp, 'nock.txt'), 'no checksums\n');
      const output = pack([path.join(tmp, 'nock.txt')], { name: 'nock', noChecksum: true });
      // The MANIFEST line for the file should not have a sha256 hash
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
      assert(output.includes("cat > 'custom/obj.txt'"));
      assert(output.includes("mkdir -p 'custom'"));
    });

    it('handles binary files with base64', () => {
      const binPath = path.join(tmp, 'binary.dat');
      fs.writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]));
      const output = pack([binPath], { name: 'binary-test' });
      assert(output.includes("base64 -d > '"));
      assert(output.includes('[binary]'));
    });
  });

  // --- Compress / Decompress ---

  describe('compress/decompress', () => {
    it('round-trips a v1 archive', () => {
      writeFile(path.join(tmp, 'comp.txt'), 'compressed content\n');
      const v1 = pack([path.join(tmp, 'comp.txt')], { name: 'comp-test' });
      const v2 = compress(v1, { name: 'comp-test' });
      assert(isCompressed(v2));
      assert(v2.includes('SLURP v2 (compressed)'));
      assert(v2.includes('sha256:'));
      const restored = decompress(v2);
      assert.strictEqual(restored, v1);
    });

    it('compressed is smaller for repetitive content', () => {
      const big = 'the quick brown fox\n'.repeat(200);
      writeFile(path.join(tmp, 'big.txt'), big);
      const v1 = pack([path.join(tmp, 'big.txt')], { name: 'big' });
      const v2 = compress(v1, { name: 'big' });
      assert(v2.length < v1.length);
    });

    it('isCompressed detects v2 vs v1', () => {
      writeFile(path.join(tmp, 'det.txt'), 'detect\n');
      const v1 = pack([path.join(tmp, 'det.txt')], { name: 'det' });
      const v2 = compress(v1, { name: 'det' });
      assert(!isCompressed(v1));
      assert(isCompressed(v2));
    });

    it('detects checksum tampering', () => {
      writeFile(path.join(tmp, 'tamper.txt'), 'tamper test\n');
      const v1 = pack([path.join(tmp, 'tamper.txt')], { name: 'tamper' });
      let v2 = compress(v1, { name: 'tamper' });
      v2 = v2.replace(/^(base64 -d.*\n)([A-Za-z])/, '$1X');
      try {
        decompress(v2);
      } catch (e) {
        assert(e.message.includes('checksum mismatch') || e.message.includes('incorrect header check'));
      }
    });
  });

  // --- parseArchive ---

  describe('parseArchive', () => {
    it('extracts metadata and file contents', () => {
      writeFile(path.join(tmp, 'p1.txt'), 'parsed content\n');
      const archive = pack(
        [path.join(tmp, 'p1.txt')],
        { name: 'parse-test', description: 'testing parser' }
      );
      const archivePath = path.join(tmp, 'parse-test.slurp.sh');
      fs.writeFileSync(archivePath, archive);

      const { metadata, files } = parseArchive(archivePath);
      assert.strictEqual(metadata.name, 'parse-test');
      assert.strictEqual(metadata.description, 'testing parser');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('parsed content'));
    });

    it('handles compressed archives transparently', () => {
      writeFile(path.join(tmp, 'tp.txt'), 'transparent\n');
      const v1 = pack([path.join(tmp, 'tp.txt')], { name: 'transparent', description: 'test' });
      const v2 = compress(v1, { name: 'transparent' });
      const archivePath = path.join(tmp, 'transparent.slurp.sh');
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
      const archivePath = path.join(tmp, 'bin-parse.slurp.sh');
      fs.writeFileSync(archivePath, archive);

      const { files } = parseArchive(archivePath);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].binary, true);
      assert(Buffer.isBuffer(files[0].content));
      assert.strictEqual(Buffer.compare(files[0].content, binData), 0);
    });

    it('v1 backward compat - still parses unchanged', () => {
      writeFile(path.join(tmp, 'bc.txt'), 'backward\n');
      const v1 = pack([path.join(tmp, 'bc.txt')], { name: 'compat' });
      const archivePath = path.join(tmp, 'compat.slurp.sh');
      fs.writeFileSync(archivePath, v1);

      const { metadata, files } = parseArchive(archivePath);
      assert.strictEqual(metadata.name, 'compat');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('backward'));
    });
  });

  // --- Round-trip: pack + sh extraction ---

  describe('round-trip (shell extraction)', () => {
    it('pack -> sh produces identical text files', () => {
      const srcDir = path.join(tmp, 'rt-src');
      mkdirp(srcDir);
      writeFile(path.join(srcDir, 'a.js'), 'const a = 1;\n');
      writeFile(path.join(srcDir, 'b.txt'), 'line 1\nline 2\n');

      const archive = pack(
        ['a.js', 'b.txt'].map(f => path.join(srcDir, f)),
        { name: 'roundtrip' }
      );
      const archivePath = path.join(tmp, 'roundtrip.slurp.sh');
      fs.writeFileSync(archivePath, archive);
      execSync(`sh ${archivePath}`, { cwd: tmp });

      for (const f of ['a.js', 'b.txt'].map(f => path.join(srcDir, f))) {
        assert(fs.existsSync(f), `File should exist: ${f}`);
      }
    });

    it('pack -> sh handles binary files via base64', () => {
      const srcDir = path.join(tmp, 'rt-bin');
      mkdirp(srcDir);
      const binData = crypto.randomBytes(512);
      const binPath = path.join(srcDir, 'data.bin');
      fs.writeFileSync(binPath, binData);

      const archive = pack(
        [{ fullPath: binPath, relPath: 'data.bin' }],
        { name: 'bin-rt' }
      );
      const archivePath = path.join(tmp, 'bin-rt.slurp.sh');
      fs.writeFileSync(archivePath, archive);

      const extractDir = path.join(tmp, 'rt-bin-extract');
      mkdirp(extractDir);
      execSync(`sh ${archivePath}`, { cwd: extractDir });

      const extracted = fs.readFileSync(path.join(extractDir, 'data.bin'));
      assert.strictEqual(Buffer.compare(extracted, binData), 0, 'binary content preserved');
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
      const archivePath = path.join(tmp, 'apply-test.slurp.sh');
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
  });

  // --- CLI ---

  describe('CLI', () => {
    it('pack writes to file with -o', () => {
      writeFile(path.join(tmp, 'cli.txt'), 'cli test\n');
      const { code } = run('pack cli.txt -n cli-test -o cli-out.slurp.sh');
      assert.strictEqual(code, 0);
      assert(fs.existsSync(path.join(tmp, 'cli-out.slurp.sh')));
    });

    it('pack -z produces compressed output', () => {
      writeFile(path.join(tmp, 'zflag.txt'), 'compress via flag\n');
      const { code } = run('pack zflag.txt -n ztest -z -o zout.slurp.sh');
      assert.strictEqual(code, 0);
      const content = fs.readFileSync(path.join(tmp, 'zout.slurp.sh'), 'utf-8');
      assert(isCompressed(content));
    });

    it('list shows files', () => {
      writeFile(path.join(tmp, 'l1.txt'), 'one\n');
      writeFile(path.join(tmp, 'l2.txt'), 'two\n');
      const archive = pack(
        [path.join(tmp, 'l1.txt'), path.join(tmp, 'l2.txt')],
        { name: 'list-test' }
      );
      fs.writeFileSync(path.join(tmp, 'list-test.slurp.sh'), archive);

      const { code, stdout } = run('list list-test.slurp.sh');
      assert.strictEqual(code, 0);
      assert(stdout.includes('l1.txt'));
      assert(stdout.includes('l2.txt'));
      assert(stdout.includes('Files (2)'));
    });

    it('list works on compressed archives', () => {
      writeFile(path.join(tmp, 'cl.txt'), 'compressed list\n');
      const v1 = pack([path.join(tmp, 'cl.txt')], { name: 'cl-test' });
      const v2 = compress(v1, { name: 'cl-test' });
      fs.writeFileSync(path.join(tmp, 'cl-test.slurp.sh'), v2);

      const { code, stdout } = run('list cl-test.slurp.sh');
      assert.strictEqual(code, 0);
      assert(stdout.includes('cl.txt'));
    });

    it('info shows metadata', () => {
      writeFile(path.join(tmp, 'info.txt'), 'info test\n');
      const archive = pack(
        [{ fullPath: path.join(tmp, 'info.txt'), relPath: 'info.txt' }],
        { name: 'info-test', description: 'testing info' }
      );
      fs.writeFileSync(path.join(tmp, 'info-test.slurp.sh'), archive);

      const { code, stdout } = run('info info-test.slurp.sh');
      assert.strictEqual(code, 0);
      assert(stdout.includes('SLURP Archive'));
      assert(stdout.includes('info-test'));
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
      assert(stdout.includes('self-extracting'));
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
      const archivePath = path.join(tmp, 'unpack-test.slurp.sh');
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
      const archivePath = path.join(tmp, 'custom.slurp.sh');
      fs.writeFileSync(archivePath, archive);

      const dest = path.join(tmp, 'my-staging');
      const stagingDir = unpack(archivePath, { output: dest });
      assert.strictEqual(stagingDir, dest);
      assert.strictEqual(fs.readFileSync(path.join(dest, 'unpack-custom.txt'), 'utf-8'), 'custom\n');
    });

    it('works with compressed archives', () => {
      writeFile(path.join(tmp, 'unpack-v2.txt'), 'compressed unpack\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'unpack-v2.txt'), relPath: 'unpack-v2.txt' }],
        { name: 'v2-unpack' }
      );
      const v2 = compress(v1, { name: 'v2-unpack' });
      const archivePath = path.join(tmp, 'v2-unpack.slurp.sh');
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
      const archivePath = path.join(tmp, 'bin-unpack.slurp.sh');
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
      const archivePath = path.join(tmp, 'roundtrip-stage.slurp.sh');
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
      fs.writeFileSync(path.join(tmp, 'cli-unpack.slurp.sh'), archive);

      const { code, stdout } = run('unpack cli-unpack.slurp.sh');
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
      fs.writeFileSync(path.join(tmp, 'cli-unpack-o.slurp.sh'), archive);

      const { code, stdout } = run('unpack cli-unpack-o.slurp.sh -o my-stage');
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
      fs.writeFileSync(path.join(tmp, 'pipe-in.slurp.sh'), archive);

      const { code, stdout } = run('unpack - -o pipe-staged < pipe-in.slurp.sh');
      assert.strictEqual(code, 0);
      assert(fs.existsSync(path.join(tmp, 'pipe-staged', 'pipe-test.txt')));
    });
  });

  // --- Encrypt / Decrypt ---

  describe('encrypt/decrypt', () => {
    it('round-trips a v1 archive with correct password', () => {
      writeFile(path.join(tmp, 'enc.txt'), 'secret content\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc.txt'), relPath: 'enc.txt' }],
        { name: 'enc-test' }
      );
      const v3 = encrypt(v1, 'mypassword', { name: 'enc-test' });
      assert(isEncrypted(v3));
      assert(v3.includes('SLURP v3 (encrypted)'));
      assert(v3.includes('sha256:'));

      const restored = decrypt(v3, 'mypassword');
      assert.strictEqual(restored, v1);
    });

    it('fails with wrong password', () => {
      writeFile(path.join(tmp, 'enc2.txt'), 'data\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc2.txt'), relPath: 'enc2.txt' }],
        { name: 'enc2' }
      );
      const v3 = encrypt(v1, 'correct', { name: 'enc2' });
      assert.throws(
        () => decrypt(v3, 'wrong'),
        /decryption failed|wrong password/
      );
    });

    it('isEncrypted detects v3 vs v1/v2', () => {
      writeFile(path.join(tmp, 'det-enc.txt'), 'detect\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'det-enc.txt'), relPath: 'det-enc.txt' }],
        { name: 'det-enc' }
      );
      const v2 = compress(v1, { name: 'det-enc' });
      const v3 = encrypt(v1, 'pass', { name: 'det-enc' });

      assert(!isEncrypted(v1));
      assert(!isEncrypted(v2));
      assert(isEncrypted(v3));
    });

    it('detects checksum tampering', () => {
      writeFile(path.join(tmp, 'enc-tamper.txt'), 'tamper test\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc-tamper.txt'), relPath: 'enc-tamper.txt' }],
        { name: 'tamper' }
      );
      let v3 = encrypt(v1, 'pass', { name: 'tamper' });

      // Corrupt a byte in the payload
      const payloadStart = v3.indexOf("SLURP_PAYLOAD=$(base64 -d << 'SLURP_ENCRYPTED'") + "SLURP_PAYLOAD=$(base64 -d << 'SLURP_ENCRYPTED'\n".length;
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
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc-unique.txt'), relPath: 'enc-unique.txt' }],
        { name: 'unique' }
      );
      const v3a = encrypt(v1, 'pass', { name: 'unique' });
      const v3b = encrypt(v1, 'pass', { name: 'unique' });

      // Same plaintext and password, but salt/iv differ
      assert.notStrictEqual(v3a, v3b);
      // Both decrypt to the same content
      assert.strictEqual(decrypt(v3a, 'pass'), v1);
      assert.strictEqual(decrypt(v3b, 'pass'), v1);
    });

    it('handles empty password gracefully (still round-trips)', () => {
      writeFile(path.join(tmp, 'enc-empty.txt'), 'empty pass\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc-empty.txt'), relPath: 'enc-empty.txt' }],
        { name: 'empty' }
      );
      const v3 = encrypt(v1, '', { name: 'empty' });
      const restored = decrypt(v3, '');
      assert.strictEqual(restored, v1);
    });

    it('encrypts large archives', () => {
      const big = 'the quick brown fox jumps over the lazy dog\n'.repeat(5000);
      writeFile(path.join(tmp, 'enc-big.txt'), big);
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc-big.txt'), relPath: 'enc-big.txt' }],
        { name: 'big' }
      );
      const v3 = encrypt(v1, 'bigpass', { name: 'big' });
      const restored = decrypt(v3, 'bigpass');
      assert.strictEqual(restored, v1);
    });

    it('v3 header contains metadata', () => {
      writeFile(path.join(tmp, 'enc-meta.txt'), 'meta\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc-meta.txt'), relPath: 'enc-meta.txt' }],
        { name: 'meta-test' }
      );
      const v3 = encrypt(v1, 'pass', { name: 'meta-test' });
      assert(v3.includes('name: meta-test'));
      assert(v3.includes('iterations: 100000'));
      assert(v3.includes('AES-256-GCM'));
    });

    it('parseArchive handles encrypted archives with password', () => {
      writeFile(path.join(tmp, 'enc-parse.txt'), 'parseable\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc-parse.txt'), relPath: 'enc-parse.txt' }],
        { name: 'enc-parse' }
      );
      const v3 = encrypt(v1, 'secret', { name: 'enc-parse' });
      const archivePath = path.join(tmp, 'enc-parse.slurp.sh');
      fs.writeFileSync(archivePath, v3);

      const { metadata, files } = parseArchive(archivePath, { password: 'secret' });
      assert.strictEqual(metadata.name, 'enc-parse');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('parseable'));
    });

    it('parseArchive throws on encrypted archive without password', () => {
      writeFile(path.join(tmp, 'enc-nopass.txt'), 'nope\n');
      const v1 = pack(
        [{ fullPath: path.join(tmp, 'enc-nopass.txt'), relPath: 'enc-nopass.txt' }],
        { name: 'enc-nopass' }
      );
      const v3 = encrypt(v1, 'pw', { name: 'enc-nopass' });
      const archivePath = path.join(tmp, 'enc-nopass.slurp.sh');
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
      run('pack cli-enc.txt -n cli-enc -o cli-enc.slurp.sh');
      const { code } = run('encrypt cli-enc.slurp.sh -p testpass -o cli-enc.v3.slurp.sh');
      assert.strictEqual(code, 0);
      const content = fs.readFileSync(path.join(tmp, 'cli-enc.v3.slurp.sh'), 'utf-8');
      assert(isEncrypted(content));
    });

    it('decrypt writes to file with -o', () => {
      writeFile(path.join(tmp, 'cli-dec.txt'), 'cli decrypt\n');
      run('pack cli-dec.txt -n cli-dec -o cli-dec.slurp.sh');
      run('encrypt cli-dec.slurp.sh -p decpass -o cli-dec.v3.slurp.sh');
      const { code } = run('decrypt cli-dec.v3.slurp.sh -p decpass -o cli-dec.v1.slurp.sh');
      assert.strictEqual(code, 0);

      const original = fs.readFileSync(path.join(tmp, 'cli-dec.slurp.sh'), 'utf-8');
      const restored = fs.readFileSync(path.join(tmp, 'cli-dec.v1.slurp.sh'), 'utf-8');
      assert.strictEqual(restored, original);
    });

    it('pack -e creates encrypted archive', () => {
      writeFile(path.join(tmp, 'cli-pack-e.txt'), 'pack encrypt\n');
      const { code } = run('pack cli-pack-e.txt -n pack-enc -e -p mypass -o pack-enc.slurp.sh');
      assert.strictEqual(code, 0);
      const content = fs.readFileSync(path.join(tmp, 'pack-enc.slurp.sh'), 'utf-8');
      assert(isEncrypted(content));
    });

    it('pack -e without password errors', () => {
      writeFile(path.join(tmp, 'cli-nopass.txt'), 'no password\n');
      const { code } = run('pack cli-nopass.txt -n nopass -e -o nopass.slurp.sh');
      assert.notStrictEqual(code, 0);
    });

    it('decrypt with wrong password errors', () => {
      writeFile(path.join(tmp, 'cli-wrong.txt'), 'wrong pass\n');
      run('pack cli-wrong.txt -n wrong -o wrong.slurp.sh');
      run('encrypt wrong.slurp.sh -p right -o wrong.v3.slurp.sh');
      const { code } = run('decrypt wrong.v3.slurp.sh -p wrong');
      assert.notStrictEqual(code, 0);
    });

    it('encrypt already-encrypted archive errors', () => {
      writeFile(path.join(tmp, 'cli-double.txt'), 'double\n');
      run('pack cli-double.txt -n double -o double.slurp.sh');
      run('encrypt double.slurp.sh -p pass -o double.v3.slurp.sh');
      const { code } = run('encrypt double.v3.slurp.sh -p pass');
      assert.notStrictEqual(code, 0);
    });

    it('info shows encrypted archive metadata', () => {
      writeFile(path.join(tmp, 'cli-info-enc.txt'), 'info encrypted\n');
      run('pack cli-info-enc.txt -n info-enc -o info-enc.slurp.sh');
      run('encrypt info-enc.slurp.sh -p pass -o info-enc.v3.slurp.sh');
      const { code, stdout } = run('info info-enc.v3.slurp.sh');
      assert.strictEqual(code, 0);
      assert(stdout.includes('v3'));
      assert(stdout.includes('encrypted'));
      assert(stdout.includes('info-enc'));
    });

    it('SLURP_PASSWORD env var works for encrypt/decrypt', () => {
      writeFile(path.join(tmp, 'cli-env.txt'), 'env password\n');
      run('pack cli-env.txt -n env-test -o env.slurp.sh');

      // Use env var via shell
      const encResult = execSync(
        `SLURP_PASSWORD=envpass node ${slurp} encrypt env.slurp.sh -o env.v3.slurp.sh`,
        { cwd: tmp, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const content = fs.readFileSync(path.join(tmp, 'env.v3.slurp.sh'), 'utf-8');
      assert(isEncrypted(content));

      const decResult = execSync(
        `SLURP_PASSWORD=envpass node ${slurp} decrypt env.v3.slurp.sh -o env.v1.slurp.sh`,
        { cwd: tmp, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const original = fs.readFileSync(path.join(tmp, 'env.slurp.sh'), 'utf-8');
      const restored = fs.readFileSync(path.join(tmp, 'env.v1.slurp.sh'), 'utf-8');
      assert.strictEqual(restored, original);
    });
  });

  // --- Directory packing via CLI ---

  describe('directory packing', () => {
    it('packs a directory recursively via CLI', () => {
      const dir = path.join(tmp, 'dirpack');
      writeFile(path.join(dir, 'root.txt'), 'root\n');
      writeFile(path.join(dir, 'sub/nested.txt'), 'nested\n');

      const { code } = run(`pack dirpack -b dirpack -n dirtest -o dirtest.slurp.sh`);
      assert.strictEqual(code, 0);

      const content = fs.readFileSync(path.join(tmp, 'dirtest.slurp.sh'), 'utf-8');
      assert(content.includes('nested.txt'));
      assert(content.includes('root.txt'));
    });

    it('excludes patterns via -x', () => {
      const dir = path.join(tmp, 'direxclude');
      writeFile(path.join(dir, 'keep.js'), 'keep\n');
      writeFile(path.join(dir, 'skip.log'), 'skip\n');

      const { code } = run(`pack direxclude -b direxclude -x "*.log" -n excl -o excl.slurp.sh`);
      assert.strictEqual(code, 0);

      const content = fs.readFileSync(path.join(tmp, 'excl.slurp.sh'), 'utf-8');
      assert(content.includes('keep.js'));
      assert(!content.includes('skip.log'));
    });
  });
});
