#!/usr/bin/env node
// scripts/upgrade.js
//
// One-click, cross-platform upgrade for lansync.
//
//   node scripts/upgrade.js            # upgrade both ends (default)
//   node scripts/upgrade.js doctor     # read-only prerequisite checks
//   node scripts/upgrade.js plan       # show what would happen
//   node scripts/upgrade.js rollback   # restore the last app.bak-* on both ends
//
// The same file also runs as the remote helper:
//   node scripts/upgrade.js agent status --json
//
// Design rules:
// - lansync      = target channel (being upgraded)
// - lansyncopt   = control channel (last known good)
// - never stop the channel that is currently serving this command
// - the remote helper is uploaded through the control channel before use
// - production is not touched until the canary smoke test passes
// - any failure after the switch restores the backup automatically
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.lansync-upgrade');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const REPORT_JSON = path.join(STATE_DIR, 'report.json');
const REPORT_MD = path.join(STATE_DIR, 'report.md');
const LOG_FILE = path.join(STATE_DIR, 'upgrade.log');

const CHANNELS = {
  lansync: path.join(HOME, '.lansync'),
  lansyncopt: path.join(HOME, '.lansyncopt'),
};

const EXIT = {
  ok: 0,
  preflight: 2,
  control: 3,
  push: 4,
  remoteTests: 5,
  publish: 6,
  canary: 7,
  rollbackFailed: 8,
};

let jsonMode = false;

// ---------- small helpers -------------------------------------------------

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
  if (!jsonMode) console.log(message);
}

function warn(message) {
  log('WARN ' + message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function tail(value, length = 2000) {
  const text = String(value || '');
  return text.length > length ? text.slice(-length) : text;
}

function fail(code, message) {
  const error = new Error(message);
  error.exitCode = code;
  return error;
}

function samePath(a, b) {
  const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function appDir(channel) {
  return path.join(CHANNELS[channel], 'app');
}

function appEntry(channel) {
  return path.join(appDir(channel), 'bin', 'lansync.js');
}

function appVersion(channel) {
  return readJson(path.join(appDir(channel), 'package.json'))?.version ?? null;
}

function serverConfig(channel) {
  return readJson(path.join(CHANNELS[channel], 'server.json'));
}

function clientConfig(channel) {
  return readJson(path.join(CHANNELS[channel], 'client.json'));
}

function publicServerConfig(channel) {
  const cfg = serverConfig(channel);
  if (!cfg) return null;
  return {
    port: cfg.port,
    rootDir: cfg.rootDir,
    pid: cfg.pid,
    policy: cfg.policy,
    ip: cfg.ip,
    hasToken: !!cfg.token,
  };
}

function publicClientConfig(channel) {
  const cfg = clientConfig(channel);
  if (!cfg) return null;
  return { serverUrl: cfg.serverUrl, workDir: cfg.workDir, hasToken: !!cfg.token };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

async function waitPort(port, host, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port, host)) return true;
    await sleep(200);
  }
  return false;
}

async function killPid(pid) {
  if (!pidAlive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if (!pidAlive(pid)) return true;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    if (!pidAlive(pid)) return true;
  }
  return !pidAlive(pid);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function run(command, args, options = {}) {
  const { timeout = 0, ...spawnOptions } = options;
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, ...spawnOptions });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = code => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout?.on('data', data => { stdout += data; });
    child.stderr?.on('data', data => { stderr += data; });
    child.on('error', error => finish(-1));
    child.on('close', code => finish(code ?? -1));
    if (timeout > 0) {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish(-2);
      }, timeout);
      timer.unref();
    }
  });
}

function runNpm(args, cwd, timeout = 180000) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(npm, args, { cwd, timeout, shell: process.platform === 'win32' });
}

// ---------- version helpers ----------------------------------------------

function parseSemver(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function bumpRepoVersion(kind) {
  const index = { major: 0, minor: 1, patch: 2 }[kind];
  if (index === undefined) throw fail(EXIT.preflight, `invalid --bump value: ${kind} (use patch, minor, or major)`);

  const packageFile = path.join(REPO_ROOT, 'package.json');
  const pkg = readJson(packageFile);
  const parts = parseSemver(pkg?.version);
  if (!parts) throw fail(EXIT.preflight, `cannot bump non-semver version: ${pkg?.version}`);

  parts[index]++;
  for (let i = index + 1; i < 3; i++) parts[i] = 0;
  const next = parts.join('.');
  pkg.version = next;
  writeJson(packageFile, pkg);

  const lockFile = path.join(REPO_ROOT, 'package-lock.json');
  const lock = readJson(lockFile);
  if (lock) {
    lock.version = next;
    if (lock.packages?.['']) lock.packages[''].version = next;
    writeJson(lockFile, lock);
  }
  return next;
}

// ---------- install / backup / daemon ------------------------------------

export function normalizeVersion(channel, version) {
  if (channel === 'lansyncopt') {
    return version.endsWith('-opt') ? version : `${version}-opt`;
  }
  return version;
}

export function patchManifest(pkg, lock, channel, version) {
  const v = normalizeVersion(channel, version);
  if (channel === 'lansyncopt') {
    pkg.name = 'lansyncopt';
    pkg.version = v;
    pkg.bin = { lansyncopt: './bin/lansync.js' };
    if (lock) {
      lock.name = 'lansyncopt';
      lock.version = v;
      if (lock.packages?.['']) {
        lock.packages[''].name = 'lansyncopt';
        lock.packages[''].version = v;
        lock.packages[''].bin = { lansyncopt: 'bin/lansync.js' };
      }
    }
  } else {
    pkg.name = 'lansync';
    pkg.version = v;
    pkg.bin = { lansync: './bin/lansync.js' };
    if (lock) {
      lock.name = 'lansync';
      lock.version = v;
      if (lock.packages?.['']) {
        lock.packages[''].name = 'lansync';
        lock.packages[''].version = v;
        lock.packages[''].bin = { lansync: 'bin/lansync.js' };
      }
    }
  }
  return v;
}

async function installFromRepo(repoRoot, channel, version, options = {}) {
  const configDir = options.configDir || CHANNELS[channel];
  const copyDeps = options.copyDeps !== false;
  const link = options.link !== false;
  const targetDir = path.join(configDir, 'app');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-install-'));

  try {
    for (const name of ['bin', 'src', 'package.json', 'package-lock.json']) {
      const source = path.join(repoRoot, name);
      if (!fs.existsSync(source)) throw new Error(`missing ${name} in ${repoRoot}`);
      fs.cpSync(source, path.join(stage, name), { recursive: true });
    }

    const pkg = readJson(path.join(stage, 'package.json'));
    const lock = readJson(path.join(stage, 'package-lock.json'));
    const installedVersion = patchManifest(pkg, lock, channel, version);
    writeJson(path.join(stage, 'package.json'), pkg);
    if (lock) writeJson(path.join(stage, 'package-lock.json'), lock);

    if (channel === 'lansyncopt') {
      const configPath = path.join(stage, 'src', 'config.js');
      let source = fs.readFileSync(configPath, 'utf8');
      source = source.replace(
        "path.join(os.homedir(), '.lansync')",
        "path.join(os.homedir(), '.lansyncopt')"
      );
      fs.writeFileSync(configPath, source);
    }

    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of ['bin', 'src', 'package.json', 'package-lock.json']) {
      fs.cpSync(path.join(stage, name), path.join(targetDir, name), { recursive: true, force: true });
    }

    if (copyDeps) {
      const repoDeps = path.join(repoRoot, 'node_modules');
      if (fs.existsSync(repoDeps)) {
        fs.cpSync(repoDeps, path.join(targetDir, 'node_modules'), { recursive: true, force: true });
      }
    }

    if (!fs.existsSync(path.join(targetDir, 'node_modules', 'minimatch'))) {
      if (!copyDeps) throw new Error('target app has no node_modules/minimatch');
      const dep = await runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], targetDir, 180000);
      if (dep.code !== 0) throw new Error(`npm ci failed: ${tail(dep.stderr || dep.stdout)}`);
    }

    if (link) {
      const linked = await runNpm(['link', '--offline', '--no-audit', '--no-fund'], targetDir, 120000);
      if (linked.code !== 0) warn(`npm link failed (continuing): ${tail(linked.stderr || linked.stdout)}`);
    }

    return { appDir: targetDir, version: installedVersion };
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

