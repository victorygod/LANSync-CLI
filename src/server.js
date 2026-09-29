// src/server.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { readServerConfig, writeServerConfig, getConfigDir } from './config.js';
import { checkPolicy, detectSelfReference, DEFAULT_POLICY, DEFAULT_BLACKLIST, DEFAULT_GRAYLIST } from './policy.js';

export const DEFAULT_PORT = 8001;
const DEFAULT_MAX_CONCURRENT = 4;
let activeExecs = 0;

// Normalize path separators to forward slashes for cross-platform compatibility
function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

// Simple logger that writes to file
function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.appendFileSync(path.join(getConfigDir(), 'server.log'), logLine);
  } catch {
    // Ignore log errors
  }
}

const DEFAULT_IGNORE_RULES = [
  '.git',
  '.lansync',
  '.lansyncopt',
  'node_modules',
  '.DS_Store',
  'Thumbs.db'
];

export function getDefaultIgnoreRules() {
  return [...DEFAULT_IGNORE_RULES];
}

export function parseGitignore(content) {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

export function shouldIgnore(filepath, rules) {
  let ignored = false;
  for (const rule of rules) {
    // Handle negation rules (starting with !)
    if (rule.startsWith('!')) {
      const negPattern = rule.slice(1);
      if (matchesPattern(filepath, negPattern)) {
        ignored = false;  // Un-ignore the file
      }
      continue;
    }
    if (matchesPattern(filepath, rule)) {
      ignored = true;
    }
  }
  return ignored;
}

function matchesPattern(filepath, pattern) {
  // Handle directory patterns (ending with /)
  if (pattern.endsWith('/')) {
    const dirRule = pattern.slice(0, -1);
    // Match directory itself or anything inside
    if (filepath === dirRule || filepath.startsWith(dirRule + '/') || filepath.startsWith(dirRule + '\\')) {
      return true;
    }
    // Also match with minimatch for glob patterns like dist/
    if (minimatch(filepath, pattern + '**', { dot: true })) {
      return true;
    }
  }
  // Direct match
  if (minimatch(filepath, pattern, { dot: true })) {
    return true;
  }
  // Match file inside a directory pattern (for bare names like node_modules)
  if (filepath === pattern || filepath.startsWith(pattern + '/') || filepath.startsWith(pattern + '\\')) {
    return true;
  }
  // Match directory anywhere in the path
  if (filepath.includes('/' + pattern + '/') || filepath.includes('\\' + pattern + '\\')) {
    return true;
  }
  // Match with ** prefix for glob patterns
  if (minimatch(filepath, '**/' + pattern, { dot: true })) {
    return true;
  }
  return false;
}

export function sanitizePath(requestedPath, rootDir) {
  // Decode URL encoding
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    return null;
  }

  // Block null bytes
  if (decoded.includes('\0')) {
    return null;
  }

  // Normalize rootDir to handle different path separators (Windows compatibility)
  const normalizedRoot = path.normalize(rootDir);

  // Normalize and resolve
  const absolutePath = path.resolve(normalizedRoot, decoded);

  // Ensure path is within root (normalize both for consistent comparison)
  const normalizedAbs = path.normalize(absolutePath);

  // Use relative path check for cross-platform compatibility
  const relativePath = path.relative(normalizedRoot, normalizedAbs);

  // If relative path starts with '..' or is absolute, it's outside root
  // Note: we check for '../' or '..\\' prefix, not just '..' substring
  // because valid filenames can contain '..' like '[...404].css'
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return absolutePath;
}

