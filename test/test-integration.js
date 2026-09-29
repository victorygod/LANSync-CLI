// test/test-integration.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// 隔离配置目录:通过 LANSNC_CONFIG_DIR 指向临时目录,绝不触碰真实 ~/.lansync / ~/.lansyncopt
let configDir;

describe('integration', () => {
  let serverDir;
  let clientDir;
  let serverUrl;

  beforeEach(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-config-'));

    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-server-'));
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-client-'));

    // 用随机高端口,避免与真实 lansync server(默认 8001)冲突
    const port = 20000 + Math.floor(Math.random() * 20000);

    // Create test files on server
    fs.writeFileSync(path.join(serverDir, 'readme.md'), '# Test Project');
    fs.writeFileSync(path.join(serverDir, 'package.json'), '{"name": "test"}');
    fs.mkdirSync(path.join(serverDir, 'src'));
    fs.writeFileSync(path.join(serverDir, 'src', 'index.js'), 'console.log("hello")');

    // Start server and capture output
    const output = await runCli(['server', 'start', '--port', String(port), '--policy', 'exec-block-black'], serverDir);
    // Parse server URL from output
    const match = output.match(/URL: (http:\/\/[^\s]+)/);
    if (match) {
      serverUrl = match[1];
    }
    assert.ok(serverUrl, `Server URL not found in output: ${output}`);
  });

  afterEach(async () => {
    // Stop server daemon properly
    try {
      await runCli(['server', 'stop'], serverDir);
    } catch {
      // Ignore
    }

    fs.rmSync(serverDir, { recursive: true, force: true });
    fs.rmSync(clientDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('syncs files from server to client', async () => {
    // Configure client (password comes from LANSNC_PASSWORD, verified against server)
    const configResult = await runCli(['client', 'config', serverUrl.replace('http://', '')], clientDir);
    assert.ok(configResult.includes('Connected to'));
    assert.ok(configResult.includes('exec policy: exec-block-black'));

    // Pull files
    const pullResult = await runCli(['pull', '--no-delete'], clientDir);
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
    const pushResult = await runCli(['push', '--no-delete'], clientDir);
    assert.ok(pushResult.includes('uploaded'));

    // Verify file on server
    assert.ok(fs.existsSync(path.join(serverDir, 'new-file.txt')));
  });

  it('prunes empty directories on server after local dir removal and push (git-style)', async () => {
    await runCli(['client', 'config', serverUrl.replace('http://', '')], clientDir);
    // 先 pull 对齐两侧,避免后续 push 把 server 独有文件删掉,干扰下面的断言
    await runCli(['pull'], clientDir);

    // 嵌套目录 push 上去
    fs.mkdirSync(path.join(clientDir, 'proj/assets/deep'), { recursive: true });
    fs.writeFileSync(path.join(clientDir, 'proj/assets/deep/a.png'), 'a');
    fs.writeFileSync(path.join(clientDir, 'proj/assets/deep/b.png'), 'b');
    fs.writeFileSync(path.join(clientDir, 'proj/readme.md'), 'r');
    await runCli(['push'], clientDir);
    assert.ok(fs.existsSync(path.join(serverDir, 'proj/assets/deep/a.png')));

    // 本地删掉整个 proj 目录,再 push:文件应被删除,空目录壳也一并修剪
    fs.rmSync(path.join(clientDir, 'proj'), { recursive: true });
    const pushResult = await runCli(['push'], clientDir);
    assert.ok(pushResult.includes('deleted'));

    assert.ok(!fs.existsSync(path.join(serverDir, 'proj/assets/deep/a.png')));
    // 关键断言:proj 目录壳不再残留
    assert.ok(!fs.existsSync(path.join(serverDir, 'proj')));
    // server 根上的无关文件不受影响
    assert.ok(fs.existsSync(path.join(serverDir, 'readme.md')));
  });

  it('diff exits 0 and reports in sync after pull', async () => {
    await runCli(['client', 'config', serverUrl.replace('http://', '')], clientDir);
    await runCli(['pull'], clientDir);

    const { code, stdout } = await runCliCapture(['diff', '--json'], clientDir);

    assert.strictEqual(code, 0);
    const result = JSON.parse(stdout);
    assert.strictEqual(result.inSync, true);
    assert.deepStrictEqual(result.files, []);
    assert.strictEqual(result.summary.inSync, 3);
  });

  it('diff exits 1 and flags modified / local-only / server-only', async () => {
    await runCli(['client', 'config', serverUrl.replace('http://', '')], clientDir);
    await runCli(['pull'], clientDir);

    // 三种差异各造一个:本地改内容 / 本地新增 / 本地删除
    fs.writeFileSync(path.join(clientDir, 'readme.md'), '# Changed locally');
    fs.writeFileSync(path.join(clientDir, 'extra.txt'), 'extra');
    fs.rmSync(path.join(clientDir, 'src', 'index.js'));

    const { code, stdout } = await runCliCapture(['diff', '--json'], clientDir);

    assert.strictEqual(code, 1);
    const result = JSON.parse(stdout);
    assert.strictEqual(result.inSync, false);

    const byPath = Object.fromEntries(result.files.map(f => [f.path, f]));
    assert.strictEqual(byPath['readme.md'].status, 'modified');
    assert.ok(byPath['readme.md'].local.hash !== byPath['readme.md'].server.hash);
    assert.strictEqual(byPath['extra.txt'].status, 'local-only');
    assert.strictEqual(byPath['src/index.js'].status, 'server-only');

    assert.deepStrictEqual(result.summary, { modified: 1, localOnly: 1, serverOnly: 1, inSync: 1 });
  });

  it('diff honors pattern scope', async () => {
    await runCli(['client', 'config', serverUrl.replace('http://', '')], clientDir);
    await runCli(['pull'], clientDir);
    fs.rmSync(path.join(clientDir, 'src', 'index.js'));

    const { code, stdout } = await runCliCapture(['diff', 'src', '--json'], clientDir);

    assert.strictEqual(code, 1);
    const result = JSON.parse(stdout);
    assert.deepStrictEqual(result.files.map(f => f.path), ['src/index.js']);
    assert.strictEqual(result.prefix, '');
  });

  it('diff exits 2 when client is not configured', async () => {
    // 指向一个全新配置目录,让 client 处于未配置状态
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-config-'));

    const { code, stderr } = await runCliCapture(['diff'], clientDir);

    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('not configured'));
  });
});

function runCliCapture(args, cwd) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(process.cwd(), 'bin', 'lansync.js');
    const proc = spawn('node', [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LANSNC_CONFIG_DIR: configDir, LANSNC_PASSWORD: 'test-password' }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('error', err => reject(err));

    proc.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function runCli(args, cwd) {
  const { code, stdout, stderr } = await runCliCapture(args, cwd);
  if (code !== 0) {
    throw new Error(`CLI failed (exit ${code}): ${stderr || stdout}`);
  }
  return stdout;
}
