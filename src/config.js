// src/config.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getConfigDir() {
  // 支持环境变量覆盖(测试隔离 / 灰度发布)。
  // 默认 ~/.lansync。远程执行功能曾以临时名 lansyncopt(配置目录 ~/.lansyncopt)
  // 并行发布以避开旧安装;合并回 main 后恢复原名。
  if (process.env.LANSNC_CONFIG_DIR) {
    return process.env.LANSNC_CONFIG_DIR;
  }
  return path.join(os.homedir(), '.lansync');
}

function ensureConfigDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readServerConfig() {
  const file = path.join(getConfigDir(), 'server.json');
  if (!fs.existsSync(file)) {
    return null;
  }
  const content = fs.readFileSync(file, 'utf-8');
  return JSON.parse(content);
}

export function writeServerConfig(config) {
  ensureConfigDir();
  const file = path.join(getConfigDir(), 'server.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

export function readClientConfig() {
  const file = path.join(getConfigDir(), 'client.json');
  if (!fs.existsSync(file)) {
    return null;
  }
  const content = fs.readFileSync(file, 'utf-8');
  return JSON.parse(content);
}

export function writeClientConfig(config) {
  ensureConfigDir();
  const file = path.join(getConfigDir(), 'client.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}