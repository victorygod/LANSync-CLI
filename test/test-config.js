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
    // 双保险:模块顶层已设隔离,但任何用例中途 delete 都会让后续用例
    // 回落 os.homedir() 写真实 ~/.lansyncopt(Windows 实测事故:test-config
    // :58/72 把活 server 的配置覆盖,daemon 每请求重读配置即刻换 token)。
    // 每个用例都重新钉一遍。
    process.env.LANSNC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lansyncopt-test-config-'));
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    // 不 delete、也不还原到「无值」:保持在本文件的隔离目录上,
    // 目录本体由模块顶层创建,文件进程结束一起消失
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
      // 此用例本身在动 env:结束时必须恢复(否则摘隔离,后续用例写盘穿透)
      const saved = process.env.LANSNC_CONFIG_DIR;
      process.env.LANSNC_CONFIG_DIR = '/tmp/custom-config';
      try {
        assert.strictEqual(getConfigDir(), '/tmp/custom-config');
      } finally {
        if (saved !== undefined) {
          process.env.LANSNC_CONFIG_DIR = saved;
        } else {
          delete process.env.LANSNC_CONFIG_DIR;
        }
      }
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