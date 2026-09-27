// test/test-config.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigDir, readServerConfig, writeServerConfig, readClientConfig, writeClientConfig } from '../src/config.js';

describe('config module', () => {
  let originalHome;

  beforeEach(() => {
    originalHome = process.env.HOME;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lansync-test-'));
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  describe('getConfigDir', () => {
    it('returns ~/.lansyncopt path (isolated from installed lansync)', () => {
      const configDir = getConfigDir();
      assert.ok(configDir.endsWith('.lansyncopt'));
    });

    it('honors LANSNC_CONFIG_DIR override', () => {
      process.env.LANSNC_CONFIG_DIR = '/tmp/custom-config';
      assert.strictEqual(getConfigDir(), '/tmp/custom-config');
      delete process.env.LANSNC_CONFIG_DIR;
    });
  });

  describe('server config', () => {
    it('returns null when config does not exist', () => {
      const config = readServerConfig();
      assert.strictEqual(config, null);
    });

    it('writes and reads server config', () => {
      const data = { pid: 12345, port: 8001, rootDir: '/tmp/test', ip: '192.168.1.1' };
      writeServerConfig(data);
      const config = readServerConfig();
      assert.deepStrictEqual(config, data);
    });
  });

  describe('client config', () => {
    it('returns null when config does not exist', () => {
      const config = readClientConfig();
      assert.strictEqual(config, null);
    });

    it('writes and reads client config', () => {
      const data = { serverUrl: 'http://192.168.1.1:8001', workDir: '/tmp/project' };
      writeClientConfig(data);
      const config = readClientConfig();
      assert.deepStrictEqual(config, data);
    });
  });
});