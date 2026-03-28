// test/test-client.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fetchFileList, fetchFile, uploadFile, deleteFile, checkServerReachable, scanLocalFiles, computePullPlan, computePushPlan, validateWorkDir, pull, push } from '../src/client.js';

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
    it('returns file content as ArrayBuffer', async () => {
      const content = await fetchFile(serverUrl, 'test.txt');
      assert.ok(content instanceof ArrayBuffer);
      const text = Buffer.from(content).toString('utf8');
      assert.strictEqual(text, 'file content');
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

  describe('pull with pattern', () => {
    it('does not delete files outside pattern', async () => {
      const result = await pull({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        pattern: 'dir'
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
        pattern: 'dir'
      });

      // Should include nested files
      assert.ok(result.downloaded.includes('dir/a.txt') || result.downloaded.includes('dir\\a.txt'));
      assert.ok(result.downloaded.some(p => p.includes('b.txt')));
    });
  });

  describe('push with pattern', () => {
    it('does not delete server files outside pattern', async () => {
      const result = await push({
        serverUrl,
        workDir: tmpDir,
        currentDir: tmpDir,
        pattern: 'dir'
      });

      // Should NOT delete other/c.txt on server
      assert.ok(fs.existsSync(path.join(serverDir, 'other', 'c.txt')));
      assert.strictEqual(result.deleted.length, 0);
    });
  });
});