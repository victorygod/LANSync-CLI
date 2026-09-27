// test/test-exec.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer, enableCli } from '../src/server.js';
import { deriveToken } from '../src/policy.js';

const PASSWORD = 'test-password';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error('waitFor timeout');
}

describe('/api/exec', () => {
  let rootDir;
  let configDir;
  let server;
  let port;
  let token;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-exec-root-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-exec-config-'));
    process.env.LANSNC_CONFIG_DIR = configDir;

    token = deriveToken(PASSWORD);
    enableCli(PASSWORD, 'block-black');

    server = createServer(rootDir);
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    delete process.env.LANSNC_CONFIG_DIR;
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function exec(command, opts = {}) {
    return fetch(`http://localhost:${port}/api/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.token ?? token}`
      },
      body: JSON.stringify({ command, cwd: opts.cwd })
    });
  }

  it('rejects without token (401)', async () => {
    const res = await fetch(`http://localhost:${port}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo hi' })
    });
    assert.strictEqual(res.status, 401);
  });

  it('rejects wrong token (401)', async () => {
    const res = await exec('echo hi', { token: 'wrong-token' });
    assert.strictEqual(res.status, 401);
  });

  it('runs a whitelist command and returns output', async () => {
    const res = await exec('echo hello-world');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.exitCode, 0);
    assert.ok(data.stdout.includes('hello-world'));
  });

  it('blocks blacklist command (403)', async () => {
    const res = await exec('rm -rf /');
    assert.strictEqual(res.status, 403);
  });

  it('blocks self-reference (own pid) (403)', async () => {
    const res = await exec(`kill ${process.pid}`);
    assert.strictEqual(res.status, 403);
  });

  it('gray command allowed in block-black, blocked in block-black-gray', async () => {
    const res1 = await exec('docker system prune');
    assert.strictEqual(res1.status, 200);

    enableCli(PASSWORD, 'block-black-gray');
    const res2 = await exec('docker system prune');
    assert.strictEqual(res2.status, 403);
  });

  it('enforces concurrency limit (429)', async () => {
    const cfgFile = path.join(configDir, 'server.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    cfg.maxConcurrent = 1;
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));

    const p1 = exec('sleep 2');
    await sleep(150); // let first command start
    const res2 = await exec('echo hi');
    assert.strictEqual(res2.status, 429);
    await p1;
  });

  it('kills whole process group on client disconnect', async () => {
    const pidFile = path.join(rootDir, 'pids.txt');
    const command = `sh -c 'echo $$ > ${pidFile}; sleep 100 & echo $! >> ${pidFile}; wait'`;

    const controller = new AbortController();
    const fetchPromise = fetch(`http://localhost:${port}/api/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ command }),
      signal: controller.signal
    });

    // 等命令真正跑起来(写出 shell pid 与子进程 pid)
    await waitFor(() => {
      try {
        const content = fs.readFileSync(pidFile, 'utf-8');
        return content.trim().split('\n').length >= 2;
      } catch {
        return false;
      }
    }, 3000);

    // 模拟 agent 超时/断开
    controller.abort();
    await fetchPromise.catch(() => {});

    // 等待 SIGTERM + 2s SIGKILL 宽限
    await sleep(3000);

    const pids = fs.readFileSync(pidFile, 'utf-8').trim().split('\n').map(Number).filter(Boolean);
    assert.ok(pids.length >= 2, `expected shell + child pid, got: ${pids}`);
    for (const pid of pids) {
      assert.strictEqual(isAlive(pid), false, `pid ${pid} should have been killed`);
    }
  });
});
