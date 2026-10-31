#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { setupCommand } from './commands/setup.js';
import { deployCommand } from './commands/deploy.js';
import { rollbackCommand } from './commands/rollback.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { doctorCommand } from './commands/doctor.js';
import { logger } from '../utils/logger.js';

const program = new Command();

program
  .name('myploy')
  .description('Lightweight zero-downtime deploy tool for Docker Compose apps on small VPS instances')
  .version('0.1.0');

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