// Git 式空目录修剪:push 删掉某目录下最后一个文件后,从其父目录向上逐级
// 尝试 rmdir,到 rootDir 为止。只在删除成功后调用(文件已不在)。
// 只删「确认空」的目录,不用 rmSync recursive——目录里还有 ignore 文件
// (.DS_Store 等)或被 Windows 占用(EBUSY/EPERM,如资源管理器开着该目录)
// 时 rmdir 失败即停,留待下次 push 再试,与 git 遇到 ignored 文件时的行为一致。
export function pruneEmptyDirs(deletedFilePath, rootDir) {
  const root = path.normalize(rootDir);
  let current = path.dirname(deletedFilePath);

  while (true) {
    const rel = path.relative(root, current);
    // rel='' 表示已到 rootDir 本身——root 是 server 的同步根,永不修剪
    // 用 `..` + sep 判断越界,避免误伤 '..foo' 这类合法名字(用意同 sanitizePath)
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) break;

    try {
      fs.rmdirSync(current);
    } catch {
      break; // 非空或被占用:停在这里
    }
    current = path.dirname(current);
  }
}

export function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const fallbackIPs = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;

      if (iface.address.startsWith('192.168.')) {
        return iface.address;
      }
      if (iface.address.startsWith('10.')) {
        fallbackIPs.push(iface.address);
      }
    }
  }

  return fallbackIPs[0] || '127.0.0.1';
}

export function walkDir(dir, baseDir, ignoreRules) {
  const results = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (shouldIgnore(relativePath, ignoreRules)) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath);
          const hash = crypto.createHash('md5').update(content).digest('hex');
          // wire 统一正斜杠:win32 上 path.relative 产出反斜杠,原样上线的话
          // POSIX client 会 join 出字面含 "\" 的扁平文件;"docs/file.txt" 在
          // Windows 端读取(以及 sanitizePath 的 path.resolve)同样有效
          results.push({
            path: normalizePath(relativePath),
            size: stat.size,
            mtime: stat.mtimeMs,
            hash
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  walk(dir);
  return results;
}

// ===== 远程命令执行(Remote Exec) =====

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => resolve(''));
  });
}

// 杀掉 exec 的整棵进程树,防止断连后残留孤儿进程继续跑。
// - POSIX:spawn 用 detached 建独立进程组,负号 PID 杀整组(SIGTERM → 2s 后 SIGKILL)
// - Windows:不能 detached。实测在 detached(无控制台)环境下,cmd 拉起的外部 exe
//   会被绑到新的隐形控制台,stdout/stderr 句柄全部失效、输出凭空丢失;
//   去掉 detached 后句柄继承恢复正常。杀进程改用 taskkill /T(树杀)。
function killExecTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 2000);
  }
}

