# slurp v4 archive format

a slurp archive is a pure data file that bundles multiple files into a single
human-readable, LLM-friendly package. archives are not executable — they are
self-documenting data bundles with an embedded format specification.

## structure

```
# --- SLURP v4 ---
#
# <this spec, embedded as comments>
#
# name: <archive-name>
# description: <what this contains>
# files: <count>
# total: <human-readable size>
# created: <ISO 8601 timestamp>
#
# MANIFEST:
#   path/to/file       1.2 KB  sha256:abcdef0123456789
#   other/file           512 B  sha256:23456789abcdef01
#   image.png          4.5 KB  sha256:fedcba9876543210  [binary]

=== path/to/file ===
<file contents verbatim, with original line endings>
=== END path/to/file ===

=== other/file ===
<file contents verbatim>
=== END other/file ===

=== image.png [binary] ===
<base64-encoded content, wrapped at 76 characters per line>
=== END image.png ===
```

## rules

- first line is always `# --- SLURP v4 ---`
- no shebang, no shell commands — this is a data format, not a script
- the spec block (this text) is embedded as `#`-prefixed comments at the top
- metadata fields (name, description, files, total, created) are `# key: value` comments
- the MANIFEST block lists each file with size, truncated sha256, and [binary] tag
- text file delimiters: `=== <path> ===` to start, `=== END <path> ===` to end
- binary file delimiters: `=== <path> [binary] ===` to start, `=== END <path> ===` to end
- text file content is stored verbatim between delimiters (no trailing newline added)
- binary file content is base64-encoded between delimiters, wrapped at 76 chars
- a blank line separates each file block for readability

## extracting

to extract a slurp archive, parse the `=== <path> ===` / `=== END <path> ===`
delimiters and write each file's content to its path. for `[binary]` files,
base64-decode the content first. create parent directories as needed.

use the slurp CLI: `slurp apply archive.slurp`

## generating by hand

to create a slurp archive without the CLI tool:

1. start with `# --- SLURP v4 ---` and the comment spec block
2. add metadata as `# key: value` comments
3. add a MANIFEST block listing files with sizes and checksums
4. for each file: `=== path ===`, content, `=== END path ===`
5. for binary files: `=== path [binary] ===`, base64 content, `=== END path ===`

## compressed format (v2)

a compressed slurp wraps a v4 archive in gzip + base64. use `slurp pack -z`.

```
# --- SLURP v2 (compressed) ---
#
# This is a compressed slurp archive.
# The payload is a gzip-compressed, base64-encoded slurp v4 archive.
#
# name: <archive-name>
# original: <bytes> bytes
# compressed: <bytes> bytes
# ratio: <percent>%
# sha256: <hex digest of gzipped payload>

--- PAYLOAD ---
<base64 lines, wrapped at 76 chars>
--- END PAYLOAD ---
```

## encrypted format (v3)

an encrypted slurp wraps a v4 archive in AES-256-GCM. use `slurp pack -e`.

```
# --- SLURP v3 (encrypted) ---
#
# This is an encrypted slurp archive.
# The payload is AES-256-GCM encrypted (PBKDF2 key derivation).
# Use: slurp decrypt <archive> to decrypt.
#
# name: <archive-name>
# original: <bytes> bytes
# encrypted: <bytes> bytes
# sha256: <hex digest of encrypted payload>
# iterations: 100000

--- PAYLOAD ---
<base64 lines, wrapped at 76 chars>
--- END PAYLOAD ---
```
