// test/test-policy.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  deriveToken,
  normalizeCommand,
  checkPolicy,
  detectSelfReference
} from '../src/policy.js';

describe('deriveToken', () => {
  it('same password -> same token', () => {
    assert.strictEqual(deriveToken('abc'), deriveToken('abc'));
  });

  it('different password -> different token', () => {
    assert.notStrictEqual(deriveToken('abc'), deriveToken('def'));
  });

  it('is a 64-char hex digest', () => {
    assert.match(deriveToken('abc'), /^[a-f0-9]{64}$/);
  });
});

describe('normalizeCommand', () => {
  it('lowercases and normalizes backslash separators', () => {
    assert.strictEqual(normalizeCommand('DEL /S /Q C:\\Temp'), 'del /s /q c:/temp');
  });
});

describe('checkPolicy', () => {
  it('blocks catastrophic root deletion as black', () => {
    const d = checkPolicy('rm -rf /', 'exec-block-black');
    assert.strictEqual(d.blocked, true);
    assert.strictEqual(d.list, 'black');
  });

  it('exec-forbidden blocks everything (defense in depth)', () => {
    assert.strictEqual(checkPolicy('echo hi', 'exec-forbidden').blocked, true);
    assert.strictEqual(checkPolicy('rm -rf /', 'exec-forbidden').list, 'policy');
  });

  it('does NOT block targeted absolute-path rm (word-boundary match)', () => {
    const d = checkPolicy('rm -rf /home/user/node_modules', 'exec-block-black');
    assert.strictEqual(d.blocked, false);
  });

  it('gray command allowed in exec-block-black, blocked in exec-block-black-gray', () => {
    assert.strictEqual(checkPolicy('docker system prune', 'exec-block-black').blocked, false);
    assert.strictEqual(checkPolicy('docker system prune', 'exec-block-black-gray').blocked, true);
  });

  it('exec-all-allow blocks nothing', () => {
    assert.strictEqual(checkPolicy('rm -rf /', 'exec-all-allow').blocked, false);
    assert.strictEqual(checkPolicy('docker system prune', 'exec-all-allow').blocked, false);
  });

  it('unrecognized policy value gets no gray pass (strict, no legacy aliases)', () => {
    // 旧名 'block-black-gray' 不是合法值:不拦灰名单,仅黑名单兜底 —— 明确不兼容旧名
    assert.strictEqual(checkPolicy('docker system prune', 'block-black-gray').blocked, false);
  });

  it('blacklist wins over graylist (sudo su vs sudo)', () => {
    const d = checkPolicy('sudo su', 'exec-block-black-gray');
    assert.strictEqual(d.list, 'black');
  });

  it('whitelist commands always pass', () => {
    assert.strictEqual(checkPolicy('git pull', 'exec-block-black').blocked, false);
    assert.strictEqual(checkPolicy('npm test', 'exec-block-black-gray').blocked, false);
  });

  it('case-insensitive for Windows commands', () => {
    const d = checkPolicy('FORMAT C:', 'exec-block-black');
    assert.strictEqual(d.blocked, true);
    assert.strictEqual(d.list, 'black');
  });
});

describe('detectSelfReference', () => {
  it('detects server pid in command', () => {
    assert.strictEqual(detectSelfReference('kill 12345', ['12345', '/tmp/cfg']), '12345');
  });

  it('detects config dir path', () => {
    assert.strictEqual(detectSelfReference('rm -rf /home/u/.lansyncopt', ['999', '/home/u/.lansyncopt']), '/home/u/.lansyncopt');
  });

  it('returns null for clean command', () => {
    assert.strictEqual(detectSelfReference('git pull', ['12345', '/tmp/cfg']), null);
  });
});
