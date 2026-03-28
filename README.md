# LANSync-CLI

A minimal LAN file sync tool.

## Features

- Simple CLI interface
- Push/pull files between machines on the same LAN
- Support for `.gitignore` patterns
- Safe file operations with path traversal protection
- Content-based sync with MD5 hash verification

## Requirements

- Node.js >= 18.0.0
- npm

## Installation

### Quick Install (macOS / Linux)

```bash
git clone https://github.com/wolf4ood/lansync.git
cd lansync
./setup.sh
```

This installs lansync to `~/.lansync` and creates a global `lansync` command.

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
# Start sync server (default port 8001)
lansync server start

# Stop server
lansync server stop

# Check server status
lansync server status
```

### Client

```bash
# Configure server address
lansync client config <ip:port>

# Pull files from server
lansync pull [pattern]

# Push files to server
lansync push [pattern]

# Pull without deleting local files
lansync pull --no-delete

# Push without deleting remote files
lansync push --no-delete
```

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

## Features

- **Automatic retry**: Network errors trigger up to 2 retries with exponential backoff
- **Fault tolerance**: Failed files are skipped; sync continues with remaining files
- **Error summary**: Failed files are listed at the end with error details
- **Cross-platform**: Handles path separator differences (Windows/macOS/Linux)
- **Chinese path support**: Full support for Chinese and special characters in filenames

## Examples

```bash
# On machine A (server)
lansync server start
# Server running at http://192.168.1.100:8001

# On machine B (client)
lansync client config 192.168.1.100:8001
lansync pull              # Sync all files
lansync pull "src/**"     # Sync only src directory
lansync push              # Push local changes to server
```

## License

MIT