function backupApp(channel, configDir = CHANNELS[channel]) {
  const dir = path.join(configDir, 'app');
  if (!fs.existsSync(dir)) return null;
  const version = readJson(path.join(dir, 'package.json'))?.version ?? 'unknown';
  const destination = `${dir}.bak-${version}`;
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(dir, destination, { recursive: true });
  return destination;
}

async function stopDaemon(configDir) {
  const cfg = readJson(path.join(configDir, 'server.json'));
  if (!cfg?.pid) return { stopped: false, reason: 'no pid' };
  const stopped = await killPid(cfg.pid);
  return { stopped, pid: cfg.pid };
}

async function startDaemon(configDir, options = {}) {
  const configFile = path.join(configDir, 'server.json');
  const cfg = readJson(configFile);
  if (!cfg) throw new Error('server.json missing; cannot restart without credentials');
  if (!cfg.rootDir || !cfg.port || !cfg.token) {
    throw new Error('server.json missing rootDir/port/token; cannot restart');
  }
  const serverPath = path.join(configDir, 'app', 'src', 'server.js');
  if (!fs.existsSync(serverPath)) throw new Error(`server entry missing: ${serverPath}`);

  const child = spawn(process.execPath, [serverPath, '--daemon', cfg.rootDir, String(cfg.port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}) },
  });
  child.unref();

  if (!(await waitPort(cfg.port, '127.0.0.1', 20000))) {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    throw new Error(`daemon did not listen on ${cfg.port}`);
  }

  cfg.pid = child.pid;
  writeJson(configFile, cfg);
  return { pid: child.pid, port: cfg.port, rootDir: cfg.rootDir };
}

async function health(configDir) {
  const cfg = readJson(path.join(configDir, 'server.json'));
  if (!cfg) return { ok: false, reason: 'no server.json' };
  if (!(await waitPort(cfg.port, '127.0.0.1', 3000))) {
    return { ok: false, reason: `port ${cfg.port} closed` };
  }
  try {
    const response = await fetch(`http://127.0.0.1:${cfg.port}/api/list?path=__lansync_health__`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: response.ok, status: response.status, port: cfg.port };
  } catch (error) {
    return { ok: false, reason: String(error.message) };
  }
}

async function switchChannel(channel, version, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const configDir = CHANNELS[channel];
  const hadServer = !!readJson(path.join(configDir, 'server.json'));
  const backup = backupApp(channel, configDir);
  if (hadServer) await stopDaemon(configDir);

  try {
    const installed = await installFromRepo(repoRoot, channel, version, { configDir });
    if (hadServer) await startDaemon(configDir);
    const checked = hadServer ? await health(configDir) : { ok: true, skipped: true };
    if (!checked.ok) throw new Error(`health check failed: ${JSON.stringify(checked)}`);
    return { ok: true, backup, installed, health: checked, appVersion: appVersion(channel) };
  } catch (error) {
    const rollback = { attempted: false, ok: false };
    if (backup && fs.existsSync(backup)) {
      rollback.attempted = true;
      try {
        await stopDaemon(configDir);
        fs.rmSync(path.join(configDir, 'app'), { recursive: true, force: true });
        fs.cpSync(backup, path.join(configDir, 'app'), { recursive: true });
        if (hadServer) await startDaemon(configDir);
        rollback.ok = hadServer ? (await health(configDir)).ok : true;
      } catch (rollbackError) {
        rollback.error = String(rollbackError.message || rollbackError);
      }
    }
    return { ok: false, error: String(error.message || error), backup, rollback };
  }
}

async function restoreChannel(channel, options = {}) {
  const configDir = CHANNELS[channel];
  const hasServer = !!readJson(path.join(configDir, 'server.json'));
  const backups = fs.existsSync(configDir)
    ? fs.readdirSync(configDir).filter(name => name.startsWith('app.bak-')).sort()
    : [];
  if (!backups.length) return { ok: false, error: 'no app.bak-* backup' };

  const latest = backups[backups.length - 1];
  const backup = path.join(configDir, latest);
  await stopDaemon(configDir);
  fs.rmSync(path.join(configDir, 'app'), { recursive: true, force: true });
  fs.cpSync(backup, path.join(configDir, 'app'), { recursive: true });
  if (options.start !== false && hasServer) await startDaemon(configDir);
  return { ok: true, restored: latest, version: appVersion(channel) };
}

