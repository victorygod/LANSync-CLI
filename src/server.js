// src/server.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { minimatch } from 'minimatch';
import { readServerConfig, writeServerConfig, getConfigDir } from './config.js';

const DEFAULT_PORT = 8001;
const LOG_FILE = path.join(getConfigDir(), 'server.log');

// Simple logger that writes to file
function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.appendFileSync(LOG_FILE, logLine);
  } catch {
    // Ignore log errors
  }
}

const DEFAULT_IGNORE_RULES = [
  '.git',
  '.lansync',
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
  for (const rule of rules) {
    // Handle directory patterns (ending with /)
    if (rule.endsWith('/')) {
      const dirRule = rule.slice(0, -1);
      // Match directory itself or anything inside
      if (filepath === dirRule || filepath.startsWith(dirRule + '/') || filepath.startsWith(dirRule + '\\')) {
        return true;
      }
      // Also match with minimatch for glob patterns like dist/
      if (minimatch(filepath, rule + '**', { dot: true })) {
        return true;
      }
    }
    // Direct match
    if (minimatch(filepath, rule, { dot: true })) {
      return true;
    }
    // Match file inside a directory pattern (for bare names like node_modules)
    if (filepath === rule || filepath.startsWith(rule + '/') || filepath.startsWith(rule + '\\')) {
      return true;
    }
    // Match directory anywhere in the path
    if (filepath.includes('/' + rule + '/') || filepath.includes('\\' + rule + '\\')) {
      return true;
    }
    // Match with ** prefix for glob patterns
    if (minimatch(filepath, '**/' + rule, { dot: true })) {
      return true;
    }
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

export function createServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Path');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      if (pathname === '/api/list' && req.method === 'GET') {
        await handleList(url, rootDir, res);
      } else if (pathname === '/api/file' && req.method === 'GET') {
        await handleFileGet(url, rootDir, res);
      } else if (pathname === '/api/file' && req.method === 'POST') {
        await handleFilePost(req, rootDir, res);
      } else if (pathname === '/api/file' && req.method === 'DELETE') {
        await handleFileDelete(url, rootDir, res);
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: [] }));
    return;
  }

  const ignoreRules = readGitignore(rootDir);
  const files = walkDir(targetDir, rootDir, ignoreRules);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ files }));
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
  const filePath = encodedPath ? decodeURIComponent(encodedPath) : null;
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

export async function startServerDaemon(rootDir, port = DEFAULT_PORT) {
  if (await isPortInUse(port)) {
    throw new Error(`Port ${port} is in use`);
  }

  const child = spawn(process.execPath, [
    path.join(path.dirname(new URL(import.meta.url).pathname), 'server.js'),
    '--daemon',
    rootDir,
    String(port)
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });

  child.unref();

  // Wait a bit for server to start
  await new Promise(resolve => setTimeout(resolve, 500));

  const ip = getLocalIP();
  writeServerConfig({
    pid: child.pid,
    port,
    rootDir,
    ip
  });

  return { pid: child.pid, port, ip, rootDir };
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
    url: `http://${config.ip}:${config.port}`
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