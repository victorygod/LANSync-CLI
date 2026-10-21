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
  let serverPid;

  beforeEach(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-config-'));

    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-server-'));
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-client-'));

    // 用随机高端口,避免与真实 lansync server(默认 8001)冲突
    const port = 20000 + Math.floor(Math.random() * 20000);

    // Create test files on server
    fs.writeFileSync(path.join(serverDir, 'readme.md'), '# Test Project');
    fs.writeFileSync(path.join(serverDir, 'package.json'), '{"name": "test"}');
    fs.mkdirSync(path.join(serverDir, 'src'));
    fs.writeFileSync(path.join(serverDir, 'src', 'index.js'), 'console.log("hello")');

    // Start server and capture output(故意不传 --exec:整个 suite 跑在新默认 normal 上)
    const output = await runCli(['server', 'start', '--port', String(port)], serverDir);
    // 默认档必须钉死:新装即「远程执行开启 + 拦黑名单」
    assert.ok(output.includes('Exec: normal'), `Default exec policy missing in output: ${output}`);
    // Parse server URL from output
    const match = output.match(/URL: (http:\/\/[^\s]+)/);
    if (match) {
      serverUrl = match[1];
    }
    assert.ok(serverUrl, `Server URL not found in output: ${output}`);

    // 记住 daemon pid:afterEach 要等它死透再删目录(win32 句柄释放滞后)
    const pidMatch = output.match(/PID: (\d+)/);
    serverPid = pidMatch ? parseInt(pidMatch[1], 10) : null;
  });

  afterEach(async () => {
    // Stop server daemon properly
    try {
      await runCli(['server', 'stop'], serverDir);
    } catch {
      // Ignore
    }

    // win32:测试 daemon 的 cwd 就在 serverDir 里,stop 后内核关句柄需要一瞬,
    // 立刻 rmSync 会撞 EPERM/EBUSY。等 daemon pid 消失(轮询至多 5s)再删;
    // rmSync 的 maxRetries/retryDelay 仅在 win32 生效,作为兜底
    let tries = 0;
    while (serverPid && tries < 25) {
      let alive = false;
      try { process.kill(serverPid, 0); alive = true; } catch {}
      if (!alive) break;
      await new Promise(resolve => setTimeout(resolve, 200));
      tries++;
    }

    fs.rmSync(serverDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.rmSync(clientDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it('syncs files from server to client', async () => {
    // Configure client (password comes from LANSNC_PASSWORD, verified against server)
    const configResult = await runCli(['client', 'config', serverUrl.replace('http://', '')], clientDir);
    assert.ok(configResult.includes('Connected to'));
    assert.ok(configResult.includes('exec policy: normal'));

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

  it('server start rejects legacy long --exec values (hard cut, no daemon spawned)', async () => {
    const { code, stderr } = await runCliCapture(
      ['server', 'start', '--exec', 'exec-block-black'], serverDir
    );
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('Invalid exec mode: exec-block-black. Valid: off, normal, strict, all'));
  });

  it('server start rejects garbage --exec values', async () => {
    const { code, stderr } = await runCliCapture(['server', 'start', '--exec', 'yes'], serverDir);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('Invalid exec mode: yes. Valid: off, normal, strict, all'));
  });

  it('server start normalizes --exec case and persists the normalized mode', async () => {
    // 第二个 daemon:独立端口 + 独立配置目录,用完恢复(仿 not-configured 用例的交换模式)
    const originalConfigDir = configDir;
    const secondConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-config-'));
    configDir = secondConfigDir;
    let secondPid;
    try {
      const secondPort = 20000 + Math.floor(Math.random() * 20000);
      const out = await runCli(['server', 'start', '--port', String(secondPort), '--exec', 'STRICT'], serverDir);
      assert.ok(out.includes('Exec: strict'), `Normalized exec mode missing in output: ${out}`);

      const pidMatch = out.match(/PID: (\d+)/);
      assert.ok(pidMatch, `PID not found in output: ${out}`);
      secondPid = parseInt(pidMatch[1], 10);

      // status 从 server.json 读取:归一后的 strict 也落了盘,不是只回显
      const status = await runCli(['server', 'status'], serverDir);
      assert.ok(status.includes('Exec: strict'), `Persisted exec mode missing in status: ${status}`);
    } finally {
      try { await runCli(['server', 'stop'], serverDir); } catch {}
      // 等 daemon 死透再删(win32 句柄释放滞后,对齐 afterEach 的轮询惯例)
      for (let tries = 0; secondPid && tries < 25; tries++) {
        let alive = false;
        try { process.kill(secondPid, 0); alive = true; } catch {}
        if (!alive) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      fs.rmSync(secondConfigDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      configDir = originalConfigDir;
    }
  });

  it('server start rejects a blank password from LANSNC_PASSWORD', async () => {
    const { code, stderr } = await runCliCapture(['server', 'start'], serverDir, {
      LANSNC_PASSWORD: '   '
    });
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('Password is required'));
  });

  it('diff exits 2 when client is not configured', async () => {
    // 指向一个全新配置目录,让 client 处于未配置状态。
    // 用完必须恢复:afterEach 的 server stop 依赖 beforeEach 的 configDir
    // (指向本用例 daemon 的配置),改了不还,daemon 就没人杀了(EPERM 现场已取证)
    const originalConfigDir = configDir;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-config-'));
    try {
      const { code, stderr } = await runCliCapture(['diff'], clientDir);

      assert.strictEqual(code, 2);
      assert.ok(stderr.includes('not configured'));
    } finally {
      configDir = originalConfigDir;
    }
  });
});

function runCliCapture(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(process.cwd(), 'bin', 'lansync.js');
    const proc = spawn('node', [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 后传入的 env 键覆盖默认(如哄骗/空白口令用例)
      env: { ...process.env, LANSNC_CONFIG_DIR: configDir, LANSNC_PASSWORD: 'test-password', ...env }
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
