#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { setupCommand } from './commands/setup.js';
import { deployCommand } from './commands/deploy.js';
import { rollbackCommand } from './commands/rollback.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { doctorCommand } from './commands/doctor.js';
import { dbCreateCommand, dbListCommand, dbBackupCommand } from './commands/db.js';
import { gitDeployCommand } from './commands/gitDeploy.js';
import { uiCommand } from './commands/ui.js';
import { sshInitCommand, sshPublicKeyCommand } from './commands/ssh.js';
import { logger } from '../utils/logger.js';

const program = new Command();

program
  .name('myploy')
  .description('Dokploy-grade lightweight zero-downtime deploy tool for VPS Docker Compose apps & databases')
  .version('0.2.0');

program
  .command('init')
  .description('Initialize a new myploy.json configuration in the current directory')
  .action(async () => {
    try {
      await initCommand();
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command('setup')
  .description('Bootstrap a clean VPS: install Docker, Compose, UFW firewall, Nginx & Certbot')
  .option('--host <host>', 'VPS IP address or hostname')
  .option('--user <user>', 'SSH user (default: root)')
  .option('-k, --key <path>', 'SSH private key path')
  .action(async (options) => {
    try {
      await setupCommand(options);
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command('deploy')
  .description('Deploy application with zero downtime via Blue/Green traffic switching and healthchecks')
  .action(async () => {
    try {
      await deployCommand();
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command('rollback')
  .description('Instantly roll back Nginx traffic to the previous active container slot')
  .action(async () => {
    try {
      await rollbackCommand();
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command('git <repoUrl>')
  .description('Deploy an application directly from a remote Git repository (Dokploy-style)')
  .option('-b, --branch <branch>', 'Git branch to deploy (default: main)', 'main')
  .option('-a, --app <name>', 'Application name')
  .option('-d, --domain <domain>', 'Domain name for routing & SSL')
  .option('-p, --port <port>', 'Internal container port (default: 3000)', '3000')
  .action(async (repoUrl, options) => {
    try {
      await gitDeployCommand(repoUrl, options);
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// Database subcommands
const dbCommand = program.command('db').description('Manage 1-click databases and automated backups');

dbCommand
  .command('create <type> <name>')
  .description('Provision a new database (postgres, mysql, redis, mongo, mariadb)')
  .action(async (type, name) => {
    try {
      await dbCreateCommand(type, name);
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

dbCommand
  .command('list')
  .description('List all active managed databases, status, and internal connection strings')
  .action(async () => {
    try {
      await dbListCommand();
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

dbCommand
  .command('backup <name>')
  .description('Create an instant snapshot backup of a managed database')
  .action(async (name) => {
    try {
      await dbBackupCommand(name);
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

// SSH Automation subcommands
const sshCommand = program.command('ssh').description('Automate SSH key generation and VPS authorization');

sshCommand
  .command('init')
  .description('Ensure local Ed25519 SSH key exists and optionally authorize it on the VPS')
  .option('--host <host>', 'VPS host IP')
  .option('--user <user>', 'SSH user (default: root)')
  .action(async (options) => {
    try {
      await sshInitCommand(options);
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

sshCommand
  .command('public-key')
  .description('Print your public SSH key to easily copy into cloud provider console')
  .action(async () => {
    try {
      await sshPublicKeyCommand();
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command('ui')
  .description('Launch the embedded web dashboard and VPS control plane (Dokploy-grade)')
  .option('-p, --port <port>', 'Local port to run UI server on', '4000')
  .action(async (options) => {
    try {
      await uiCommand(options);
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current active slot, container health, and proxy routing status')
  .action(async () => {
    try {
      await statusCommand();
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command('logs')
  .description('Stream logs from the active production container')
  .option('-s, --slot <slot>', 'Target specific slot (blue or green)')
  .option('-t, --tail <lines>', 'Number of lines to show (default: 100)', '100')
  .option('-f, --follow', 'Follow log output', false)
  .action(async (options) => {
    try {
      await logsCommand(options);
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Run local configuration and remote VPS connectivity diagnostics')
  .action(async () => {
    try {
      await doctorCommand();
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
