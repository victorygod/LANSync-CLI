// test/test-server.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { sanitizePath, getLocalIP, parseGitignore, shouldIgnore, getDefaultIgnoreRules, walkDir, pruneEmptyDirs, createServer, isPortInUse, startServerDaemon, stopServerDaemon, getServerStatus, getPortOwnerPid, getPidCommand, killPidHard } from '../src/server.js';
import { writeServerConfig, getConfigDir } from '../src/config.js';
import { deriveToken } from '../src/policy.js';

// 隔离配置目录,避免测试日志/状态读写污染真实 ~/.lansyncopt
process.env.LANSNC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-config-'));

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

    it('handles Chinese characters in path', () => {
      const result = sanitizePath('%E6%96%87%E4%BB%B6%E5%A4%B9/%E6%96%87%E4%BB%B6.txt', rootDir);
      // URL decoded: 文件夹/文件.txt
      assert.ok(result !== null);
      assert.ok(result.includes('文件夹') || result.includes('%E6%96%87%E4%BB%B6%E5%A4%B9'));
    });

    it('handles mixed path separators (Windows compatibility)', () => {
      // Simulate Windows scenario: rootDir with forward slash, path resolved with backslash
      // On macOS/Linux, path.resolve uses forward slash, so this tests normalization
      const result = sanitizePath('src/index.js', rootDir);
      assert.ok(result !== null);
      // Should work regardless of separator style
      assert.ok(result.endsWith('src/index.js') || result.endsWith('src\\index.js'));
    });

    it('allows filenames containing .. substring', () => {
      // Filenames like [...404].css contain .. but should be allowed
      const result = sanitizePath('routes/[...404].css', rootDir);
      assert.ok(result !== null);
      assert.ok(result.includes('[...404].css'));
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

    it('handles negation rules', () => {
      const rulesWithNegation = ['local-data/*.json', '!local-data/.gitkeep', '*.log'];
      assert.ok(shouldIgnore('local-data/test.json', rulesWithNegation));
      assert.ok(!shouldIgnore('local-data/.gitkeep', rulesWithNegation));  // negated
      assert.ok(shouldIgnore('debug.log', rulesWithNegation));
      assert.ok(!shouldIgnore('src/index.js', rulesWithNegation));  // should not ignore
    });
  });
});

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
    // wire 统一正斜杠:client 落盘、pattern 匹配都依赖这一约定
    assert.ok(paths.includes('src/index.js'));
    assert.ok(!paths.some(p => p.includes('\\')));
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

describe('pruneEmptyDirs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-prune-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prunes the whole empty chain up to root (call after file is gone)', () => {
    fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'c', 'x.txt'), 'x');
    fs.unlinkSync(path.join(tmpDir, 'a', 'b', 'c', 'x.txt'));

    pruneEmptyDirs(path.join(tmpDir, 'a', 'b', 'c', 'x.txt'), tmpDir);

    assert.ok(!fs.existsSync(path.join(tmpDir, 'a')));
    assert.ok(fs.existsSync(tmpDir));
  });

  it('stops at the first non-empty directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'a', 'sibling.txt'), 's');
    fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'x.txt'), 'x');
    fs.unlinkSync(path.join(tmpDir, 'a', 'b', 'x.txt'));

    pruneEmptyDirs(path.join(tmpDir, 'a', 'b', 'x.txt'), tmpDir);

    // b 被修剪,a 里还有 sibling.txt,必须留下
    assert.ok(!fs.existsSync(path.join(tmpDir, 'a', 'b')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'a', 'sibling.txt')));
  });

  it('never removes the root directory itself', () => {
    fs.writeFileSync(path.join(tmpDir, 'only.txt'), 'x');
    fs.unlinkSync(path.join(tmpDir, 'only.txt'));

    pruneEmptyDirs(path.join(tmpDir, 'only.txt'), tmpDir);

    assert.ok(fs.existsSync(tmpDir));
  });

  it('does nothing when the path is directly under root', () => {
    fs.writeFileSync(path.join(tmpDir, 'top.txt'), 'x');

    // 文件还在(未被删除)时调用,父目录即 root 本身,应无任何动作
    pruneEmptyDirs(path.join(tmpDir, 'top.txt'), tmpDir);

    assert.ok(fs.existsSync(path.join(tmpDir, 'top.txt')));
  });
});

