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
# target: <expected repo or directory>
# files: <count>
# created: <ISO 8601 timestamp>
#
# changes:
#   path/to/file   - short description

set -e

# optional safety check (ensures correct working directory)
if [ ! -f "<sentinel>" ]; then
  echo "error: expected <sentinel> in current directory" >&2
  exit 1
fi

echo "applying <name>..."

cat > 'path/to/file' << 'SLURP_END_path_to_file'
<file contents verbatim>
SLURP_END_path_to_file

echo "done. N files extracted."
```

## rules

- shebang is always `#!/bin/sh` (POSIX, not bash)
- `set -e` to halt on first error
- each file is a quoted heredoc: `<< 'MARKER'` (single-quoted to prevent expansion)
- EOF markers are deterministic: `SLURP_END_` + path with `/` and `.` replaced by `_`
- parent directories are created with `mkdir -p` before `cat >` when paths contain `/`
- the prompt block (this text) is embedded as `#`-prefixed comments at the top
- metadata fields (name, description, target, files, created) follow the prompt

## generating by hand

to create a slurp archive without the CLI tool:

1. start with `#!/bin/sh` and the comment prompt block
2. add metadata as `# key: value` comments
3. add `set -e`
4. for each file: `mkdir -p '<dir>'` (if nested), then `cat > '<path>' << 'SLURP_END_<marker>'`
5. end with an echo summarizing what was extracted

## applying

```sh
cd <target-directory>
sh archive.slurp.sh
```

or use the slurp CLI: `slurp apply archive.slurp.sh`
