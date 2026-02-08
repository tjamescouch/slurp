# slurp

Pure data archives with embedded OWL spec. Pack files into a single `.slurp` bundle that's human-readable, LLM-friendly, and self-documenting.

Archives are not executable — they're data files with an embedded natural language format specification. Any tool or agent that reads the spec can extract them.

## Install

```sh
npm install -g slurp
```

Or use directly:

```sh
node slurp.js pack file1.js file2.js -o patch.slurp
```

## Quick Start

```sh
# Pack files into an archive
slurp pack src/app.js src/utils.js -o update.slurp

# Pack a directory
slurp pack src/ -o src-backup.slurp

# Extract via Node.js
slurp apply update.slurp
```

## Commands

| Command | Description |
|---------|-------------|
| `slurp pack <files/dirs...>` | Create a `.slurp` archive |
| `slurp list <archive>` | List files in an archive |
| `slurp info <archive>` | Show archive metadata |
| `slurp apply <archive>` | Extract files (Node.js) |
| `slurp verify <archive>` | Verify SHA-256 checksums |

## Pack Options

```
-o, --output <path>       Output file (default: stdout)
-n, --name <name>         Archive name
-d, --description <desc>  Description
-z, --compress            Compress archive (v2 gzip+base64)
-e, --encrypt             Encrypt archive (v3 AES-256-GCM)
-x, --exclude <glob>      Exclude files matching glob (repeatable)
-b, --base-dir <dir>      Base directory for relative paths
--no-checksum             Skip SHA-256 checksums
```

## Archive Formats

### v4 (default) — Pure data

Human-readable delimited file blocks. No shell commands, no shebang — just data with an embedded format spec.

```
# --- SLURP v4 ---
# <embedded OWL spec describing the format>
#
# name: my-patch
# files: 2
# MANIFEST:
#   src/app.js    1.2 KB  sha256:abcdef...
#   logo.png      4.5 KB  sha256:fedcba...  [binary]

=== src/app.js ===
console.log("hello");
=== END src/app.js ===

=== logo.png [binary] ===
iVBORw0KGgo...
=== END logo.png ===
```

### v2 (`-z`) — Compressed

gzip + base64 wrapper around a v4 archive. Use for larger archives where size matters.

```sh
slurp pack -z src/ -o bundle.slurp
```

### v3 (`-e`) — Encrypted

AES-256-GCM encrypted wrapper around a v4 archive.

```sh
slurp pack -e -p secret src/ -o secure.slurp
```

## Features

- **Pure data** — archives are not executable scripts; they're self-documenting data bundles
- **Human-readable** — v4 archives use simple `=== path ===` delimiters you can read and edit
- **LLM-friendly** — embedded OWL spec means any agent can understand and generate archives
- **Binary support** — images, fonts, etc. via inline base64 with `[binary]` tags
- **Integrity checking** — per-file SHA-256 checksums in the MANIFEST
- **Zero dependencies** — Node.js stdlib only
- **Directory walking** — recursive with glob exclusion patterns
- **Backward compatible** — still reads v1/v2/v3 archives from older versions

## Defaults

- `.git/` and `node_modules/` are excluded automatically
- Output extension is `.slurp` by default

## Testing

```sh
node --test slurp.test.js
```

## License

MIT
