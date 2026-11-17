#!/usr/bin/env bash
# Stage this checkout as the isolated lansyncopt trial and install it.
#
# Keeps ~/.lansyncopt configuration and never touches the production lansync
# install. The running daemon keeps using the modules it already loaded; restart
# it separately when you want the new code to serve requests.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
install_root=${LANSYNCOPT_HOME:-$HOME/.lansyncopt}
stage=$(mktemp -d "${TMPDIR:-/tmp}/lansyncopt-stage-XXXXXX")
trap 'rm -rf "$stage"' EXIT

cp -R "$repo_root/bin" "$repo_root/src" "$repo_root/package.json" "$repo_root/package-lock.json" "$repo_root/setup.sh" "$stage/"

version=$(cd "$stage" && node -p "require('./package.json').version")
version="${version}-opt"

node - "$stage" "$version" <<'NODE'
const fs = require('fs');
const path = require('path');
const [dir, version] = process.argv.slice(2);

const pkgPath = path.join(dir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.name = 'lansyncopt';
pkg.version = version;
pkg.bin = { lansyncopt: './bin/lansync.js' };
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const lockPath = path.join(dir, 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
lock.name = 'lansyncopt';
lock.version = version;
lock.packages[''].name = 'lansyncopt';
lock.packages[''].version = version;
lock.packages[''].bin = { lansyncopt: 'bin/lansync.js' };
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

// The trial keeps its own config dir so it can run beside lansync.
const cfgPath = path.join(dir, 'src', 'config.js');
let cfg = fs.readFileSync(cfgPath, 'utf8');
cfg = cfg.replace("path.join(os.homedir(), '.lansync')", "path.join(os.homedir(), '.lansyncopt')");
fs.writeFileSync(cfgPath, cfg);

const setupPath = path.join(dir, 'setup.sh');
let setup = fs.readFileSync(setupPath, 'utf8');
setup = setup.replaceAll('!== "lansync"', '!== "lansyncopt"');
fs.writeFileSync(setupPath, setup);
NODE

LANSYNC_INSTALL_DIR="$install_root" bash "$stage/setup.sh"