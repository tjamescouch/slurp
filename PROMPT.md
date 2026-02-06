# slurp format

a slurp file is a self-extracting POSIX shell archive. it bundles multiple files
into a single `.slurp.sh` script that recreates them when run with `sh`.

## structure

```sh
#!/bin/sh
# --- SLURP v1 ---
# <this prompt, embedded as comments>
#
# name: <archive-name>
# description: <what this does>
# files: <count>
# total: <human-readable size>
# created: <ISO 8601 timestamp>
#
# MANIFEST:
#   path/to/file       1.2 KB  sha256:abcdef0123456789
#   other/file           512 B  sha256:23456789abcdef01
#   image.png          4.5 KB  sha256:fedcba9876543210  [binary]
#

set -e

# optional safety check (ensures correct working directory)
if [ ! -f "<sentinel>" ]; then
  echo "error: expected <sentinel> in current directory" >&2
  exit 1
fi

echo "applying <name>..."

# text files use quoted heredocs (no shell expansion)
mkdir -p 'path/to'
cat > 'path/to/file' << 'SLURP_END_path_to_file'
<file contents verbatim>
SLURP_END_path_to_file

# binary files use base64 heredocs
base64 -d > 'image.png' << 'SLURP_END_image_png'
<base64-encoded content, wrapped at 76 chars>
SLURP_END_image_png

echo "done. N files extracted."
```

## rules

- shebang is always `#!/bin/sh` (POSIX, not bash)
- `set -e` to halt on first error
- text files use quoted heredocs: `cat > 'path' << 'MARKER'` (single-quoted to prevent expansion)
- binary files use base64 heredocs: `base64 -d > 'path' << 'MARKER'`
- EOF markers are deterministic: `SLURP_END_` + path with `/` and `.` replaced by `_`
- parent directories are created with `mkdir -p` before `cat >` when paths contain `/`
- the prompt block (this text) is embedded as `#`-prefixed comments at the top
- metadata fields (name, description, files, total, created) follow the prompt
- the MANIFEST block lists each file with size, truncated sha256, and [binary] tag

## generating by hand

to create a slurp archive without the CLI tool:

1. start with `#!/bin/sh` and the comment prompt block
2. add metadata as `# key: value` comments
3. add a MANIFEST block listing files with sizes
4. add `set -e`
5. for each file: `mkdir -p '<dir>'` (if nested), then the appropriate heredoc
6. end with an echo summarizing what was extracted

## compressed format (v2)

a compressed slurp wraps a v1 archive in gzip + base64, producing a text-only
self-extracting script. use `slurp pack -z` to create one.

```sh
#!/bin/sh
# --- SLURP v2 (compressed) ---
#
# This is a compressed slurp archive.
# The payload is a gzip-compressed, base64-encoded slurp v1 archive.
# To decompress manually: base64 -d <<< payload | gunzip
# Or simply run this file: sh archive.slurp.sh
#
# name: <archive-name>
# original: <bytes> bytes
# compressed: <bytes> bytes
# ratio: <percent>%
# sha256: <hex digest of gzipped payload>

base64 -d << 'SLURP_COMPRESSED' | gunzip | sh
<base64 lines, wrapped at 76 chars>
SLURP_COMPRESSED
```

- the inner payload is a complete v1 archive
- `sha256` is the SHA-256 hash of the gzipped (pre-base64) payload for integrity verification
- `list` and `apply` auto-detect v2 and decompress transparently
- POSIX compatible: requires only `base64`, `gunzip`, and `sh`

## applying

```sh
cd <target-directory>
sh archive.slurp.sh
```

or use the slurp CLI: `slurp apply archive.slurp.sh`
