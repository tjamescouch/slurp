# components

## archive

the archive is the `.slurp` data format itself. it exists in three variants: v4 (plaintext), v2 (compressed), and v3 (encrypted). a legacy v1 format is supported for reading only.

### state

- format version (v1, v2, v3, or v4)
- metadata: name, description, file count, total size, creation timestamp
- manifest: list of file entries with path, human-readable size, truncated sha256 checksum, and binary flag
- file blocks: ordered sequence of file contents with start/end delimiters
- embedded spec: the format specification reproduced as comment lines in the header

### capabilities

- self-documenting: any reader can parse the archive by following the embedded spec
- human-readable: v4 archives use plain text delimiters (`=== path ===` / `=== END path ===`) that a person can read and edit
- integrity-verifiable: each file in the manifest carries a sha256 checksum prefix

### interfaces

- v4 text format: `# --- SLURP v4 ---` header, `# key: value` metadata, `# MANIFEST:` block, `=== path ===` file delimiters
- v2 compressed format: `# --- SLURP v2 (compressed) ---` header, `--- PAYLOAD ---` / `--- END PAYLOAD ---` delimiters around gzip+base64 content
- v3 encrypted format: `# --- SLURP v3 (encrypted) ---` header, `--- PAYLOAD ---` / `--- END PAYLOAD ---` delimiters around AES-256-GCM encrypted content
- v1 legacy format: `#!/bin/sh` shebang, `set -e`, heredoc-style file blocks (`cat > 'path' << 'MARKER'`)

### invariants

- the first line of a v4 archive is always `# --- SLURP v4 ---`
- v4 archives contain no shebang, no shell commands, and no executable instructions
- text file content is stored verbatim between delimiters with no trailing newline added
- binary file content is base64-encoded between delimiters, wrapped at 76 characters per line
- binary files are tagged with `[binary]` in both the manifest and the file delimiter
- a blank line separates each file block

---

## packer

the packer reads source files and produces an archive string.

### state

- list of file entries (path, content buffer, binary flag, size, checksum)
- archive options: name, description, noChecksum flag

### capabilities

- reads files from disk given absolute paths or {fullPath, relPath} objects
- detects binary files by scanning for null bytes in the first 8192 bytes
- computes sha256 checksums for each file
- loads and embeds the PROMPT.md spec as comment-prefixed lines
- produces a complete v4 archive string

### interfaces

- `pack(fileList, opts)` accepts a list of file paths or objects and returns a v4 archive string
- options: `name`, `description`, `noChecksum`

### invariants

- every file entry has a manifest line with size and (unless noChecksum) a truncated sha256
- the output always starts with `# --- SLURP v4 ---`

---

## parser

the parser converts archive content from any supported format into a uniform structure.

### state

- parsed metadata object (name, description, files, total, created)
- parsed checksums map (path to truncated sha256)
- parsed file entries array (path, binary flag, content as string or buffer)

### capabilities

- detects archive format (v1, v4, v2 compressed, v3 encrypted) from the first line
- parses v4 archives by scanning for `=== path ===` / `=== END path ===` delimiters
- parses v1 archives by scanning for `cat > 'path' << 'MARKER'` heredoc patterns
- transparently decompresses v2 and decrypts v3 before parsing the inner archive
- decodes base64 content for binary file entries

### interfaces

- `parseArchive(archivePath, opts)` reads a file from disk and returns `{metadata, checksums, files}`
- `parseContent(content)` accepts a raw archive string and returns the same structure
- `parseContentV4(content)` handles v4 format specifically
- `parseContentV1(content)` handles v1 format specifically

### invariants

- the output structure always has `metadata`, `checksums`, and `files` fields regardless of input format
- binary file entries have `content` as a Buffer; text file entries have `content` as a string
- encrypted archives require a password in opts or parsing throws

---

## extractor

the extractor writes parsed file entries to the filesystem.

### state

- target base directory (cwd for apply, staging dir for unpack)
- list of parsed file entries to write

### capabilities

- writes text files with a trailing newline appended if not already present
- writes binary files from their buffer content directly
- creates parent directories as needed
- validates all file paths against the base directory before writing (path traversal protection)

### interfaces

