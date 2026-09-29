// test/test-client.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fetchFileList, fetchFile, uploadFile, deleteFile, checkServerReachable, verifyAuth, scanLocalFiles, computePullPlan, computePushPlan, computeDiffInventory, validateWorkDir, pull, push } from '../src/client.js';
import { writeServerConfig, readClientConfig } from '../src/config.js';

// 必须在模块顶层隔离:line ~316 的 writeServerConfig 不隔离时会写真实
// ~/.lansyncopt/server.json。daemon 每个请求都重读配置,在跑着 server 的
// 机器上(Windows)这会让活 server 即刻换 token,client 全线 401。
// (HOME 覆盖在 Windows 无效:os.homedir() 走 USERPROFILE)
process.env.LANSNC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-test-client-'));

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

      if (url.pathname === '/api/auth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, policy: 'exec-forbidden' }));
      } else if (url.pathname === '/api/list') {
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
      const reachable = await checkServerReachable(serverUrl, 'test-token');
      assert.strictEqual(reachable, true);
    });

    it('throws with cause for unreachable server', async () => {
      await assert.rejects(
        () => checkServerReachable('http://localhost:59999', 'test-token'),
        /Cannot reach http:\/\/localhost:59999 \(ECONNREFUSED\)/
      );
    });

    it('throws with hint for unresolvable host (typo guard)', async () => {
      await assert.rejects(
        () => checkServerReachable('http://192.168.71,239:8001', 'test-token'),
        /ENOTFOUND/
      );
    });
  });

  describe('fetchFileList', () => {
    it('returns file list', async () => {
      const { files, exists } = await fetchFileList(serverUrl, '', 'test-token');
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].path, 'test.txt');
      // 旧 server 响应没有 exists 字段,缺省按"目录存在"处理
      assert.strictEqual(exists, true);
    });
  });

  describe('fetchFile', () => {
    it('returns file content as ArrayBuffer', async () => {
      const content = await fetchFile(serverUrl, 'test.txt', 'test-token');
      assert.ok(content instanceof ArrayBuffer);
      const text = Buffer.from(content).toString('utf8');
      assert.strictEqual(text, 'file content');
    });
  });

  describe('uploadFile', () => {
    it('uploads file successfully', async () => {
      const result = await uploadFile(serverUrl, 'new.txt', Buffer.from('new content'), 'test-token');
      assert.strictEqual(result.success, true);
    });
  });

  describe('deleteFile', () => {
    it('deletes file successfully', async () => {
      const result = await deleteFile(serverUrl, 'test.txt', 'test-token');
      assert.strictEqual(result.success, true);
    });
  });

  describe('verifyAuth', () => {
    it('returns server policy on success', async () => {
      const policy = await verifyAuth(serverUrl, 'test-token');
      assert.strictEqual(policy, 'exec-forbidden');
    });
  });
});

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
        { path: 'new.txt', size: 10, mtime: 1000, hash: 'abc123' },
        { path: 'shared.txt', size: 10, mtime: 2000, hash: 'def456' } // changed
      ];
      const localFiles = [
        { path: 'shared.txt', size: 5, mtime: 1000, hash: 'xyz789' }, // different content
        { path: 'local-only.txt', size: 5, mtime: 1000, hash: 'local1' }
      ];

      const plan = computePullPlan(serverFiles, localFiles, false);

      assert.strictEqual(plan.toDownload.length, 2);
      assert.ok(plan.toDownload.some(f => f.path === 'new.txt'));
      assert.ok(plan.toDownload.some(f => f.path === 'shared.txt'));
      assert.strictEqual(plan.toDelete.length, 1);
      assert.strictEqual(plan.toDelete[0].path, 'local-only.txt');
    });

    it('skips unchanged files (mtime match)', () => {
      const serverFiles = [
        { path: 'same.txt', size: 10, mtime: 1000, hash: 'abc123' }
      ];
      const localFiles = [
        { path: 'same.txt', size: 10, mtime: 1000, hash: 'abc123' }
      ];

      const plan = computePullPlan(serverFiles, localFiles, false);

      assert.strictEqual(plan.toDownload.length, 0);
      assert.strictEqual(plan.toSkip.length, 1);
    });

    it('skips files with different mtime but same hash', () => {
      // mtime differs but content is identical
      const serverFiles = [
        { path: 'file.txt', size: 10, mtime: 2000, hash: 'abc123' }
      ];
      const localFiles = [
        { path: 'file.txt', size: 10, mtime: 1000, hash: 'abc123' }
      ];

      const plan = computePullPlan(serverFiles, localFiles, false);

      assert.strictEqual(plan.toDownload.length, 0);
      assert.strictEqual(plan.toSkip.length, 1);
    });

    it('downloads files with different hash', () => {
      // mtime differs and content differs
      const serverFiles = [
        { path: 'file.txt', size: 10, mtime: 2000, hash: 'server123' }
      ];
      const localFiles = [
        { path: 'file.txt', size: 10, mtime: 1000, hash: 'local456' }
      ];

      const plan = computePullPlan(serverFiles, localFiles, false);

      assert.strictEqual(plan.toDownload.length, 1);
      assert.strictEqual(plan.toSkip.length, 0);
    });

    it('respects --no-delete flag', () => {
      const serverFiles = [{ path: 'a.txt', size: 10, mtime: 1000, hash: 'abc' }];
      const localFiles = [
        { path: 'a.txt', size: 10, mtime: 1000, hash: 'abc' },
        { path: 'b.txt', size: 5, mtime: 1000, hash: 'def' }
      ];

      const plan = computePullPlan(serverFiles, localFiles, true);

      assert.strictEqual(plan.toDelete.length, 0);
      assert.strictEqual(plan.keptCount, 1);
    });

    it('handles path separator differences (cross-platform)', () => {
      // Server uses POSIX style (/), client uses Windows style (\)
      const serverFiles = [
        { path: 'folder/file.txt', size: 10, mtime: 1000, hash: 'abc123' },
        { path: 'another.txt', size: 5, mtime: 2000, hash: 'def456' }
      ];
      const localFiles = [
        { path: 'folder\\file.txt', size: 10, mtime: 1000, hash: 'abc123' },
        { path: 'another.txt', size: 5, mtime: 2000, hash: 'def456' }
      ];

      const plan = computePullPlan(serverFiles, localFiles, false);

      // Should NOT download or delete - files are identical
      assert.strictEqual(plan.toDownload.length, 0);
      assert.strictEqual(plan.toDelete.length, 0);
      assert.strictEqual(plan.toSkip.length, 2);
    });
  });

  describe('computePushPlan', () => {
    it('identifies files to upload', () => {
      const localFiles = [
        { path: 'new.txt', size: 10, mtime: 1000, hash: 'abc123' },
        { path: 'changed.txt', size: 20, mtime: 2000, hash: 'local123' }
      ];
      const serverFiles = [
        { path: 'changed.txt', size: 10, mtime: 1000, hash: 'server456' },
        { path: 'server-only.txt', size: 5, mtime: 1000, hash: 'srv789' }
      ];

      const plan = computePushPlan(localFiles, serverFiles, false);

      assert.strictEqual(plan.toUpload.length, 2);
      assert.strictEqual(plan.toDelete.length, 1);
    });

    it('skips files with different mtime but same hash', () => {
      const localFiles = [
        { path: 'file.txt', size: 10, mtime: 2000, hash: 'abc123' }
      ];
      const serverFiles = [
        { path: 'file.txt', size: 10, mtime: 1000, hash: 'abc123' }
      ];

      const plan = computePushPlan(localFiles, serverFiles, false);

      assert.strictEqual(plan.toUpload.length, 0);
      assert.strictEqual(plan.toSkip.length, 1);
    });

    it('respects --no-delete flag', () => {
      const localFiles = [{ path: 'a.txt', size: 10, mtime: 1000, hash: 'abc' }];
      const serverFiles = [
        { path: 'a.txt', size: 10, mtime: 1000, hash: 'abc' },
        { path: 'b.txt', size: 5, mtime: 1000, hash: 'def' }
      ];

      const plan = computePushPlan(localFiles, serverFiles, true);

      assert.strictEqual(plan.toDelete.length, 0);
      assert.strictEqual(plan.keptCount, 1);
    });
  });
});