async function handleExec(req, res, rootDir, config) {
  const ip = req.socket.remoteAddress || 'unknown';

  // 策略门禁:exec-forbidden 直接拒(鉴权已在路由层通过,403 与 401 区分)
  const policy = config.policy || DEFAULT_POLICY;
  if (policy === 'exec-forbidden') {
    log(`DENIED ip=${ip} reason=exec_forbidden`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Exec is forbidden on this server (policy=${policy})` }));
    return;
  }

  let body = {};
  try {
    body = JSON.parse(await readJsonBody(req));
  } catch {
    body = {};
  }

  const command = String(body.command || '').trim();
  if (!command) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing command' }));
    return;
  }

  // 动态自引用检测:命令里出现 server 自身精确标识(PID/配置目录/代码路径)→ 拒绝。
  // 注意:不把工具名(lansync/lansyncopt)做裸子串匹配——那会误拦任何含该词的路径。
  // 「按名杀 server」(pkill -f lansync 等)由黑名单覆盖,精确标识则始终生效。
  const identifiers = [
    String(process.pid),
    getConfigDir(),
    fileURLToPath(import.meta.url)
  ];
  const selfHit = detectSelfReference(command, identifiers);
  if (selfHit) {
    log(`BLOCKED ip=${ip} command="${command}" reason=self-reference(${selfHit})`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Command blocked (self-reference)' }));
    return;
  }

  // 分级拦截:黑名单优先,再按 policy 决定是否拦灰名单;exec-all-allow 跳过名单
  if (policy !== 'exec-all-allow') {
    const blacklist = [...DEFAULT_BLACKLIST, ...(config.commandBlacklist || [])];
    const graylist = [...DEFAULT_GRAYLIST, ...(config.commandGraylist || [])];
    const decision = checkPolicy(command, policy, blacklist, graylist);
    if (decision.blocked) {
      log(`BLOCKED ip=${ip} command="${command}" reason=${decision.list}(${decision.matched})`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Command blocked (${decision.list})` }));
      return;
    }
  }

  // 并发上限(防 fork 炸弹)
  const maxConcurrent = config.maxConcurrent || DEFAULT_MAX_CONCURRENT;
  if (activeExecs >= maxConcurrent) {
    log(`DENIED ip=${ip} reason=too_many_concurrent`);
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many concurrent commands' }));
    return;
  }

  // 工作目录:相对 rootDir,任意命令可 cd 逃逸,故仅作默认值
  const execCwd = body.cwd ? path.resolve(rootDir, body.cwd) : rootDir;

  // 用临时文件捕获 stdout/stderr,而不是管道:
  // Windows 下 spawn(detached + shell:true) 时,cmd 自身的输出能进管道,
  // 但 cmd 再拉起的外部 exe(node 等)不会收到管道句柄,输出会凭空丢失。
  // 文件重定向(> file)对 Windows 的所有子进程都成立,是最可靠的捕获方式。
  const execTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-exec-'));
  const outPath = path.join(execTmpDir, 'stdout.txt');
  const errPath = path.join(execTmpDir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const start = Date.now();

  activeExecs++;
  const child = spawn(command, {
    shell: true,
    // POSIX 用独立进程组支持断连杀组;Windows 不用 detached(见 killExecTree 注释)
    detached: process.platform !== 'win32',
    cwd: execCwd,
    stdio: ['ignore', outFd, errFd]
  });
  let settled = false;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    activeExecs--;
    try { fs.closeSync(outFd); } catch {}
    try { fs.closeSync(errFd); } catch {}
    const durationMs = Date.now() - start;
    log(`EXEC ip=${ip} command="${command}" cwd="${execCwd}" exitCode=${result.exitCode} durationMs=${durationMs}`);
    if (!res.writableEnded) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs }));
    }
  };

  child.on('error', err => {
    finish({ exitCode: -1, stdout: '', stderr: String(err.message) });
  });
  child.on('close', code => {
    let stdout = '';
    let stderr = '';
    try { stdout = fs.readFileSync(outPath, 'utf-8'); } catch {}
    try { stderr = fs.readFileSync(errPath, 'utf-8'); } catch {}
    finish({ exitCode: code, stdout, stderr });
    try { fs.rmSync(execTmpDir, { recursive: true, force: true }); } catch {}
  });

  // 断连即杀:client 在命令结束前断开(agent 超时/网络断开)→ 杀整棵进程树
  const abort = () => {
    if (!settled) killExecTree(child);
  };
  req.on('aborted', abort);
  res.on('close', abort);
}

export function createServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Path, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // 统一鉴权:所有 /api/*(含文件接口)都要求 Bearer token,密码全量管控
      const config = readServerConfig();
      if (!config || !config.token || req.headers['authorization'] !== `Bearer ${config.token}`) {
        log(`DENIED ip=${req.socket.remoteAddress || 'unknown'} path=${pathname} reason=unauthorized`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (pathname === '/api/auth' && req.method === 'GET') {
        // client config 验证口令用:鉴权已通过,回传 server 的 exec policy
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, policy: config.policy || DEFAULT_POLICY }));
      } else if (pathname === '/api/list' && req.method === 'GET') {
        await handleList(url, rootDir, res);
      } else if (pathname === '/api/file' && req.method === 'GET') {
        await handleFileGet(url, rootDir, res);
      } else if (pathname === '/api/file' && req.method === 'POST') {
        await handleFilePost(req, rootDir, res);
      } else if (pathname === '/api/file' && req.method === 'DELETE') {
        await handleFileDelete(url, rootDir, res);
      } else if (pathname === '/api/exec' && req.method === 'POST') {
        await handleExec(req, res, rootDir, config);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return server;
}

