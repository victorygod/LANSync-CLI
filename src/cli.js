// src/cli.js
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { startServerDaemon, stopServerDaemon, getServerStatus, enableCli, disableCli } from './server.js';
import { pull, push, checkServerReachable, execRemote } from './client.js';
import { readClientConfig, writeClientConfig } from './config.js';
import { deriveToken } from './policy.js';

const args = process.argv.slice(2);

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
        console.log('lansyncopt v1.0.0');
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
  lansyncopt server start [--port <n>]  Start server daemon
  lansyncopt server stop                Stop server daemon
  lansyncopt server status              Show server status
  lansyncopt server enable-cli --policy <mode>  Enable remote exec (password + policy)
  lansyncopt server disable-cli         Disable remote exec
  lansyncopt client config <ip:port>    Configure server address
  lansyncopt client status              Show client config
  lansyncopt client enable-cli          Enable remote exec on client (same password)
  lansyncopt client disable-cli         Disable remote exec on client
  lansyncopt pull [pattern] [--no-delete]  Pull files from server
  lansyncopt push [pattern] [--no-delete]  Push files to server
  lansyncopt exec [--json] "<command>"  Execute remote command

Options:
  --no-delete    Don't delete files not present on source
  --policy <m>   allow-all | block-black | block-black-gray (default block-black)
  --version, -v  Show version
  --help, -h     Show this help
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
      const result = await startServerDaemon(rootDir, port);
      console.log('Server started successfully.');
      console.log(`  URL: http://${result.ip}:${result.port}`);
      console.log(`  Root: ${result.rootDir}`);
      console.log(`  PID: ${result.pid}`);
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
      if (status.status === 'running') {
        console.log(`  URL: ${status.url}`);
        console.log(`  Root: ${status.rootDir}`);
        console.log(`  PID: ${status.pid}`);
        console.log(`  CLI: ${status.cliEnabled ? `enabled (policy=${status.policy})` : 'disabled'}`);
      }
      break;
    }
    case 'enable-cli': {
      const policyArgIndex = subArgs.indexOf('--policy');
      const policy = policyArgIndex !== -1 && subArgs[policyArgIndex + 1]
        ? subArgs[policyArgIndex + 1]
        : 'block-black';
      const validPolicies = ['allow-all', 'block-black', 'block-black-gray'];
      if (!validPolicies.includes(policy)) {
        console.error(`Invalid policy: ${policy}. Valid: ${validPolicies.join(', ')}`);
        process.exit(1);
      }
      const password = await promptPassword('Enter cli password: ');
      if (!password) {
        console.error('Password is required (set LANSNC_PASSWORD or enter interactively).');
        process.exit(1);
      }
      enableCli(password, policy);
      console.log(`CLI enabled. policy=${policy}`);
      break;
    }
    case 'disable-cli': {
      const disabled = disableCli();
      console.log(disabled ? 'CLI disabled.' : 'CLI was not enabled.');
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

      const serverUrl = serverAddr.startsWith('http') ? serverAddr : `http://${serverAddr}`;
      const workDir = process.cwd();

      writeClientConfig({ serverUrl, workDir });
      console.log(`Configured server: ${serverUrl}`);
      console.log(`Working directory: ${workDir}`);
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
      console.log(`CLI: ${config.token ? 'enabled' : 'disabled'}`);
      break;
    }
    case 'enable-cli': {
      const password = await promptPassword('Enter cli password: ');
      if (!password) {
        console.error('Password is required (set LANSNC_PASSWORD or enter interactively).');
        process.exit(1);
      }
      const config = readClientConfig();
      if (!config) {
        console.error('Client not configured. Run: lansyncopt client config <ip:port> first.');
        process.exit(1);
      }
      config.token = deriveToken(password);
      writeClientConfig(config);
      console.log('Client cli enabled (token saved).');
      break;
    }
    case 'disable-cli': {
      const config = readClientConfig();
      if (config && config.token) {
        delete config.token;
        writeClientConfig(config);
        console.log('Client cli disabled.');
      } else {
        console.log('Client cli was not enabled.');
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

  const { serverUrl, workDir } = config;
  const currentDir = process.cwd();

  console.log(`Connecting to ${serverUrl}...`);

  const reachable = await checkServerReachable(serverUrl);
  if (!reachable) {
    console.error(`Server not reachable at ${serverUrl}`);
    process.exit(1);
  }

  const pathPrefix = currentDir !== workDir ? path.relative(workDir, currentDir) : '';
  if (pathPrefix) {
    console.log(`Syncing path: ${pathPrefix}/`);
  }

  console.log('Reading .gitignore rules...');
  console.log('Syncing files...');

  const noDelete = subArgs.includes('--no-delete');
  const pattern = subArgs.find(a => !a.startsWith('--'));

  const result = await pull({ serverUrl, workDir, currentDir, pattern, noDelete });

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

  const { serverUrl, workDir } = config;
  const currentDir = process.cwd();

  console.log(`Connecting to ${serverUrl}...`);

  const reachable = await checkServerReachable(serverUrl);
  if (!reachable) {
    console.error(`Server not reachable at ${serverUrl}`);
    process.exit(1);
  }

  const pathPrefix = currentDir !== workDir ? path.relative(workDir, currentDir) : '';
  if (pathPrefix) {
    console.log(`Syncing path: ${pathPrefix}/`);
  }

  console.log('Reading .gitignore rules...');
  console.log('Syncing files...');

  const noDelete = subArgs.includes('--no-delete');
  const pattern = subArgs.find(a => !a.startsWith('--'));

  const result = await push({ serverUrl, workDir, currentDir, pattern, noDelete });

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
    console.error('Client cli not enabled. Run: lansyncopt client enable-cli');
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