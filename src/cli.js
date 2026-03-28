// src/cli.js
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { startServerDaemon, stopServerDaemon, getServerStatus } from './server.js';
import { pull, push, checkServerReachable } from './client.js';
import { readClientConfig, writeClientConfig } from './config.js';

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
      case '--version':
      case '-v':
        console.log('lansync v1.0.0');
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
lansync - LAN file sync tool

Usage:
  lansync server start              Start server daemon
  lansync server stop               Stop server daemon
  lansync server status             Show server status
  lansync client config <ip:port>   Configure server address
  lansync client status             Show client config
  lansync pull [pattern] [--no-delete]  Pull files from server
  lansync push [pattern] [--no-delete]  Push files to server

Options:
  --no-delete    Don't delete files not present on source
  --version, -v  Show version
  --help, -h     Show this help
`);
}

async function handleServerCommand(subArgs) {
  const subCommand = subArgs[0];

  switch (subCommand) {
    case 'start': {
      const rootDir = process.cwd();
      const result = await startServerDaemon(rootDir);
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
        console.error('Usage: lansync client config <ip:port>');
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
        console.log('Client not configured. Run: lansync client config <ip:port>');
        return;
      }
      console.log(`Server URL: ${config.serverUrl}`);
      console.log(`Working directory: ${config.workDir}`);
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
    console.error('Client not configured. Run: lansync client config <ip:port>');
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

  if (result.downloaded.length > 0) {
    console.log('\n  Downloads:');
    for (const file of result.downloaded) {
      console.log(`    + ${file}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('\n  Skipped (unchanged):');
    for (const file of result.skipped) {
      console.log(`    ~ ${file}`);
    }
  }

  if (result.deleted.length > 0) {
    console.log('\n  Deleted (not on server):');
    for (const file of result.deleted) {
      console.log(`    - ${file}`);
    }
  }

  console.log(`\nSync complete: ${result.downloaded.length} downloaded, ${result.skipped.length} skipped, ${result.deleted.length} deleted`);

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
    console.error('Client not configured. Run: lansync client config <ip:port>');
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

  if (result.uploaded.length > 0) {
    console.log('\n  Uploads:');
    for (const file of result.uploaded) {
      console.log(`    + ${file}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('\n  Skipped (unchanged):');
    for (const file of result.skipped) {
      console.log(`    ~ ${file}`);
    }
  }

  if (result.deleted.length > 0) {
    console.log('\n  Deleted (not on client):');
    for (const file of result.deleted) {
      console.log(`    - ${file}`);
    }
  }

  console.log(`\nSync complete: ${result.uploaded.length} uploaded, ${result.skipped.length} skipped, ${result.deleted.length} deleted`);

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

main();