async function handleList(url, rootDir, res) {
  const subPath = url.searchParams.get('path') || '';
  const targetDir = subPath ? sanitizePath(subPath, rootDir) : rootDir;

  if (!targetDir) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  if (!fs.existsSync(targetDir)) {
    // 区分"目录不存在"与"目录为空":client 若把 files:[] 当"server 全空",
    // pull 会把本地文件全部判为 toDelete。exists:false 让 client 直接拒绝。
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: [], exists: false }));
    return;
  }

  const ignoreRules = readGitignore(rootDir);
  const files = walkDir(targetDir, rootDir, ignoreRules);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ files, exists: true }));
}

async function handleFileGet(url, rootDir, res) {
  const filePath = url.searchParams.get('path');
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing path parameter' }));
    return;
  }

  const absolutePath = sanitizePath(filePath, rootDir);
  if (!absolutePath) {
    log(`403 GET ${filePath} - sanitizePath failed, rootDir=${rootDir}`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path', path: filePath }));
    return;
  }

  if (!fs.existsSync(absolutePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found', path: filePath }));
    return;
  }

  const content = fs.readFileSync(absolutePath);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(content);
}

async function handleFilePost(req, rootDir, res) {
  const encodedPath = req.headers['x-path'];
  // Decode and normalize path separators for cross-platform compatibility
  const filePath = encodedPath ? normalizePath(decodeURIComponent(encodedPath)) : null;
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing X-Path header' }));
    return;
  }

  const absolutePath = sanitizePath(filePath, rootDir);
  if (!absolutePath) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(absolutePath);
  fs.mkdirSync(parentDir, { recursive: true });

  // Read body and write file
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  fs.writeFileSync(absolutePath, Buffer.concat(chunks));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, path: filePath }));
}

async function handleFileDelete(url, rootDir, res) {
  const filePath = url.searchParams.get('path');
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing path parameter' }));
    return;
  }

  const absolutePath = sanitizePath(filePath, rootDir);
  if (!absolutePath) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  if (!fs.existsSync(absolutePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
    return;
  }

  fs.unlinkSync(absolutePath);

  // 删除成功后向上修剪空目录:本地删掉整个目录再 push 时,server 端不再
  // 残留空目录壳(协议只列文件,这些空壳对后续 push 永远不可见,会一直积累)
  pruneEmptyDirs(absolutePath, rootDir);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

function readGitignore(rootDir) {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const rules = getDefaultIgnoreRules();

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    rules.push(...parseGitignore(content));
  }

  return rules;
}

