// src/client.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { minimatch } from 'minimatch';

const TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

// Normalize path separators to forward slashes for cross-platform comparison
function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

// Compute hash of a file (MD5 for speed, sufficient for sync comparison)
function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

// Compute hash from buffer
function computeBufferHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// 把 undici 的 "fetch failed" 翻译成带错误码与提示的可操作信息。
// 真实原因藏在 err.cause(ECONNREFUSED/ENOTFOUND 等),不取出来用户就只看到一句 fetch failed。
function describeFetchError(err, serverUrl) {
  const cause = err?.cause || {};
  const code = cause.code || err.code || (err.name === 'AbortError' ? 'ETIMEDOUT' : '') || err.name;
  const hints = {
    ENOTFOUND: 'host not found - check the address for typos (see lansyncopt client status)',
    ECONNREFUSED: 'connection refused - server not running or wrong port',
    ETIMEDOUT: 'timed out - host unreachable or firewall',
    EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable',
    ECONNRESET: 'connection reset'
  };
  const hint = hints[code] || cause.message || err.message;
  const wrapped = new Error(`Cannot reach ${serverUrl} (${code}): ${hint}`);
  wrapped.code = code;
  return wrapped;
}

// 统一的网络请求封装:超时 + Bearer token + 网络错误翻译
async function apiFetch(url, { token, ...options } = {}) {
  const headers = { ...options.headers };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  try {
    return await fetchWithTimeout(url, { ...options, headers });
  } catch (err) {
    throw describeFetchError(err, new URL(url).origin);
  }
}

function unauthorizedError() {
  return new Error('Unauthorized: wrong password. Re-run: lansyncopt client config <ip:port>');
}

// Retry helper for network operations
async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Only retry on network errors (timeout, connection refused, etc.)
      const isNetworkError = err.name === 'AbortError' ||
        ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(err.code) ||
        err.message.includes('network') ||
        err.message.includes('timeout');

      if (!isNetworkError || attempt === maxRetries) {
        throw err;
      }
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

// 探活:网络失败/401 直接抛带 cause 的可操作错误(不再返回 bool)
export async function checkServerReachable(serverUrl, token) {
  const res = await apiFetch(`${serverUrl}/api/list?path=`, { token });
  if (res.status === 401) {
    throw unauthorizedError();
  }
  if (!res.ok) {
    throw new Error(`Server responded ${res.status} at ${serverUrl}`);
  }
  return true;
}

// 校验口令是否与 server 一致,返回 server 的 exec policy(client config 用)
export async function verifyAuth(serverUrl, token) {
  const res = await apiFetch(`${serverUrl}/api/auth`, { token });
  if (res.status === 401) {
    throw new Error('Password rejected by server (401). Check the password entered on the server side.');
  }
  if (!res.ok) {
    throw new Error(`Auth check failed: ${res.status}`);
  }
  const data = await res.json();
  return data.policy;
}

export async function fetchFileList(serverUrl, pathPrefix, token) {
  const url = `${serverUrl}/api/list?path=${encodeURIComponent(pathPrefix)}`;
  const res = await apiFetch(url, { token });

  if (!res.ok) {
    if (res.status === 401) {
      throw unauthorizedError();
    }
    throw new Error(`Failed to fetch file list: ${res.status}`);
  }

  const data = await res.json();
  // exists 标识 pathPrefix 对应目录在 server 上是否存在;旧 server 无该字段,
  // 缺省按存在处理(仅新 server 会显式回 exists:false)
  return { files: data.files || [], exists: data.exists !== false };
}

