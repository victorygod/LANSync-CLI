// src/cli.js
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { startServerDaemon, stopServerDaemon, getServerStatus } from './server.js';
import { pull, push, checkServerReachable, verifyAuth, execRemote } from './client.js';
import { readClientConfig, writeClientConfig } from './config.js';
import { deriveToken, EXEC_POLICIES, DEFAULT_POLICY } from './policy.js';

const args = process.argv.slice(2);

// 版本号单一来源:package.json。start/config/status 都打印,
// 用于一眼确认对端机器部署的是哪个版本的代码。
let VERSION = 'unknown';
try {
  VERSION = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
  ).version;
} catch {}

async function main() {
  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  try {
    switch (command) {
      case 'server':
        await handleServerCommand(args.slice(1));
        break;
      case 'client':
        await handleClientCommand(args.slice(1));
        break;
      case 'pull':
        await handlePullCommand(args.slice(1));
        break;
      case 'push':
        await handlePushCommand(args.slice(1));
        break;
      case 'exec':
        await handleExecCommand(args.slice(1));
        break;
      case '--version':
      case '-v':
        console.log(`lansyncopt v${VERSION}`);
        break;
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
lansyncopt - LAN file sync tool (remote-exec)

Usage:
  lansyncopt server start [--port <n>] [--policy <m>]  Start server daemon (prompts for password)
  lansyncopt server stop                Stop server daemon
  lansyncopt server status              Show server status
  lansyncopt client config <ip:port>    Configure server address + password (verified against server)
  lansyncopt client status              Show client config
  lansyncopt pull [pattern] [--no-delete]  Pull files from server
  lansyncopt push [pattern] [--no-delete]  Push files to server
  lansyncopt exec [--json] "<command>"  Execute remote command

All requests are authenticated with the password (Bearer token). The password is
set on the server at start and must match on the client at config time.

Options:
  --no-delete    Don't delete files not present on source
  --policy <m>   exec-forbidden (default) | exec-all-allow | exec-block-black | exec-block-black-gray
  --version, -v  Show version
  --help, -h     Show this help

Agent usage:
  Agents normally drive the client side. Connect first via 'client config <ip:port>'
  (verifies the password against the server), then confirm with 'client status'.
  Tip: set LANSNC_PASSWORD to skip interactive password prompts in scripts.

  1. Sync with pull/push, never as exec side effects. Each pull/push transfers
     diffs and lists changed files, so a call doubles as a diff check.
     Run 'git commit' on the local repo BEFORE syncing: the default pull/push
     deletes files missing on the other side, uncommitted changes can be lost
     (--no-delete disables deletion).
  2. Recommended loop: keep the server copy identical to the local repo. Edit
     locally first, git commit, 'lansyncopt push' to the server, then
     'lansyncopt exec "<command>"' to run commands on the server.
`);
}

async function handleServerCommand(subArgs) {
  const subCommand = subArgs[0];

  switch (subCommand) {
    case 'start': {
      const rootDir = process.cwd();
      const portArgIndex = subArgs.indexOf('--port');
      const port = portArgIndex !== -1 && subArgs[portArgIndex + 1]
        ? parseInt(subArgs[portArgIndex + 1], 10)
        : undefined;
      const policyArgIndex = subArgs.indexOf('--policy');
      const policy = policyArgIndex !== -1 && subArgs[policyArgIndex + 1]
        ? subArgs[policyArgIndex + 1]
        : DEFAULT_POLICY;
      if (!EXEC_POLICIES.includes(policy)) {
        console.error(`Invalid policy: ${policy}. Valid: ${EXEC_POLICIES.join(', ')}`);
        process.exit(1);
      }
      // 密码始终必填:所有 /api/*(含 pull/push)都要求 token
      const password = await promptPassword('Enter cli password: ');
      if (!password) {
        console.error('Password is required (set LANSNC_PASSWORD or enter interactively).');
        process.exit(1);
      }
      const token = deriveToken(password);
      const result = await startServerDaemon(rootDir, port, token, policy);
      console.log('Server started successfully.');
      console.log(`  Version: ${VERSION}`);
      console.log(`  URL: http://${result.ip}:${result.port}`);
      console.log(`  Root: ${result.rootDir}`);
      console.log(`  PID: ${result.pid}`);
      console.log(`  Exec: ${policy}`);
      break;
    }
    case 'stop': {
      const stopped = stopServerDaemon();
      if (stopped) {
        console.log('Server stopped.');
      } else {
        console.log('No server running.');
      }
      break;
    }
    case 'status': {
      const status = getServerStatus();
      console.log(`Server status: ${status.status}`);
      console.log(`  Version: ${VERSION}`);
      if (status.status === 'running') {
        console.log(`  URL: ${status.url}`);
        console.log(`  Root: ${status.rootDir}`);
        console.log(`  PID: ${status.pid}`);
        console.log(`  Exec: ${status.policy}`);
      }
      break;
    }
    default:
      console.error(`Unknown server command: ${subCommand}`);
      process.exit(1);
  }
}

