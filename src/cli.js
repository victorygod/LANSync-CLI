// src/cli.js
import process from 'node:process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { startServerDaemon, stopServerDaemon, getServerStatus, getPortOwnerPid, isOwnDaemon, killPidHard, DEFAULT_PORT } from './server.js';
import { pull, push, diff, verifyAuth, execRemote } from './client.js';
import { readClientConfig, writeClientConfig } from './config.js';
import { deriveToken, EXEC_POLICIES, DEFAULT_POLICY, resolvePolicy } from './policy.js';

const args = process.argv.slice(2);

// 版本号单一来源:package.json。start/config/status 都打印,
// 用于一眼确认对端机器部署的是哪个版本的代码。
let VERSION = 'unknown';
try {
  VERSION = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
  ).version;
} catch {}

// Windows + undici: calling process.exit() while a socket is in
// UV_HANDLE_CLOSING trips a libuv assertion (win/async.c). Set the exit code
// and let the event loop close sockets; the unref'd timer only fires if
// keep-alive handles would otherwise keep the CLI alive.
class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'ExitSignal';
    this.exitCode = code;
  }
}

function scheduleExit(code) {
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), 50);
  timer.unref();
}

// Preserve process.exit()'s "stop here" semantics: throwing unwinds the
// handler instead of letting it continue with missing config/paths.
function exitSoon(code) {
  scheduleExit(code);
  throw new ExitSignal(code);
}

async function main() {
  if (args.length === 0) {
    printHelp();
    return;
  }

  const command = args[0];

  try {
    const grouped = command === 'server' || command === 'client';
    const key = grouped ? args.slice(0, 2).join(' ') : command;
    const argv = args.slice(grouped ? 2 : 1);
    const definitions = {
      push: { 'no-delete': { type: 'boolean' } },
      pull: { 'no-delete': { type: 'boolean' } },
      diff: { json: { type: 'boolean' } },
      exec: { json: { type: 'boolean' } },
      'server start': { port: { type: 'string' }, exec: { type: 'string' } },
      'server stop': { yes: { type: 'boolean', short: 'y' } },
      'server status': {}, 'client status': {}, 'client config': {}
    };
    let options, paths;
    if (Object.hasOwn(definitions, key)) {
      let parsed;
      try {
        parsed = parseArgs({ args: argv, allowPositionals: true, options: {
          ...definitions[key], help: { type: 'boolean', short: 'h' }
        } });
      } catch (err) {
        if (key === 'exec') throw new Error(`${err.message}. Quote the entire remote command, e.g. lansync exec "git status"`);
        throw err;
      }
      options = parsed.values;
      paths = parsed.positionals;
      if (options.help) return printHelp();
      const variable = ['push', 'pull', 'diff'].includes(key);
      const count = key === 'exec' || key === 'client config' ? 1 : 0;
      if (key === 'exec' && paths.length !== 1) throw new Error('Quote the entire remote command, e.g. lansync exec "git status"');
      if (!variable && paths.length !== count) throw new Error(`Invalid arguments for ${key}. See lansync ${key} --help`);
    } else if (grouped && ['--help', '-h'].includes(args[1])) return printHelp();
    switch (command) {
      case 'server':
        await handleServerCommand(args[1], options);
        break;
      case 'client':
        await handleClientCommand(args[1], paths);
        break;
      case 'pull':
        await handlePullCommand(options, paths);
        break;
      case 'push':
        await handlePushCommand(options, paths);
        break;
      case 'exec':
        await handleExecCommand(options, paths);
        break;
      case 'diff':
        await handleDiffCommand(options, paths);
        break;
      case '--version':
      case '-v':
        console.log(`lansync v${VERSION}`);
        break;
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        exitSoon(1);
    }
  } catch (err) {
    if (err instanceof ExitSignal) return;
    const optionEnd = args.indexOf('--');
    const json = command === 'diff' && args.slice(1, optionEnd < 0 ? args.length : optionEnd).includes('--json');
    console.error(json ? JSON.stringify({ error: err.message }) : `Error: ${err.message}`);
    scheduleExit(command === 'diff' ? 2 : 1);
  }
}

