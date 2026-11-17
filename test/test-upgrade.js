// test/test-upgrade.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeVersion, patchManifest, compareSemver } from '../scripts/upgrade.js';

describe('upgrade version handling', () => {
  it('keeps lansync on the plain version', () => {
    assert.strictEqual(normalizeVersion('lansync', '1.6.1'), '1.6.1');
    assert.strictEqual(normalizeVersion('lansyncopt', '1.6.1'), '1.6.1-opt');
    assert.strictEqual(normalizeVersion('lansyncopt', '1.6.1-opt'), '1.6.1-opt');
  });

  it('compares semantic versions', () => {
    assert.ok(compareSemver('1.6.1', '1.6.0') > 0);
    assert.ok(compareSemver('1.6.0', '1.6.0') === 0);
    assert.ok(compareSemver('1.5.9', '1.6.0') < 0);
    assert.ok(compareSemver('2.0.0', '1.99.99') > 0);
  });

  it('patches package and lock for lansyncopt', () => {
    const pkg = { name: 'lansync', version: '1.6.1', bin: { lansync: './bin/lansync.js' } };
    const lock = {
      name: 'lansync',
      version: '1.6.1',
      packages: { '': { name: 'lansync', version: '1.6.1', bin: { lansync: 'bin/lansync.js' } } }
    };

    assert.strictEqual(patchManifest(pkg, lock, 'lansyncopt', '1.6.1'), '1.6.1-opt');
    assert.deepStrictEqual(pkg.name, 'lansyncopt');
    assert.deepStrictEqual(pkg.version, '1.6.1-opt');
    assert.deepStrictEqual(pkg.bin, { lansyncopt: './bin/lansync.js' });
    assert.deepStrictEqual(lock.packages[''].bin, { lansyncopt: 'bin/lansync.js' });
  });

  it('patches package and lock for lansync', () => {
    const pkg = { name: 'lansyncopt', version: '1.6.1-opt', bin: { lansyncopt: './bin/lansync.js' } };
    const lock = {
      name: 'lansyncopt',
      version: '1.6.1-opt',
      packages: { '': { name: 'lansyncopt', version: '1.6.1-opt', bin: { lansyncopt: 'bin/lansync.js' } } }
    };

    assert.strictEqual(patchManifest(pkg, lock, 'lansync', '1.6.1'), '1.6.1');
    assert.deepStrictEqual(pkg.name, 'lansync');
    assert.deepStrictEqual(pkg.version, '1.6.1');
    assert.deepStrictEqual(pkg.bin, { lansync: './bin/lansync.js' });
    assert.deepStrictEqual(lock.packages[''].bin, { lansync: 'bin/lansync.js' });
  });
});