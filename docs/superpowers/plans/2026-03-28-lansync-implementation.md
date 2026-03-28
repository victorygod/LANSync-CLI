# lansync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal LAN file sync tool for syncing code between machines.

**Architecture:** Node.js HTTP server (native `http` module) + CLI client. Server exposes REST APIs for file operations. Client uses native `fetch` for HTTP calls. Config stored in `~/.lansync/` as JSON files.

**Tech Stack:** Node.js 18+, minimatch for glob patterns, native http/fetch/fs modules.

---

## File Structure

```
lansync/
├── package.json
├── bin/
│   └── lansync.js          # CLI entry point
├── src/
│   ├── cli.js              # Command parser
│   ├── server.js           # HTTP server + file APIs
│   ├── client.js           # Push/pull sync logic
│   └── config.js           # Config management
└── test/
    ├── test-server.js      # Server API tests
    ├── test-client.js      # Client sync tests
    └── fixtures/           # Test files
```

---

### Task 1: Project Setup

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "lansync",
  "version": "1.0.0",
  "description": "Minimal LAN file sync tool",
  "type": "module",
  "bin": {
    "lansync": "./bin/lansync.js"
  },
  "scripts": {
    "test": "node --test test/*.js"
  },
  "dependencies": {
    "minimatch": "^9.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: node_modules created with minimatch

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: initial project setup"
```

---

### Task 2: Config Module

**Files:**
- Create: `src/config.js`
- Create: `test/test-config.js`

- [ ] **Step 1: Write failing tests for config module**

```javascript
// test/test-config.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigDir, readServerConfig, writeServerConfig, readClientConfig, writeClientConfig } from '../src/config.js';

describe('config module', () => {
  let originalHome;

  beforeEach(() => {
    originalHome = process.env.HOME;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-test-'));
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  describe('getConfigDir', () => {
    it('returns ~/.lansync path', () => {
      const configDir = getConfigDir();
      assert.ok(configDir.endsWith('.lansync'));
    });
  });

  describe('server config', () => {
    it('returns null when config does not exist', () => {
      const config = readServerConfig();
      assert.strictEqual(config, null);
    });

    it('writes and reads server config', () => {
      const data = { pid: 12345, port: 8001, rootDir: '/tmp/test', ip: '192.168.1.1' };
      writeServerConfig(data);
      const config = readServerConfig();
      assert.deepStrictEqual(config, data);
    });
  });

  describe('client config', () => {
    it('returns null when config does not exist', () => {
      const config = readClientConfig();
      assert.strictEqual(config, null);
    });

    it('writes and reads client config', () => {
      const data = { serverUrl: 'http://192.168.1.1:8001', workDir: '/tmp/project' };
      writeClientConfig(data);
      const config = readClientConfig();
      assert.deepStrictEqual(config, data);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/config.js'"

- [ ] **Step 3: Implement config module**

```javascript
// src/config.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getConfigDir() {
  return path.join(os.homedir(), '.lansync');
}

function ensureConfigDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readServerConfig() {
  const file = path.join(getConfigDir(), 'server.json');
  if (!fs.existsSync(file)) {
    return null;
  }
  const content = fs.readFileSync(file, 'utf-8');
  return JSON.parse(content);
}

export function writeServerConfig(config) {
  ensureConfigDir();
  const file = path.join(getConfigDir(), 'server.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

export function readClientConfig() {
  const file = path.join(getConfigDir(), 'client.json');
  if (!fs.existsSync(file)) {
    return null;
  }
  const content = fs.readFileSync(file, 'utf-8');
  return JSON.parse(content);
}

export function writeClientConfig(config) {
  ensureConfigDir();
  const file = path.join(getConfigDir(), 'client.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/test-config.js
git commit -m "feat: add config module"
```

---

### Task 3: Server Core - Path Utilities

**Files:**
- Create: `src/server.js` (partial)
- Create: `test/test-server.js`

- [ ] **Step 1: Write failing tests for path utilities**

```javascript
// test/test-server.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizePath, getLocalIP } from '../src/server.js';

describe('server utilities', () => {
  describe('sanitizePath', () => {
    const rootDir = '/tmp/project';

    it('returns absolute path for valid relative path', () => {
      const result = sanitizePath('src/index.js', rootDir);
      assert.strictEqual(result, '/tmp/project/src/index.js');
    });

    it('handles URL encoded paths', () => {
      const result = sanitizePath('src%20files/test.js', rootDir);
      assert.strictEqual(result, '/tmp/project/src files/test.js');
    });

    it('returns null for path traversal attack', () => {
      const result = sanitizePath('../etc/passwd', rootDir);
      assert.strictEqual(result, null);
    });

    it('returns null for null byte injection', () => {
      const result = sanitizePath('file\u0000.js', rootDir);
      assert.strictEqual(result, null);
    });

    it('returns null for path escaping root', () => {
      const result = sanitizePath('foo/../../bar', rootDir);
      // This resolves to /tmp/bar which is outside /tmp/project
      assert.strictEqual(result, null);
    });
  });

  describe('getLocalIP', () => {
    it('returns a valid IP address', () => {
      const ip = getLocalIP();
      // Should be a valid IPv4 address or fallback
      assert.ok(typeof ip === 'string');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/server.js'" or "sanitizePath is not exported"

- [ ] **Step 3: Implement path utilities**

```javascript
// src/server.js
import os from 'node:os';
import path from 'node:path';

export function sanitizePath(requestedPath, rootDir) {
  // Decode URL encoding
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    return null;
  }

  // Block path traversal and null bytes
  if (decoded.includes('..') || decoded.includes('\0')) {
    return null;
  }

  // Normalize and resolve
  const absolutePath = path.resolve(rootDir, decoded);

  // Ensure path is within root
  if (!absolutePath.startsWith(rootDir)) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/test-server.js
git commit -m "feat: add server path utilities"
```

---

### Task 4: Server Core - Ignore Rules

**Files:**
- Modify: `src/server.js`
- Modify: `test/test-server.js`

- [ ] **Step 1: Write failing tests for ignore rules**

Add to `test/test-server.js`:

```javascript
import { parseGitignore, shouldIgnore, getDefaultIgnoreRules } from '../src/server.js';

describe('ignore rules', () => {
  describe('getDefaultIgnoreRules', () => {
    it('returns default ignore patterns', () => {
      const rules = getDefaultIgnoreRules();
      assert.ok(rules.includes('.git'));
      assert.ok(rules.includes('node_modules'));
      assert.ok(rules.includes('.DS_Store'));
    });
  });

  describe('parseGitignore', () => {
    it('parses gitignore content', () => {
      const content = `dist/
*.log
# comment
.env`;
      const rules = parseGitignore(content);
      assert.deepStrictEqual(rules, ['dist/', '*.log', '.env']);
    });

    it('returns empty array for empty content', () => {
      const rules = parseGitignore('');
      assert.deepStrictEqual(rules, []);
    });
  });

  describe('shouldIgnore', () => {
    const rules = ['dist/', '*.log', '.env', 'node_modules'];

    it('ignores files matching pattern', () => {
      assert.ok(shouldIgnore('dist/bundle.js', rules));
      assert.ok(shouldIgnore('debug.log', rules));
      assert.ok(shouldIgnore('.env', rules));
      assert.ok(shouldIgnore('node_modules/package/index.js', rules));
    });

    it('does not ignore non-matching files', () => {
      assert.ok(!shouldIgnore('src/index.js', rules));
      assert.ok(!shouldIgnore('package.json', rules));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with exports not found

- [ ] **Step 3: Implement ignore rules**

Add to `src/server.js`:

```javascript
import minimatch from 'minimatch';

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
    // Match file inside a directory pattern
    if (minimatch(filepath, '**/' + rule, { dot: true })) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/test-server.js
git commit -m "feat: add gitignore parsing and ignore rules"
```

---

### Task 5: Server Core - File Walking

**Files:**
- Modify: `src/server.js`
- Modify: `test/test-server.js`

- [ ] **Step 1: Write failing tests for file walking**

Add to `test/test-server.js`:

```javascript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { walkDir } from '../src/server.js';

describe('walkDir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-walk-'));
    fs.writeFileSync(path.join(tmpDir, 'root.txt'), 'root');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'index');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), 'pkg');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all files with metadata', () => {
    const files = walkDir(tmpDir, tmpDir, []);
    assert.ok(files.length >= 3);
    const paths = files.map(f => f.path);
    assert.ok(paths.includes('root.txt'));
    assert.ok(paths.includes('src/index.js') || paths.includes('src\\index.js'));
  });

  it('excludes ignored files', () => {
    const files = walkDir(tmpDir, tmpDir, ['node_modules']);
    const paths = files.map(f => f.path);
    assert.ok(!paths.some(p => p.includes('node_modules')));
  });

  it('includes file size and mtime', () => {
    const files = walkDir(tmpDir, tmpDir, []);
    const rootFile = files.find(f => f.path === 'root.txt');
    assert.ok(rootFile.size > 0);
    assert.ok(rootFile.mtime > 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with walkDir not exported

- [ ] **Step 3: Implement walkDir**

Add to `src/server.js`:

```javascript
import fs from 'node:fs';

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
          results.push({
            path: relativePath,
            size: stat.size,
            mtime: stat.mtimeMs
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/test-server.js
git commit -m "feat: add directory walking with ignore support"
```

---

### Task 6: Server Core - HTTP Server

**Files:**
- Modify: `src/server.js`
- Modify: `test/test-server.js`

- [ ] **Step 1: Write failing tests for HTTP server**

Add to `test/test-server.js`:

```javascript
import http from 'node:http';

describe('HTTP server', () => {
  let tmpDir;
  let server;
  let port;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-http-'));
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello world');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'nested.txt'), 'nested content');

    server = createServer(tmpDir);
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/list', () => {
    it('returns file list', async () => {
      const res = await fetch(`http://localhost:${port}/api/list`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.files));
      const paths = data.files.map(f => f.path);
      assert.ok(paths.includes('test.txt'));
    });

    it('supports path parameter', async () => {
      const res = await fetch(`http://localhost:${port}/api/list?path=sub`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      const paths = data.files.map(f => f.path);
      assert.ok(paths.some(p => p.includes('nested.txt')));
    });
  });

  describe('GET /api/file', () => {
    it('returns file content', async () => {
      const res = await fetch(`http://localhost:${port}/api/file?path=test.txt`);
      assert.strictEqual(res.status, 200);
      const content = await res.text();
      assert.strictEqual(content, 'hello world');
    });

    it('returns 404 for missing file', async () => {
      const res = await fetch(`http://localhost:${port}/api/file?path=missing.txt`);
      assert.strictEqual(res.status, 404);
    });

    it('returns 403 for path traversal', async () => {
      const res = await fetch(`http://localhost:${port}/api/file?path=../etc/passwd`);
      assert.strictEqual(res.status, 403);
    });
  });

  describe('POST /api/file', () => {
    it('uploads file', async () => {
      const res = await fetch(`http://localhost:${port}/api/file`, {
        method: 'POST',
        headers: { 'X-Path': 'new.txt' },
        body: 'new content'
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.success);
      assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'new.txt'), 'utf-8'), 'new content');
    });

    it('creates nested directories', async () => {
      const res = await fetch(`http://localhost:${port}/api/file`, {
        method: 'POST',
        headers: { 'X-Path': 'deep/nested/file.txt' },
        body: 'nested'
      });
      assert.strictEqual(res.status, 200);
      assert.ok(fs.existsSync(path.join(tmpDir, 'deep', 'nested', 'file.txt')));
    });
  });

  describe('DELETE /api/file', () => {
    it('deletes file', async () => {
      const res = await fetch(`http://localhost:${port}/api/file?path=test.txt`, {
        method: 'DELETE'
      });
      assert.strictEqual(res.status, 200);
      assert.ok(!fs.existsSync(path.join(tmpDir, 'test.txt')));
    });

    it('returns 404 for missing file', async () => {
      const res = await fetch(`http://localhost:${port}/api/file?path=missing.txt`, {
        method: 'DELETE'
      });
      assert.strictEqual(res.status, 404);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with createServer not exported

- [ ] **Step 3: Implement HTTP server**

Add to `src/server.js`:

```javascript
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
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  if (!fs.existsSync(absolutePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
    return;
  }

  const content = fs.readFileSync(absolutePath);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(content);
}

async function handleFilePost(req, rootDir, res) {
  const filePath = req.headers['x-path'];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/test-server.js
git commit -m "feat: add HTTP server with file APIs"
```

---

### Task 7: Server Daemon Management

**Files:**
- Modify: `src/server.js`
- Modify: `test/test-server.js`

- [ ] **Step 1: Write failing tests for daemon management**

Add to `test/test-server.js`:

```javascript
import { spawn } from 'node:child_process';
import { isPortInUse, startServerDaemon, stopServerDaemon, getServerStatus } from '../src/server.js';

describe('daemon management', () => {
  describe('isPortInUse', () => {
    it('returns false for unused port', async () => {
      const inUse = await isPortInUse(59999);
      assert.strictEqual(inUse, false);
    });

    it('returns true for used port', async () => {
      const server = http.createServer(() => {});
      await new Promise(resolve => server.listen(59998, resolve));
      const inUse = await isPortInUse(59998);
      assert.strictEqual(inUse, true);
      await new Promise(resolve => server.close(resolve));
    });
  });

  describe('getServerStatus', () => {
    it('returns stopped when no config', () => {
      const status = getServerStatus();
      assert.strictEqual(status.status, 'stopped');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with exports not found

- [ ] **Step 3: Implement daemon management**

Add to `src/server.js`:

```javascript
import net from 'node:net';
import { spawn } from 'node:child_process';

const DEFAULT_PORT = 8001;

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
```

- [ ] **Step 4: Import getConfigDir in server.js**

Add at top of `src/server.js`:

```javascript
import { readServerConfig, writeServerConfig, getConfigDir } from './config.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/test-server.js
git commit -m "feat: add server daemon management"
```

---

### Task 8: Client Core - HTTP Client

**Files:**
- Create: `src/client.js`
- Create: `test/test-client.js`

- [ ] **Step 1: Write failing tests for HTTP client**

```javascript
// test/test-client.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fetchFileList, fetchFile, uploadFile, deleteFile, checkServerReachable } from '../src/client.js';

describe('client HTTP functions', () => {
  let tmpDir;
  let server;
  let port;
  let serverUrl;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-client-'));
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello');

    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/api/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [{ path: 'test.txt', size: 5, mtime: 1000 }] }));
      } else if (url.pathname === '/api/file' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('file content');
      } else if (url.pathname === '/api/file' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else if (url.pathname === '/api/file' && req.method === 'DELETE') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
    serverUrl = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('checkServerReachable', () => {
    it('returns true for reachable server', async () => {
      const reachable = await checkServerReachable(serverUrl);
      assert.strictEqual(reachable, true);
    });

    it('returns false for unreachable server', async () => {
      const reachable = await checkServerReachable('http://localhost:59999');
      assert.strictEqual(reachable, false);
    });
  });

  describe('fetchFileList', () => {
    it('returns file list', async () => {
      const files = await fetchFileList(serverUrl, '');
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].path, 'test.txt');
    });
  });

  describe('fetchFile', () => {
    it('returns file content', async () => {
      const content = await fetchFile(serverUrl, 'test.txt');
      assert.strictEqual(content, 'file content');
    });
  });

  describe('uploadFile', () => {
    it('uploads file successfully', async () => {
      const result = await uploadFile(serverUrl, 'new.txt', Buffer.from('new content'));
      assert.strictEqual(result.success, true);
    });
  });

  describe('deleteFile', () => {
    it('deletes file successfully', async () => {
      const result = await deleteFile(serverUrl, 'test.txt');
      assert.strictEqual(result.success, true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with module not found

- [ ] **Step 3: Implement HTTP client**

```javascript
// src/client.js
const TIMEOUT_MS = 10000;

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
    throw new Error(`Failed to fetch file: ${res.status}`);
  }

  return res.arrayBuffer();
}

export async function uploadFile(serverUrl, filePath, content) {
  const url = `${serverUrl}/api/file`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'X-Path': filePath
    },
    body: content
  });

  if (!res.ok) {
    throw new Error(`Failed to upload file: ${res.status}`);
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
    throw new Error(`Failed to delete file: ${res.status}`);
  }

  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/client.js test/test-client.js
git commit -m "feat: add client HTTP functions"
```

---

### Task 9: Client Core - Sync Logic

**Files:**
- Modify: `src/client.js`
- Modify: `test/test-client.js`

- [ ] **Step 1: Write failing tests for sync logic**

Add to `test/test-client.js`:

```javascript
import { scanLocalFiles, computePullPlan, computePushPlan, validateWorkDir } from '../src/client.js';

describe('sync logic', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-sync-'));
    fs.writeFileSync(path.join(tmpDir, 'local.txt'), 'local');
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'shared');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'nested.txt'), 'nested');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateWorkDir', () => {
    it('returns empty pathPrefix for workDir', () => {
      const result = validateWorkDir(tmpDir, tmpDir);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.pathPrefix, '');
    });

    it('returns relative pathPrefix for subdirectory', () => {
      const subDir = path.join(tmpDir, 'sub');
      const result = validateWorkDir(subDir, tmpDir);
      assert.strictEqual(result.valid, true);
      assert.ok(result.pathPrefix.includes('sub'));
    });

    it('rejects directory outside workDir', () => {
      const otherDir = path.join(os.tmpdir(), 'other');
      const result = validateWorkDir(otherDir, tmpDir);
      assert.strictEqual(result.valid, false);
    });
  });

  describe('scanLocalFiles', () => {
    it('returns all local files with metadata', () => {
      const files = scanLocalFiles(tmpDir, []);
      assert.ok(files.length >= 3);
      const paths = files.map(f => f.path);
      assert.ok(paths.some(p => p.includes('local.txt')));
    });

    it('respects ignore rules', () => {
      fs.mkdirSync(path.join(tmpDir, 'node_modules'));
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), 'pkg');
      const files = scanLocalFiles(tmpDir, ['node_modules']);
      const paths = files.map(f => f.path);
      assert.ok(!paths.some(p => p.includes('node_modules')));
    });
  });

  describe('computePullPlan', () => {
    it('identifies files to download', () => {
      const serverFiles = [
        { path: 'new.txt', size: 10, mtime: 1000 },
        { path: 'shared.txt', size: 10, mtime: 2000 } // changed
      ];
      const localFiles = [
        { path: 'shared.txt', size: 5, mtime: 1000 }, // different
        { path: 'local-only.txt', size: 5, mtime: 1000 }
      ];

      const plan = computePullPlan(serverFiles, localFiles, false);

      assert.strictEqual(plan.toDownload.length, 2);
      assert.ok(plan.toDownload.some(f => f.path === 'new.txt'));
      assert.ok(plan.toDownload.some(f => f.path === 'shared.txt'));
      assert.strictEqual(plan.toDelete.length, 1);
      assert.strictEqual(plan.toDelete[0].path, 'local-only.txt');
    });

    it('skips unchanged files', () => {
      const serverFiles = [
        { path: 'same.txt', size: 10, mtime: 1000 }
      ];
      const localFiles = [
        { path: 'same.txt', size: 10, mtime: 1000 }
      ];

      const plan = computePullPlan(serverFiles, localFiles, false);

      assert.strictEqual(plan.toDownload.length, 0);
      assert.strictEqual(plan.toSkip.length, 1);
    });

    it('respects --no-delete flag', () => {
      const serverFiles = [{ path: 'a.txt', size: 10, mtime: 1000 }];
      const localFiles = [
        { path: 'a.txt', size: 10, mtime: 1000 },
        { path: 'b.txt', size: 5, mtime: 1000 }
      ];

      const plan = computePullPlan(serverFiles, localFiles, true);

      assert.strictEqual(plan.toDelete.length, 0);
      assert.strictEqual(plan.keptCount, 1);
    });
  });

  describe('computePushPlan', () => {
    it('identifies files to upload', () => {
      const localFiles = [
        { path: 'new.txt', size: 10, mtime: 1000 },
        { path: 'changed.txt', size: 20, mtime: 2000 }
      ];
      const serverFiles = [
        { path: 'changed.txt', size: 10, mtime: 1000 },
        { path: 'server-only.txt', size: 5, mtime: 1000 }
      ];

      const plan = computePushPlan(localFiles, serverFiles, false);

      assert.strictEqual(plan.toUpload.length, 2);
      assert.strictEqual(plan.toDelete.length, 1);
    });

    it('respects --no-delete flag', () => {
      const localFiles = [{ path: 'a.txt', size: 10, mtime: 1000 }];
      const serverFiles = [
        { path: 'a.txt', size: 10, mtime: 1000 },
        { path: 'b.txt', size: 5, mtime: 1000 }
      ];

      const plan = computePushPlan(localFiles, serverFiles, true);

      assert.strictEqual(plan.toDelete.length, 0);
      assert.strictEqual(plan.keptCount, 1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with exports not found

- [ ] **Step 3: Implement sync logic**

Add to `src/client.js`:

```javascript
import fs from 'node:fs';
import path from 'node:path';
import minimatch from 'minimatch';

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
          results.push({
            path: relativePath,
            size: stat.size,
            mtime: stat.mtimeMs
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

  const localMap = new Map(localFiles.map(f => [f.path, f]));

  for (const serverFile of serverFiles) {
    const localFile = localMap.get(serverFile.path);

    if (!localFile) {
      toDownload.push(serverFile);
    } else if (localFile.size !== serverFile.size || localFile.mtime !== serverFile.mtime) {
      toDownload.push(serverFile);
    } else {
      toSkip.push(serverFile);
    }

    localMap.delete(serverFile.path);
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

  const serverMap = new Map(serverFiles.map(f => [f.path, f]));

  for (const localFile of localFiles) {
    const serverFile = serverMap.get(localFile.path);

    if (!serverFile) {
      toUpload.push(localFile);
    } else if (serverFile.size !== localFile.size || serverFile.mtime !== localFile.mtime) {
      toUpload.push(localFile);
    } else {
      toSkip.push(localFile);
    }

    serverMap.delete(localFile.path);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/client.js test/test-client.js
git commit -m "feat: add client sync logic"
```

---

### Task 10: Client Core - Pull/Push Commands

**Files:**
- Modify: `src/client.js`
- Modify: `test/test-client.js`

- [ ] **Step 1: Write failing tests for pull/push commands**

Add to `test/test-client.js`:

```javascript
import { pull, push } from '../src/client.js';

describe('pull and push commands', () => {
  let tmpDir;
  let server;
  let port;
  let serverUrl;
  let serverDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-pull-'));
    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-server-'));

    fs.writeFileSync(path.join(serverDir, 'server.txt'), 'server content');
    fs.writeFileSync(path.join(tmpDir, 'client.txt'), 'client content');

    const { createServer } = await import('../src/server.js');
    server = createServer(serverDir);
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
    serverUrl = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(serverDir, { recursive: true, force: true });
  });

  describe('pull', () => {
    it('downloads files from server', async () => {
      const result = await pull({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        noDelete: true
      });

      assert.ok(result.downloaded.length >= 1);
      assert.ok(fs.existsSync(path.join(tmpDir, 'server.txt')));
    });

    it('deletes local files not on server', async () => {
      const result = await pull({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        noDelete: false
      });

      assert.ok(!fs.existsSync(path.join(tmpDir, 'client.txt')));
    });
  });

  describe('push', () => {
    it('uploads files to server', async () => {
      const result = await push({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        noDelete: true
      });

      assert.ok(result.uploaded.length >= 1);
      assert.ok(fs.existsSync(path.join(serverDir, 'client.txt')));
    });

    it('deletes server files not on client', async () => {
      const result = await push({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        noDelete: false
      });

      assert.ok(!fs.existsSync(path.join(serverDir, 'server.txt')));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with pull/push not exported

- [ ] **Step 3: Implement pull/push commands**

Add to `src/client.js`:

```javascript
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

export async function pull({ serverUrl, workDir, currentDir, pattern, noDelete }) {
  const validation = validateWorkDir(currentDir, workDir);
  if (!validation.valid) {
    throw new Error(`${validation.error}\nCurrent directory: ${validation.currentDir}`);
  }

  const pathPrefix = validation.pathPrefix;
  const ignoreRules = loadIgnoreRules(workDir);

  // Fetch server file list
  let serverFiles = await fetchFileList(serverUrl, pathPrefix);

  // Filter by pattern if provided
  if (pattern) {
    serverFiles = serverFiles.filter(f => minimatch(f.path, pattern, { dot: true }));
  }

  // Scan local files
  let localFiles = scanLocalFiles(currentDir, ignoreRules);

  // Compute plan
  const plan = computePullPlan(serverFiles, localFiles, noDelete);

  // Execute downloads
  const downloaded = [];
  for (const file of plan.toDownload) {
    const content = await fetchFile(serverUrl, pathPrefix ? `${pathPrefix}/${file.path}` : file.path);
    if (content) {
      const localPath = path.join(currentDir, file.path);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, Buffer.from(content));
      downloaded.push(file.path);
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
    keptCount: plan.keptCount
  };
}

export async function push({ serverUrl, workDir, currentDir, pattern, noDelete }) {
  const validation = validateWorkDir(currentDir, workDir);
  if (!validation.valid) {
    throw new Error(`${validation.error}\nCurrent directory: ${validation.currentDir}`);
  }

  const pathPrefix = validation.pathPrefix;
  const ignoreRules = loadIgnoreRules(workDir);

  // Scan local files
  let localFiles = scanLocalFiles(currentDir, ignoreRules);

  // Filter by pattern if provided
  if (pattern) {
    localFiles = localFiles.filter(f => minimatch(f.path, pattern, { dot: true }));
  }

  // Fetch server file list
  const serverFiles = await fetchFileList(serverUrl, pathPrefix);

  // Compute plan
  const plan = computePushPlan(localFiles, serverFiles, noDelete);

  // Execute uploads
  const uploaded = [];
  for (const file of plan.toUpload) {
    const localPath = path.join(currentDir, file.path);
    const content = fs.readFileSync(localPath);
    const serverPath = pathPrefix ? `${pathPrefix}/${file.path}` : file.path;
    await uploadFile(serverUrl, serverPath, content);
    uploaded.push(file.path);
  }

  // Execute deletes
  const deleted = [];
  for (const file of plan.toDelete) {
    const serverPath = pathPrefix ? `${pathPrefix}/${file.path}` : file.path;
    await deleteFile(serverUrl, serverPath);
    deleted.push(file.path);
  }

  return {
    uploaded,
    skipped: plan.toSkip.map(f => f.path),
    deleted,
    keptCount: plan.keptCount
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/client.js test/test-client.js
git commit -m "feat: add pull and push commands"
```

---

### Task 11: CLI Entry Point

**Files:**
- Create: `bin/lansync.js`
- Create: `src/cli.js`

- [ ] **Step 1: Create CLI entry point**

```javascript
// bin/lansync.js
#!/usr/bin/env node
import '../src/cli.js';
```

- [ ] **Step 2: Create CLI module**

```javascript
// src/cli.js
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { startServerDaemon, stopServerDaemon, getServerStatus } from './server.js';
import { pull, push, checkServerReachable } from './client.js';
import { readClientConfig, writeClientConfig } from './config.js';

const args = process.argv.slice(2);

async function main() {
  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  try {
    switch (command) {
      case 'server':
        await handleServerCommand(args.slice(1));
        break;
      case 'client':
        await handleClientCommand(args.slice(1));
        break;
      case 'pull':
        await handlePullCommand(args.slice(1));
        break;
      case 'push':
        await handlePushCommand(args.slice(1));
        break;
      case '--version':
      case '-v':
        console.log('lansync v1.0.0');
        break;
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
lansync - LAN file sync tool

Usage:
  lansync server start              Start server daemon
  lansync server stop               Stop server daemon
  lansync server status             Show server status
  lansync client config <ip:port>   Configure server address
  lansync client status             Show client config
  lansync pull [pattern] [--no-delete]  Pull files from server
  lansync push [pattern] [--no-delete]  Push files to server

Options:
  --no-delete    Don't delete files not present on source
  --version, -v  Show version
  --help, -h     Show this help
`);
}

async function handleServerCommand(subArgs) {
  const subCommand = subArgs[0];

  switch (subCommand) {
    case 'start': {
      const rootDir = process.cwd();
      const result = await startServerDaemon(rootDir);
      console.log('Server started successfully.');
      console.log(`  URL: http://${result.ip}:${result.port}`);
      console.log(`  Root: ${result.rootDir}`);
      console.log(`  PID: ${result.pid}`);
      break;
    }
    case 'stop': {
      const stopped = stopServerDaemon();
      if (stopped) {
        console.log('Server stopped.');
      } else {
        console.log('No server running.');
      }
      break;
    }
    case 'status': {
      const status = getServerStatus();
      console.log(`Server status: ${status.status}`);
      if (status.status === 'running') {
        console.log(`  URL: ${status.url}`);
        console.log(`  Root: ${status.rootDir}`);
        console.log(`  PID: ${status.pid}`);
      }
      break;
    }
    default:
      console.error(`Unknown server command: ${subCommand}`);
      process.exit(1);
  }
}

async function handleClientCommand(subArgs) {
  const subCommand = subArgs[0];

  switch (subCommand) {
    case 'config': {
      const serverAddr = subArgs[1];
      if (!serverAddr) {
        console.error('Usage: lansync client config <ip:port>');
        process.exit(1);
      }

      const serverUrl = serverAddr.startsWith('http') ? serverAddr : `http://${serverAddr}`;
      const workDir = process.cwd();

      writeClientConfig({ serverUrl, workDir });
      console.log(`Configured server: ${serverUrl}`);
      console.log(`Working directory: ${workDir}`);
      break;
    }
    case 'status': {
      const config = readClientConfig();
      if (!config) {
        console.log('Client not configured. Run: lansync client config <ip:port>');
        return;
      }
      console.log(`Server URL: ${config.serverUrl}`);
      console.log(`Working directory: ${config.workDir}`);
      break;
    }
    default:
      console.error(`Unknown client command: ${subCommand}`);
      process.exit(1);
  }
}

async function handlePullCommand(subArgs) {
  const config = readClientConfig();
  if (!config) {
    console.error('Client not configured. Run: lansync client config <ip:port>');
    process.exit(1);
  }

  const { serverUrl, workDir } = config;
  const currentDir = process.cwd();

  console.log(`Connecting to ${serverUrl}...`);

  const reachable = await checkServerReachable(serverUrl);
  if (!reachable) {
    console.error(`Server not reachable at ${serverUrl}`);
    process.exit(1);
  }

  const pathPrefix = currentDir !== workDir ? path.relative(workDir, currentDir) : '';
  if (pathPrefix) {
    console.log(`Syncing path: ${pathPrefix}/`);
  }

  console.log('Reading .gitignore rules...');
  console.log('Syncing files...');

  const noDelete = subArgs.includes('--no-delete');
  const pattern = subArgs.find(a => !a.startsWith('--'));

  const result = await pull({ serverUrl, workDir, currentDir, pattern, noDelete });

  if (result.downloaded.length > 0) {
    console.log('\n  Downloads:');
    for (const file of result.downloaded) {
      console.log(`    + ${file}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('\n  Skipped (unchanged):');
    for (const file of result.skipped) {
      console.log(`    ~ ${file}`);
    }
  }

  if (result.deleted.length > 0) {
    console.log('\n  Deleted (not on server):');
    for (const file of result.deleted) {
      console.log(`    - ${file}`);
    }
  }

  console.log(`\nSync complete: ${result.downloaded.length} downloaded, ${result.skipped.length} skipped, ${result.deleted.length} deleted`);

  if (noDelete && result.keptCount > 0) {
    console.log(`(Note: ${result.keptCount} local files not on server were kept due to --no-delete)`);
  }

  if (result.downloaded.length === 0 && result.skipped.length === 0 && result.deleted.length === 0) {
    console.log('\nNo changes. Already in sync.');
  }
}

async function handlePushCommand(subArgs) {
  const config = readClientConfig();
  if (!config) {
    console.error('Client not configured. Run: lansync client config <ip:port>');
    process.exit(1);
  }

  const { serverUrl, workDir } = config;
  const currentDir = process.cwd();

  console.log(`Connecting to ${serverUrl}...`);

  const reachable = await checkServerReachable(serverUrl);
  if (!reachable) {
    console.error(`Server not reachable at ${serverUrl}`);
    process.exit(1);
  }

  const pathPrefix = currentDir !== workDir ? path.relative(workDir, currentDir) : '';
  if (pathPrefix) {
    console.log(`Syncing path: ${pathPrefix}/`);
  }

  console.log('Reading .gitignore rules...');
  console.log('Syncing files...');

  const noDelete = subArgs.includes('--no-delete');
  const pattern = subArgs.find(a => !a.startsWith('--'));

  const result = await push({ serverUrl, workDir, currentDir, pattern, noDelete });

  if (result.uploaded.length > 0) {
    console.log('\n  Uploads:');
    for (const file of result.uploaded) {
      console.log(`    + ${file}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('\n  Skipped (unchanged):');
    for (const file of result.skipped) {
      console.log(`    ~ ${file}`);
    }
  }

  if (result.deleted.length > 0) {
    console.log('\n  Deleted (not on client):');
    for (const file of result.deleted) {
      console.log(`    - ${file}`);
    }
  }

  console.log(`\nSync complete: ${result.uploaded.length} uploaded, ${result.skipped.length} skipped, ${result.deleted.length} deleted`);

  if (noDelete && result.keptCount > 0) {
    console.log(`(Note: ${result.keptCount} server files not on client were kept due to --no-delete)`);
  }

  if (result.uploaded.length === 0 && result.skipped.length === 0 && result.deleted.length === 0) {
    console.log('\nNo changes. Already in sync.');
  }
}

main();
```

- [ ] **Step 3: Make bin/lansync.js executable**

Run: `chmod +x bin/lansync.js`
Expected: No output (success)

- [ ] **Step 4: Test CLI locally**

Run: `node bin/lansync.js --help`
Expected: Help output displayed

- [ ] **Step 5: Commit**

```bash
git add bin/lansync.js src/cli.js
git commit -m "feat: add CLI entry point and commands"
```

---

### Task 12: Integration Test

**Files:**
- Create: `test/test-integration.js`

- [ ] **Step 1: Write integration test**

```javascript
// test/test-integration.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

describe('integration', () => {
  let serverDir;
  let clientDir;
  let serverProcess;
  let serverUrl;
  let cliPath;

  beforeEach(async () => {
    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-server-'));
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-client-'));
    cliPath = path.join(process.cwd(), 'bin', 'lansync.js');

    // Create test files on server
    fs.writeFileSync(path.join(serverDir, 'readme.md'), '# Test Project');
    fs.writeFileSync(path.join(serverDir, 'package.json'), '{"name": "test"}');
    fs.mkdirSync(path.join(serverDir, 'src'));
    fs.writeFileSync(path.join(serverDir, 'src', 'index.js'), 'console.log("hello")');

    // Start server
    serverProcess = spawn('node', [cliPath, 'server', 'start'], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for server to start and capture output
    let output = '';
    serverProcess.stdout.on('data', data => {
      output += data.toString();
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Parse server URL from output
    const match = output.match(/URL: (http:\/\/[^\s]+)/);
    if (match) {
      serverUrl = match[1];
    }
  });

  afterEach(async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
    fs.rmSync(serverDir, { recursive: true, force: true });
    fs.rmSync(clientDir, { recursive: true, force: true });

    // Clean server config
    const configDir = path.join(os.homedir(), '.lansync');
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('syncs files from server to client', async () => {
    // Configure client
    const configResult = await runCli(['client', 'config', serverUrl.replace('http://', '')], clientDir);
    assert.ok(configResult.includes('Configured server'));

    // Pull files
    const pullResult = await runCli(['pull'], clientDir);
    assert.ok(pullResult.includes('downloaded'));

    // Verify files exist
    assert.ok(fs.existsSync(path.join(clientDir, 'readme.md')));
    assert.ok(fs.existsSync(path.join(clientDir, 'package.json')));
    assert.ok(fs.existsSync(path.join(clientDir, 'src', 'index.js')));
  });

  it('syncs files from client to server', async () => {
    // Configure client
    await runCli(['client', 'config', serverUrl.replace('http://', '')], clientDir);

    // Create client file
    fs.writeFileSync(path.join(clientDir, 'new-file.txt'), 'new content');

    // Push files
    const pushResult = await runCli(['push'], clientDir);
    assert.ok(pushResult.includes('uploaded'));

    // Verify file on server
    assert.ok(fs.existsSync(path.join(serverDir, 'new-file.txt')));
  });
});

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(process.cwd(), 'bin', 'lansync.js');
    const proc = spawn('node', [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`CLI failed: ${stderr || stdout}`));
      }
    });
  });
}
```

- [ ] **Step 2: Run integration test**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/test-integration.js
git commit -m "test: add integration tests"
```

---

### Task 13: Final Verification

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Test npm link**

Run: `npm link && lansync --help`
Expected: Help output displayed

- [ ] **Step 3: Unlink**

Run: `npm unlink -g`
Expected: No output (success)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final verification"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Server start/stop/status - Task 7, 11
- [x] Client config/status - Task 11
- [x] Pull command - Task 10, 11
- [x] Push command - Task 10, 11
- [x] Path traversal protection - Task 3
- [x] .gitignore support - Task 4
- [x] Modification detection - Task 9
- [x] --no-delete flag - Task 9, 10, 11
- [x] Pattern filtering - Task 9, 10, 11
- [x] Subdirectory execution - Task 9

**2. Placeholder scan:**
- [x] No TBD/TODO
- [x] No "add validation" without code
- [x] No "write tests" without test code
- [x] All code blocks contain complete implementations

**3. Type consistency:**
- [x] `pathPrefix` used consistently
- [x] `ignoreRules` array format consistent
- [x] File objects have `path`, `size`, `mtime`