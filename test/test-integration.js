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
});

function runCli(args, cwd) {
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
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`CLI failed: ${stderr || stdout}`));
      }
    });
  });
}