export async function fetchFile(serverUrl, filePath, token) {
  const url = `${serverUrl}/api/file?path=${encodeURIComponent(filePath)}`;
  const res = await apiFetch(url, { token });

  if (!res.ok) {
    if (res.status === 404) {
      return null;
    }
    if (res.status === 401) {
      throw unauthorizedError();
    }
    // Try to get error details from response
    let errorDetail = '';
    try {
      const errorData = await res.json();
      errorDetail = errorData.error || '';
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(`Failed to fetch file "${filePath}": ${res.status}${errorDetail ? ` - ${errorDetail}` : ''}`);
  }

  return res.arrayBuffer();
}

export async function uploadFile(serverUrl, filePath, content, token) {
  const url = `${serverUrl}/api/file`;
  const res = await apiFetch(url, {
    token,
    method: 'POST',
    headers: {
      'X-Path': encodeURIComponent(filePath)
    },
    body: content
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw unauthorizedError();
    }
    let errorDetail = '';
    try {
      const errorData = await res.json();
      errorDetail = errorData.error || '';
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(`Failed to upload file "${filePath}": ${res.status}${errorDetail ? ` - ${errorDetail}` : ''}`);
  }

  return res.json();
}

export async function deleteFile(serverUrl, filePath, token) {
  const url = `${serverUrl}/api/file?path=${encodeURIComponent(filePath)}`;
  const res = await apiFetch(url, { token, method: 'DELETE' });

  if (!res.ok) {
    if (res.status === 404) {
      return { success: true };
    }
    if (res.status === 401) {
      throw unauthorizedError();
    }
    let errorDetail = '';
    try {
      const errorData = await res.json();
      errorDetail = errorData.error || '';
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(`Failed to delete file "${filePath}": ${res.status}${errorDetail ? ` - ${errorDetail}` : ''}`);
  }

  return res.json();
}

// 执行远程命令(不设超时:命令可无限运行,client 断开后 server 自行杀进程)
export async function execRemote(serverUrl, token, command) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ command })
    });
  } catch (err) {
    throw describeFetchError(err, serverUrl);
  }

  if (res.status === 401) {
    throw unauthorizedError();
  }
  if (res.status === 403) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(detail || 'Command blocked');
  }
  if (res.status === 429) {
    throw new Error('Too many concurrent commands');
  }
  if (!res.ok) {
    throw new Error(`Exec failed: ${res.status}`);
  }
  return res.json();
}

export function validateWorkDir(currentDir, workDir) {
  const normalizedCurrent = path.resolve(currentDir);
  const normalizedWork = path.resolve(workDir);

  if (!normalizedCurrent.startsWith(normalizedWork)) {
    return {
      valid: false,
      error: `Must run inside workDir: ${workDir}`,
      currentDir: normalizedCurrent
    };
  }

  const pathPrefix = normalizedCurrent === normalizedWork
    ? ''
    : path.relative(normalizedWork, normalizedCurrent);

  return {
    valid: true,
    pathPrefix
  };
}