describe('HTTP server', () => {
  let tmpDir;
  let server;
  let port;
  let token;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-http-'));
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello world');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'nested.txt'), 'nested content');

    token = deriveToken('test-password');
    writeServerConfig({ pid: process.pid, port: 0, rootDir: tmpDir, ip: '127.0.0.1', token, policy: 'exec-forbidden' });

    server = createServer(tmpDir);
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(getConfigDir(), 'server.json')); } catch {}
  });

  function authFetch(pathname, opts = {}) {
    return fetch(`http://localhost:${port}${pathname}`, {
      ...opts,
      headers: { 'Authorization': `Bearer ${token}`, ...opts.headers }
    });
  }

  it('rejects requests without token (401)', async () => {
    const res = await fetch(`http://localhost:${port}/api/list`);
    assert.strictEqual(res.status, 401);
  });

  it('rejects requests with wrong token (401)', async () => {
    const res = await fetch(`http://localhost:${port}/api/list`, {
      headers: { 'Authorization': 'Bearer wrong-token' }
    });
    assert.strictEqual(res.status, 401);
  });

  describe('GET /api/list', () => {
    it('returns file list', async () => {
      const res = await authFetch('/api/list');
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.files));
      const paths = data.files.map(f => f.path);
      assert.ok(paths.includes('test.txt'));
    });

    it('supports path parameter', async () => {
      const res = await authFetch('/api/list?path=sub');
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.exists, true);
      const paths = data.files.map(f => f.path);
      assert.ok(paths.some(p => p.includes('nested.txt')));
    });

    it('reports exists:false for a missing directory (delete protection)', async () => {
      const res = await authFetch('/api/list?path=not-there');
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.exists, false);
      assert.deepStrictEqual(data.files, []);
    });
  });

  describe('GET /api/file', () => {
    it('returns file content', async () => {
      const res = await authFetch('/api/file?path=test.txt');
      assert.strictEqual(res.status, 200);
      const content = await res.text();
      assert.strictEqual(content, 'hello world');
    });

    it('returns 404 for missing file', async () => {
      const res = await authFetch('/api/file?path=missing.txt');
      assert.strictEqual(res.status, 404);
    });

    it('returns 403 for path traversal', async () => {
      const res = await authFetch('/api/file?path=../etc/passwd');
      assert.strictEqual(res.status, 403);
    });
  });

  describe('POST /api/file', () => {
    it('uploads file', async () => {
      const res = await authFetch('/api/file', {
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
      const res = await authFetch('/api/file', {
        method: 'POST',
        headers: { 'X-Path': 'deep/nested/file.txt' },
        body: 'nested'
      });
      assert.strictEqual(res.status, 200);
      assert.ok(fs.existsSync(path.join(tmpDir, 'deep', 'nested', 'file.txt')));
    });

    it('handles unicode file paths', async () => {
      const res = await authFetch('/api/file', {
        method: 'POST',
        headers: { 'X-Path': encodeURIComponent('中文目录/文件.txt') },
        body: 'unicode content'
      });
      assert.strictEqual(res.status, 200);
      assert.ok(fs.existsSync(path.join(tmpDir, '中文目录', '文件.txt')));
      assert.strictEqual(fs.readFileSync(path.join(tmpDir, '中文目录', '文件.txt'), 'utf-8'), 'unicode content');
    });

    it('handles Windows-style backslash paths', async () => {
      const res = await authFetch('/api/file', {
        method: 'POST',
        headers: { 'X-Path': encodeURIComponent('test\\subdir\\winfile.txt') },
        body: 'windows path'
      });
      assert.strictEqual(res.status, 200);
      // Should create proper nested directory, not a file with backslash in name
      assert.ok(fs.existsSync(path.join(tmpDir, 'test', 'subdir', 'winfile.txt')));
      assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'test', 'subdir', 'winfile.txt'), 'utf-8'), 'windows path');
    });
  });

  describe('DELETE /api/file', () => {
    it('deletes file', async () => {
      const res = await authFetch('/api/file?path=test.txt', {
        method: 'DELETE'
      });
      assert.strictEqual(res.status, 200);
      assert.ok(!fs.existsSync(path.join(tmpDir, 'test.txt')));
    });

    it('returns 404 for missing file', async () => {
      const res = await authFetch('/api/file?path=missing.txt', {
        method: 'DELETE'
      });
      assert.strictEqual(res.status, 404);
    });

    it('prunes empty parent directories after deleting the last file (git-style)', async () => {
      fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'c', 'leaf.txt'), 'leaf');

      const res = await authFetch(`/api/file?path=${encodeURIComponent('a/b/c/leaf.txt')}`, {
        method: 'DELETE'
      });

      assert.strictEqual(res.status, 200);
      // 文件删掉后,整串空目录 a/b/c 应被修剪干净
      assert.ok(!fs.existsSync(path.join(tmpDir, 'a')));
    });

    it('keeps directories that still contain files', async () => {
      fs.mkdirSync(path.join(tmpDir, 'keep', 'inner'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'keep', 'inner', 'one.txt'), '1');
      fs.writeFileSync(path.join(tmpDir, 'keep', 'inner', 'two.txt'), '2');

      await authFetch(`/api/file?path=${encodeURIComponent('keep/inner/one.txt')}`, {
        method: 'DELETE'
      });

      assert.ok(fs.existsSync(path.join(tmpDir, 'keep', 'inner', 'two.txt')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'keep', 'inner')));
    });
  });
});

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
describe('orphan daemon handling (getPortOwnerPid / killPidHard)', () => {
  it('getPortOwnerPid returns the listening process pid', async () => {
    const holder = http.createServer();
    await new Promise(resolve => holder.listen(0, resolve));
    const port = holder.address().port;

    try {
      assert.strictEqual(getPortOwnerPid(port), process.pid);
    } finally {
      await new Promise(resolve => holder.close(resolve));
    }
  });

  it('getPortOwnerPid returns null for a free port', async () => {
    const other = http.createServer();
    await new Promise(resolve => other.listen(0, resolve));
    const freePort = other.address().port;
    await new Promise(resolve => other.close(resolve));

    assert.strictEqual(getPortOwnerPid(freePort), null);
  });

  it('getPidCommand identifies a pid', () => {
    const cmd = getPidCommand(process.pid);
    assert.ok(cmd, 'expected a non-empty command name for the test process');
  });

  it('killPidHard kills a spawned child and reports success', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    });
    // 等 child 真正起来
    await new Promise(resolve => setTimeout(resolve, 300));

    assert.ok(await killPidHard(child.pid), 'killPidHard should report success');

    // 让出事件循环后 pid 应彻底消失(僵尸已被收割)
    const alive = await new Promise(resolve => {
      try {
        process.kill(child.pid, 0);
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    assert.strictEqual(alive, false);
  }, 10000);

  it('killPidHard returns true for an already-dead pid (ESRCH = goal achieved)', async () => {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise(resolve => dead.once('exit', resolve));
    // 再让出几轮事件循环,确保 zombie 收割、pid 释放
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(await killPidHard(dead.pid), true);
  }, 10000);
});
