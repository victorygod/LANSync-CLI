#!/bin/bash

# lansyncopt setup script for macOS / Linux
# Installs lansyncopt to ~/.lansyncopt and creates a global command
# (isolated from the existing lansync install at ~/.lansync)

set -e

MIN_NODE_VERSION=18
INSTALL_DIR="$HOME/.lansyncopt"
REPO_URL="https://github.com/wolf4ood/lansync.git"

echo "=== lansyncopt Setup ==="
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
    # Running from source directory - copy to install location first
    echo "Installing from source directory..."
    SOURCE_DIR="$SCRIPT_DIR"
else
    # Clone from GitHub
    echo "Cloning lansyncopt from GitHub..."
    SOURCE_DIR="$INSTALL_DIR"
fi

# Always install to ~/.lansyncopt for consistency
if [ -d "$INSTALL_DIR" ]; then
    echo "Removing existing installation..."
    rm -rf "$INSTALL_DIR"
fi

# Copy files to install directory
if [ "$SOURCE_DIR" = "$INSTALL_DIR" ]; then
    # Cloning case
    git clone "$REPO_URL" "$INSTALL_DIR"
else
    # Copy from source directory
    echo "Copying to $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR"
    cp -r "$SOURCE_DIR"/* "$INSTALL_DIR/"
fi

# Install dependencies in the install directory
echo "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --silent

# Link globally from the install directory
echo "Linking command..."
npm link --silent

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installed to: $INSTALL_DIR"
echo ""
echo "Usage:"
echo "  lansyncopt --help"
echo "  lansyncopt server start"
echo "  lansyncopt client config <ip:port>"
echo "  lansyncopt pull"
echo "  lansyncopt push"
echo ""
echo "To uninstall:"
echo "  rm -rf $INSTALL_DIR"
echo "  npm unlink -g lansyncopt"