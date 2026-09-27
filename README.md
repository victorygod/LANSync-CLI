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
- **Cross-platform**: Handles path separator differences (Windows/macOS/Linux)
- **Chinese path support**: Full support for Chinese and special characters in filenames

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