async function handleClientCommand(subArgs) {
  const subCommand = subArgs[0];

  switch (subCommand) {
    case 'config': {
      const serverAddr = subArgs[1];
      if (!serverAddr) {
        console.error('Usage: lansyncopt client config <ip:port>');
        process.exit(1);
      }

      // 地址基本校验:拦住 192.168.71,239(逗号当点)这类手滑,顺便归一化成 origin
      let url;
      try {
        url = new URL(serverAddr.startsWith('http') ? serverAddr : `http://${serverAddr}`);
      } catch {
        console.error(`Invalid server address: ${serverAddr}`);
        process.exit(1);
      }
      if (!url.hostname || url.hostname.includes(',') || url.hostname.includes(' ')) {
        console.error(`Invalid server address: ${serverAddr} (hostname: "${url.hostname}")`);
        process.exit(1);
      }
      const serverUrl = url.origin;
      const workDir = process.cwd();

      const password = await promptPassword('Enter cli password: ');
      if (!password) {
        console.error('Password is required (set LANSNC_PASSWORD or enter interactively).');
        process.exit(1);
      }
      const token = deriveToken(password);

      // 连 server 验证口令:错了当场报,不落半截配置
      const policy = await verifyAuth(serverUrl, token);

      writeClientConfig({ serverUrl, workDir, token });
      console.log(`Connected to ${serverUrl}`);
      console.log(`Server exec policy: ${policy}`);
      console.log(`Working directory: ${workDir}`);
      console.log(`Version: ${VERSION}`);
      break;
    }
    case 'status': {
      const config = readClientConfig();
      if (!config) {
        console.log('Client not configured. Run: lansyncopt client config <ip:port>');
        return;
      }
      console.log(`Server URL: ${config.serverUrl}`);
      console.log(`Working directory: ${config.workDir}`);
      console.log(`Version: ${VERSION}`);
      if (!config.token) {
        console.log('Password: not set (re-run: lansyncopt client config <ip:port>)');
        return;
      }
      console.log('Password: saved');
      // 顺手探活并回显 server 端 policy;失败不致命,status 依旧可用
      try {
        const policy = await verifyAuth(config.serverUrl, config.token);
        console.log(`Server: reachable (exec policy: ${policy})`);
      } catch (err) {
        console.log(`Server: unreachable (${err.message})`);
      }
      break;
    }
    default:
      console.error(`Unknown client command: ${subCommand}`);
      process.exit(1);
  }
}

async function handlePullCommand(subArgs) {
  const config = readClientConfig();
  if (!config) {
    console.error('Client not configured. Run: lansyncopt client config <ip:port>');
    process.exit(1);
  }

  const { serverUrl, workDir, token } = config;
  if (!token) {
    console.error('Client has no password. Re-run: lansyncopt client config <ip:port>');
    process.exit(1);
  }
  const currentDir = process.cwd();

  console.log(`Connecting to ${serverUrl}...`);

  // 网络/鉴权失败直接抛带 cause 的错误,由 main 统一打印
  await checkServerReachable(serverUrl, token);

  const pathPrefix = currentDir !== workDir ? path.relative(workDir, currentDir) : '';
  if (pathPrefix) {
    console.log(`Syncing path: ${pathPrefix}/`);
  }

  console.log('Reading .gitignore rules...');
  console.log('Syncing files...');

  const noDelete = subArgs.includes('--no-delete');
  const pattern = subArgs.find(a => !a.startsWith('--'));

  const result = await pull({ serverUrl, workDir, currentDir, pattern, noDelete, token });

  if (result.skipped.length > 0) {
    console.log('\n  Skipped (unchanged):');
    for (const file of result.skipped) {
      console.log(`    ~ ${file}`);
    }
  }

  if (result.downloaded.length > 0) {
    console.log('\n  Downloads:');
    for (const file of result.downloaded) {
      console.log(`    + ${file}`);
    }
  }

  if (result.deleted.length > 0) {
    console.log('\n  Deleted (not on server):');
    for (const file of result.deleted) {
      console.log(`    - ${file}`);
    }
  }

  console.log(`\nSync complete: ${result.skipped.length} skipped, ${result.downloaded.length} downloaded, ${result.deleted.length} deleted`);

  if (result.failed.length > 0) {
    console.log(`\n  Failed (${result.failed.length}):`);
    for (const file of result.failed) {
      console.log(`    ! ${file.path}`);
      console.log(`      ${file.error}`);
    }
  }

  if (noDelete && result.keptCount > 0) {
    console.log(`(Note: ${result.keptCount} local files not on server were kept due to --no-delete)`);
  }

  if (result.downloaded.length === 0 && result.skipped.length === 0 && result.deleted.length === 0 && result.failed.length === 0) {
    console.log('\nNo changes. Already in sync.');
  }

  if (result.failed.length > 0) {
    process.exit(1);
  }
}