function printHelp() {
  console.log(`
lansync - LAN file sync tool (remote-exec)

Usage:
  lansync server start [--port <n>] [--exec <m>]  Start server daemon (prompts for password)
  lansync server stop [-y]           Stop server daemon; if the port is still
                                        held by an orphan process, show the owner
                                        and ask to kill it (Y = kill, -y = no ask)
  lansync server status              Show server status
  lansync client config <ip:port>    Configure server address + password (verified against server)
  lansync client status              Show client config
  lansync pull [path ...] [--no-delete]  Pull files from server
  lansync push [path ...] [--no-delete]  Push files to server
  lansync exec [--json] "<command>"  Execute remote command
  lansync diff [path ...] [--json]    Compare local with server without transferring
                                        exit 0 = in sync, 1 = differs, 2 = error

All requests are authenticated with the password (Bearer token). The password is
set on the server at start and must match on the client at config time.

Options:
  --no-delete    Don't delete files not present on source
  --exec <m>     Remote exec mode: off (disabled) | normal (default: block blacklist,
                 allow graylist) | strict (block blacklist+graylist) | all (allow all);
                 case-insensitive
  --version, -v  Show version
  --help, -h     Show this help

Agent usage:
  Agents normally drive the client side. Connect first via 'client config <ip:port>'
  (verifies the password against the server), then confirm with 'client status'.
  Tip: set LANSNC_PASSWORD to skip interactive password prompts in scripts.
  Large repos: small calls use 10s; listings/transfers default to 300s and can
  be overridden with LANSNC_LIST_TIMEOUT_MS / LANSNC_TRANSFER_TIMEOUT_MS.

  1. Sync with pull/push, never as exec side effects. Each pull/push transfers
     diffs and lists changed files, so a call doubles as a diff check.
     'lansync diff [--json] [path ...]' checks sync state WITHOUT
     transferring: exit 0 = in sync, 1 = differs. Use it to decide whether a
     push/pull is needed.
     Run 'git commit' on the local repo BEFORE syncing: the default pull/push
     deletes files missing on the other side, uncommitted changes can be lost
     (--no-delete disables deletion).
  2. Recommended loop: keep the server copy identical to the local repo. Edit
     locally first, git commit, 'lansync push' to the server, then
     'lansync exec "<command>"' to run commands on the server.
  3. Git: commit locally BEFORE syncing, and commit on the far side AFTER a
     push. lansync copies working-tree files only; .git is ignored and the
     two histories stay independent.
`);
}