export function scanLocalFiles(dir, ignoreRules) {
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
      const relativePath = path.relative(dir, fullPath);

      if (shouldIgnore(relativePath, ignoreRules)) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath);
          const hash = crypto.createHash('md5').update(content).digest('hex');
          results.push({
            path: relativePath,
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

function shouldIgnore(filepath, rules) {
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
  if (pattern.endsWith('/')) {
    const dirRule = pattern.slice(0, -1);
    if (filepath === dirRule || filepath.startsWith(dirRule + '/') || filepath.startsWith(dirRule + '\\')) {
      return true;
    }
    if (minimatch(filepath, pattern + '**', { dot: true })) {
      return true;
    }
  }
  if (minimatch(filepath, pattern, { dot: true })) {
    return true;
  }
  if (minimatch(filepath, '**/' + pattern, { dot: true })) {
    return true;
  }
  return false;
}

export function computePullPlan(serverFiles, localFiles, noDelete) {
  const toDownload = [];
  const toSkip = [];
  const toDelete = [];
  let keptCount = 0;

  // Normalize paths for cross-platform comparison
  const localMap = new Map(localFiles.map(f => [normalizePath(f.path), f]));

  for (const serverFile of serverFiles) {
    const normalizedServerPath = normalizePath(serverFile.path);
    const localFile = localMap.get(normalizedServerPath);

    if (!localFile) {
      // File doesn't exist locally
      toDownload.push(serverFile);
    } else if (localFile.mtime === serverFile.mtime && localFile.size === serverFile.size) {
      // mtime and size match exactly - skip (fast path)
      toSkip.push(serverFile);
    } else if (localFile.hash === serverFile.hash) {
      // Content identical - skip (hash verification)
      toSkip.push(serverFile);
    } else {
      // Content differs
      toDownload.push(serverFile);
    }

    localMap.delete(normalizedServerPath);
  }

  // Remaining local files not on server
  for (const localFile of localMap.values()) {
    if (noDelete) {
      keptCount++;
    } else {
      toDelete.push(localFile);
    }
  }

  return { toDownload, toSkip, toDelete, keptCount };
}

// 清单级 diff:只陈述「两边内容是否一致」,不偏向 push/pull 任何一方。
// 判定只用 hash,不复用 push/pull 的 mtime+size 快路径——diff 是给「确认是否
// 同步」用的事实报告,若走快路径会出现「diff 说 modified、push 却说 skip」
// 的自相矛盾。status 三态:modified / local-only / server-only;
// 两边一致的文件不进 files,只计入 summary.inSync。
function diffMeta(f) {
  return { size: f.size, mtime: f.mtime, hash: f.hash };
}

export function computeDiffInventory(localFiles, serverFiles) {
  const localMap = new Map(localFiles.map(f => [normalizePath(f.path), f]));
  const serverMap = new Map(serverFiles.map(f => [normalizePath(f.path), f]));

  const files = [];
  let inSyncCount = 0;

  for (const [key, local] of localMap) {
    const server = serverMap.get(key);
    if (!server) {
      files.push({ path: key, status: 'local-only', local: diffMeta(local), server: null });
      continue;
    }
    serverMap.delete(key);
    if (local.hash === server.hash) {
      inSyncCount++;
    } else {
      files.push({ path: key, status: 'modified', local: diffMeta(local), server: diffMeta(server) });
    }
  }

  for (const [key, server] of serverMap) {
    files.push({ path: key, status: 'server-only', local: null, server: diffMeta(server) });
  }

  // 按路径排序:两次 diff 的输出可做位置对比(agent 消费场景)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    inSync: files.length === 0,
    files,
    summary: {
      modified: files.filter(f => f.status === 'modified').length,
      localOnly: files.filter(f => f.status === 'local-only').length,
      serverOnly: files.filter(f => f.status === 'server-only').length,
      inSync: inSyncCount
    }
  };
}

// 清单级 diff 的一次编排:一次 /api/list + 本地扫描,零协议改动,只读不传输。
// server 目录不存在不算错误(与 pull 的拒绝语义不同):diff 是只读的事实报告,
// 此时 server 侧清单为空,本地文件如实报告为 local-only。
export async function diff({ serverUrl, workDir, currentDir, pattern, token }) {
  const validation = validateWorkDir(currentDir, workDir);
  if (!validation.valid) {
    throw new Error(`${validation.error}\nCurrent directory: ${validation.currentDir}`);
  }

  // win32 上 path.relative 产出反斜杠前缀,统一为 `/`(server 端按正斜杠解析)
  const pathPrefix = normalizePath(validation.pathPrefix);
  const ignoreRules = loadIgnoreRules(workDir);

  // Expand pattern for directory matching
  const expandedPattern = expandPattern(pattern);

  const listing = await fetchFileList(serverUrl, pathPrefix, token);
  let serverFiles = mapServerFiles(listing.files, pathPrefix);

  if (expandedPattern) {
    serverFiles = serverFiles.filter(f => minimatch(f.path, expandedPattern, { dot: true }));
  }

  let localFiles = scanLocalFiles(currentDir, ignoreRules);
  // win32 上扫描结果是反斜杠路径:统一为 `/`,与 server 侧一致
  localFiles = localFiles.map(f => ({ ...f, path: normalizePath(f.path) }));

  if (expandedPattern) {
    localFiles = localFiles.filter(f => minimatch(f.path, expandedPattern, { dot: true }));
  }

  const inventory = computeDiffInventory(localFiles, serverFiles);

  return {
    ...inventory,
    localRoot: currentDir,
    prefix: pathPrefix,
    serverDirExists: listing.exists
  };
}

export function computePushPlan(localFiles, serverFiles, noDelete) {
  const toUpload = [];
  const toSkip = [];
  const toDelete = [];
  let keptCount = 0;

  // Normalize paths for cross-platform comparison
  const serverMap = new Map(serverFiles.map(f => [normalizePath(f.path), f]));

  for (const localFile of localFiles) {
    const normalizedLocalPath = normalizePath(localFile.path);
    const serverFile = serverMap.get(normalizedLocalPath);

    if (!serverFile) {
      // File doesn't exist on server
      toUpload.push(localFile);
    } else if (serverFile.mtime === localFile.mtime && serverFile.size === localFile.size) {
      // mtime and size match exactly - skip (fast path)
      toSkip.push(localFile);
    } else if (serverFile.hash === localFile.hash) {
      // Content identical - skip (hash verification)
      toSkip.push(localFile);
    } else {
      // Content differs
      toUpload.push(localFile);
    }

    serverMap.delete(normalizedLocalPath);
  }

  // Remaining server files not on client
  for (const serverFile of serverMap.values()) {
    if (noDelete) {
      keptCount++;
    } else {
      toDelete.push(serverFile);
    }
  }

  return { toUpload, toSkip, toDelete, keptCount };
}

const DEFAULT_IGNORE_RULES = ['.git', '.lansync', '.lansyncopt', 'node_modules', '.DS_Store', 'Thumbs.db'];

function loadIgnoreRules(workDir) {
  const rules = [...DEFAULT_IGNORE_RULES];
  const gitignorePath = path.join(workDir, '.gitignore');

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const parsed = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    rules.push(...parsed);
  }

  return rules;
}