// ---------- agent mode (runs on the remote) ------------------------------

function statusObject() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    home: HOME,
    repo: {
      cwd: process.cwd(),
      version: readJson(path.join(process.cwd(), 'package.json'))?.version ?? null,
    },
    channels: {
      lansync: {
        appVersion: appVersion('lansync'),
        server: publicServerConfig('lansync'),
        client: publicClientConfig('lansync'),
      },
      lansyncopt: {
        appVersion: appVersion('lansyncopt'),
        server: publicServerConfig('lansyncopt'),
        client: publicClientConfig('lansyncopt'),
      },
    },
  };
}

async function testRepo() {
  const checks = [];
  let ok = true;

  const files = [];
  for (const dir of ['src', 'bin']) {
    const absolute = path.join(process.cwd(), dir);
    if (!fs.existsSync(absolute)) continue;
    for (const name of fs.readdirSync(absolute)) {
      if (name.endsWith('.js')) files.push(path.join(absolute, name));
    }
  }
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      ok = false;
      checks.push({
        name: 'node --check',
        file: path.relative(process.cwd(), file),
        ok: false,
        detail: tail(result.stderr),
      });
    }
  }
  if (ok) checks.push({ name: 'node --check', ok: true, count: files.length });

  if (!fs.existsSync(path.join(process.cwd(), 'node_modules', 'minimatch'))) {
    const dep = await runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], process.cwd(), 180000);
    checks.push({ name: 'npm ci', ok: dep.code === 0, detail: tail(dep.stderr || dep.stdout) });
    if (dep.code !== 0) ok = false;
  }

  const tests = await runNpm(['test'], process.cwd(), 300000);
  const testsOk = tests.code === 0;
  if (!testsOk) ok = false;
  checks.push({
    name: 'npm test',
    ok: testsOk,
    code: tests.code,
    stdout: tail(tests.stdout, 4000),
    stderr: tail(tests.stderr, 2000),
  });

  return { ok, checks };
}

async function stagingStart(version) {
  const base = path.join(STATE_DIR, 'staging');
  const configDir = path.join(base, 'config');
  const rootDir = path.join(base, 'root');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  const token = crypto.randomBytes(32).toString('hex');
  const port = await freePort();
  await installFromRepo(process.cwd(), 'lansync', version, {
    configDir,
    copyDeps: true,
    link: false,
  });
  writeJson(path.join(configDir, 'server.json'), {
    token,
    policy: 'normal',
    rootDir,
    port,
    ip: '127.0.0.1',
  });
  const started = await startDaemon(configDir, { env: { LANSNC_CONFIG_DIR: configDir } });
  return { port, token, rootDir, configDir, pid: started.pid, version };
}

function parseAgentArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const index = arg.indexOf('=');
      if (index > 0) out[arg.slice(2, index)] = arg.slice(index + 1);
      else out[arg.slice(2)] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

async function agentMain(argv) {
  const { _, ...args } = parseAgentArgs(argv);
  const op = _[0];
  try {
    switch (op) {
      case 'status':
        return { ok: true, status: statusObject() };
      case 'test-repo':
        return await testRepo();
      case 'install': {
        const installed = await installFromRepo(process.cwd(), args.channel, args.version, {
          copyDeps: args['copy-deps'] !== 'false',
          link: args.link !== 'false',
        });
        return { ok: true, ...installed, appVersion: appVersion(args.channel) };
      }
      case 'switch':
        return await switchChannel(args.channel, args.version);
      case 'backup':
        return { ok: true, backup: backupApp(args.channel) };
      case 'restore':
        return await restoreChannel(args.channel, { start: args.start !== 'false' });
      case 'stop':
        return { ok: true, ...(await stopDaemon(CHANNELS[args.channel])) };
      case 'start':
        return { ok: true, ...(await startDaemon(CHANNELS[args.channel])) };
      case 'health':
        return await health(CHANNELS[args.channel]);
      case 'staging-start':
        return { ok: true, ...(await stagingStart(args.version)) };
      case 'staging-stop': {
        const cfg = readJson(path.join(STATE_DIR, 'staging', 'config', 'server.json'));
        if (!cfg?.pid) return { ok: true, stopped: false };
        return { ok: true, stopped: await killPid(cfg.pid) };
      }
      case 'staging-exists': {
        const root = path.join(STATE_DIR, 'staging', 'root');
        const target = path.resolve(root, args.path);
        if (!target.startsWith(root)) return { ok: false, error: 'path escapes staging root' };
        return { ok: true, exists: fs.existsSync(target) };
      }
      case 'staging-write': {
        const root = path.join(STATE_DIR, 'staging', 'root');
        const target = path.resolve(root, args.path);
        if (!target.startsWith(root)) return { ok: false, error: 'path escapes staging root' };
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(args.data || '', 'base64'));
        return { ok: true };
      }
      case 'install-control': {
        const installed = await installFromRepo(process.cwd(), 'lansyncopt', args.version, {
          configDir: CHANNELS.lansyncopt,
          copyDeps: false,
          link: false,
        });
        return { ok: true, ...installed, appVersion: appVersion('lansyncopt') };
      }
      case 'schedule-stop': {
        const cfg = readJson(path.join(CHANNELS[args.channel], 'server.json'));
        if (!cfg?.pid) return { ok: true, scheduled: false };
        const code = `setTimeout(()=>{try{process.kill(${cfg.pid},'SIGTERM')}catch{};setTimeout(()=>{try{process.kill(${cfg.pid},'SIGKILL')}catch{}},3000)},2500)`;
        const child = spawn(process.execPath, ['-e', code], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        return { ok: true, scheduled: true, pid: cfg.pid };
      }
      default:
        return { ok: false, error: `unknown agent op: ${op}` };
    }
  } catch (error) {
    return { ok: false, error: String(error.message || error), stack: error.stack };
  }
}

// ---------- driver mode --------------------------------------------------

function shellArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9._:/\\-]+$/.test(text) ? text : `"${text.replace(/"/g, '')}"`;
}

async function controlExec(control, command, timeout = 300000) {
  const result = await run(process.execPath, [appEntry(control), 'exec', '--json', command], {
    cwd: REPO_ROOT,
    timeout,
  });
  if (result.code !== 0) {
    throw fail(EXIT.control, `control exec failed (${result.code}): ${tail(result.stderr || result.stdout)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw fail(EXIT.control, `control exec returned non-JSON: ${tail(result.stdout)}`);
  }
  if (parsed.exitCode !== 0) {
    throw fail(EXIT.control, `remote command failed (${parsed.exitCode}): ${tail(parsed.stderr || parsed.stdout)}`);
  }
  return parsed;
}

async function agentCall(control, op, args = {}) {
  const parts = ['node', 'scripts/upgrade.js', 'agent', op];
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) parts.push(`--${key}=${shellArg(value)}`);
  }
  parts.push('--json');
  const result = await controlExec(control, parts.join(' '));
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw fail(EXIT.control, `agent returned non-JSON: ${tail(result.stdout)}`);
  }
}

async function uploadScript(control) {
  const cfg = clientConfig(control);
  if (!cfg?.serverUrl || !cfg?.token) throw fail(EXIT.control, `missing client config for ${control}`);
  const response = await fetch(new URL('/api/file', cfg.serverUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'X-Path': 'scripts/upgrade.js',
      'Content-Type': 'application/octet-stream',
    },
    body: fs.readFileSync(SELF),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw fail(EXIT.control, `upload helper failed: HTTP ${response.status} ${tail(await response.text())}`);
  }
}

async function reachableChannel(channel) {
  if (!clientConfig(channel)) return false;
  const result = await run(process.execPath, [appEntry(channel), 'exec', '--json', 'node -v'], {
    cwd: REPO_ROOT,
    timeout: 25000,
  });
  if (result.code !== 0) return false;
  try {
    return JSON.parse(result.stdout).exitCode === 0;
  } catch {
    return false;
  }
}

async function startLansyncoptViaLansync() {
  if (!clientConfig('lansync')) return false;
  // Start the stopped control daemon from its preserved server.json. The
  // inline command only uses os.homedir(), so it does not trip the server's
  // own-config-path self-reference guard.
  const code = [
    "const{spawn}=require('child_process'),fs=require('fs'),os=require('os');",
    "const p=os.homedir()+'/.lansyncopt';",
    "const c=JSON.parse(fs.readFileSync(p+'/server.json'));",
    "const s=spawn(process.execPath,[p+'/app/src/server.js','--daemon',c.rootDir,String(c.port)],{detached:true,stdio:'ignore',windowsHide:true});",
    "s.unref();c.pid=s.pid;fs.writeFileSync(p+'/server.json',JSON.stringify(c,null,2)+'\\n');console.log('started '+s.pid)",
  ].join('');
  const result = await run(process.execPath, [
    appEntry('lansync'),
    'exec',
    '--json',
    `node -e "${code}"`,
  ], { cwd: REPO_ROOT, timeout: 30000 });
  if (result.code !== 0) return false;
  try {
    if (JSON.parse(result.stdout).exitCode !== 0) return false;
  } catch {
    return false;
  }
  for (let i = 0; i < 20; i++) {
    if (await reachableChannel('lansyncopt')) return true;
    await sleep(500);
  }
  return false;
}

async function pickControl() {
  if (await reachableChannel('lansyncopt')) return 'lansyncopt';
  if (await startLansyncoptViaLansync()) return 'lansyncopt';
  if (await reachableChannel('lansync')) return 'lansync';
  return null;
}

async function preflight(opts, state) {
  const newVersion = readJson(path.join(REPO_ROOT, 'package.json'))?.version;
  if (!newVersion) throw fail(EXIT.preflight, 'cannot read version from repo package.json');
  state.newVersion = newVersion;

  const control = await pickControl();
  if (!control) throw fail(EXIT.control, 'no reachable control channel (start lansyncopt or lansync first)');
  state.control = control;
  log(`control channel: ${control}`);

  const controlClient = clientConfig(control);
  if (!controlClient?.workDir || !samePath(controlClient.workDir, REPO_ROOT)) {
    throw fail(
      EXIT.preflight,
      `control client workDir (${controlClient?.workDir}) is not this checkout (${REPO_ROOT})`
    );
  }

  await uploadScript(control);
  const remote = await agentCall(control, 'status');
  if (!remote.ok) throw fail(EXIT.control, `remote status failed: ${remote.error}`);
  state.remote = remote.status;

  const controlRoot = remote.status.channels[control]?.server?.rootDir;
  if (!controlRoot) throw fail(EXIT.control, `control channel ${control} has no server root on the remote`);
  if (!samePath(controlRoot, remote.status.repo.cwd)) {
    throw fail(
      EXIT.control,
      `control server root (${controlRoot}) is not the source checkout (${remote.status.repo.cwd})`
    );
  }

  const remoteTarget = remote.status.channels.lansync;
  const localRunning = appVersion('lansync');
  const remoteRunning = remoteTarget?.appVersion ?? null;
  const stale = [];
  if (localRunning && compareSemver(newVersion, localRunning) <= 0) stale.push(`local ${localRunning}`);
  if (remoteRunning && compareSemver(newVersion, remoteRunning) <= 0) stale.push(`remote ${remoteRunning}`);
  if (stale.length && !opts.allowSameVersion) {
    throw fail(
      EXIT.preflight,
      `repo version ${newVersion} is not newer than the running lansync (${stale.join(', ')}); ` +
      'bump package.json or run with --bump=patch'
    );
  }

  return { newVersion, control, remote: remote.status, remoteTarget, localRunning };
}

function stateInit() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const state = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    phase: 'preflight',
    status: 'running',
    checks: [],
    newVersion: null,
    control: null,
    remote: null,
    staging: null,
    remoteSwitch: null,
    localSwitch: null,
    health: null,
    remoteRollback: null,
    localRollback: null,
    controlInstall: null,
    controlStop: null,
    error: null,
  };
  saveState(state);
  return state;
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

function reportObject(state) {
  return {
    schemaVersion: 1,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt || null,
    status: state.status,
    phase: state.phase,
    newVersion: state.newVersion,
    control: state.control,
    local: {
      lansync: { appVersion: appVersion('lansync'), server: publicServerConfig('lansync') },
      lansyncopt: { appVersion: appVersion('lansyncopt'), server: publicServerConfig('lansyncopt') },
    },
    remote: state.remote
      ? {
          platform: state.remote.platform,
          node: state.remote.node,
          repo: state.remote.repo,
          channels: {
            lansync: {
              appVersion: state.remote.channels.lansync.appVersion,
              server: state.remote.channels.lansync.server,
            },
            lansyncopt: {
              appVersion: state.remote.channels.lansyncopt.appVersion,
              server: state.remote.channels.lansyncopt.server,
            },
          },
        }
      : null,
    checks: state.checks,
    push: state.push || null,
    remoteTests: state.remoteTests || null,
    staging: state.staging,
    remoteSwitch: state.remoteSwitch,
    localSwitch: state.localSwitch,
    health: state.health,
    remoteRollback: state.remoteRollback,
    localRollback: state.localRollback,
    controlInstall: state.controlInstall,
    controlStop: state.controlStop,
    error: state.error,
    paths: { json: REPORT_JSON, markdown: REPORT_MD, log: LOG_FILE },
  };
}

function writeReport(state) {
  const report = reportObject(state);
  writeJson(REPORT_JSON, report);

  const lines = [
    '# lansync upgrade report',
    '',
    `- status: **${report.status}**`,
    `- phase: ${report.phase}`,
    `- target version: ${report.newVersion}`,
    `- control channel: ${report.control}`,
    `- started: ${report.startedAt}`,
    `- finished: ${report.finishedAt}`,
    '',
    '## Versions',
    '',
    `| side | lansync | lansyncopt |`,
    `| --- | --- | --- |`,
    `| local | ${report.local.lansync.appVersion} | ${report.local.lansyncopt.appVersion} |`,
    `| remote | ${report.remote?.channels.lansync.appVersion} | ${report.remote?.channels.lansyncopt.appVersion} |`,
    '',
    '## Checks',
    '',
    ...(report.checks.length
      ? report.checks.map(check => `- ${check.ok === false ? 'FAIL' : 'ok'}: ${check.name}`)
      : ['- (none)']),
    '',
    '## Staging',
    '',
    report.staging ? `- port ${report.staging.port}, version ${report.staging.version}` : '- skipped',
    '',
    '## Error',
    '',
    report.error ? `- ${report.error.message}` : '- none',
    '',
    `Machine-readable report: ${REPORT_JSON}`,
  ];
  fs.writeFileSync(REPORT_MD, lines.join('\n') + '\n');
  return report;
}

function finish(state, code) {
  state.finishedAt = new Date().toISOString();
  saveState(state);
  const report = writeReport(state);
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log(`Upgrade ${report.status}.`);
    console.log(`  target: ${report.newVersion}`);
    console.log(`  local:  lansync ${report.local.lansync.appVersion} / lansyncopt ${report.local.lansyncopt.appVersion}`);
    console.log(`  remote: lansync ${report.remote?.channels.lansync.appVersion} / lansyncopt ${report.remote?.channels.lansyncopt.appVersion}`);
    if (report.error) console.log(`  error: ${report.error.message}`);
    console.log(`  report: ${REPORT_JSON}`);
  }
  process.exitCode = code;
  return code;
}

async function smoke(control, staging) {
  const controlClient = clientConfig(control);
  const host = new URL(controlClient.serverUrl).hostname;
  // macOS mkdtemp returns /var/..., whose real path is /private/var/...
  // validateWorkDir compares resolved paths, so normalize before use.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-smoke-')));
  const configDir = path.join(base, 'config');
  const workDir = path.join(base, 'work');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  writeJson(path.join(configDir, 'client.json'), {
    serverUrl: `http://${host}:${staging.port}`,
    workDir,
    token: staging.token,
  });

  const cli = path.join(REPO_ROOT, 'bin', 'lansync.js');
  const env = { ...process.env, LANSNC_CONFIG_DIR: configDir };
  const runCli = async args => {
    const result = await run(process.execPath, [cli, ...args], { cwd: workDir, env, timeout: 120000 });
    if (result.code !== 0) {
      throw fail(EXIT.canary, `smoke: ${args.join(' ')} exited ${result.code}: ${tail(result.stderr || result.stdout)}`);
    }
    return result;
  };

  try {
    fs.writeFileSync(path.join(workDir, '.gitignore'), '/rss/*\n');
    fs.mkdirSync(path.join(workDir, 'rss'));
    fs.writeFileSync(path.join(workDir, 'rss', 'excluded.txt'), 'root');
    fs.mkdirSync(path.join(workDir, 'vendor', 'rss'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'vendor', 'rss', 'keep.txt'), 'nested');
    fs.mkdirSync(path.join(workDir, 'unicode'));
    fs.writeFileSync(path.join(workDir, 'unicode', '文件 名.txt'), 'unicode');
    fs.mkdirSync(path.join(workDir, 'pct'));
    fs.writeFileSync(path.join(workDir, 'pct', 'report%2Ffinal.txt'), 'percent');
    fs.mkdirSync(path.join(workDir, 'del'));
    fs.writeFileSync(path.join(workDir, 'del', 'me.txt'), 'delete-me');

    await runCli(['push']);
    await runCli(['diff', '--json']);

    const expectations = [
      ['vendor/rss/keep.txt', true],
      ['rss/excluded.txt', false],
      ['unicode/文件 名.txt', true],
      ['pct/report%2Ffinal.txt', true],
    ];
    for (const [target, expected] of expectations) {
      const check = await agentCall(control, 'staging-exists', { path: target });
      if (!check.ok) throw fail(EXIT.canary, `smoke: exists check failed: ${check.error}`);
      if (check.exists !== expected) {
        throw fail(EXIT.canary, `smoke: ${target} exists=${check.exists}, expected ${expected}`);
      }
    }

    await runCli(['exec', '--json', 'node -v']);

    fs.writeFileSync(path.join(workDir, 'vendor', 'rss', 'keep.txt'), 'nested-v2');
    await runCli(['push']);

    fs.rmSync(path.join(workDir, 'del', 'me.txt'));
    await runCli(['push']);
    const deleted = await agentCall(control, 'staging-exists', { path: 'del/me.txt' });
    if (deleted.exists) throw fail(EXIT.canary, 'smoke: deleted file still exists on server');

    const written = await agentCall(control, 'staging-write', {
      path: 'pulled/from-server.txt',
      data: Buffer.from('pulled-from-server').toString('base64'),
    });
    if (!written.ok) throw fail(EXIT.canary, `smoke: staging write failed: ${written.error}`);
    await runCli(['pull']);
    const pulled = fs.readFileSync(path.join(workDir, 'pulled', 'from-server.txt'), 'utf8');
    if (pulled !== 'pulled-from-server') throw fail(EXIT.canary, 'smoke: pull content mismatch');

    const final = await runCli(['diff', '--json']);
    let parsed;
    try {
      parsed = JSON.parse(final.stdout);
    } catch {
      throw fail(EXIT.canary, `smoke: final diff not JSON: ${tail(final.stdout)}`);
    }
    if (!parsed.inSync) throw fail(EXIT.canary, 'smoke: final diff not in sync');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function targetHealth() {
  const cfg = clientConfig('lansync');
  if (!cfg?.serverUrl || !cfg?.token) return { ok: true, skipped: true };
  try {
    const response = await fetch(new URL('/api/list?path=__lansync_health__', cfg.serverUrl), {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: String(error.message) };
  }
}

async function rollbackRemote(control, state) {
  if (!state.remoteSwitched) return { ok: true, skipped: true };
  const result = await agentCall(control, 'restore', { channel: 'lansync' }).catch(error => ({
    ok: false,
    error: String(error.message),
  }));
  state.remoteRollback = result;
  return result;
}

async function rollbackLocal(state) {
  if (!state.localSwitched) return { ok: true, skipped: true };
  const result = await restoreChannel('lansync');
  state.localRollback = result;
  return result;
}

async function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function runUpgrade(opts) {
  const state = stateInit();
  state.phase = 'preflight';
  saveState(state);

  try {
    if (opts.bump) {
      const bumped = bumpRepoVersion(opts.bump);
      log(`bumped repo version to ${bumped}`);
    }
    const pre = await preflight(opts, state);
    state.checks.push({ name: 'preflight', ok: true });
    log(`target version: ${pre.newVersion}`);
    log(`remote: lansync ${pre.remoteTarget?.appVersion} / lansyncopt ${pre.remote.channels.lansyncopt.appVersion}`);

    if (!opts.yes && process.stdin.isTTY) {
      const answer = await ask(`Upgrade both ends to lansync ${pre.newVersion}? [Y/n]: `);
      if (!/^y(es)?$/i.test(answer.trim()) && answer.trim() !== '') {
        log('aborted by user');
        state.status = 'aborted';
        return finish(state, EXIT.ok);
      }
    }

    if (opts.dryRun) {
      state.status = 'dry-run';
      state.phase = 'done';
      log('dry run complete (no hosts changed)');
      return finish(state, EXIT.ok);
    }

    state.phase = 'push';
    saveState(state);
    const pushArgs = opts.mirror ? ['push'] : ['push', '--no-delete'];
    log(`pushing source via ${pre.control}: ${pushArgs.join(' ')}`);
    const push = await run(process.execPath, [appEntry(pre.control), ...pushArgs], {
      cwd: REPO_ROOT,
      timeout: 600000,
    });
    state.push = { code: push.code, stdout: tail(push.stdout, 4000), stderr: tail(push.stderr, 2000) };
    if (push.code !== 0) throw fail(EXIT.push, `push failed (${push.code}): ${tail(push.stderr || push.stdout)}`);

    const afterPush = await agentCall(pre.control, 'status');
    if (!afterPush.ok) throw fail(EXIT.push, `remote status after push failed: ${afterPush.error}`);
    if (afterPush.status.repo.version !== pre.newVersion) {
      throw fail(EXIT.push, `remote repo version ${afterPush.status.repo.version} != ${pre.newVersion}`);
    }
    await uploadScript(pre.control);
    state.checks.push({ name: 'push + remote repo version', ok: true });

    state.phase = 'remote-tests';
    saveState(state);
    log('running remote tests...');
    const tests = await agentCall(pre.control, 'test-repo');
    state.remoteTests = tests;
    if (!tests.ok) throw fail(EXIT.remoteTests, 'remote tests failed');
    state.checks.push({ name: 'remote tests', ok: true });

    state.phase = 'canary';
    saveState(state);
    log('starting canary...');
    const staging = await agentCall(pre.control, 'staging-start', { version: pre.newVersion });
    if (!staging.ok) throw fail(EXIT.canary, `staging start failed: ${staging.error}`);
    state.staging = { port: staging.port, rootDir: staging.rootDir, version: staging.version };
    saveState(state);
    try {
      await smoke(pre.control, staging);
      state.checks.push({ name: 'canary smoke', ok: true });
      log('canary smoke passed');
    } finally {
      await agentCall(pre.control, 'staging-stop').catch(() => {});
    }

    state.phase = 'switch';
    saveState(state);
    log('switching remote lansync...');
    const remoteSwitch = await agentCall(pre.control, 'switch', {
      channel: 'lansync',
      version: pre.newVersion,
    });
    state.remoteSwitch = remoteSwitch;
    if (!remoteSwitch.ok) throw fail(EXIT.publish, `remote switch failed: ${remoteSwitch.error}`);
    if (remoteSwitch.appVersion !== pre.newVersion) {
      throw fail(EXIT.publish, `remote lansync version ${remoteSwitch.appVersion} != ${pre.newVersion}`);
    }
    state.remoteSwitched = true;
    saveState(state);

    log('switching local lansync...');
    const localSwitch = await switchChannel('lansync', pre.newVersion);
    state.localSwitch = localSwitch;
    if (!localSwitch.ok) {
      await rollbackRemote(pre.control, state);
      throw fail(EXIT.publish, `local switch failed: ${localSwitch.error}`);
    }
    if (localSwitch.appVersion !== pre.newVersion) {
      await rollbackRemote(pre.control, state);
      await rollbackLocal(state);
      state.status = 'rolled-back';
      throw fail(EXIT.publish, `local lansync version ${localSwitch.appVersion} != ${pre.newVersion}`);
    }
    state.localSwitched = true;
    saveState(state);

    const checked = await targetHealth();
    state.health = checked;
    if (!checked.ok) {
      await rollbackRemote(pre.control, state);
      await rollbackLocal(state);
      state.status = 'rolled-back';
      throw fail(EXIT.publish, `end-to-end health check failed: ${JSON.stringify(checked)}`);
    }
    state.checks.push({ name: 'end-to-end health', ok: true });

    state.phase = 'finish';
    saveState(state);
    log('finishing: updating lansyncopt installs...');
    const controlVersion = normalizeVersion('lansyncopt', pre.newVersion);
    const controlInstall = await agentCall(pre.control, 'install-control', { version: pre.newVersion });
    state.controlInstall = controlInstall;
    if (!controlInstall.ok) {
      warn(`remote lansyncopt install failed: ${controlInstall.error}`);
    } else if (controlInstall.appVersion !== controlVersion) {
      warn(`remote lansyncopt version ${controlInstall.appVersion} != ${controlVersion}`);
    } else {
      state.checks.push({ name: 'remote lansyncopt version', ok: true, version: controlVersion });
    }

    const localControl = await installFromRepo(REPO_ROOT, 'lansyncopt', pre.newVersion);
    state.checks.push({ name: 'local lansyncopt install', ok: localControl.version === controlVersion, version: localControl.version });
    if (localControl.version !== controlVersion) {
      warn(`local lansyncopt version ${localControl.version} != ${controlVersion}`);
    }

    // Refresh the remote snapshot so the report shows post-switch versions.
    const finalRemote = await agentCall(pre.control, 'status').catch(() => null);
    if (finalRemote?.ok) state.remote = finalRemote.status;

    if (opts.stopControl) {
      const scheduled = await agentCall(pre.control, 'schedule-stop', { channel: 'lansyncopt' });
      state.controlStop = scheduled;
      log('remote lansyncopt scheduled to stop');
    } else {
      log('remote lansyncopt left running (control channel)');
    }

    state.status = 'success';
    state.phase = 'done';
    return finish(state, EXIT.ok);
  } catch (error) {
    state.status = state.status === 'rolled-back' ? 'rolled-back' : 'failed';
    state.error = { message: String(error.message || error), code: error.exitCode ?? 1 };
    log(`FAILED: ${state.error.message}`);
    const rollbackFailed =
      state.remoteRollback?.ok === false || state.localRollback?.ok === false;
    return finish(state, rollbackFailed ? EXIT.rollbackFailed : state.error.code);
  }
}

async function doctor(opts) {
  const state = stateInit();
  try {
    const pre = await preflight(opts, state);
    const lines = [
      `repo version: ${pre.newVersion}`,
      `control: ${pre.control}`,
      `remote: ${pre.remote.platform} node ${pre.remote.node}`,
      `remote repo: ${pre.remote.repo.cwd} @ ${pre.remote.repo.version}`,
      `remote lansync: ${pre.remoteTarget?.appVersion} (pid ${pre.remoteTarget?.server?.pid ?? 'n/a'})`,
      `remote lansyncopt: ${pre.remote.channels.lansyncopt.appVersion} (pid ${pre.remote.channels.lansyncopt.server?.pid ?? 'n/a'})`,
      `local lansync: ${appVersion('lansync')}`,
      `local lansyncopt: ${appVersion('lansyncopt')}`,
    ];
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, ...pre, local: reportObject(state).local }, null, 2));
    } else {
      console.log(lines.join('\n'));
      console.log('doctor: OK');
    }
    state.status = 'doctor-ok';
    state.phase = 'done';
    state.finishedAt = new Date().toISOString();
    saveState(state);
    process.exitCode = EXIT.ok;
  } catch (error) {
    state.status = 'failed';
    state.error = { message: String(error.message || error), code: error.exitCode ?? 1 };
    finish(state, error.exitCode ?? EXIT.preflight);
  }
}

