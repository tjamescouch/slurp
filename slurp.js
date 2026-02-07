#!/usr/bin/env node
/**
 * slurp - self-extracting POSIX shell archives
 *
 * Packs files into a single .slurp.sh script that recreates them when run
 * with `sh`. Archives are human-readable, LLM-friendly, and POSIX-compatible.
 *
 * Usage:
 *   slurp pack [options] <files/dirs...>  Pack into a .slurp.sh archive
 *   slurp list <archive>                  List files in an archive
 *   slurp info <archive>                  Show archive metadata
 *   slurp apply <archive>                 Extract files to current dir
 *   slurp unpack <archive>                Extract to staging dir (prints path)
 *   slurp create <staging-dir> [dest]     Copy staging dir to destination
 *   slurp verify <archive>               Verify file checksums
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

// --- Helpers ---

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function eofMarker(filePath) {
  return 'SLURP_END_' + filePath.replace(/[/.]/g, '_');
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function isBinary(buffer) {
  const len = Math.min(buffer.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function loadPrompt() {
  const promptPath = path.join(__dirname, 'PROMPT.md');
  if (!fs.existsSync(promptPath)) return null;
  return fs.readFileSync(promptPath, 'utf-8');
}

function promptAsComments(text) {
  return text.split('\n').map(line => line ? `# ${line}` : '#').join('\n');
}

// --- File collection ---

function collectFiles(target, baseDir, excludePatterns = []) {
  const results = [];
  const absTarget = path.resolve(target);
  const absBase = path.resolve(baseDir);

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(absBase, fullPath);

      if (excludePatterns.some(p => p.test(relPath) || p.test(entry.name))) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        results.push({ fullPath, relPath });
      }
    }
  }

  const stat = fs.statSync(absTarget);
  if (stat.isDirectory()) {
    walk(absTarget);
  } else {
    results.push({ fullPath: absTarget, relPath: path.relative(absBase, absTarget) });
  }

  return results;
}

// --- Pack ---

function pack(fileList, opts = {}) {
  const prompt = loadPrompt();
  const name = opts.name || 'archive';
  const description = opts.description || '';
  const noChecksum = opts.noChecksum || false;
  const now = new Date().toISOString();

  // Normalize: accept strings or {fullPath, relPath} objects
  const entries = fileList.map(f => {
    const fullPath = typeof f === 'string' ? f : f.fullPath;
    const relPath = typeof f === 'string' ? f : f.relPath;
    const content = fs.readFileSync(fullPath);
    const binary = isBinary(content);
    return {
      relPath,
      content,
      text: binary ? null : content.toString('utf-8'),
      binary,
      size: content.length,
      checksum: noChecksum ? null : sha256(content),
    };
  });

  const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
  const lines = [];

  // Header
  lines.push('#!/bin/sh');
  lines.push('# --- SLURP v1 ---');

  if (prompt) {
    lines.push(promptAsComments(prompt));
  }

  lines.push('#');
  lines.push(`# name: ${name}`);
  if (description) lines.push(`# description: ${description}`);
  lines.push(`# files: ${entries.length}`);
  lines.push(`# total: ${humanSize(totalSize)}`);
  lines.push(`# created: ${now}`);
  lines.push('#');

  // Manifest
  if (entries.length > 0) {
    lines.push('# MANIFEST:');
    const maxLen = Math.max(...entries.map(e => e.relPath.length), 4);
    for (const e of entries) {
      const size = humanSize(e.size).padStart(10);
      const ck = e.checksum ? `  sha256:${e.checksum.slice(0, 16)}` : '';
      const bin = e.binary ? '  [binary]' : '';
      lines.push(`#   ${e.relPath.padEnd(maxLen)}  ${size}${ck}${bin}`);
    }
    lines.push('#');
  }

  lines.push('');
  lines.push('set -e');
  lines.push('');

  // Sentinel
  if (opts.sentinel) {
    lines.push(`if [ ! -f "${opts.sentinel}" ]; then`);
    lines.push(`  echo "error: expected ${opts.sentinel} in current directory" >&2`);
    lines.push('  exit 1');
    lines.push('fi');
    lines.push('');
  }

  lines.push(`echo "applying ${name}..."`);
  lines.push('');

  // File bodies
  for (const e of entries) {
    const marker = eofMarker(e.relPath);
    const dir = path.dirname(e.relPath);

    if (dir && dir !== '.') {
      lines.push(`mkdir -p '${dir}'`);
    }

    if (e.binary) {
      lines.push(`base64 -d > '${e.relPath}' << '${marker}'`);
      const b64 = e.content.toString('base64');
      const wrapped = b64.match(/.{1,76}/g).join('\n');
      lines.push(wrapped);
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

// --- Compress / Decompress (v2) ---

function compress(v1Archive, opts = {}) {
  const name = opts.name || 'archive';
  const gzipped = zlib.gzipSync(Buffer.from(v1Archive, 'utf-8'));
  const b64 = gzipped.toString('base64');
  const checksum = sha256(gzipped);
  const originalSize = Buffer.byteLength(v1Archive, 'utf-8');
  const compressedSize = b64.length;
  const ratio = Math.round((1 - compressedSize / originalSize) * 100);
  const wrapped = b64.match(/.{1,76}/g).join('\n');

  const lines = [];
  lines.push('#!/bin/sh');
  lines.push('# --- SLURP v2 (compressed) ---');
  lines.push('#');
  lines.push('# This is a compressed slurp archive.');
  lines.push('# The payload is a gzip-compressed, base64-encoded slurp v1 archive.');
  lines.push('# To decompress manually: base64 -d <<< payload | gunzip');
  lines.push('# Or simply run this file: sh archive.slurp.sh');
  lines.push('#');
  lines.push(`# name: ${name}`);
  lines.push(`# original: ${originalSize} bytes`);
  lines.push(`# compressed: ${compressedSize} bytes`);
  lines.push(`# ratio: ${ratio}%`);
  lines.push(`# sha256: ${checksum}`);
  lines.push('');
  lines.push("base64 -d << 'SLURP_COMPRESSED' | gunzip | sh");
  lines.push(wrapped);
  lines.push('SLURP_COMPRESSED');
  lines.push('');

  return lines.join('\n');
}

function decompress(content) {
  const lines = content.split('\n');

  let expectedChecksum = null;
  for (const line of lines) {
    if (line === "base64 -d << 'SLURP_COMPRESSED' | gunzip | sh") break;
    const m = line.match(/^# sha256:\s*([0-9a-f]{64})/);
    if (m) expectedChecksum = m[1];
  }

  const startIdx = lines.indexOf("base64 -d << 'SLURP_COMPRESSED' | gunzip | sh");
  const endIdx = lines.indexOf('SLURP_COMPRESSED', startIdx + 1);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('invalid v2 archive: missing SLURP_COMPRESSED markers');
  }

  const b64 = lines.slice(startIdx + 1, endIdx).join('');
  const gzipped = Buffer.from(b64, 'base64');

  if (expectedChecksum) {
    const actual = sha256(gzipped);
    if (actual !== expectedChecksum) {
      throw new Error(`checksum mismatch: expected ${expectedChecksum}, got ${actual}`);
    }
  }

  return zlib.gunzipSync(gzipped).toString('utf-8');
}

function isCompressed(content) {
  const secondLine = content.split('\n')[1];
  return secondLine === '# --- SLURP v2 (compressed) ---';
}

// --- Parse ---

function parseArchive(archivePath) {
  let content = fs.readFileSync(archivePath, 'utf-8');
  if (isCompressed(content)) {
    content = decompress(content);
  }

  const lines = content.split('\n');
  const metadata = {};
  const files = [];

  // Parse metadata from header (before 'set -e')
  for (const line of lines) {
    if (line === 'set -e') break;
    const m = line.match(/^# (name|description|files|total|created|sentinel):\s*(.+)/);
    if (m) metadata[m[1]] = m[2];
  }

  // Parse manifest checksums
  const checksums = {};
  let inManifest = false;
  for (const line of lines) {
    if (line === 'set -e') break;
    if (line === '# MANIFEST:') { inManifest = true; continue; }
    if (inManifest) {
      if (line === '#') { inManifest = false; continue; }
      const m = line.match(/^#\s+(\S+)\s+.*sha256:([0-9a-f]{16})/);
      if (m) checksums[m[1]] = m[2];
    }
  }

  // Parse file blocks
  let i = 0;
  while (i < lines.length) {
    // Match text heredocs: cat > 'path' << 'MARKER'
    const catMatch = lines[i].match(/^cat > '([^']+)' << '([^']+)'$/);
    // Match binary heredocs: base64 -d > 'path' << 'MARKER'
    const b64Match = lines[i].match(/^base64 -d > '([^']+)' << '([^']+)'$/);
    const match = catMatch || b64Match;
    const binary = !!b64Match;

    if (match) {
      const filePath = match[1];
      const marker = match[2];
      const contentLines = [];
      i++;
      while (i < lines.length && lines[i] !== marker) {
        contentLines.push(lines[i]);
        i++;
      }

      if (binary) {
        const b64 = contentLines.join('');
        files.push({
          path: filePath,
          marker,
          binary: true,
          content: Buffer.from(b64, 'base64'),
        });
      } else {
        files.push({
          path: filePath,
          marker,
          binary: false,
          content: contentLines.join('\n'),
        });
      }
    }
    i++;
  }

  return { metadata, checksums, files };
}

// --- Commands ---

function list(archivePath) {
  const { metadata, files } = parseArchive(archivePath);
  if (metadata.name) console.log(`Archive: ${metadata.name}`);
  if (metadata.description) console.log(`Description: ${metadata.description}`);
  if (metadata.created) console.log(`Created: ${metadata.created}`);
  if (metadata.total) console.log(`Total: ${metadata.total}`);
  console.log(`Files (${files.length}):`);
  for (const f of files) {
    const tag = f.binary ? ' [binary]' : '';
    console.log(`  ${f.path}${tag}`);
  }
}

function info(archivePath) {
  let content = fs.readFileSync(archivePath, 'utf-8');
  const compressed = isCompressed(content);
  if (compressed) {
    content = decompress(content);
  }

  const { metadata, files } = parseArchive(archivePath);
  console.log('SLURP Archive');
  if (metadata.name) console.log(`  Name:        ${metadata.name}`);
  if (metadata.description) console.log(`  Description: ${metadata.description}`);
  if (metadata.created) console.log(`  Created:     ${metadata.created}`);
  console.log(`  Files:       ${files.length}`);
  if (metadata.total) console.log(`  Total size:  ${metadata.total}`);
  console.log(`  Compressed:  ${compressed ? 'yes (v2)' : 'no (v1)'}`);
}

function apply(archivePath) {
  const { metadata, files } = parseArchive(archivePath);
  console.log(`applying ${metadata.name || 'archive'}...`);

  for (const f of files) {
    const dir = path.dirname(f.path);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (f.binary) {
      fs.writeFileSync(f.path, f.content);
    } else {
      fs.writeFileSync(f.path, f.content.endsWith('\n') ? f.content : f.content + '\n');
    }
  }

  console.log(`done. ${files.length} files extracted.`);
}

function verify(archivePath) {
  const { files } = parseArchive(archivePath);
  let fail = 0;

  for (const f of files) {
    if (!fs.existsSync(f.path)) {
      console.log(`  MISSING: ${f.path}`);
      fail++;
      continue;
    }

    const ondisk = fs.readFileSync(f.path);
    const expected = f.binary ? f.content : Buffer.from(f.content.endsWith('\n') ? f.content : f.content + '\n');

    if (Buffer.compare(ondisk, expected) !== 0) {
      console.log(`  MISMATCH: ${f.path}`);
      fail++;
    } else {
      console.log(`  OK: ${f.path}`);
    }
  }

  if (fail === 0) {
    console.log(`\nAll ${files.length} files verified.`);
  } else {
    console.log(`\n${fail} file(s) failed verification.`);
  }

  return fail === 0;
}

// --- Unpack (extract to staging dir) ---

function unpack(archivePathOrContent, opts = {}) {
  let parsed;
  if (typeof archivePathOrContent === 'string' && fs.existsSync(archivePathOrContent)) {
    parsed = parseArchive(archivePathOrContent);
  } else {
    // Content passed directly (e.g. from stdin)
    let content = typeof archivePathOrContent === 'string'
      ? archivePathOrContent
      : archivePathOrContent.toString('utf-8');
    if (isCompressed(content)) {
      content = decompress(content);
    }
    parsed = parseContent(content);
  }

  const { metadata, files } = parsed;
  const name = metadata.name || 'archive';
  const rand = crypto.randomBytes(4).toString('hex');
  const stagingDir = opts.output || path.resolve(`${name}.${rand}.unslurp`);

  fs.mkdirSync(stagingDir, { recursive: true });

  for (const f of files) {
    const dest = path.join(stagingDir, f.path);
    const dir = path.dirname(dest);
    if (dir !== stagingDir) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (f.binary) {
      fs.writeFileSync(dest, f.content);
    } else {
      fs.writeFileSync(dest, f.content.endsWith('\n') ? f.content : f.content + '\n');
    }
  }

  return stagingDir;
}

// --- Parse content string (no file path) ---

function parseContent(content) {
  const lines = content.split('\n');
  const metadata = {};
  const files = [];

  for (const line of lines) {
    if (line === 'set -e') break;
    const m = line.match(/^# (name|description|files|total|created|sentinel):\s*(.+)/);
    if (m) metadata[m[1]] = m[2];
  }

  let i = 0;
  while (i < lines.length) {
    const catMatch = lines[i].match(/^cat > '([^']+)' << '([^']+)'$/);
    const b64Match = lines[i].match(/^base64 -d > '([^']+)' << '([^']+)'$/);
    const match = catMatch || b64Match;
    const binary = !!b64Match;

    if (match) {
      const filePath = match[1];
      const marker = match[2];
      const contentLines = [];
      i++;
      while (i < lines.length && lines[i] !== marker) {
        contentLines.push(lines[i]);
        i++;
      }

      if (binary) {
        const b64 = contentLines.join('');
        files.push({ path: filePath, marker, binary: true, content: Buffer.from(b64, 'base64') });
      } else {
        files.push({ path: filePath, marker, binary: false, content: contentLines.join('\n') });
      }
    }
    i++;
  }

  return { metadata, files };
}

// --- Create (copy staging dir to destination) ---

function create(stagingDir, destDir) {
  if (!fs.existsSync(stagingDir) || !fs.statSync(stagingDir).isDirectory()) {
    throw new Error(`staging directory not found: ${stagingDir}`);
  }

  destDir = destDir || '.';
  fs.mkdirSync(destDir, { recursive: true });

  let count = 0;

  function copyRecursive(src, dest) {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        count++;
      }
    }
  }

  copyRecursive(stagingDir, destDir);
  return count;
}

// --- Exports ---

export {
  sha256,
  humanSize,
  eofMarker,
  globToRegex,
  isBinary,
  collectFiles,
  pack,
  compress,
  decompress,
  isCompressed,
  parseArchive,
  parseContent,
  list,
  info,
  apply,
  verify,
  unpack,
  create,
};

// --- CLI ---

if (isMain) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(`slurp - self-extracting POSIX shell archives

Usage:
  slurp pack [options] <files/dirs...>  Pack into a .slurp.sh archive
  slurp list <archive>                  List files in an archive
  slurp info <archive>                  Show archive metadata
  slurp apply <archive>                 Extract files to current dir
  slurp unpack <archive>                Extract to staging dir (prints path)
  slurp create <staging-dir> [dest]     Copy staging dir to destination
  slurp verify <archive>                Verify file checksums

Pack options:
  -o, --output <path>       Output file (default: stdout)
  -n, --name <name>         Archive name
  -d, --description <desc>  Description
  -s, --sentinel <file>     Sentinel file for safety check
  -z, --compress            Compress archive (v2 gzip+base64)
  -x, --exclude <glob>      Exclude files matching glob (repeatable)
  -b, --base-dir <dir>      Base directory for relative paths
  --no-checksum             Skip SHA-256 checksums

Unpack options:
  -o, --output <dir>        Staging directory (default: <name>.<random>.unslurp)
  -                         Read archive from stdin

Pipeline examples:
  slurp pack dir | slurp unpack -        Pack and unpack via pipe
  STAGE=$(slurp unpack archive.slurp.sh) Stage for editing
  sed -i 's/old/new/g' $STAGE/*.js       Transform staged files
  slurp create $STAGE ./dest             Apply to destination
`);
    process.exit(0);
  }

  switch (command) {
    case 'pack': {
      const rest = args.slice(1);
      const targets = [];
      const opts = {};
      const excludes = [];
      let baseDir = null;
      let i = 0;

      while (i < rest.length) {
        const arg = rest[i];
        if (arg === '-o' || arg === '--output') { opts.output = rest[++i]; }
        else if (arg === '-n' || arg === '--name') { opts.name = rest[++i]; }
        else if (arg === '-d' || arg === '--description') { opts.description = rest[++i]; }
        else if (arg === '-s' || arg === '--sentinel') { opts.sentinel = rest[++i]; }
        else if (arg === '-z' || arg === '--compress') { opts.compress = true; }
        else if (arg === '-x' || arg === '--exclude') { excludes.push(rest[++i]); }
        else if (arg === '-b' || arg === '--base-dir') { baseDir = rest[++i]; }
        else if (arg === '--no-checksum') { opts.noChecksum = true; }
        else { targets.push(arg); }
        i++;
      }

      if (targets.length === 0) {
        console.error('error: no files specified');
        process.exit(1);
      }

      // Build exclude patterns (always exclude .git and node_modules)
      const excludePatterns = [
        globToRegex('.git'), globToRegex('.git/*'),
        globToRegex('node_modules'), globToRegex('node_modules/*'),
        ...excludes.map(globToRegex),
      ];

      // Collect files
      let allFiles = [];
      for (const target of targets) {
        if (!fs.existsSync(target)) {
          console.error(`error: ${target} does not exist`);
          process.exit(1);
        }
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          const base = baseDir || target;
          allFiles.push(...collectFiles(target, base, excludePatterns));
        } else {
          const base = baseDir || path.dirname(target);
          const relPath = path.relative(base, target);
          allFiles.push({ fullPath: path.resolve(target), relPath });
        }
      }

      // Deduplicate and sort
      const seen = new Set();
      allFiles = allFiles.filter(f => {
        if (seen.has(f.relPath)) return false;
        seen.add(f.relPath);
        return true;
      });
      allFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

      if (allFiles.length === 0) {
        console.error('error: no files found to archive');
        process.exit(1);
      }

      let output = pack(allFiles, opts);
      if (opts.compress) {
        output = compress(output, opts);
      }

      if (opts.output) {
        fs.writeFileSync(opts.output, output);
        console.error(`wrote ${opts.output} (${allFiles.length} files)`);
      } else {
        process.stdout.write(output);
      }
      break;
    }

    case 'list': {
      const archive = args[1];
      if (!archive) { console.error('error: no archive specified'); process.exit(1); }
      list(archive);
      break;
    }

    case 'info': {
      const archive = args[1];
      if (!archive) { console.error('error: no archive specified'); process.exit(1); }
      info(archive);
      break;
    }

    case 'apply': {
      const archive = args[1];
      if (!archive) { console.error('error: no archive specified'); process.exit(1); }
      apply(archive);
      break;
    }

    case 'unpack': {
      const rest = args.slice(1);
      let archive = null;
      let outputDir = null;
      let fromStdin = false;
      let i = 0;

      while (i < rest.length) {
        const arg = rest[i];
        if (arg === '-o' || arg === '--output') { outputDir = rest[++i]; }
        else if (arg === '-') { fromStdin = true; }
        else { archive = arg; }
        i++;
      }

      if (!archive && !fromStdin) {
        console.error('error: no archive specified (use - for stdin)');
        process.exit(1);
      }

      const opts = {};
      if (outputDir) opts.output = outputDir;

      let stagingDir;
      if (fromStdin) {
        const chunks = [];
        const fd = fs.openSync('/dev/stdin', 'r');
        const buf = Buffer.alloc(65536);
        let n;
        while ((n = fs.readSync(fd, buf)) > 0) {
          chunks.push(buf.subarray(0, n));
        }
        fs.closeSync(fd);
        const content = Buffer.concat(chunks).toString('utf-8');
        stagingDir = unpack(content, opts);
      } else {
        stagingDir = unpack(archive, opts);
      }

      // Print staging dir path to stdout for pipeline use
      process.stdout.write(stagingDir + '\n');
      break;
    }

    case 'create': {
      const stagingDir = args[1];
      const dest = args[2] || '.';
      if (!stagingDir) { console.error('error: no staging directory specified'); process.exit(1); }
      const count = create(stagingDir, dest);
      console.error(`created ${count} files in ${dest}`);
      break;
    }

    case 'verify': {
      const archive = args[1];
      if (!archive) { console.error('error: no archive specified'); process.exit(1); }
      const ok = verify(archive);
      process.exit(ok ? 0 : 1);
      break;
    }

    default:
      console.error(`unknown command: ${command}`);
      process.exit(1);
  }
}
