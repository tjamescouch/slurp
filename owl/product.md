# slurp

slurp is a pure-data archive tool that packs files into a single human-readable, LLM-friendly `.slurp` bundle with an embedded format specification.

## components

- [archive](components.md#archive)
- [packer](components.md#packer)
- [parser](components.md#parser)
- [extractor](components.md#extractor)
- [compressor](components.md#compressor)
- [encryptor](components.md#encryptor)
- [file-collector](components.md#file-collector)
- [cli](components.md#cli)

## behaviors

- the packer reads files from disk, encodes binary files as base64, and emits a v4 archive string with header, manifest, and delimited file blocks.
- the parser accepts archive content in any supported format (v1, v4, v2 compressed, v3 encrypted) and produces a uniform structure of metadata and file entries.
- the extractor writes parsed file entries to the filesystem, creating directories as needed.
- the compressor wraps a v4 archive in gzip + base64 to produce a v2 archive, and reverses the process on decompression.
- the encryptor wraps a v4 archive in AES-256-GCM encryption to produce a v3 archive, and reverses the process on decryption given the correct password.
- the file collector recursively walks directories, applies glob exclusion patterns, and produces a list of file entries with relative paths.
- the cli dispatches subcommands (pack, list, info, apply, unpack, create, verify, encrypt, decrypt, enc, dec) and parses flags.
- archives embed the format specification (PROMPT.md) as comment lines so any reader or agent can understand the format without external documentation.

## constraints

- [constraints](constraints.md)