async function plan(opts) {
  const state = stateInit();
  try {
    const pre = await preflight(opts, state);
    const steps = [
      `1. push source via ${pre.control} (${opts.mirror ? 'mirror' : '--no-delete'})`,
      '2. run remote node --check + npm test',
      '3. start canary on a spare port and run the smoke matrix',
      `4. switch remote lansync to ${pre.newVersion} (backup + preserve token)`,
      `5. switch local lansync to ${pre.newVersion}`,
      '6. health check from the local lansync client',
      `7. update both lansyncopt installs to ${pre.newVersion}-opt`,
      opts.keepControl ? '8. leave lansyncopt running' : '8. stop the remote lansyncopt daemon',
    ];
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, newVersion: pre.newVersion, control: pre.control, steps }, null, 2));
    } else {
      console.log(`Plan for lansync ${pre.newVersion}:`);
      console.log(steps.join('\n'));
    }
    state.status = 'planned';
    state.phase = 'done';
    state.finishedAt = new Date().toISOString();
    saveState(state);
    process.exitCode = EXIT.ok;
  } catch (error) {
    state.status = 'failed';
    state.error = { message: String(error.message || error), code: error.exitCode ?? 1 };
    finish(state, error.exitCode ?? EXIT.preflight);
  }
}

async function stopControlCommand() {
  log('stopping lansyncopt (token/config preserved)...');
  let ok = true;

  const local = serverConfig('lansyncopt');
  if (local?.pid) {
    const stopped = await killPid(local.pid);
    console.log(`local lansyncopt: ${stopped ? 'stopped' : 'still running'} (pid ${local.pid}, config preserved)`);
    if (!stopped) ok = false;
  } else {
    console.log('local lansyncopt: no running server.json');
  }

  if (await reachableChannel('lansync')) {
    const code = "const fs=require('fs'),os=require('os');const c=JSON.parse(fs.readFileSync(os.homedir()+'/.lansyncopt/server.json'));try{process.kill(c.pid,'SIGTERM');console.log('stopped '+c.pid)}catch(e){console.log('already stopped')}";
    const result = await run(process.execPath, [
      appEntry('lansync'),
      'exec',
      '--json',
      `node -e "${code}"`,
    ], { cwd: REPO_ROOT, timeout: 30000 });
    if (result.code !== 0) {
      console.log('remote lansyncopt:', tail(result.stderr || result.stdout));
      ok = false;
    } else {
      let parsed;
      try { parsed = JSON.parse(result.stdout); } catch {}
      console.log('remote lansyncopt:', (parsed?.stdout || '').trim() || '(no output)');
      if (parsed?.exitCode !== 0) ok = false;
    }
  } else if (await reachableChannel('lansyncopt')) {
    const scheduled = await agentCall('lansyncopt', 'schedule-stop', { channel: 'lansyncopt' })
      .catch(error => ({ ok: false, error: String(error.message) }));
    console.log('remote lansyncopt:', JSON.stringify(scheduled));
    if (!scheduled.ok) ok = false;
  } else {
    console.log('remote lansyncopt: neither channel reachable, skipped');
  }

  process.exitCode = ok ? EXIT.ok : EXIT.preflight;
}

