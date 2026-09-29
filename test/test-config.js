// test/test-config.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigDir, readServerConfig, writeServerConfig, readClientConfig, writeClientConfig } from '../src/config.js';

// 必须在文件顶部隔离配置目录:本文件直接读写 server.json/client.json。
// 注意 HOME 覆盖不够——os.homedir() 在 Windows 上走 USERPROFILE,
// 旧写法只在 macOS 隔离生效,Windows 上会把真实 ~/.lansyncopt/server.json
// 写花(daemon 每请求重读配置 → 活着的 server 即刻换 token → client 全线 401)
process.env.LANSNC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-test-config-'));

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
      // 本文件顶部为防泄漏设了 LANSNC_CONFIG_DIR;该用例专测默认值,临时摘掉
      const savedOverride = process.env.LANSNC_CONFIG_DIR;
      delete process.env.LANSNC_CONFIG_DIR;
      try {
        const configDir = getConfigDir();
        assert.ok(configDir.endsWith('.lansyncopt'));
      } finally {
        if (savedOverride !== undefined) {
          process.env.LANSNC_CONFIG_DIR = savedOverride;
        }
      }
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