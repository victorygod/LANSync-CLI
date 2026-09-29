# lansyncopt

A minimal LAN file sync tool with optional remote command execution.

> This is the `feature/remote-exec` branch of [lansync](https://github.com/wolf4ood/lansync),
> published temporarily under the name `lansyncopt` so it can run side by side with an
> existing `lansync` install (separate command, config dir, and server state).

## Features

- Simple CLI interface
- Push/pull files between machines on the same LAN
- Support for `.gitignore` patterns
- Safe file operations with path traversal protection
- Content-based sync with MD5 hash verification
- `diff` command: read-only inventory comparison between local and server
  (which files are modified / only on one side), with JSON output and
  sync-state exit codes, so agents can script `diff && push`
- Windows ↔ macOS/Linux safe: canonical forward-slash paths on the wire, so
  nested directories, patterns, and Unicode filenames survive sync in both
  directions
- Git-style directory semantics: directories are not tracked, and after push
  deletes the last file of a directory, the empty directory shell is pruned
  server-side (never the sync root; directories still containing ignored
  files such as `.DS_Store` are left alone)
- Remote command execution with token auth, black/gray command policy,
  disconnect-kill, concurrency limit, and audit logging

## Requirements

- Node.js >= 18.0.0
- npm

## Installation

### Quick Install (macOS / Linux)

```bash
./setup.sh
```

This installs lansyncopt to `~/.lansyncopt` and creates a global `lansyncopt` command.
It does **not** touch an existing lansync install (`~/.lansync`, `lansync` command).

### Manual Install

```bash
npm install
npm link
```

## Uninstallation

```bash
rm -rf ~/.lansyncopt
npm unlink -g lansyncopt
```

## Usage

### Server

```bash
# Start sync server (default port 8001, default policy exec-forbidden).
# Prompts for a password; every request must carry the matching token.
lansyncopt server start
lansyncopt server start --policy exec-block-black

# Stop server
lansyncopt server stop

# Check server status
lansyncopt server status
```

### Client

```bash
# Configure server address + password (verified against the server; saves token)
lansyncopt client config <ip:port>

# Pull files from server
lansyncopt pull [pattern]

# Push files to server
lansyncopt push [pattern]

# Pull without deleting local files
lansyncopt pull --no-delete

# Push without deleting remote files
lansyncopt push --no-delete

# Check whether local and server are in sync - no transfer, no deletion.
# Prints modified / local-only / server-only files; --json for agents.
# Exit code: 0 = in sync, 1 = differs, 2 = error
lansyncopt diff
lansyncopt diff src
lansyncopt diff --json
```

### Authentication

All `/api/*` endpoints (pull/push/exec alike) require a Bearer token derived
from the shared password (HMAC-SHA256); the token is stored, the password is
not. The password is set on the server at `server start` and must match on the
client at `client config` — which verifies it against the server before saving.
Supply it via `LANSNC_PASSWORD` for non-interactive use.

### Remote command execution

Exec is controlled by the server-side `--policy` at start; the default
`exec-forbidden` keeps remote commands off until you opt in:

```bash
#   --policy exec-forbidden        remote commands disabled (default)
#   --policy exec-all-allow        allow everything
#   --policy exec-block-black      block blacklist, allow graylist
#   --policy exec-block-black-gray block blacklist and graylist

# Run a command on the server (quote the whole command)
lansyncopt exec "git pull"
lansyncopt exec --json "npm test"   # machine-readable output for agents
```

Behavior notes for `exec`:

- Exit code is the remote command's exit code
- If the client is killed (e.g. an agent timeout), the connection drops and the
  server kills the whole remote process group
- Blacklist/graylist hits return an error containing `blocked`
- Every execution is written to the audit log (`~/.lansyncopt/server.log`)
- Commands run via the platform shell (`cmd.exe` on Windows). Windows builtins
  (`ver`, `dir` errors) print in the OEM code page (GBK on Chinese Windows),
  so their output may look garbled; Git-for-Windows tools (`ls`, `md5sum`,
  `uname`) speak UTF-8 and display correctly.

### Pattern Examples

```bash
# Sync a specific file
lansyncopt pull file.txt

# Sync an entire directory (recursive)
lansyncopt pull src

# Sync with glob pattern
lansyncopt pull "src/**/*.js"

# Pattern only affects matched files - others are left untouched
# When pattern is specified, files outside the pattern are NOT deleted
```

## Sync Algorithm

1. **Fast path**: If mtime and size match exactly, skip the file
2. **Hash verification**: If mtime differs, compare MD5 hash of content
3. **Smart sync**: Only transfer files with different content

This avoids unnecessary transfers when only timestamps differ.

## Fault Tolerance

- **Automatic retry**: Network errors trigger up to 2 retries with exponential backoff
- **Fault tolerance**: Failed files are skipped; sync continues with remaining files
- **Error summary**: Failed files are listed at the end with error details
- **Cross-platform**: See [Cross-platform behavior](#cross-platform-behavior-windows--macoslinux)
- **Chinese path support**: Full support for Chinese and special characters in filenames

## Cross-platform behavior (Windows ↔ macOS/Linux)

All relative paths on the wire are canonical forward-slash paths: the server
normalizes what it lists (`walkDir`), and the client normalizes everything it
sends and writes (server listings, `pathPrefix`, locally scanned paths).
Every platform combination — Windows server + POSIX client, and the reverse —
behaves identically:

- Nested directories are preserved in both directions; on a POSIX client you
  never get flat files with literal `\` in their names
- `[pattern]` filters match identically regardless of either machine's OS
- Unicode (e.g. Chinese) filenames round-trip correctly — names go over the
  wire as UTF-8 and hit each filesystem via Node's Unicode-aware APIs
- `pull` **refuses to run** when the current directory does not exist on the
  server (`Server has no directory "..."`) instead of treating the server as
  empty — a stalled/path-mismatched pull would otherwise delete all local
  files. `push` has no such restriction: a first push into a directory that
  doesn't exist yet simply creates it.
- Known limitation: a POSIX-side file whose *name* contains a literal `\`
  (legal on Unix) cannot be represented unambiguously on the wire and is
  skipped rather than synced

## Examples

```bash
# On machine A (server)
lansyncopt server start --policy exec-block-black
# Server running at http://192.168.1.100:8001

# On machine B (client)
lansyncopt client config 192.168.1.100:8001   # prompts for the same password
lansyncopt pull              # Sync all files
lansyncopt pull "src/**"     # Sync only src directory
lansyncopt push              # Push local changes to server
lansyncopt exec "npm test"   # Run tests on machine A
```

## Design

See [docs/remote-exec-design.md](docs/remote-exec-design.md) for the remote-exec
design (auth model, command policy tiers, disconnect-kill, audit) and
[docs/devlog-remote-exec.md](docs/devlog-remote-exec.md) for the development log.

## License

MIT
