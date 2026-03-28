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
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND' ||
        err.code === 'ETIMEDOUT' ||
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

export async function checkServerReachable(serverUrl) {
  try {
    const res = await fetchWithTimeout(`${serverUrl}/api/list?path=`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchFileList(serverUrl, pathPrefix) {
  const url = `${serverUrl}/api/list?path=${encodeURIComponent(pathPrefix)}`;
  const res = await fetchWithTimeout(url);

  if (!res.ok) {
    throw new Error(`Failed to fetch file list: ${res.status}`);
  }

  const data = await res.json();
  return data.files || [];
}

export async function fetchFile(serverUrl, filePath) {
  const url = `${serverUrl}/api/file?path=${encodeURIComponent(filePath)}`;
  const res = await fetchWithTimeout(url);

  if (!res.ok) {
    if (res.status === 404) {
      return null;
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

export async function uploadFile(serverUrl, filePath, content) {
  const url = `${serverUrl}/api/file`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'X-Path': encodeURIComponent(filePath)
    },
    body: content
  });

  if (!res.ok) {
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

export async function deleteFile(serverUrl, filePath) {
  const url = `${serverUrl}/api/file?path=${encodeURIComponent(filePath)}`;
  const res = await fetchWithTimeout(url, {
    method: 'DELETE'
  });

  if (!res.ok) {
    if (res.status === 404) {
      return { success: true };
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
  for (const rule of rules) {
    if (rule.endsWith('/')) {
      const dirRule = rule.slice(0, -1);
      if (filepath === dirRule || filepath.startsWith(dirRule + '/') || filepath.startsWith(dirRule + '\\')) {
        return true;
      }
      if (minimatch(filepath, rule + '**', { dot: true })) {
        return true;
      }
    }
    if (minimatch(filepath, rule, { dot: true })) {
      return true;
    }
    if (minimatch(filepath, '**/' + rule, { dot: true })) {
      return true;
    }
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

const DEFAULT_IGNORE_RULES = ['.git', '.lansync', 'node_modules', '.DS_Store', 'Thumbs.db'];

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

export async function pull({ serverUrl, workDir, currentDir, pattern, noDelete }) {
  const validation = validateWorkDir(currentDir, workDir);
  if (!validation.valid) {
    throw new Error(`${validation.error}\nCurrent directory: ${validation.currentDir}`);
  }

  const pathPrefix = validation.pathPrefix;
  const ignoreRules = loadIgnoreRules(workDir);

  // Expand pattern for directory matching
  const expandedPattern = expandPattern(pattern);

  // Fetch server file list (paths are relative to rootDir)
  let serverFiles = await fetchFileList(serverUrl, pathPrefix);

  // Convert server paths to be relative to currentDir for consistent comparison
  // Server returns paths like "subfolder/file.txt", but we need "file.txt" when in subfolder
  serverFiles = serverFiles.map(f => {
    let relativePath = f.path;
    if (pathPrefix) {
      const prefixWithSlash = pathPrefix + '/';
      const prefixWithBackslash = pathPrefix + '\\';
      if (f.path.startsWith(prefixWithSlash)) {
        relativePath = f.path.slice(prefixWithSlash.length);
      } else if (f.path.startsWith(prefixWithBackslash)) {
        relativePath = f.path.slice(prefixWithBackslash.length);
      }
    }
    return { ...f, path: relativePath, serverPath: f.path };
  });

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
      const content = await withRetry(() => fetchFile(serverUrl, file.serverPath || file.path));
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

export async function push({ serverUrl, workDir, currentDir, pattern, noDelete }) {
  const validation = validateWorkDir(currentDir, workDir);
  if (!validation.valid) {
    throw new Error(`${validation.error}\nCurrent directory: ${validation.currentDir}`);
  }

  const pathPrefix = validation.pathPrefix;
  const ignoreRules = loadIgnoreRules(workDir);

  // Expand pattern for directory matching
  const expandedPattern = expandPattern(pattern);

  // Scan local files (paths are relative to currentDir)
  let localFiles = scanLocalFiles(currentDir, ignoreRules);

  // Add serverPath to local files for upload
  localFiles = localFiles.map(f => ({
    ...f,
    serverPath: pathPrefix ? `${pathPrefix}/${f.path}` : f.path
  }));

  // Filter by pattern if provided
  if (expandedPattern) {
    localFiles = localFiles.filter(f => minimatch(f.path, expandedPattern, { dot: true }));
  }

  // Fetch server file list (paths are relative to rootDir)
  let serverFiles = await fetchFileList(serverUrl, pathPrefix);

  // Convert server paths to be relative to currentDir for consistent comparison
  serverFiles = serverFiles.map(f => {
    let relativePath = f.path;
    if (pathPrefix) {
      const prefixWithSlash = pathPrefix + '/';
      const prefixWithBackslash = pathPrefix + '\\';
      if (f.path.startsWith(prefixWithSlash)) {
        relativePath = f.path.slice(prefixWithSlash.length);
      } else if (f.path.startsWith(prefixWithBackslash)) {
        relativePath = f.path.slice(prefixWithBackslash.length);
      }
    }
    return { ...f, path: relativePath, serverPath: f.path };
  });

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
      await withRetry(() => uploadFile(serverUrl, file.serverPath, content));
      uploaded.push(file.path);
    } catch (err) {
      failed.push({ path: file.path, error: err.message });
    }
  }

  // Execute deletes
  const deleted = [];
  for (const file of plan.toDelete) {
    try {
      await withRetry(() => deleteFile(serverUrl, file.serverPath));
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