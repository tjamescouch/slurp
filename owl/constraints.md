# constraints

## security

- never write files outside the target base directory. validate every path from an archive with `safePath` before writing.
- reject absolute paths in archive entries.
- reject paths containing `..` components that resolve outside the base directory.
- never execute archive contents as shell commands or code. archives are data, not scripts.
- derive encryption keys with PBKDF2 using 100000 iterations and sha256. never use raw passwords as keys.
- use AES-256-GCM for authenticated encryption. never use unauthenticated cipher modes.
- generate a fresh random salt (16 bytes) and iv (12 bytes) for every encryption operation.
- verify sha256 checksums before attempting decompression or decryption.

## format

- v4 is the default output format. v1 is never produced, only parsed for backward compatibility.
- the first line of a v4 archive is `# --- SLURP v4 ---`. no shebang, no shell preamble.
- embed the format specification (PROMPT.md) as `#`-prefixed comment lines at the top of every v4 archive.
- use `=== path ===` and `=== END path ===` as file block delimiters. never use heredoc syntax in output.
- tag binary files with `[binary]` in both the delimiter line and the manifest entry.
- encode binary file content as base64, wrapped at 76 characters per line.
- store text file content verbatim. strip one trailing newline during packing; restore it during extraction.
- separate file blocks with a blank line.
- include a manifest block listing every file with human-readable size and truncated sha256 (first 16 hex chars).

## compatibility

- parse v1 archives (shell heredoc format) for backward compatibility.
- parse old-style v2 compressed archives that use `base64 -d << 'SLURP_COMPRESSED' | gunzip | sh` markers.
- parse old-style v3 encrypted archives that use `SLURP_PAYLOAD=$(base64 -d << 'SLURP_ENCRYPTED'` markers.
- accept both `{fullPath, relPath}` objects and bare path strings as input to the packer.

## technology

- implement as a single ESM module (`slurp.js`) with no external dependencies.
- use only node.js standard library: `fs`, `path`, `zlib`, `crypto`, `url`, `child_process`.
- target node.js 18, 20, and 22. run ci on all three versions.
- use `node:test` and `node:assert` for the test suite. no test framework dependencies.
- license under MIT.

## defaults

- always exclude `.git/` and `node_modules/` when packing directories.
- default archive name is `archive` when none is specified.
- default output is stdout when no `-o` flag is given.
- status and error messages go to stderr; archive data goes to stdout.
