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
  let serverUrl;
  let cliPath;

  beforeEach(async () => {
    // Clean up any existing server/config first
    const configDir = path.join(os.homedir(), '.lansync');
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-server-'));
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-client-'));
    cliPath = path.join(process.cwd(), 'bin', 'lansync.js');

    // Create test files on server
    fs.writeFileSync(path.join(serverDir, 'readme.md'), '# Test Project');
    fs.writeFileSync(path.join(serverDir, 'package.json'), '{"name": "test"}');
    fs.mkdirSync(path.join(serverDir, 'src'));
    fs.writeFileSync(path.join(serverDir, 'src', 'index.js'), 'console.log("hello")');

    // Start server and capture output
    const output = await runCli(['server', 'start'], serverDir);
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