export async function isPortInUse(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

// ---- 孤儿 daemon 处置(见 devlog 2026-09-30 事故)--------------------------
// stopServerDaemon 只信 server.json 里的 pid,孤儿(半途 start/强杀/配置丢失
// 脱管)永远杀不掉。这里给 cli 一套「端口真相」工具:谁是占用者、怎么硬杀。

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 查询 LISTEN 在指定端口上的进程 pid。无跨平台 API,netstat/lsof 各走一条;
// 查不到(lsof 缺席、解析失败)返回 null,由调用方退化为人工提示
export function getPortOwnerPid(port) {
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    if (out.status !== 0 || !out.stdout) return null;
    // TCP    0.0.0.0:8001    0.0.0.0:0    LISTENING    12345
    for (const line of out.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(`:${port}`)) {
        return parseInt(cols[4], 10) || null;
      }
    }
    return null;
  }
  const out = spawnSync('lsof', ['-t', `-i:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (out.status !== 0 || !out.stdout) return null;
  return parseInt(out.stdout.trim().split('\n')[0], 10) || null;
}

// 展示占用者身份(不拦截、不判断归属):Windows tasklist 取映像名,POSIX ps 取 comm
export function getPidCommand(pid) {
  if (process.platform === 'win32') {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const line = (out.stdout || '').split('\n').find(l => l.trim().startsWith('"'));
    if (!line) return null;
    const first = line.match(/"([^"]*)"/g);
    return first && first[0] ? first[0].slice(1, -1) : null;
  }
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
}

// 不经配置文件的硬杀:win32 直接 taskkill /F;POSIX 先 SIGTERM,宽限后仍在则补
// SIGKILL。最终以「进程是否已不存在」为准,不吞错——占用者可能不是我们的
// daemon,调用方应先把身份展示给用户确认。
// async + 让出事件循环是必须的:若用同步睡眠,libuv 没机会处理 SIGCHLD、
// 收割僵尸进程,kill(pid,0) 会一直命中 zombie,把「已死」误判成「仍存活」
export async function killPidHard(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // pid 不存在(ESRCH)也算达成目的,由结尾的存在性检查统一判定
  }
  if (process.platform !== 'win32') {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  return !pidAlive(pid);
}

export async function startServerDaemon(rootDir, port = DEFAULT_PORT, token, policy = DEFAULT_POLICY) {
  if (await isPortInUse(port)) {
    // 只拒绝、不杀:占用者可能是旧 lansync server 或其他应用,不能自动 kill。
    // 给出明确出路:换端口,或用对应命令停掉占用者。
    throw new Error(
      `Port ${port} is in use. Either start on another port (lansyncopt server start --port <n>), ` +
      `or stop the process holding it (lansyncopt server stop for a leftover daemon; ` +
      `lansync server stop if the old lansync server is running)`
    );
  }

  // 注意:必须用 fileURLToPath。Windows 下 new URL().pathname 会得到 /C:/...,
  // spawn 出来的 daemon 会立即报 "Cannot find module" 死掉,而旧代码还在 500ms 后假装成功。
  const serverPath = fileURLToPath(import.meta.url);

  // daemon 的 stderr 落到日志,启动失败时能看到真实报错(而不是静默死掉)
  const logFile = path.join(getConfigDir(), 'server.log');
  try { fs.mkdirSync(getConfigDir(), { recursive: true }); } catch {}

  // 先写 token/policy 等鉴权配置,再 spawn:daemon 的每个请求都会读它,启动自检也带 token
  writeServerConfig({ token, policy, rootDir, port });

  const child = spawn(process.execPath, [
    serverPath,
    '--daemon',
    rootDir,
    String(port)
  ], {
    detached: true,
    stdio: ['ignore', 'ignore', fs.openSync(logFile, 'a')],
    windowsHide: true
  });

  child.unref();

  // 轮询确认 server 真正起来(最多 3 秒),没起来明确报错,不假装成功
  let up = false;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/list?path=`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) { up = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!up) {
    // 清掉半截配置,避免残留一个指向死进程的状态
    try { fs.unlinkSync(path.join(getConfigDir(), 'server.json')); } catch {}
    throw new Error(`Server failed to start on port ${port}. Check the log for details: ${logFile}`);
  }

  // 补写 pid/ip(保留 token/policy/rootDir/port)
  const config = readServerConfig() || {};
  config.pid = child.pid;
  config.ip = getLocalIP();
  writeServerConfig(config);

  return { pid: child.pid, port, ip: config.ip, rootDir };
}

export function stopServerDaemon() {
  const config = readServerConfig();
  if (!config || !config.pid) {
    return false;
  }

  try {
    process.kill(config.pid, 'SIGTERM');
  } catch {
    // Process might already be dead
  }

  // Clear config
  const configFile = path.join(getConfigDir(), 'server.json');
  try {
    fs.unlinkSync(configFile);
  } catch {
    // Ignore
  }

  return true;
}

export function getServerStatus() {
  const config = readServerConfig();
  if (!config) {
    return { status: 'stopped' };
  }

  let isRunning = false;
  try {
    process.kill(config.pid, 0);
    isRunning = true;
  } catch {
    // Process not running
  }

  return {
    status: isRunning ? 'running' : 'stopped',
    pid: config.pid,
    port: config.port,
    rootDir: config.rootDir,
    ip: config.ip,
    url: `http://${config.ip}:${config.port}`,
    policy: config.policy || DEFAULT_POLICY
  };
}

// Daemon entry point
if (process.argv[2] === '--daemon') {
  const rootDir = process.argv[3];
  const port = parseInt(process.argv[4], 10) || DEFAULT_PORT;

  const server = createServer(rootDir);
  server.listen(port, () => {
    // Daemon is running
  });
}