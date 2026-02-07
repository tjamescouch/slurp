# slurp

Self-extracting POSIX shell archives. Pack files into a single script that recreates them when run with `sh`.

Archives are human-readable, LLM-generatable, and work anywhere with a POSIX shell.

## Install

```sh
npm install -g slurp
```

Or use directly:

```sh
node slurp.js pack file1.js file2.js -o patch.slurp.sh
```

## Quick Start

```sh
# Pack files into an archive
slurp pack src/app.js src/utils.js -o update.slurp.sh

# Pack a directory
slurp pack src/ -o src-backup.slurp.sh

# Apply it anywhere
cd my-project && sh update.slurp.sh

# Or apply via Node.js
slurp apply update.slurp.sh
```

## Commands

| Command | Description |
|---------|-------------|
| `slurp pack <files/dirs...>` | Create a `.slurp.sh` archive |
| `slurp list <archive>` | List files in an archive |
| `slurp info <archive>` | Show archive metadata |
| `slurp apply <archive>` | Extract files (Node.js) |
| `slurp verify <archive>` | Verify SHA-256 checksums |

## Pack Options

```
-o, --output <path>       Output file (default: stdout)
-n, --name <name>         Archive name
-d, --description <desc>  Description
-s, --sentinel <file>     Sentinel file for safety check
-z, --compress            Compress archive (v2 gzip+base64)
-x, --exclude <glob>      Exclude files matching glob (repeatable)
-b, --base-dir <dir>      Base directory for relative paths
--no-checksum             Skip SHA-256 checksums
```

## Archive Formats

### v1 (default) — Plain text

Human-readable heredocs. Text files use `cat >`, binary files use `base64 -d >`. Every file gets a SHA-256 checksum in the MANIFEST header.

```sh
#!/bin/sh
# --- SLURP v1 ---
# name: my-patch
# files: 2
# MANIFEST:
#   src/app.js    1.2 KB  sha256:abcdef...
#   logo.png      4.5 KB  sha256:fedcba...  [binary]

set -e
cat > 'src/app.js' << 'SLURP_END_src_app_js'
console.log("hello");
SLURP_END_src_app_js

base64 -d > 'logo.png' << 'SLURP_END_logo_png'
iVBORw0KGgo...
SLURP_END_logo_png

echo "done. 2 files extracted."
```

### v2 (`-z`) — Compressed

gzip + base64 wrapper around a v1 archive. Still ASCII-safe, still self-extracting. Use for larger archives where size matters.

```sh
slurp pack -z src/ -o bundle.slurp.sh
```

## Features

- **Self-extracting** — `sh archive.slurp.sh` works on any POSIX system
- **Human-readable** — v1 archives are plain text you can read and edit
- **LLM-friendly** — AI agents can generate archives by hand using the embedded PROMPT.md
- **Binary support** — images, fonts, etc. via inline base64
- **Integrity checking** — per-file SHA-256 checksums in the MANIFEST
- **Safety checks** — sentinel file option prevents extraction in wrong directory
- **Zero dependencies** — Node.js stdlib only
- **Directory walking** — recursive with glob exclusion patterns
- **PROMPT.md** — format spec embedded as comments, self-documenting for AI

## Defaults

- `.git/` and `node_modules/` are excluded automatically
- Output extension is your choice (`.slurp.sh`, `.txt`, anything)
- `.gitignore` excludes `*.slurp.sh` by default — add exceptions with `!filename`

## Testing

```sh
node --test slurp.test.js
```

42 tests covering helpers, file collection, packing, compression, parsing, round-trips (shell and Node.js apply), CLI, and directory packing.

## License

MIT
