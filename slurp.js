#!/usr/bin/env node
/**
 * slurp - self-extracting shell archives for AI agents
 *
 * Usage:
 *   slurp pack <file...> [options]    Pack files into a .slurp.sh archive
 *   slurp list <archive>              List files in a slurp archive
 *   slurp apply <archive>             Extract files from a slurp archive
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CLI parsing ---

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

function parsePackArgs(args) {
  const files = [];
  const opts = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output') { opts.output = args[++i]; }
    else if (arg === '-n' || arg === '--name') { opts.name = args[++i]; }
    else if (arg === '-d' || arg === '--description') { opts.description = args[++i]; }
    else if (arg === '-s' || arg === '--sentinel') { opts.sentinel = args[++i]; }
    else { files.push(arg); }
    i++;
  }
  return { files, opts };
}

// --- Helpers ---

function eofMarker(filePath) {
  return 'SLURP_END_' + filePath.replace(/[/.]/g, '_');
}

function loadPrompt() {
  const promptPath = path.join(__dirname, 'PROMPT.md');
  if (!fs.existsSync(promptPath)) return null;
  return fs.readFileSync(promptPath, 'utf-8');
}

function promptAsComments(promptText) {
  return promptText.split('\n').map(line => line ? `# ${line}` : '#').join('\n');
}

// --- Pack ---

function pack(files, opts = {}) {
  const prompt = loadPrompt();
  const name = opts.name || 'archive';
  const description = opts.description || '';
  const now = new Date().toISOString();
  const lines = [];

  lines.push('#!/bin/sh');
  lines.push('# --- SLURP v1 ---');

  if (prompt) {
    lines.push(promptAsComments(prompt));
  }

  lines.push('#');
  lines.push(`# name: ${name}`);
  if (description) lines.push(`# description: ${description}`);
  lines.push(`# files: ${files.length}`);
  lines.push(`# created: ${now}`);
  lines.push('#');
  lines.push('# changes:');
  for (const f of files) {
    lines.push(`#   ${f}`);
  }
  lines.push('');
  lines.push('set -e');
  lines.push('');

  if (opts.sentinel) {
    lines.push(`if [ ! -f "${opts.sentinel}" ]; then`);
    lines.push(`  echo "error: expected ${opts.sentinel} in current directory" >&2`);
    lines.push('  exit 1');
    lines.push('fi');
    lines.push('');
  }

  lines.push(`echo "applying ${name}..."`);
  lines.push('');

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const marker = eofMarker(filePath);
    const dir = path.dirname(filePath);

    if (dir && dir !== '.') {
      lines.push(`mkdir -p '${dir}'`);
    }
    lines.push(`cat > '${filePath}' << '${marker}'`);
    lines.push(content.endsWith('\n') ? content.slice(0, -1) : content);
    lines.push(marker);
    lines.push('');
  }

  lines.push('echo ""');
  lines.push(`echo "done. ${files.length} files extracted."`);
  lines.push('');

  return lines.join('\n');
}

// --- List ---

function parseArchive(archivePath) {
  const content = fs.readFileSync(archivePath, 'utf-8');
  const lines = content.split('\n');
  const metadata = {};
  const files = [];

  // Parse metadata from header only (before 'set -e')
  for (const line of lines) {
    if (line === 'set -e') break;
    const metaMatch = line.match(/^# (name|description|target|files|created):\s*(.+)/);
    if (metaMatch) metadata[metaMatch[1]] = metaMatch[2];
  }

  // Parse file blocks sequentially (avoids matching inside heredocs)
  let i = 0;
  while (i < lines.length) {
    const catMatch = lines[i].match(/^cat > '([^']+)' << '([^']+)'$/);
    if (catMatch) {
      const filePath = catMatch[1];
      const marker = catMatch[2];
      const contentLines = [];
      i++;
      while (i < lines.length && lines[i] !== marker) {
        contentLines.push(lines[i]);
        i++;
      }
      files.push({ path: filePath, marker, content: contentLines.join('\n') });
    }
    i++;
  }

  return { metadata, files };
}

function list(archivePath) {
  const { metadata, files } = parseArchive(archivePath);

  if (metadata.name) console.log(`Archive: ${metadata.name}`);
  if (metadata.description) console.log(`Description: ${metadata.description}`);
  if (metadata.created) console.log(`Created: ${metadata.created}`);
  console.log(`Files (${files.length}):`);
  for (const f of files) {
    console.log(`  ${f.path}`);
  }
}

// --- Apply ---

function apply(archivePath) {
  const { metadata, files } = parseArchive(archivePath);

  console.log(`applying ${metadata.name || 'archive'}...`);

  for (const f of files) {
    const dir = path.dirname(f.path);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(f.path, f.content.endsWith('\n') ? f.content : f.content + '\n');
  }

  console.log(`done. ${files.length} files extracted.`);
}

// --- Exports for testing ---

export { pack, parseArchive, list, apply, eofMarker };

// --- Run ---

if (isMain) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`slurp - self-extracting shell archives

Usage:
  slurp pack <file...> [options]    Pack files into a .slurp.sh archive
  slurp list <archive>              List files in a slurp archive
  slurp apply <archive>             Extract files from a slurp archive

Pack options:
  -o, --output <path>       Output file (default: stdout)
  -n, --name <name>         Archive name
  -d, --description <desc>  Description
  -s, --sentinel <file>     Sentinel file for safety check
`);
    process.exit(0);
  }

  switch (command) {
    case 'pack': {
      const { files, opts } = parsePackArgs(args.slice(1));
      if (files.length === 0) {
        console.error('error: no files specified');
        process.exit(1);
      }
      const output = pack(files, opts);
      if (opts.output) {
        fs.writeFileSync(opts.output, output);
        console.error(`wrote ${opts.output}`);
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
    case 'apply': {
      const archive = args[1];
      if (!archive) { console.error('error: no archive specified'); process.exit(1); }
      apply(archive);
      break;
    }
    default:
      console.error(`unknown command: ${command}`);
      process.exit(1);
  }
}
