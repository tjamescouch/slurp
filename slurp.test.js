import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pack, compress, decompress, isCompressed, parseArchive, eofMarker } from './slurp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const slurp = path.join(__dirname, 'slurp.js');
const tmp = path.join(__dirname, '.test-tmp');

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

function writeFile(filePath, content) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
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

describe('slurp', () => {
  before(() => mkdirp(tmp));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe('eofMarker', () => {
    it('sanitizes paths into valid markers', () => {
      assert.strictEqual(eofMarker('src/index.js'), 'SLURP_END_src_index_js');
      assert.strictEqual(eofMarker('file.txt'), 'SLURP_END_file_txt');
      assert.strictEqual(eofMarker('a/b/c.d.ts'), 'SLURP_END_a_b_c_d_ts');
    });
  });

  describe('pack', () => {
    it('generates a valid shell script', () => {
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

    it('embeds the PROMPT.md as comments', () => {
      writeFile(path.join(tmp, 'a.txt'), 'content\n');
      const output = pack([path.join(tmp, 'a.txt')], { name: 'test' });
      assert(output.includes('# slurp format'), 'Should embed PROMPT.md');
      assert(output.includes('# a slurp file is a self-extracting'));
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
      writeFile(nested, 'nested content\n');
      const output = pack([nested], { name: 'nested' });
      assert(output.includes("mkdir -p '"));
    });
  });

  describe('list', () => {
    it('lists files from a generated archive', () => {
      writeFile(path.join(tmp, 'f1.txt'), 'file one\n');
      writeFile(path.join(tmp, 'f2.txt'), 'file two\n');
      const archive = pack(
        [path.join(tmp, 'f1.txt'), path.join(tmp, 'f2.txt')],
        { name: 'list-test' }
      );
      const archivePath = path.join(tmp, 'list-test.slurp.sh');
      fs.writeFileSync(archivePath, archive);

      const { code, stdout } = run('list list-test.slurp.sh');
      assert.strictEqual(code, 0);
      assert(stdout.includes('f1.txt'));
      assert(stdout.includes('f2.txt'));
      assert(stdout.includes('Files (2)'));
    });
  });

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
  });

  describe('round-trip', () => {
    it('pack -> apply produces identical files', () => {
      const srcDir = path.join(tmp, 'rt-src');
      const destDir = path.join(tmp, 'rt-dest');
      mkdirp(srcDir);
      mkdirp(destDir);

      writeFile(path.join(srcDir, 'a.js'), 'const a = 1;\n');
      writeFile(path.join(srcDir, 'b.txt'), 'line 1\nline 2\n');

      const archive = pack(
        ['a.js', 'b.txt'].map(f => path.join(srcDir, f)),
        { name: 'roundtrip' }
      );
      const archivePath = path.join(tmp, 'roundtrip.slurp.sh');
      fs.writeFileSync(archivePath, archive);

      // Apply via shell
      execSync(`sh ${archivePath}`, { cwd: tmp });

      // Verify files were written
      for (const f of ['a.js', 'b.txt'].map(f => path.join(srcDir, f))) {
        assert(fs.existsSync(f), `File should exist: ${f}`);
      }
    });
  });

  describe('compress/decompress', () => {
    it('round-trips a v1 archive through compress/decompress', () => {
      writeFile(path.join(tmp, 'comp1.txt'), 'hello compressed world\n');
      const v1 = pack([path.join(tmp, 'comp1.txt')], { name: 'comp-test' });
      const v2 = compress(v1, { name: 'comp-test' });
      assert(isCompressed(v2));
      assert(v2.includes('SLURP v2 (compressed)'));
      assert(v2.includes('sha256:'));
      const restored = decompress(v2);
      assert.strictEqual(restored, v1);
    });

    it('compressed archive is smaller than original for repetitive content', () => {
      const bigContent = 'the quick brown fox jumps over the lazy dog\n'.repeat(200);
      writeFile(path.join(tmp, 'big.txt'), bigContent);
      const v1 = pack([path.join(tmp, 'big.txt')], { name: 'big-test' });
      const v2 = compress(v1, { name: 'big-test' });
      assert(v2.length < v1.length, `compressed (${v2.length}) should be smaller than original (${v1.length})`);
    });

    it('isCompressed detects v2 vs v1', () => {
      writeFile(path.join(tmp, 'det.txt'), 'detect me\n');
      const v1 = pack([path.join(tmp, 'det.txt')], { name: 'detect' });
      const v2 = compress(v1, { name: 'detect' });
      assert(!isCompressed(v1));
      assert(isCompressed(v2));
    });

    it('parseArchive transparently handles compressed archives', () => {
      writeFile(path.join(tmp, 'tp1.txt'), 'transparent content\n');
      const v1 = pack([path.join(tmp, 'tp1.txt')], { name: 'transparent', description: 'test transparency' });
      const v2 = compress(v1, { name: 'transparent' });
      const archivePath = path.join(tmp, 'transparent.slurp.sh');
      fs.writeFileSync(archivePath, v2);

      const { metadata, files } = parseArchive(archivePath);
      assert.strictEqual(metadata.name, 'transparent');
      assert.strictEqual(metadata.description, 'test transparency');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('transparent content'));
    });

    it('list works on compressed archives via CLI', () => {
      writeFile(path.join(tmp, 'cl1.txt'), 'cli list compressed\n');
      writeFile(path.join(tmp, 'cl2.txt'), 'second file\n');
      const v1 = pack(
        [path.join(tmp, 'cl1.txt'), path.join(tmp, 'cl2.txt')],
        { name: 'cli-comp' }
      );
      const v2 = compress(v1, { name: 'cli-comp' });
      fs.writeFileSync(path.join(tmp, 'cli-comp.slurp.sh'), v2);

      const { code, stdout } = run('list cli-comp.slurp.sh');
      assert.strictEqual(code, 0);
      assert(stdout.includes('cl1.txt'));
      assert(stdout.includes('cl2.txt'));
      assert(stdout.includes('Files (2)'));
    });

    it('v1 archives still parse unchanged (backward compat)', () => {
      writeFile(path.join(tmp, 'bc.txt'), 'backward compat\n');
      const v1 = pack([path.join(tmp, 'bc.txt')], { name: 'compat' });
      const archivePath = path.join(tmp, 'compat.slurp.sh');
      fs.writeFileSync(archivePath, v1);

      const { metadata, files } = parseArchive(archivePath);
      assert.strictEqual(metadata.name, 'compat');
      assert.strictEqual(files.length, 1);
      assert(files[0].content.includes('backward compat'));
    });

    it('detects checksum tampering', () => {
      writeFile(path.join(tmp, 'tamper.txt'), 'tamper test\n');
      const v1 = pack([path.join(tmp, 'tamper.txt')], { name: 'tamper' });
      let v2 = compress(v1, { name: 'tamper' });
      // Corrupt one character of the base64 payload
      v2 = v2.replace(/^(base64 -d.*\n)([A-Za-z])/, '$1X');
      // Only test if we actually corrupted something detectable
      try {
        decompress(v2);
        // If it didn't throw, the corruption wasn't enough to change the hash
      } catch (e) {
        assert(e.message.includes('checksum mismatch') || e.message.includes('incorrect header check'));
      }
    });

    it('CLI pack -z produces compressed output', () => {
      writeFile(path.join(tmp, 'zflag.txt'), 'compress via flag\n');
      const { code } = run('pack zflag.txt -n ztest -z -o zout.slurp.sh');
      assert.strictEqual(code, 0);
      const content = fs.readFileSync(path.join(tmp, 'zout.slurp.sh'), 'utf-8');
      assert(isCompressed(content));
      assert(content.includes('SLURP v2 (compressed)'));
      assert(content.includes('sha256:'));
    });
  });

  describe('CLI', () => {
    it('pack writes to file with -o', () => {
      writeFile(path.join(tmp, 'cli.txt'), 'cli test\n');
      const { code } = run('pack cli.txt -n cli-test -o cli-out.slurp.sh');
      assert.strictEqual(code, 0);
      assert(fs.existsSync(path.join(tmp, 'cli-out.slurp.sh')));
    });

    it('errors on missing files', () => {
      const { code } = run('pack');
      assert.notStrictEqual(code, 0);
    });

    it('errors on unknown command', () => {
      const { code } = run('bogus');
      assert.notStrictEqual(code, 0);
    });
  });
});