- `apply(archivePath)` extracts files to the current working directory
- `unpack(archivePathOrContent, opts)` extracts files to a staging directory and returns the staging path
- `create(stagingDir, destDir)` copies all files from a staging directory to a destination
- `verify(archivePath)` checks extracted files against archive contents

### invariants

- no file is ever written outside the target base directory
- absolute paths in archives are rejected
- paths containing `..` components that escape the base directory are rejected
- staging directories follow the naming pattern `<name>.<random-hex>.unslurp`

---

## compressor

the compressor handles v2 gzip+base64 wrapping and unwrapping.

### state

- inner archive content (a v4 or v1 archive string)
- compressed payload (gzip buffer, base64-encoded)
- sha256 checksum of the gzipped payload

### capabilities

- compresses a v4 archive into a v2 wrapper with metadata header and base64 payload
- decompresses a v2 archive back to its inner content
- verifies the sha256 checksum on decompression
- detects v2 format from the header line

### interfaces

- `compress(innerArchive, opts)` returns a v2 archive string
- `decompress(content)` returns the inner archive string
- `isCompressed(content)` returns true if the content is a v2 archive

### invariants

- the v2 header includes original size, compressed size, compression ratio, and sha256
- checksum verification fails loudly on tampered payloads
- supports both new-style (`--- PAYLOAD ---`) and old-style (`base64 -d << 'SLURP_COMPRESSED'`) payload markers for backward compatibility

---

## encryptor

the encryptor handles v3 AES-256-GCM encryption and decryption.

### state

- inner archive content
- password
- derived key (via PBKDF2 with random salt)
- initialization vector, auth tag, ciphertext

### capabilities

- encrypts a v4 archive: compresses with gzip, encrypts with AES-256-GCM, wraps in base64
- decrypts a v3 archive given the correct password
- derives encryption keys from passwords using PBKDF2 (100000 iterations, sha256)
- verifies sha256 checksum of the encrypted payload before attempting decryption
- provides raw encrypt/decrypt primitives for arbitrary binary data (pipe-friendly)

### interfaces

- `encrypt(innerArchive, password, opts)` returns a v3 archive string
- `decrypt(content, password)` returns the inner archive string
- `isEncrypted(content)` returns true if the content is a v3 archive
- `encryptRaw(inputBuffer, password)` encrypts arbitrary binary data, returns a buffer
- `decryptRaw(inputBuffer, password)` decrypts arbitrary binary data, returns a buffer

### invariants

- each encryption produces unique ciphertext due to random salt and iv
- wrong password produces a clear error message, not garbled output
- the encrypted payload layout is: salt(16 bytes) + iv(12 bytes) + authTag(16 bytes) + ciphertext
- supports both new-style and old-style v3 payload markers for backward compatibility

---

## file-collector

the file collector recursively walks directories and produces a normalized file list.

### state

- target path (file or directory)
- base directory for computing relative paths
- list of exclusion patterns (compiled globs)

### capabilities

- walks directories recursively, following the filesystem tree
- computes relative paths from the base directory
- applies glob exclusion patterns to both the relative path and the bare filename
- handles single files as well as directories

### interfaces

- `collectFiles(target, baseDir, excludePatterns)` returns an array of `{fullPath, relPath}` objects

### invariants

- `.git/` and `node_modules/` are always excluded by the cli layer
- symbolic links are followed and treated as regular files
- directories themselves are never included, only their contained files

---

## cli

the cli is the command-line interface that dispatches user commands.

### state

- parsed command name
- parsed flags and positional arguments
- collected file list (for pack)

### capabilities

- dispatches subcommands: pack, list, info, apply, unpack, create, verify, encrypt, decrypt, enc, dec
- parses flags: -o (output), -n (name), -d (description), -z (compress), -e (encrypt), -p (password), -x (exclude), -b (base-dir), --no-checksum
- reads password from -p flag or SLURP_PASSWORD environment variable
- reads archive content from stdin when `-` is specified
- writes output to file (-o) or stdout
- deduplicates and sorts collected files before packing
- prints help text on --help, -h, or no arguments

### interfaces

- invoked as `slurp <command> [options] [args...]`
- exit code 0 on success, 1 on error
- status messages go to stderr; data output goes to stdout

### invariants

- the cli never executes archive contents as code
- missing required arguments produce an error and nonzero exit code
- the cli is only active when the module is run directly (not when imported)