// 给使用真实 createServer 的用例准备隔离的鉴权配置
function setupAuthConfig(rootDir) {
  process.env.LANSNC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-client-config-'));
  writeServerConfig({ pid: process.pid, port: 0, rootDir, ip: '127.0.0.1', token: 'test-token', policy: 'exec-forbidden' });
}

function teardownAuthConfig() {
  const dir = process.env.LANSNC_CONFIG_DIR;
  delete process.env.LANSNC_CONFIG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
}

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

    setupAuthConfig(serverDir);

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
    teardownAuthConfig();
  });

  describe('pull', () => {
    it('downloads files from server', async () => {
      const result = await pull({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        noDelete: true,
        token: 'test-token'
      });

      assert.ok(result.downloaded.length >= 1);
      assert.ok(fs.existsSync(path.join(tmpDir, 'server.txt')));
    });

    it('deletes local files not on server', async () => {
      const result = await pull({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        noDelete: false,
        token: 'test-token'
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
        noDelete: true,
        token: 'test-token'
      });

      assert.ok(result.uploaded.length >= 1);
      assert.ok(fs.existsSync(path.join(serverDir, 'client.txt')));
    });

    it('deletes server files not on client', async () => {
      const result = await push({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        noDelete: false,
        token: 'test-token'
      });

      assert.ok(!fs.existsSync(path.join(serverDir, 'server.txt')));
    });
  });
});

