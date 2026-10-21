// test/test-policy.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  deriveToken,
  normalizeCommand,
  checkPolicy,
  resolvePolicy,
  detectSelfReference,
  DEFAULT_POLICY
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

describe('resolvePolicy', () => {
  it('normalizes case', () => {
    assert.strictEqual(resolvePolicy('OFF'), 'off');
    assert.strictEqual(resolvePolicy('NORMAL'), 'normal');
    assert.strictEqual(resolvePolicy('Strict'), 'strict');
    assert.strictEqual(resolvePolicy('ALL'), 'all');
  });

  it('trims surrounding whitespace', () => {
    assert.strictEqual(resolvePolicy(' off '), 'off');
  });

  it('rejects legacy long names (hard cut)', () => {
    assert.strictEqual(resolvePolicy('exec-forbidden'), null);
    assert.strictEqual(resolvePolicy('exec-block-black'), null);
    assert.strictEqual(resolvePolicy('exec-block-black-gray'), null);
    assert.strictEqual(resolvePolicy('exec-all-allow'), null);
  });

  it('rejects garbage and non-string input', () => {
    assert.strictEqual(resolvePolicy('yes'), null);
    assert.strictEqual(resolvePolicy(''), null);
    assert.strictEqual(resolvePolicy(undefined), null);
    assert.strictEqual(resolvePolicy(null), null);
  });

  it('default policy is normal', () => {
    assert.strictEqual(DEFAULT_POLICY, 'normal');
  });
});

describe('checkPolicy', () => {
  it('blocks catastrophic root deletion as black', () => {
    const d = checkPolicy('rm -rf /', 'normal');
    assert.strictEqual(d.blocked, true);
    assert.strictEqual(d.list, 'black');
  });

  it('off blocks everything (defense in depth)', () => {
    assert.strictEqual(checkPolicy('echo hi', 'off').blocked, true);
    assert.strictEqual(checkPolicy('rm -rf /', 'off').list, 'policy');
  });

  it('does NOT block targeted absolute-path rm (word-boundary match)', () => {
    const d = checkPolicy('rm -rf /home/user/node_modules', 'normal');
    assert.strictEqual(d.blocked, false);
  });

  it('gray command allowed in normal, blocked in strict', () => {
    assert.strictEqual(checkPolicy('docker system prune', 'normal').blocked, false);
    assert.strictEqual(checkPolicy('docker system prune', 'strict').blocked, true);
  });

  it('all blocks nothing', () => {
    assert.strictEqual(checkPolicy('rm -rf /', 'all').blocked, false);
    assert.strictEqual(checkPolicy('docker system prune', 'all').blocked, false);
  });

  it('unrecognized policy value gets no gray pass (strict, no legacy aliases)', () => {
    // 旧长名 'exec-block-black' 自 v1.5.0 起非法:checkPolicy 对未识别值仅黑名单兜底
    // —— 黑名单仍拦,灰名单放行(与 server 侧兜成 normal 的行为等价)
    assert.strictEqual(checkPolicy('rm -rf /', 'exec-block-black').blocked, true);
    assert.strictEqual(checkPolicy('docker system prune', 'exec-block-black').blocked, false);
  });

  it('blacklist wins over graylist (sudo su vs sudo)', () => {
    const d = checkPolicy('sudo su', 'strict');
    assert.strictEqual(d.list, 'black');
  });

  it('whitelist commands always pass', () => {
    assert.strictEqual(checkPolicy('git pull', 'normal').blocked, false);
    assert.strictEqual(checkPolicy('npm test', 'strict').blocked, false);
  });

  it('case-insensitive for Windows commands', () => {
    const d = checkPolicy('FORMAT C:', 'normal');
    assert.strictEqual(d.blocked, true);
    assert.strictEqual(d.list, 'black');
  });
});

describe('detectSelfReference', () => {
  it('detects server pid in command', () => {
    assert.strictEqual(detectSelfReference('kill 12345', ['12345', '/tmp/cfg']), '12345');
  });

  it('detects config dir path', () => {
    assert.strictEqual(detectSelfReference('rm -rf /home/u/.lansync', ['999', '/home/u/.lansync']), '/home/u/.lansync');
  });

  it('returns null for clean command', () => {
    assert.strictEqual(detectSelfReference('git pull', ['12345', '/tmp/cfg']), null);
  });
});