async function handlePushCommand(subArgs) {
  const config = readClientConfig();
  if (!config) {
    console.error('Client not configured. Run: lansyncopt client config <ip:port>');
    process.exit(1);
  }

  const { serverUrl, workDir, token } = config;
  if (!token) {
    console.error('Client has no password. Re-run: lansyncopt client config <ip:port>');
    process.exit(1);
  }
  const currentDir = process.cwd();

  console.log(`Connecting to ${serverUrl}...`);

  // 网络/鉴权失败直接抛带 cause 的错误,由 main 统一打印
  await checkServerReachable(serverUrl, token);

  const pathPrefix = currentDir !== workDir ? path.relative(workDir, currentDir) : '';
  if (pathPrefix) {
    console.log(`Syncing path: ${pathPrefix}/`);
  }

  console.log('Reading .gitignore rules...');
  console.log('Syncing files...');

  const noDelete = subArgs.includes('--no-delete');
  const pattern = subArgs.find(a => !a.startsWith('--'));

  const result = await push({ serverUrl, workDir, currentDir, pattern, noDelete, token });

  if (result.skipped.length > 0) {
    console.log('\n  Skipped (unchanged):');
    for (const file of result.skipped) {
      console.log(`    ~ ${file}`);
    }
  }

  if (result.uploaded.length > 0) {
    console.log('\n  Uploads:');
    for (const file of result.uploaded) {
      console.log(`    + ${file}`);
    }
  }

  if (result.deleted.length > 0) {
    console.log('\n  Deleted (not on client):');
    for (const file of result.deleted) {
      console.log(`    - ${file}`);
    }
  }

  console.log(`\nSync complete: ${result.skipped.length} skipped, ${result.uploaded.length} uploaded, ${result.deleted.length} deleted`);

  if (result.failed.length > 0) {
    console.log(`\n  Failed (${result.failed.length}):`);
    for (const file of result.failed) {
      console.log(`    ! ${file.path}`);
      console.log(`      ${file.error}`);
    }
  }

  if (noDelete && result.keptCount > 0) {
    console.log(`(Note: ${result.keptCount} server files not on client were kept due to --no-delete)`);
  }

  if (result.uploaded.length === 0 && result.skipped.length === 0 && result.deleted.length === 0 && result.failed.length === 0) {
    console.log('\nNo changes. Already in sync.');
  }

  if (result.failed.length > 0) {
    process.exit(1);
  }
}

async function handleExecCommand(subArgs) {
  const config = readClientConfig();
  if (!config) {
    console.error('Client not configured. Run: lansyncopt client config <ip:port>');
    process.exit(1);
  }
  if (!config.token) {
    console.error('Client has no password. Re-run: lansyncopt client config <ip:port>');
    process.exit(1);
  }

  const { serverUrl, token } = config;
  const json = subArgs.includes('--json');
  const command = subArgs.filter(a => a !== '--json').join(' ');
  if (!command) {
    console.error('Usage: lansyncopt exec [--json] "<command>"');
    process.exit(1);
  }

  const result = await execRemote(serverUrl, token, command);

  if (json) {
    console.log(JSON.stringify(result));
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  process.exit(result.exitCode ?? 0);
}

// 读取口令:优先环境变量 LANSNC_PASSWORD(agent 场景),否则交互式隐藏回显
function promptPassword(promptText) {
  return new Promise((resolve) => {
    if (process.env.LANSNC_PASSWORD) {
      resolve(process.env.LANSNC_PASSWORD);
      return;
    }
    const muted = new Writable({
      write(chunk, encoding, cb) { cb(); }
    });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(promptText);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

main();