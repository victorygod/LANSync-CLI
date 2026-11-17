# lansync

A minimal LAN file sync tool with optional remote command execution.

## Features

- Simple CLI interface
- Push/pull files between machines on the same LAN
- Support for `.gitignore` patterns
- Safe file operations with path traversal protection
- Content-based sync with MD5 hash verification
- `diff` command: read-only inventory comparison between local and server
  (which files are modified / only on one side), with JSON output and
  sync-state exit codes for scripts
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

- Node.js 20 or >=22
- npm

## Installation

### Install from this checkout (macOS, Linux, or Git Bash on Windows)

```bash
./setup.sh
```

Setup installs the `lansync` command into the npm global prefix and copies the application to `~/.lansync/app`. The default port is 8001. Existing `lansync` client and server settings live in `~/.lansync`. Restart a running server to load the updated code. If you used the separate `lansyncopt` trial, configure the production client and server with `lansync` when switching.

See [file selection and directory handling](docs/sync-scope-design.md).

### Manual Install

```bash
npm install
npm link
```

## Upgrading

Use the one-click upgrade script from the machine that holds the new checkout:

```bash
node scripts/upgrade.js
```

- It uses `lansyncopt` (last known good) as the control channel.
- It pushes this checkout, runs the remote tests, and canaries the new code on
  a spare port before touching production.
- It preserves the existing `server.json` token/root/port when switching
  `lansync`, verifies the installed versions, and rolls back automatically on
  failure.
- It updates both `lansyncopt` installs and leaves the remote control daemon
  running (use `--stop-control` or `node scripts/upgrade.js stop-control` to
  stop it explicitly, without deleting its token/config).

The repo version must be newer than the running `lansync`. Bump it in the same
command:

```bash
node scripts/upgrade.js --bump=patch --yes
```

Check prerequisites or preview the steps without changing services:

```bash
node scripts/upgrade.js doctor
node scripts/upgrade.js plan
```

lansync copies working-tree files only (`.git` is ignored). The upgrade does
not commit anything: commit separately on each machine. The remote commit is
independent from the local one, and git history is never transferred.

If the command exits non-zero, give your agent:

```text
~/.lansync-upgrade/report.json
```

See the [upgrade runbook](docs/upgrade-runbook.md) for exit codes, artifacts,
and rollback.

## Uninstallation

```bash
lansync server stop
npm unlink -g lansync
# Optional: remove installed files and saved settings
rm -rf ~/.lansync
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
lansync pull [path ...]

# Push files to server
lansync push [path ...]

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

lansync syncs working-tree files only; `.git` is ignored. Commit locally
before syncing, and commit on the far side after a push. The two commits are
independent and git history is never transferred.

Small API calls time out after 10s. File listings and transfers default to a
300s budget (large trees can take >10s to walk and hash); override them with
`LANSNC_LIST_TIMEOUT_MS` and `LANSNC_TRANSFER_TIMEOUT_MS`.

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
lansync push README.md src/

# Pattern only affects matched files - others are left untouched
# When pattern is specified, files outside the pattern are NOT deleted
```

## Sync Algorithm

Each push, pull, or diff computes an MD5 digest for every non-ignored file under the current directory on both machines. For paths present on both sides, matching digests mean the file is in sync. Different digests trigger an upload or download in the chosen direction. Size and modification time are reported as metadata.

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

If any file transfer fails, push and pull skip all planned deletions for that run. Run the command again to compare fresh inventories and retry.
