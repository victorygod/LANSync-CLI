import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanLocalFiles } from '../src/client.js';
import { walkDir } from '../src/server.js';

const cli = fileURLToPath(new URL('../bin/lansync.js', import.meta.url));
const exec = promisify(execFile);

it('both scanners propagate directory and file read errors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'locked'), 'content');
  t.mock.method(fs, 'readFileSync', () => { throw new Error('Cannot read locked'); });
  for (const scan of [dir => scanLocalFiles(dir, []), dir => walkDir(dir, dir, [])]) {
    assert.throws(() => scan(root), /locked/);
    assert.throws(() => scan(path.join(root, 'missing')), /ENOENT/);
  }
});

for (const op of ['push', 'pull']) {
  it(op + ' requests one scoped list and preserves deletion candidates after failure', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sync-error-'));
    const cwd = path.join(root, 'sub');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'local'), 'local');
    const requests = [];
    let status = 200;
    let recovery = false;
    let listing = { files: [{ path: 'sub/remote', hash: 'remote' }], scopedPrune: true };
    const server = http.createServer((req, res) => {
      requests.push([req.method, req.url]);
      if (req.url === '/api/list?path=sub') {
        res.writeHead(status);
        return res.end(JSON.stringify(listing));
      }
      if (recovery) return res.end(req.method === 'GET' ? 'recovered' : '{}');
      res.writeHead(req.method === 'GET' ? 404 : 500);
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const serverUrl = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(path.join(root, 'client.json'), JSON.stringify({ workDir: root, token: 'test', serverUrl }));
    const run = cmd => exec(process.execPath, [cli, cmd], { cwd, env: { ...process.env, LANSNC_CONFIG_DIR: root } });
    await assert.rejects(run(op), err => err.code === 1 && /Skipped 1 planned deletions/.test(err.stdout));
    assert.deepEqual(requests.filter(([,url]) => url.startsWith('/api/list')), [['GET', '/api/list?path=sub']]);
    assert.ok(requests.every(([method]) => method !== 'DELETE'));
    assert.equal(fs.readFileSync(path.join(cwd, 'local'), 'utf8'), 'local');
    listing = {};
    for (const cmd of [op, 'diff']) {
      requests.length = 0;
      await assert.rejects(run(cmd), err => err.code === (cmd === 'diff' ? 2 : 1) && /files array/.test(err.stderr));
      assert.deepEqual(requests, [['GET', '/api/list?path=sub']]);
    }
    for (status of [401, 500]) {
      listing = { error: 'Cannot read locked file' };
      requests.length = 0;
      await assert.rejects(run(op), err => err.code === 1 && (status === 401 || err.stderr.includes(listing.error)));
      assert.deepEqual(requests, [['GET', '/api/list?path=sub']]);
      assert.ok(fs.existsSync(path.join(cwd, 'local')));
    }
    status = 200;
    recovery = true;
    listing = { files: [{ path: 'sub/remote', hash: 'remote' }], scopedPrune: true };
    requests.length = 0;
    await run(op);
    assert.equal(requests[0][1], '/api/list?path=sub');
    if (op === 'pull') {
      assert.equal(fs.readFileSync(path.join(cwd, 'remote'), 'utf8'), 'recovered');
      assert.ok(!fs.existsSync(path.join(cwd, 'local')));
    } else {
      assert.deepEqual(requests.map(([method]) => method), ['GET', 'POST', 'DELETE']);
    }
    await new Promise(resolve => server.close(resolve));
    await assert.rejects(run(op), err => err.code === 1 && /Cannot reach/.test(err.stderr));
  });
}
