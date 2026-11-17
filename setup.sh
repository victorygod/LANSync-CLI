#!/bin/bash
# Install the CLI from this checkout.
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")"
node -e 'const major = +process.versions.node.split(".")[0]; if (typeof require("node:util").parseArgs !== "function" || major < 20 || major === 21) throw Error("Node.js 20 or >=22 required"); const p = require("./package.json"); if (p.name !== "lansync" || Object.keys(p.bin).join() !== "lansync") throw Error("Expected lansync package and binary")'
install_dir="${LANSYNC_INSTALL_DIR:-$HOME/.lansync}/app"
mkdir -p "$install_dir"
cp -R bin src package.json package-lock.json "$install_dir/"
cd "$install_dir"
npm ci --omit=dev --no-audit --no-fund
npm link --offline --no-audit --no-fund
echo "Installed lansync. Run lansync --help."
