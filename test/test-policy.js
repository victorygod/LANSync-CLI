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
    const d = checkPolicy('rm -rf /', 'block-black');
    assert.strictEqual(d.blocked, true);
    assert.strictEqual(d.list, 'black');
  });

  it('does NOT block targeted absolute-path rm (word-boundary match)', () => {
    const d = checkPolicy('rm -rf /home/user/node_modules', 'block-black');
    assert.strictEqual(d.blocked, false);
  });

  it('gray command allowed in block-black, blocked in block-black-gray', () => {
    assert.strictEqual(checkPolicy('docker system prune', 'block-black').blocked, false);
    assert.strictEqual(checkPolicy('docker system prune', 'block-black-gray').blocked, true);
  });

  it('allow-all blocks nothing', () => {
    assert.strictEqual(checkPolicy('rm -rf /', 'allow-all').blocked, false);
    assert.strictEqual(checkPolicy('docker system prune', 'allow-all').blocked, false);
  });

  it('blacklist wins over graylist (sudo su vs sudo)', () => {
    const d = checkPolicy('sudo su', 'block-black-gray');
    assert.strictEqual(d.list, 'black');
  });

  it('whitelist commands always pass', () => {
    assert.strictEqual(checkPolicy('git pull', 'block-black').blocked, false);
    assert.strictEqual(checkPolicy('npm test', 'block-black-gray').blocked, false);
  });

  it('case-insensitive for Windows commands', () => {
    const d = checkPolicy('FORMAT C:', 'block-black');
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
