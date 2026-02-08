#!/usr/bin/env node
/**
 * slurp - pure data archives with embedded OWL spec
 *
 * Packs files into a single .slurp archive — a human-readable, LLM-friendly
 * data bundle. Archives are not executable; they are self-documenting data
 * files with an embedded format specification.
 *
 * Usage:
 *   slurp pack [options] <files/dirs...>  Pack into a .slurp archive
 *   slurp list <archive>                  List files in an archive
 *   slurp info <archive>                  Show archive metadata
 *   slurp apply <archive>                 Extract files to current dir
 *   slurp unpack <archive>                Extract to staging dir (prints path)
 *   slurp create <staging-dir> [dest]     Copy staging dir to destination
 *   slurp verify <archive>               Verify file checksums
 *   slurp encrypt <archive> [options]    Encrypt archive (v3 AES-256-GCM)
 *   slurp decrypt <archive> [options]    Decrypt a v3 archive
 *   slurp enc [file] [options]           Raw encrypt (pipe-friendly)
 *   slurp dec [file] [options]           Raw decrypt (pipe-friendly)
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

  // Header — v4 pure data format (no shebang)
  lines.push('# --- SLURP v4 ---');

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

  // File bodies — v4 delimiters
  for (const e of entries) {
    if (e.binary) {
      lines.push(`=== ${e.relPath} [binary] ===`);
      const b64 = e.content.toString('base64');
      const wrapped = b64.match(/.{1,76}/g).join('\n');
      lines.push(wrapped);
    } else {
      lines.push(`=== ${e.relPath} ===`);
      lines.push(e.text.endsWith('\n') ? e.text.slice(0, -1) : e.text);
    }

    lines.push(`=== END ${e.relPath} ===`);
    lines.push('');
  }

  return lines.join('\n');
}

// --- Compress / Decompress (v2) ---

function compress(innerArchive, opts = {}) {
  const name = opts.name || 'archive';
  const gzipped = zlib.gzipSync(Buffer.from(innerArchive, 'utf-8'));
  const b64 = gzipped.toString('base64');
  const checksum = sha256(gzipped);
  const originalSize = Buffer.byteLength(innerArchive, 'utf-8');
  const compressedSize = b64.length;
  const ratio = Math.round((1 - compressedSize / originalSize) * 100);
  const wrapped = b64.match(/.{1,76}/g).join('\n');

  const lines = [];
  lines.push('# --- SLURP v2 (compressed) ---');
  lines.push('#');
  lines.push('# This is a compressed slurp archive.');
  lines.push('# The payload is a gzip-compressed, base64-encoded slurp v4 archive.');
  lines.push('#');
  lines.push(`# name: ${name}`);
  lines.push(`# original: ${originalSize} bytes`);
  lines.push(`# compressed: ${compressedSize} bytes`);
  lines.push(`# ratio: ${ratio}%`);
  lines.push(`# sha256: ${checksum}`);
  lines.push('');
  lines.push('--- PAYLOAD ---');
  lines.push(wrapped);
  lines.push('--- END PAYLOAD ---');
  lines.push('');

  return lines.join('\n');
}

function decompress(content) {
  const lines = content.split('\n');

  let expectedChecksum = null;
  for (const line of lines) {
    if (line === '--- PAYLOAD ---' || line === "base64 -d << 'SLURP_COMPRESSED' | gunzip | sh") break;
    const m = line.match(/^# sha256:\s*([0-9a-f]{64})/);
    if (m) expectedChecksum = m[1];
  }

  // Try new v4-style payload markers first, then fall back to old v1-style
  let startIdx = lines.indexOf('--- PAYLOAD ---');
  let endIdx = startIdx !== -1 ? lines.indexOf('--- END PAYLOAD ---', startIdx + 1) : -1;

  if (startIdx === -1 || endIdx === -1) {
    // Fall back to old v2 format (wrapping v1)
    startIdx = lines.indexOf("base64 -d << 'SLURP_COMPRESSED' | gunzip | sh");
    endIdx = lines.indexOf('SLURP_COMPRESSED', startIdx + 1);
  }

  if (startIdx === -1 || endIdx === -1) {
    throw new Error('invalid v2 archive: missing payload markers');
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
  const firstLine = content.split('\n')[0];
  const secondLine = content.split('\n')[1];
  return firstLine === '# --- SLURP v2 (compressed) ---' || secondLine === '# --- SLURP v2 (compressed) ---';
}

// --- Encrypt / Decrypt (v3) ---

function encrypt(innerArchive, password, opts = {}) {
  const name = opts.name || 'archive';

  // Derive key from password using PBKDF2
  const salt = crypto.randomBytes(16);
  const iterations = 100000;
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const iv = crypto.randomBytes(12);

  // Compress first, then encrypt
  const compressed = zlib.gzipSync(Buffer.from(innerArchive, 'utf-8'));

  // AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: salt(16) + iv(12) + authTag(16) + ciphertext
  const payload = Buffer.concat([salt, iv, authTag, encrypted]);
  const b64 = payload.toString('base64');
  const checksum = sha256(payload);
  const wrapped = b64.match(/.{1,76}/g).join('\n');

  const originalSize = Buffer.byteLength(innerArchive, 'utf-8');

  const lines = [];
  lines.push('# --- SLURP v3 (encrypted) ---');
  lines.push('#');
  lines.push('# This is an encrypted slurp archive.');
  lines.push('# The payload is AES-256-GCM encrypted (PBKDF2 key derivation).');
  lines.push('# Use: slurp decrypt <archive> to decrypt.');
  lines.push('#');
  lines.push(`# name: ${name}`);
  lines.push(`# original: ${originalSize} bytes`);
  lines.push(`# encrypted: ${b64.length} bytes`);
  lines.push(`# sha256: ${checksum}`);
  lines.push(`# iterations: ${iterations}`);
  lines.push('');
  lines.push('--- PAYLOAD ---');
  lines.push(wrapped);
  lines.push('--- END PAYLOAD ---');
  lines.push('');

  return lines.join('\n');
}

function decrypt(content, password) {
  const lines = content.split('\n');

  // Verify it's a v3 archive
  if (!isEncrypted(content)) {
    throw new Error('not a v3 encrypted archive');
  }

  // Parse iterations from header
  let iterations = 100000;
  let expectedChecksum = null;
  for (const line of lines) {
    const iterMatch = line.match(/^# iterations:\s*(\d+)/);
    if (iterMatch) iterations = parseInt(iterMatch[1], 10);
    const shaMatch = line.match(/^# sha256:\s*([0-9a-f]{64})/);
    if (shaMatch) expectedChecksum = shaMatch[1];
  }

  // Try new payload markers first, then fall back to old v3 format
  let startIdx = lines.indexOf('--- PAYLOAD ---');
  let endIdx = startIdx !== -1 ? lines.indexOf('--- END PAYLOAD ---', startIdx + 1) : -1;

  if (startIdx === -1 || endIdx === -1) {
    // Fall back to old v3 format
    startIdx = lines.findIndex(l => l === "SLURP_PAYLOAD=$(base64 -d << 'SLURP_ENCRYPTED'");
    endIdx = lines.indexOf('SLURP_ENCRYPTED', startIdx + 1);
  }

  if (startIdx === -1 || endIdx === -1) {
    throw new Error('invalid v3 archive: missing payload markers');
  }

  const b64 = lines.slice(startIdx + 1, endIdx).join('');
  const payload = Buffer.from(b64, 'base64');

  // Verify checksum
  if (expectedChecksum) {
    const actual = sha256(payload);
    if (actual !== expectedChecksum) {
      throw new Error(`checksum mismatch: expected ${expectedChecksum}, got ${actual}`);
    }
  }

  // Unpack: salt(16) + iv(12) + authTag(16) + ciphertext
  if (payload.length < 44) {
    throw new Error('invalid v3 archive: payload too short');
  }

  const salt = payload.subarray(0, 16);
  const iv = payload.subarray(16, 28);
  const authTag = payload.subarray(28, 44);
  const encrypted = payload.subarray(44);

  // Derive key
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');

  // Decrypt
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted;
  try {
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (e) {
    throw new Error('decryption failed: wrong password or corrupted archive');
  }

  // Decompress
  const inner = zlib.gunzipSync(decrypted).toString('utf-8');
  return inner;
}

function isEncrypted(content) {
  const firstLine = content.split('\n')[0];
  const secondLine = content.split('\n')[1];
  return firstLine === '# --- SLURP v3 (encrypted) ---' || secondLine === '# --- SLURP v3 (encrypted) ---';
}

// --- Raw encrypt/decrypt (pipe primitives) ---

function encryptRaw(inputBuffer, password) {
  const salt = crypto.randomBytes(16);
  const iterations = 100000;
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(inputBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Output: salt(16) + iv(12) + authTag(16) + ciphertext
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decryptRaw(inputBuffer, password) {
  if (inputBuffer.length < 44) {
    throw new Error('input too short to be encrypted data');
  }

  const salt = inputBuffer.subarray(0, 16);
  const iv = inputBuffer.subarray(16, 28);
  const authTag = inputBuffer.subarray(28, 44);
  const encrypted = inputBuffer.subarray(44);

  const iterations = 100000;
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (e) {
    throw new Error('decryption failed: wrong password or corrupted data');
  }
}

// --- Parse ---

function isV4(content) {
  const firstLine = content.split('\n')[0];
  return firstLine === '# --- SLURP v4 ---';
}

function parseArchive(archivePath, opts = {}) {
  let content = fs.readFileSync(archivePath, 'utf-8');
  if (isEncrypted(content)) {
    if (!opts.password) {
      throw new Error('archive is encrypted: password required');
    }
    content = decrypt(content, opts.password);
  }
  if (isCompressed(content)) {
    content = decompress(content);
  }

  return parseContent(content);
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

function info(archivePath, opts = {}) {
  let content = fs.readFileSync(archivePath, 'utf-8');
  const encrypted = isEncrypted(content);
  const compressed = isCompressed(content);

  console.log('SLURP Archive');

  if (encrypted) {
    // Parse what we can from the v3 header without decrypting
    const lines = content.split('\n');
    let name, original, encSize, checksum;
    for (const line of lines) {
      const m = line.match(/^# (name|original|encrypted|sha256):\s*(.+)/);
      if (m) {
        if (m[1] === 'name') name = m[2];
        if (m[1] === 'original') original = m[2];
        if (m[1] === 'encrypted') encSize = m[2];
        if (m[1] === 'sha256') checksum = m[2];
      }
    }
    if (name) console.log(`  Name:        ${name}`);
    if (original) console.log(`  Original:    ${original}`);
    if (encSize) console.log(`  Encrypted:   ${encSize}`);
    console.log(`  Format:      v3 (encrypted, AES-256-GCM)`);
    if (checksum) console.log(`  SHA-256:     ${checksum}`);
    return;
  }

  if (compressed) {
    content = decompress(content);
  }

  const { metadata, files } = parseArchive(archivePath);
  const v4 = isV4(content);
  if (metadata.name) console.log(`  Name:        ${metadata.name}`);
  if (metadata.description) console.log(`  Description: ${metadata.description}`);
  if (metadata.created) console.log(`  Created:     ${metadata.created}`);
  console.log(`  Files:       ${files.length}`);
  if (metadata.total) console.log(`  Total size:  ${metadata.total}`);
  console.log(`  Format:      ${v4 ? 'v4' : 'v1'}${compressed ? ' (compressed)' : ''}`);
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
  if (isV4(content)) {
    return parseContentV4(content);
  }
  return parseContentV1(content);
}

function parseContentV4(content) {
  const lines = content.split('\n');
  const metadata = {};
  const checksums = {};
  const files = [];

  // Parse metadata from header comments
  let inManifest = false;
  for (const line of lines) {
    if (!line.startsWith('#') && line !== '') break;
    const m = line.match(/^# (name|description|files|total|created|sentinel):\s*(.+)/);
    if (m) metadata[m[1]] = m[2];
    if (line === '# MANIFEST:') { inManifest = true; continue; }
    if (inManifest) {
      if (line === '#') { inManifest = false; continue; }
      const cm = line.match(/^#\s+(\S+)\s+.*sha256:([0-9a-f]{16})/);
      if (cm) checksums[cm[1]] = cm[2];
    }
  }

  // Parse v4 file blocks: === path === / === END path ===
  let i = 0;
  while (i < lines.length) {
    // Match text file delimiter: === path ===
    const textMatch = lines[i].match(/^=== (.+?) ===$/);
    // Match binary file delimiter: === path [binary] ===
    const binMatch = lines[i].match(/^=== (.+?) \[binary\] ===$/);

    if (textMatch || binMatch) {
      const binary = !!binMatch;
      const filePath = binary ? binMatch[1] : textMatch[1];
      // Skip if this is an END marker
      if (filePath.startsWith('END ')) { i++; continue; }
      const endMarker = `=== END ${filePath} ===`;
      const contentLines = [];
      i++;
      while (i < lines.length && lines[i] !== endMarker) {
        contentLines.push(lines[i]);
        i++;
      }

      if (binary) {
        const b64 = contentLines.join('');
        files.push({ path: filePath, binary: true, content: Buffer.from(b64, 'base64') });
      } else {
        files.push({ path: filePath, binary: false, content: contentLines.join('\n') });
      }
    }
    i++;
  }

  return { metadata, checksums, files };
}

function parseContentV1(content) {
  const lines = content.split('\n');
  const metadata = {};
  const checksums = {};
  const files = [];

  for (const line of lines) {
    if (line === 'set -e') break;
    const m = line.match(/^# (name|description|files|total|created|sentinel):\s*(.+)/);
    if (m) metadata[m[1]] = m[2];
  }

  let inManifest = false;
  for (const line of lines) {
    if (line === 'set -e') break;
    if (line === '# MANIFEST:') { inManifest = true; continue; }
    if (inManifest) {
      if (line === '#') { inManifest = false; continue; }
      const cm = line.match(/^#\s+(\S+)\s+.*sha256:([0-9a-f]{16})/);
      if (cm) checksums[cm[1]] = cm[2];
    }
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

  return { metadata, checksums, files };
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
  isV4,
  collectFiles,
  pack,
  compress,
  decompress,
  isCompressed,
  encrypt,
  decrypt,
  isEncrypted,
  encryptRaw,
  decryptRaw,
  parseArchive,
  parseContent,
  parseContentV1,
  parseContentV4,
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
    console.log(`slurp - pure data archives with embedded OWL spec

Usage:
  slurp pack [options] <files/dirs...>  Pack into a .slurp archive
  slurp list <archive>                  List files in an archive
  slurp info <archive>                  Show archive metadata
  slurp apply <archive>                 Extract files to current dir
  slurp unpack <archive>                Extract to staging dir (prints path)
  slurp create <staging-dir> [dest]     Copy staging dir to destination
  slurp verify <archive>                Verify file checksums
  slurp encrypt <archive> [options]     Encrypt an archive (v3 AES-256-GCM)
  slurp decrypt <archive> [options]     Decrypt a v3 archive
  slurp enc [file] [options]            Raw encrypt (pipe-friendly)
  slurp dec [file] [options]            Raw decrypt (pipe-friendly)

Pack options:
  -o, --output <path>       Output file (default: stdout)
  -n, --name <name>         Archive name
  -d, --description <desc>  Description
  -z, --compress            Compress archive (v2 gzip+base64)
  -e, --encrypt             Encrypt archive (v3 AES-256-GCM)
  -x, --exclude <glob>      Exclude files matching glob (repeatable)
  -b, --base-dir <dir>      Base directory for relative paths
  --no-checksum             Skip SHA-256 checksums

Encrypt/Decrypt options:
  -p, --password <pass>     Password (or set SLURP_PASSWORD env var)
  -o, --output <path>       Output file (default: stdout)

Unpack options:
  -o, --output <dir>        Staging directory (default: <name>.<random>.unslurp)
  -                         Read archive from stdin
  -p, --password <pass>     Password for encrypted archives

Pipeline examples:
  slurp pack dir | slurp unpack -        Pack and unpack via pipe
  STAGE=$(slurp unpack archive.slurp)    Stage for editing
  sed -i 's/old/new/g' $STAGE/*.js       Transform staged files
  slurp create $STAGE ./dest             Apply to destination
  slurp pack -e -p secret dir            Pack and encrypt in one step
  slurp decrypt archive.v3.slurp         Decrypt an encrypted archive
  cat file | slurp enc -p secret > out   Raw encrypt via pipe
  cat out | slurp dec -p secret          Raw decrypt via pipe
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
        else if (arg === '-e' || arg === '--encrypt') { opts.encrypt = true; }
        else if (arg === '-p' || arg === '--password') { opts.password = rest[++i]; }
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
      if (opts.encrypt) {
        const pw = opts.password || process.env.SLURP_PASSWORD;
        if (!pw) {
          console.error('error: password required for encryption (use -p or SLURP_PASSWORD env var)');
          process.exit(1);
        }
        output = encrypt(output, pw, opts);
      } else if (opts.compress) {
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

    case 'encrypt': {
      const rest = args.slice(1);
      let archive = null;
      let outputFile = null;
      let pw = null;
      let i = 0;

      while (i < rest.length) {
        const arg = rest[i];
        if (arg === '-o' || arg === '--output') { outputFile = rest[++i]; }
        else if (arg === '-p' || arg === '--password') { pw = rest[++i]; }
        else { archive = arg; }
        i++;
      }

      if (!archive) { console.error('error: no archive specified'); process.exit(1); }
      pw = pw || process.env.SLURP_PASSWORD;
      if (!pw) {
        console.error('error: password required (use -p or SLURP_PASSWORD env var)');
        process.exit(1);
      }

      let content = fs.readFileSync(archive, 'utf-8');
      // If already v2, decompress to inner archive first
      if (isCompressed(content)) {
        content = decompress(content);
      }
      if (isEncrypted(content)) {
        console.error('error: archive is already encrypted');
        process.exit(1);
      }

      // Parse name from the archive
      const nameLine = content.split('\n').find(l => l.match(/^# name:\s/));
      const archiveName = nameLine ? nameLine.replace(/^# name:\s*/, '') : 'archive';

      const encrypted = encrypt(content, pw, { name: archiveName });

      if (outputFile) {
        fs.writeFileSync(outputFile, encrypted);
        console.error(`wrote ${outputFile} (encrypted)`);
      } else {
        process.stdout.write(encrypted);
      }
      break;
    }

    case 'decrypt': {
      const rest = args.slice(1);
      let archive = null;
      let outputFile = null;
      let pw = null;
      let i = 0;

      while (i < rest.length) {
        const arg = rest[i];
        if (arg === '-o' || arg === '--output') { outputFile = rest[++i]; }
        else if (arg === '-p' || arg === '--password') { pw = rest[++i]; }
        else { archive = arg; }
        i++;
      }

      if (!archive) { console.error('error: no archive specified'); process.exit(1); }
      pw = pw || process.env.SLURP_PASSWORD;
      if (!pw) {
        console.error('error: password required (use -p or SLURP_PASSWORD env var)');
        process.exit(1);
      }

      const content = fs.readFileSync(archive, 'utf-8');
      if (!isEncrypted(content)) {
        console.error('error: archive is not encrypted');
        process.exit(1);
      }

      const decrypted = decrypt(content, pw);

      if (outputFile) {
        fs.writeFileSync(outputFile, decrypted);
        console.error(`wrote ${outputFile} (decrypted)`);
      } else {
        process.stdout.write(decrypted);
      }
      break;
    }

    case 'enc': {
      const rest = args.slice(1);
      let inputFile = null;
      let outputFile = null;
      let pw = null;
      let i = 0;

      while (i < rest.length) {
        const arg = rest[i];
        if (arg === '-o' || arg === '--output') { outputFile = rest[++i]; }
        else if (arg === '-p' || arg === '--password') { pw = rest[++i]; }
        else if (arg !== '-') { inputFile = arg; }
        i++;
      }

      pw = pw || process.env.SLURP_PASSWORD;
      if (!pw) {
        console.error('error: password required (use -p or SLURP_PASSWORD env var)');
        process.exit(1);
      }

      let input;
      if (inputFile) {
        input = fs.readFileSync(inputFile);
      } else {
        const chunks = [];
        const fd = fs.openSync('/dev/stdin', 'r');
        const buf = Buffer.alloc(65536);
        let n;
        while ((n = fs.readSync(fd, buf)) > 0) chunks.push(buf.subarray(0, n));
        fs.closeSync(fd);
        input = Buffer.concat(chunks);
      }

      const result = encryptRaw(input, pw);

      if (outputFile) {
        fs.writeFileSync(outputFile, result);
        console.error(`wrote ${outputFile} (${result.length} bytes encrypted)`);
      } else {
        process.stdout.write(result);
      }
      break;
    }

    case 'dec': {
      const rest = args.slice(1);
      let inputFile = null;
      let outputFile = null;
      let pw = null;
      let i = 0;

      while (i < rest.length) {
        const arg = rest[i];
        if (arg === '-o' || arg === '--output') { outputFile = rest[++i]; }
        else if (arg === '-p' || arg === '--password') { pw = rest[++i]; }
        else if (arg !== '-') { inputFile = arg; }
        i++;
      }

      pw = pw || process.env.SLURP_PASSWORD;
      if (!pw) {
        console.error('error: password required (use -p or SLURP_PASSWORD env var)');
        process.exit(1);
      }

      let input;
      if (inputFile) {
        input = fs.readFileSync(inputFile);
      } else {
        const chunks = [];
        const fd = fs.openSync('/dev/stdin', 'r');
        const buf = Buffer.alloc(65536);
        let n;
        while ((n = fs.readSync(fd, buf)) > 0) chunks.push(buf.subarray(0, n));
        fs.closeSync(fd);
        input = Buffer.concat(chunks);
      }

      try {
        const result = decryptRaw(input, pw);
        if (outputFile) {
          fs.writeFileSync(outputFile, result);
          console.error(`wrote ${outputFile} (${result.length} bytes decrypted)`);
        } else {
          process.stdout.write(result);
        }
      } catch (e) {
        console.error(`error: ${e.message}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`unknown command: ${command}`);
      process.exit(1);
  }
}