// Expand pattern to support directory matching
// - 'dir' or 'dir/' -> '{dir,dir/**}' (match dir itself and all files inside)
// - 'file.txt' -> 'file.txt' (exact file match)
// - '**/pattern' -> stays as is
function expandPattern(pattern) {
  if (!pattern) return pattern;

  // If pattern already has glob wildcards, use as-is
  if (pattern.includes('*') || pattern.includes('?')) {
    return pattern;
  }

  // If pattern ends with /, it's explicitly a directory
  if (pattern.endsWith('/')) {
    return pattern + '**';
  }

  // Check if it looks like a file (has extension or is a dotfile)
  const lastPart = pattern.split('/').pop();

  // Dotfiles like .gitignore, .env are files
  if (lastPart.startsWith('.')) {
    return pattern;
  }

  // Has extension if there's a dot followed by letters/numbers at the end
  if (/\.[a-zA-Z0-9]+$/.test(lastPart)) {
    return pattern;
  }

  // No extension - could be a file or directory
  // Match both the file itself and all files inside the directory
  return `{${pattern},${pattern}/**}`;
}

// server 列表 → client 视角:统一正斜杠、剥离 pathPrefix。
// server 路径相对 rootDir,client 需要相对 currentDir 的路径;
// path/serverPath 共用同一份归一化字符串,落盘、请求、过滤不再各走各的
function mapServerFiles(serverFiles, pathPrefix) {
  return serverFiles.map(f => {
    // 新 server 已统一 `/`;normalizePath 再兜底旧 Windows server 的反斜杠输出
    const wirePath = normalizePath(f.path);
    const relativePath = pathPrefix && wirePath.startsWith(pathPrefix + '/')
      ? wirePath.slice(pathPrefix.length + 1)
      : wirePath;
    return { ...f, path: relativePath, serverPath: wirePath };
  });
}

export async function pull({ serverUrl, workDir, currentDir, pattern, noDelete, token }) {
  const validation = validateWorkDir(currentDir, workDir);
  if (!validation.valid) {
    throw new Error(`${validation.error}\nCurrent directory: ${validation.currentDir}`);
  }

  // win32 上 path.relative 产出反斜杠前缀,统一为 `/`(server 端按正斜杠解析)
  const pathPrefix = normalizePath(validation.pathPrefix);
  const ignoreRules = loadIgnoreRules(workDir);

  // Expand pattern for directory matching
  const expandedPattern = expandPattern(pattern);

  // Fetch server file list (paths are relative to rootDir)
  const listing = await fetchFileList(serverUrl, pathPrefix, token);
  if (!listing.exists) {
    // 目录不存在时列表为空,计划会把本地文件全部判为 toDelete,必须直接拒绝
    throw new Error(
      `Server has no directory "${pathPrefix || '.'}" - refusing to pull to avoid deleting local files`
    );
  }
  let serverFiles = mapServerFiles(listing.files, pathPrefix);

  // Filter by pattern if provided
  if (expandedPattern) {
    serverFiles = serverFiles.filter(f => minimatch(f.path, expandedPattern, { dot: true }));
  }

  // Scan local files (paths are relative to currentDir)
  let localFiles = scanLocalFiles(currentDir, ignoreRules);

  // Filter local files by the same pattern to prevent deleting files outside pattern
  if (expandedPattern) {
    localFiles = localFiles.filter(f => minimatch(f.path, expandedPattern, { dot: true }));
  }

  // When pattern is specified, never delete files outside the pattern scope
  const effectiveNoDelete = noDelete || !!expandedPattern;

  // Compute plan
  const plan = computePullPlan(serverFiles, localFiles, effectiveNoDelete);

  // Execute downloads with retry and error collection
  const downloaded = [];
  const failed = [];
  for (const file of plan.toDownload) {
    try {
      // Use serverPath for fetching (relative to rootDir)
      const content = await withRetry(() => fetchFile(serverUrl, file.serverPath || file.path, token));
      if (content) {
        // Use path for local saving (relative to currentDir)
        const localPath = path.join(currentDir, file.path);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, Buffer.from(content));
        downloaded.push(file.path);
      }
    } catch (err) {
      failed.push({ path: file.path, error: err.message });
    }
  }

  // Execute deletes
  const deleted = [];
  for (const file of plan.toDelete) {
    const localPath = path.join(currentDir, file.path);
    try {
      fs.unlinkSync(localPath);
      deleted.push(file.path);
    } catch {
      // Ignore errors
    }
  }

  // Clean empty directories
  cleanEmptyDirs(currentDir);

  return {
    downloaded,
    skipped: plan.toSkip.map(f => f.path),
    deleted,
    keptCount: plan.keptCount,
    failed
  };
}

