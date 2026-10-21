# lansync

A minimal LAN file sync tool with optional remote command execution.

> The remote-exec capability was developed on `feature/remote-exec` and briefly
> released under the temporary name `lansyncopt` (separate command and config
> dir `~/.lansyncopt`) so it could run side by side with the older
> file-sync-only `lansync`. It is now merged back under the name `lansync`.
> If you upgrade from a `lansyncopt`-era install, re-run `server start` /
> `client config` — configuration left in `~/.lansyncopt` is not migrated.

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

This installs lansync to `~/.lansync` and creates a global `lansync` command.
Running it over an existing install removes the whole directory first —
including `client.json`/`server.json` — so re-run `client config` after
reinstalling. `~/.lansyncopt` from the temporary release is left untouched.

### Manual Install

```bash
npm install
npm link
```

## Uninstallation

```bash
rm -rf ~/.lansync
npm unlink -g lansync
```

## Usage

### Server

```bash
# Start sync server (default port 8001). Remote exec is ON by default at
# the 'normal' mode (catastrophic blocklist enforced); change it with --exec.
# Prompts for a password; every request must carry the matching token.
lansync server start
lansync server start --exec strict

# Stop server. stop verifies the port afterwards: if an orphan process still
# holds it (lost config / killed half-start), it shows the owner PID and asks
# to kill it interactively; -y kills without asking (agent-safe: non-TTY
# stdin never blocks and defaults to "leave it running")
lansync server stop
lansync server stop -y

# Check server status
lansync server status
```

### Client

```bash
# Configure server address + password (verified against the server; saves token)
lansync client config <ip:port>

# Pull files from server
lansync pull [pattern]

# Push files to server
lansync push [pattern]

# Pull without deleting local files
lansync pull --no-delete

# Push without deleting remote files
lansync push --no-delete

# Check whether local and server are in sync - no transfer, no deletion.
# Prints modified / local-only / server-only files; --json for agents.
# Exit code: 0 = in sync, 1 = differs, 2 = error
lansync diff
lansync diff src
lansync diff --json
```

### Authentication

All `/api/*` endpoints (pull/push/exec alike) require a Bearer token derived
from the shared password (HMAC-SHA256); the token is stored, the password is
not. The password is set on the server at `server start` and must match on the
client at `client config` — which verifies it against the server before saving.
Supply it via `LANSNC_PASSWORD` for non-interactive use.

### Remote command execution

Exec is controlled by the server-side `--exec <mode>` at start. The default
`normal` enables remote execution with the catastrophic blocklist enforced;
values are case-insensitive:

```bash
#   --exec off       remote commands disabled
#   --exec normal    block blacklist, allow graylist (default)
#   --exec strict    block blacklist and graylist
#   --exec all       allow everything

# Run a command on the server (quote the whole command)
lansync exec "git pull"
lansync exec --json "npm test"   # machine-readable output for agents
```

Behavior notes for `exec`:

- Exit code is the remote command's exit code
- If the client is killed (e.g. an agent timeout), the connection drops and the
  server kills the whole remote process group
- Blacklist/graylist hits return an error containing `blocked`
- Every execution is written to the audit log (`~/.lansync/server.log`)
- Commands run via the platform shell (`cmd.exe` on Windows). The server
  switches the console to UTF-8 (`chcp 65001`) before executing, so even
  Windows builtins (`taskkill`, `dir`) emit UTF-8 and never garble over the
  wire

### Pattern Examples

```bash
# Sync a specific file
lansync pull file.txt

# Sync an entire directory (recursive)
lansync pull src

# Sync with glob pattern
lansync pull "src/**/*.js"

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
lansync server start --exec strict
# Server running at http://192.168.1.100:8001

# On machine B (client)
lansync client config 192.168.1.100:8001   # prompts for the same password
lansync pull              # Sync all files
lansync pull "src/**"     # Sync only src directory
lansync push              # Push local changes to server
lansync exec "npm test"   # Run tests on machine A
```

## Design

See [docs/remote-exec-design.md](docs/remote-exec-design.md) for the remote-exec
design (auth model, command policy tiers, disconnect-kill, audit) and
[docs/devlog-remote-exec.md](docs/devlog-remote-exec.md) for the development log.

## License

MIT