async function rollbackCommand() {
  const state = readJson(STATE_FILE) || {};
  log('rolling back...');
  const control = await pickControl();
  let ok = true;
  if (control) {
    const result = await agentCall(control, 'restore', { channel: 'lansync' }).catch(error => ({
      ok: false,
      error: String(error.message),
    }));
    console.log('remote:', JSON.stringify(result));
    if (!result.ok) ok = false;
  } else {
    console.log('remote: no reachable control channel, skipped');
  }
  const local = await restoreChannel('lansync');
  console.log('local:', JSON.stringify(local));
  if (!local.ok) ok = false;
  state.status = ok ? 'rolled-back' : 'rollback-failed';
  state.finishedAt = new Date().toISOString();
  saveState(state);
  writeReport(state);
  process.exitCode = ok ? EXIT.ok : EXIT.rollbackFailed;
}

// ---------- CLI ----------------------------------------------------------

function printHelp() {
  console.log(`
lansync one-click upgrade

Usage:
  node scripts/upgrade.js                 Upgrade both ends (one command).
  node scripts/upgrade.js doctor          Check prerequisites only. No services stop.
  node scripts/upgrade.js plan            Explain what the upgrade would do.
  node scripts/upgrade.js rollback        Restore the newest app.bak-* on both ends.
  node scripts/upgrade.js stop-control    Stop lansyncopt but keep its server.json.
  node scripts/upgrade.js --help          Show this help.

Options:
  -y, --yes             Do not ask for confirmation.
      --dry-run         Run preflight and stop before changing anything.
      --json            Print the machine-readable report on stdout.
      --stop-control    Stop the remote lansyncopt after the upgrade (default: keep
                        it running as the control/fallback channel).
      --mirror          Allow the push to delete remote files (default: --no-delete).
      --bump=KIND       Bump the repo version first (patch, minor, or major).
      --allow-same-version
                        Permit redeploying the same version (not recommended).
      --help, -h        Show this help.

Version rule:
  The repo version must be newer than the running lansync on every end.
  Use --bump=patch (or edit package.json) before upgrading. The script
  verifies the installed lansync and lansyncopt versions after switching.

What happens (default command):
  1. Discover the control channel (lansyncopt first, then lansync).
  2. Upload the remote helper through the control channel.
  3. Push this checkout to the remote (never deletes by default).
  4. Run node --check and npm test on the remote.
  5. Start a canary server on a spare port and run the smoke matrix:
     push/pull/diff, deletions, unicode and percent paths, anchored ignore,
     and exec.
  6. Switch remote and local lansync to the new version. Existing
     server.json (token/root/port) is preserved. A backup is taken first.
  7. Health-check the new service from the local client.
  8. Update both lansyncopt installs and leave the remote control daemon
     running (use --stop-control to stop it explicitly).

Safety:
  - Production is not touched until the canary passes.
  - Any failure after the switch restores app.bak-* automatically.
  - Interrupted runs are safe to re-run; rollback is always available.
  - Tokens are never printed or written to the report.

Exit codes:
  0  success
  2  preflight failed (nothing changed)
  3  control channel / remote helper failed (nothing changed)
  4  push or remote repo verification failed (production untouched)
  5  remote tests failed (production untouched)
  6  publish/switch or end-to-end health failed (rolled back when possible)
  7  canary failed (production untouched)
  8  rollback failed (needs attention)

Artifacts:
  ${STATE_FILE}
  ${REPORT_JSON}
  ${REPORT_MD}
  ${LOG_FILE}

If the command exits non-zero, send ${REPORT_JSON} to your agent.
`);
}