export async function push({ serverUrl, workDir, currentDir, pattern, noDelete, token }) {
  const validation = validateWorkDir(currentDir, workDir);
  if (!validation.valid) {
    throw new Error(`${validation.error}\nCurrent directory: ${validation.currentDir}`);
  }

  // win32 上 path.relative 产出反斜杠前缀,统一为 `/`(server 端按正斜杠解析)
  const pathPrefix = normalizePath(validation.pathPrefix);
  const ignoreRules = loadIgnoreRules(workDir);

  // Expand pattern for directory matching
  const expandedPattern = expandPattern(pattern);

  // Scan local files (paths are relative to currentDir)
  let localFiles = scanLocalFiles(currentDir, ignoreRules);

  // win32 上扫描结果是反斜杠路径:统一为 `/`,pattern 过滤、本地读取、
  // 展示在所有平台行为一致;serverPath 相对 rootDir
  localFiles = localFiles.map(f => ({
    ...f,
    path: normalizePath(f.path),
    serverPath: normalizePath(pathPrefix ? `${pathPrefix}/${f.path}` : f.path)
  }));

  // Filter by pattern if provided
  if (expandedPattern) {
    localFiles = localFiles.filter(f => minimatch(f.path, expandedPattern, { dot: true }));
  }

  // Fetch server file list (paths are relative to rootDir)
  // push 对"目录不存在"直接按空列表处理:首次向新子目录 push 属正常场景,
  // 空列表意味着全部上传、无需剔除
  const listing = await fetchFileList(serverUrl, pathPrefix, token);
  let serverFiles = mapServerFiles(listing.files, pathPrefix);

  // Filter server files by the same pattern to prevent deleting files outside pattern
  if (expandedPattern) {
    serverFiles = serverFiles.filter(f => minimatch(f.path, expandedPattern, { dot: true }));
  }

  // When pattern is specified, never delete files outside the pattern scope
  const effectiveNoDelete = noDelete || !!expandedPattern;

  // Compute plan
  const plan = computePushPlan(localFiles, serverFiles, effectiveNoDelete);

  // Execute uploads with retry and error collection
  const uploaded = [];
  const failed = [];
  for (const file of plan.toUpload) {
    try {
      const localPath = path.join(currentDir, file.path);
      const content = fs.readFileSync(localPath);
      await withRetry(() => uploadFile(serverUrl, file.serverPath, content, token));
      uploaded.push(file.path);
    } catch (err) {
      failed.push({ path: file.path, error: err.message });
    }
  }

  // Execute deletes
  const deleted = [];
  for (const file of plan.toDelete) {
    try {
      await withRetry(() => deleteFile(serverUrl, file.serverPath, token));
      deleted.push(file.path);
    } catch (err) {
      failed.push({ path: file.path, error: err.message });
    }
  }

  return {
    uploaded,
    skipped: plan.toSkip.map(f => f.path),
    deleted,
    keptCount: plan.keptCount,
    failed
  };
}

function cleanEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subDir = path.join(dir, entry.name);
      cleanEmptyDirs(subDir);

      // Check if directory is now empty
      const subEntries = fs.readdirSync(subDir);
      if (subEntries.length === 0) {
        fs.rmdirSync(subDir);
      }
    }
  }
}