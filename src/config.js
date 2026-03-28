// src/config.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function getConfigDir() {
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