async function handleServerCommand(subCommand, options) {

  switch (subCommand) {
    case 'start': {
      const rootDir = process.cwd();
      const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
      if (options.port !== undefined && (!/^\d+$/.test(options.port) || port < 1 || port > 65535)) {
        throw new Error(`Invalid port: ${options.port}`);
      }
      const execArg = options.exec ?? DEFAULT_POLICY;
      const policy = resolvePolicy(execArg);
      if (!policy) {
        console.error(`Invalid exec mode: ${execArg}. Valid: ${EXEC_POLICIES.join(', ')}`);
        exitSoon(1);
      }
      // 密码始终必填:所有 /api/*(含 pull/push)都要求 token,与 --exec 取值无关
      const password = await promptPassword('Enter cli password: ');
      if (!password || !password.trim()) {
        console.error('Password is required (set LANSNC_PASSWORD or enter interactively).');
        exitSoon(1);
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
      const port = getServerStatus().port ?? DEFAULT_PORT;
      const force = options.yes;
      const stopped = stopServerDaemon();
      if (stopped) {
        console.log('Server stopped.');
      }

      // 端口真相核查:孤儿 daemon(强杀/半途 start/配置丢失)不经配置文件管理,
      // 「stop 不报错」不等于端口已释放。发现占用 → 展示占用者 → 交互确认硬杀
      const ownerPid = getPortOwnerPid(port);
      if (!ownerPid) {
        if (!stopped) console.log('No server running.');
        break;
      }

      if (!isOwnDaemon(ownerPid)) throw new Error(`Port ${port} is held by another process (PID ${ownerPid}).`);
      if (stopped) {
        console.log(`Warning: port ${port} is still occupied by PID ${ownerPid} (lansync daemon)`);
      } else {
        console.log(`No server running, but port ${port} is occupied:`);
        console.log(`  PID ${ownerPid} (lansync daemon)`);
      }

      let confirmed = force;
      if (!confirmed) {
        const answer = await askYesNo(`Kill PID ${ownerPid} to free port ${port}? [y/N]: `);
        confirmed = /^y(es)?$/i.test(answer.trim());
      }

      if (!confirmed) {
        console.log('Left it running. Re-run with -y to kill without asking.');
        break;
      }

      if (await killPidHard(ownerPid)) {
        const still = getPortOwnerPid(port);
        console.log(still
          ? `Killed PID ${ownerPid}, but port ${port} is STILL occupied by PID ${still}.`
          : `Killed PID ${ownerPid}. Port ${port} is free.`);
      } else {
        console.error(`Failed to kill PID ${ownerPid}. Kill it manually: taskkill /PID ${ownerPid} /F (Windows) or kill -9 ${ownerPid}.`);
        exitSoon(1);
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
      exitSoon(1);
  }
}

async function handleClientCommand(subCommand, paths) {

  switch (subCommand) {
    case 'config': {
      const serverAddr = paths[0];
      if (!serverAddr) {
        console.error('Usage: lansync client config <ip:port>');
        exitSoon(1);
      }

      // 地址基本校验:拦住 192.168.71,239(逗号当点)这类手滑,顺便归一化成 origin
      let url;
      try {
        url = new URL(serverAddr.startsWith('http') ? serverAddr : `http://${serverAddr}`);
      } catch {
        console.error(`Invalid server address: ${serverAddr}`);
        exitSoon(1);
      }
      if (!url.hostname || url.hostname.includes(',') || url.hostname.includes(' ')) {
        console.error(`Invalid server address: ${serverAddr} (hostname: "${url.hostname}")`);
        exitSoon(1);
      }
      const serverUrl = url.origin;
      const workDir = process.cwd();

      const password = await promptPassword('Enter cli password: ');
      if (!password || !password.trim()) {
        console.error('Password is required (set LANSNC_PASSWORD or enter interactively).');
        exitSoon(1);
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
        console.log('Client not configured. Run: lansync client config <ip:port>');
        return;
      }
      console.log(`Server URL: ${config.serverUrl}`);
      console.log(`Working directory: ${config.workDir}`);
      console.log(`Version: ${VERSION}`);
      if (!config.token) {
        console.log('Password: not set (re-run: lansync client config <ip:port>)');
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
      exitSoon(1);
  }
}

async function handlePullCommand(options, patterns) {
  const config = readClientConfig();
  if (!config) {
    console.error('Client not configured. Run: lansync client config <ip:port>');
    exitSoon(1);
  }

  const { serverUrl, workDir, token } = config;
  if (!token) {
    console.error('Client has no password. Re-run: lansync client config <ip:port>');
    exitSoon(1);
  }
  const currentDir = process.cwd();

  console.log(`Connecting to ${serverUrl}...`);

  const pathPrefix = currentDir !== workDir ? path.relative(workDir, currentDir) : '';
  if (pathPrefix) {
    console.log(`Syncing path: ${pathPrefix}/`);
  }

  console.log('Reading .gitignore rules...');
  console.log('Syncing files...');

  const noDelete = options['no-delete'];

  const result = await pull({ serverUrl, workDir, currentDir, patterns, noDelete, token });

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

  if (result.skippedDeletes) console.log(`Skipped ${result.skippedDeletes} planned deletions because a transfer failed.`);
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
    process.exitCode = 1;
  }
}

async function handlePushCommand(options, patterns) {
  const config = readClientConfig();
  if (!config) {
    console.error('Client not configured. Run: lansync client config <ip:port>');
    exitSoon(1);
  }

  const { serverUrl, workDir, token } = config;
  if (!token) {
    console.error('Client has no password. Re-run: lansync client config <ip:port>');
    exitSoon(1);
  }
  const currentDir = process.cwd();

  console.log(`Connecting to ${serverUrl}...`);

  const pathPrefix = currentDir !== workDir ? path.relative(workDir, currentDir) : '';
  if (pathPrefix) {
    console.log(`Syncing path: ${pathPrefix}/`);
  }

  console.log('Reading .gitignore rules...');
  console.log('Syncing files...');

  const noDelete = options['no-delete'];

  const result = await push({ serverUrl, workDir, currentDir, patterns, noDelete, token });

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

  if (result.skippedDeletes) console.log(`Skipped ${result.skippedDeletes} planned deletions because a transfer failed.`);
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
    process.exitCode = 1;
  }
}

async function handleDiffCommand(options, patterns) {
  const json = options.json;

  // diff 的一切失败(未配置/网络/鉴权/越界)都退出码 2,与「有差异」的 1 严格
  // 区分:agent 用 $? 即可判定同步状态,无需解析文本
  const fail = (message) => {
    console.error(json ? JSON.stringify({ error: message }) : `Error: ${message}`);
    exitSoon(2);
  };

  const config = readClientConfig();
  if (!config) {
    fail('Client not configured. Run: lansync client config <ip:port>');
  }
  if (!config.token) {
    fail('Client has no password. Re-run: lansync client config <ip:port>');
  }

  const { serverUrl, workDir, token } = config;
  const currentDir = process.cwd();

  if (!json) {
    console.log(`Comparing local (${currentDir}) with server (${serverUrl})...`);
  }

  try {
    const result = await diff({ serverUrl, workDir, currentDir, patterns, token });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.inSync ? 0 : 1;
      return;
    }

    if (result.prefix) {
      console.log(`Scope: ${result.prefix}/`);
    }
    if (!result.serverDirExists) {
      console.log(`(note: server has no directory "${result.prefix}" - every local file reports as local-only)`);
    }

    if (result.files.length === 0) {
      console.log(`In sync (${result.summary.inSync} file${result.summary.inSync === 1 ? '' : 's'})`);
      return;
    }

    const MARKS = { modified: 'M', 'local-only': '+', 'server-only': '-' };
    for (const f of result.files) {
      const detail = f.status === 'modified'
        ? `local ${f.local.size}B / server ${f.server.size}B`
        : (f.status === 'local-only' ? 'only in local' : 'only in server');
      console.log(`  ${MARKS[f.status]}  ${f.path}  ${detail}`);
    }

    const s = result.summary;
    console.log(`\n${s.modified} modified, ${s.localOnly} local-only, ${s.serverOnly} server-only, ${s.inSync} in sync`);
    process.exitCode = 1;
  } catch (err) {
    fail(err.message);
  }
}

async function handleExecCommand(options, patterns) {
  const config = readClientConfig();
  if (!config) {
    console.error('Client not configured. Run: lansync client config <ip:port>');
    exitSoon(1);
  }
  if (!config.token) {
    console.error('Client has no password. Re-run: lansync client config <ip:port>');
    exitSoon(1);
  }

  const { serverUrl, token } = config;
  const json = options.json;
  const command = patterns[0];
  if (!command) {
    console.error('Usage: lansync exec [--json] "<command>"');
    exitSoon(1);
  }

  const result = await execRemote(serverUrl, token, command);

  if (json) {
    console.log(JSON.stringify(result));
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode ?? 0;
}

// 非交互(stdin 非 TTY)直接视作否:agent/exec 场景不能挂起干等输入
function askYesNo(promptText) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdout.write(promptText);
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.once('line', line => {
      rl.close();
      resolve(line);
    });
  });
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

main().catch(err => {
  if (err instanceof ExitSignal) return;
  console.error(err?.stack || String(err));
  scheduleExit(1);
});