function parseCli(argv) {
  const opts = {
    command: 'run',
    yes: false,
    dryRun: false,
    json: false,
    stopControl: false,
    mirror: false,
    help: false,
    bump: null,
    allowSameVersion: false,
  };
  const commands = new Set(['run', 'doctor', 'plan', 'rollback', 'stop-control', 'resume']);
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--stop-control') opts.stopControl = true;
    else if (arg === '--keep-control') opts.stopControl = false;
    else if (arg === '--mirror') opts.mirror = true;
    else if (arg === '--allow-same-version') opts.allowSameVersion = true;
    else if (arg.startsWith('--bump=')) opts.bump = arg.slice('--bump='.length);
    else if (commands.has(arg)) opts.command = arg;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unknown command: ${arg}`);
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'agent') {
    const result = await agentMain(argv.slice(1));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok === false ? 1 : 0;
    return;
  }

  let opts;
  try {
    opts = parseCli(argv);
  } catch (error) {
    console.error(error.message);
    console.error('Run: node scripts/upgrade.js --help');
    process.exitCode = EXIT.preflight;
    return;
  }
  jsonMode = opts.json;

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.command === 'doctor') return doctor(opts);
  if (opts.command === 'plan') return plan(opts);
  if (opts.command === 'rollback') return rollbackCommand(opts);
  if (opts.command === 'stop-control') return stopControlCommand(opts);
  return runUpgrade(opts);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (isMain) {
  main().catch(error => {
    console.error(error.stack || String(error));
    process.exitCode = error.exitCode ?? 1;
  });
}