describe('pattern behavior', () => {
  let tmpDir;
  let server;
  let port;
  let serverUrl;
  let serverDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-pattern-'));
    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-server-pattern-'));

    // Create server files: dir/a.txt, dir/sub/b.txt, other/c.txt
    fs.mkdirSync(path.join(serverDir, 'dir', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(serverDir, 'other'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'dir', 'a.txt'), 'a');
    fs.writeFileSync(path.join(serverDir, 'dir', 'sub', 'b.txt'), 'b');
    fs.writeFileSync(path.join(serverDir, 'other', 'c.txt'), 'c');

    // Create client files: dir/a.txt (different), other/c.txt
    fs.mkdirSync(path.join(tmpDir, 'dir'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'other'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dir', 'a.txt'), 'old-a');
    fs.writeFileSync(path.join(tmpDir, 'other', 'c.txt'), 'c');

    setupAuthConfig(serverDir);

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
    teardownAuthConfig();
  });

  describe('pull with pattern', () => {
    it('does not delete files outside pattern', async () => {
      const result = await pull({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        pattern: 'dir',
        token: 'test-token'
      });

      // Should sync dir/ contents
      assert.ok(fs.existsSync(path.join(tmpDir, 'dir', 'a.txt')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dir', 'sub', 'b.txt')));
      // Should NOT delete other/c.txt (outside pattern)
      assert.ok(fs.existsSync(path.join(tmpDir, 'other', 'c.txt')));
      assert.strictEqual(result.deleted.length, 0);
    });

    it('syncs directory recursively with simple name', async () => {
      const result = await pull({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        pattern: 'dir',
        token: 'test-token'
      });

      // Should include nested files(wire 统一正斜杠,输出不再随平台变化)
      assert.ok(result.downloaded.includes('dir/a.txt'));
      assert.ok(result.downloaded.some(p => p.includes('b.txt')));
    });
  });

  describe('push with pattern', () => {
    it('does not delete server files outside pattern', async () => {
      const result = await push({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        pattern: 'dir',
        token: 'test-token'
      });

      // Should NOT delete other/c.txt on server
      assert.ok(fs.existsSync(path.join(serverDir, 'other', 'c.txt')));
      assert.strictEqual(result.deleted.length, 0);
    });
  });
});

describe('cross-platform path handling (win32 wire shapes)', () => {
  let tmpDir;
  let server;
  let serverUrl;
  let fileRequests;
  let listRequests;
  // 模拟 Windows server:path.relative 在 win32 上产出反斜杠路径,旧版 server
  // 会原样发上线。这里逐字复刻 wire 形状,client 侧全部走真实代码
  let serverMissing;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-xplat-'));
    fileRequests = [];
    listRequests = [];
    serverMissing = false;

    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/api/list') {
        const prefix = url.searchParams.get('path') || '';
        listRequests.push(prefix);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (serverMissing) {
          // 新 server:目录不存在显式上报,pull 据此拒绝同步
          res.end(JSON.stringify({ files: [], exists: false }));
        } else if (prefix) {
          // server 有该子目录:路径带前缀(wire 统一正斜杠)
          res.end(JSON.stringify({ files: [
            { path: `${prefix}/file.txt`, size: 4, mtime: 1, hash: 'h-f' }
          ], exists: true }));
        } else {
          // 旧版 Windows server 形态:字面反斜杠路径
          res.end(JSON.stringify({ files: [
            { path: 'docs\\readme.md', size: 5, mtime: 1, hash: 'h-readme' },
            { path: 'docs\\sub\\b.txt', size: 3, mtime: 1, hash: 'h-b' },
            { path: 'root.txt', size: 4, mtime: 1, hash: 'h-root' }
          ], exists: true }));
        }
      } else if (url.pathname === '/api/file' && req.method === 'GET') {
        const p = url.searchParams.get('path');
        fileRequests.push(p);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('DATA:' + p);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, resolve));
    serverUrl = `http://localhost:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pull builds nested dirs from backslash wire paths (no literal \\ filenames)', async () => {
    const result = await pull({ serverUrl, workDir: tmpDir, currentDir: tmpDir, token: 't' });

    assert.ok(fs.existsSync(path.join(tmpDir, 'docs', 'readme.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'docs', 'sub', 'b.txt')));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'docs\\readme.md')));
    assert.deepStrictEqual(
      [...result.downloaded].sort(),
      ['docs/readme.md', 'docs/sub/b.txt', 'root.txt']
    );
    // 下载请求走 serverPath,统一正斜杠
    assert.ok(fileRequests.every(p => !p.includes('\\')));
  });

  it('pull pattern matches backslash wire paths', async () => {
    const result = await pull({
      serverUrl, workDir: tmpDir, currentDir: tmpDir, pattern: 'docs', token: 't'
    });

    assert.deepStrictEqual(
      [...result.downloaded].sort(),
      ['docs/readme.md', 'docs/sub/b.txt']
    );
    assert.ok(fs.existsSync(path.join(tmpDir, 'docs', 'sub', 'b.txt')));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'root.txt')));
  });

  it('normalizes a win32-style pathPrefix from nested client cwd', async () => {
    // 模拟 Win client 嵌套 cwd:path.relative 产出 "sub1\sub2";本机上用
    // 字面反斜杠目录名复刻完全相同的 wire 前缀
    const sub = path.join(tmpDir, 'sub1\\sub2');
    fs.mkdirSync(sub, { recursive: true });

    const result = await pull({ serverUrl, workDir: tmpDir, currentDir: sub, token: 't' });

    assert.deepStrictEqual(result.downloaded, ['file.txt']);
    assert.ok(fs.existsSync(path.join(sub, 'file.txt')));
    // 列表请求前缀已归一化,server 按 sub1/sub2 解析
    assert.ok(listRequests.includes('sub1/sub2'));
    assert.ok(!listRequests.some(p => p.includes('\\')));
  });

  it('refuses to pull (no deletion) when server directory is missing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'precious');
    serverMissing = true;

    await assert.rejects(
      () => pull({ serverUrl, workDir: tmpDir, currentDir: tmpDir, token: 't' }),
      /refusing to pull/
    );
    assert.ok(fs.existsSync(path.join(tmpDir, 'keep.txt')));
  });
});
describe('computeDiffInventory', () => {
  const meta = (hash, size, mtime) => ({ size, mtime, hash });
  const localFile = (path, hash, size, mtime) => ({ path, hash, size, mtime });
  const serverFile = (path, hash, size, mtime) => ({ path, hash, size, mtime });

  it('is in sync with empty summary when both sides match exactly', () => {
    const result = computeDiffInventory(
      [localFile('a.js', 'h1', 10, 100)],
      [serverFile('a.js', 'h1', 10, 100)]
    );

    assert.strictEqual(result.inSync, true);
    assert.deepStrictEqual(result.files, []);
    assert.deepStrictEqual(result.summary, { modified: 0, localOnly: 0, serverOnly: 0, inSync: 1 });
  });

  it('judges by hash only: equal hash with different mtime/size is still in sync', () => {
    // push/pull 有 mtime+size 快路径;diff 必须只认内容(hash),
    // 避免「diff 说 modified、push 却说 skip」的自相矛盾
    const result = computeDiffInventory(
      [localFile('a.js', 'h1', 10, 100)],
      [serverFile('a.js', 'h1', 88, 999)]
    );

    assert.strictEqual(result.inSync, true);
  });

  it('reports inSync=false immediately in top-level bool', () => {
    const result = computeDiffInventory(
      [localFile('a.js', 'h1', 10, 100)],
      [serverFile('a.js', 'h2', 10, 100)]
    );

    assert.strictEqual(result.inSync, false);
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.summary.modified, 1);
  });

  it('classifies modified / local-only / server-only and keeps side meta', () => {
    const result = computeDiffInventory(
      [
        localFile('modified.js', 'L1', 120, 1000),
        localFile('onlylocal.txt', 'L2', 4, 1000)
      ],
      [
        serverFile('modified.js', 'S1', 80, 2000),
        serverFile('onlyserver.js', 'S3', 210, 2000)
      ]
    );

    assert.deepStrictEqual(result.files.map(f => f.path), ['modified.js', 'onlylocal.txt', 'onlyserver.js']);
    assert.deepStrictEqual(result.files.map(f => f.status), ['modified', 'local-only', 'server-only']);

    const modified = result.files.find(f => f.status === 'modified');
    assert.deepStrictEqual(modified.local, meta('L1', 120, 1000));
    assert.deepStrictEqual(modified.server, meta('S1', 80, 2000));

    const onlyLocal = result.files.find(f => f.status === 'local-only');
    assert.deepStrictEqual(onlyLocal.local, meta('L2', 4, 1000));
    assert.strictEqual(onlyLocal.server, null);

    const onlyServer = result.files.find(f => f.status === 'server-only');
    assert.strictEqual(onlyServer.local, null);
    assert.deepStrictEqual(onlyServer.server, meta('S3', 210, 2000));
  });

  it('normalizes win32 backslash paths before comparing', () => {
    const result = computeDiffInventory(
      [localFile('src\\cli.js', 'h1', 10, 100)],
      [serverFile('src/cli.js', 'h1', 10, 100)]
    );

    assert.strictEqual(result.inSync, true);
    assert.strictEqual(result.summary.inSync, 1);
  });

  it('sorts output by path for stable positional comparison', () => {
    const result = computeDiffInventory(
      [
        localFile('z.txt', 'L', 1, 1),
        localFile('a.txt', 'L2', 1, 1)
      ],
      [serverFile('m.txt', 'S', 1, 1)]
    );

    assert.deepStrictEqual(result.files.map(f => f.path), ['a.txt', 'm.txt', 'z.txt']);
  });
});
