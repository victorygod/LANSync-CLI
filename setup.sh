#!/bin/bash
# Install this checkout's trial CLI alongside lansync.
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")"
node -e 'if (+process.versions.node.split(".")[0] < 18) throw Error("Node.js 18+ required"); const p = require("./package.json"); if (p.name !== "lansyncopt" || Object.keys(p.bin).join() !== "lansyncopt") throw Error("Expected lansyncopt package and binary")'
install_dir="${LANSYNCOPT_INSTALL_DIR:-$HOME/.lansyncopt}/app"
mkdir -p "$install_dir"
cp -R bin src package.json package-lock.json "$install_dir/"
cd "$install_dir"
npm ci --omit=dev --no-audit --no-fund
npm link --offline --no-audit --no-fund
echo "Installed lansyncopt. Run lansyncopt --help."
