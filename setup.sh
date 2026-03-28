#!/bin/bash

# lansync setup script for macOS / Linux
# Installs lansync to ~/.lansync and creates a global command

set -e

MIN_NODE_VERSION=18
INSTALL_DIR="$HOME/.lansync"
REPO_URL="https://github.com/wolf4ood/lansync.git"

echo "=== lansync Setup ==="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed."
    echo ""
    echo "Please install Node.js $MIN_NODE_VERSION or higher:"
    echo "  - Using nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash && nvm install $MIN_NODE_VERSION"
    echo "  - Using Homebrew (macOS): brew install node"
    echo "  - Download from: https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | sed 's/v//' | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt "$MIN_NODE_VERSION" ]; then
    echo "Error: Node.js version is too old (current: $(node -v))."
    echo "Please upgrade to Node.js $MIN_NODE_VERSION or higher."
    exit 1
fi

echo "Node.js version: $(node -v) ✓"
echo ""

# Determine source directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if running from git repo or need to clone
if [ -f "$SCRIPT_DIR/package.json" ]; then
    # Running from source directory
    echo "Installing from source directory..."
    SOURCE_DIR="$SCRIPT_DIR"
else
    # Clone from GitHub
    echo "Cloning lansync from GitHub..."
    if [ -d "$INSTALL_DIR" ]; then
        echo "Removing existing installation..."
        rm -rf "$INSTALL_DIR"
    fi
    git clone "$REPO_URL" "$INSTALL_DIR"
    SOURCE_DIR="$INSTALL_DIR"
fi

# Install dependencies
echo "Installing dependencies..."
cd "$SOURCE_DIR"
npm install --silent

# Link globally
echo "Linking command..."
npm link --silent

# If not already installed to ~/.lansync, copy there for persistence
if [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then
    echo "Copying to $INSTALL_DIR for persistence..."
    mkdir -p "$INSTALL_DIR"
    cp -r "$SOURCE_DIR"/* "$INSTALL_DIR/"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installed to: $INSTALL_DIR"
echo ""
echo "Usage:"
echo "  lansync --help"
echo "  lansync server start"
echo "  lansync client config <ip:port>"
echo "  lansync pull"
echo "  lansync push"
echo ""
echo "To uninstall:"
echo "  rm -rf $INSTALL_DIR"
echo "  npm unlink -g lansync"