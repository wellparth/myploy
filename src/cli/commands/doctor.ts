import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { loadConfig, expandTilde } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { checkServerPrerequisites } from '../../remote/bootstrap.js';
import { logger } from '../../utils/logger.js';

export async function doctorCommand(): Promise<void> {
  logger.header('MyPloy Diagnostics Doctor');

  console.log(chalk.bold('1. Local Workspace Checks:'));

  let config;
  try {
    config = loadConfig();
    logger.success('Configuration file loaded (myploy.json / .myploy.yml)');
  } catch (err: any) {
    logger.error('Configuration check failed: ' + err.message);
    return;
  }

  const composePath = path.resolve(process.cwd(), config.composeFile || 'docker-compose.yml');
  if (fs.existsSync(composePath)) {
    logger.success(`Docker Compose file found (${config.composeFile})`);
  } else {
    logger.warn(`Docker Compose file missing at: ${composePath}`);
  }

  if (config.sshKey) {
    const keyPath = expandTilde(config.sshKey);
    if (fs.existsSync(keyPath)) {
      logger.success(`SSH private key found at: ${keyPath}`);
    } else {
      logger.error(`SSH private key not found at: ${keyPath}`);
    }
  }

  console.log('\n' + chalk.bold('2. Remote VPS Diagnostics:'));
  const ssh = new SSHClient(config);

  try {
    const connSpinner = logger.step(`Testing SSH connection to ${config.user}@${config.host}...`);
    await ssh.connect();
    connSpinner.succeed(`SSH connected successfully to ${config.host}:${config.port || 22}`);

    const prereqs = await checkServerPrerequisites(ssh);

    if (prereqs.hasDocker) {
      logger.success(`Docker Engine ready (${prereqs.dockerVersion})`);
    } else {
      logger.error('Docker Engine NOT installed. Run "myploy setup" to install.');
    }

    if (prereqs.hasCompose) {
      logger.success(`Docker Compose plugin ready (${prereqs.composeVersion})`);
    } else {
      logger.error('Docker Compose plugin NOT installed. Run "myploy setup" to install.');
    }

    const netCheck = await ssh.exec('docker network inspect myploy-net 2>/dev/null');
    if (netCheck.code === 0) {
      logger.success('Docker network "myploy-net" configured');
    } else {
      logger.warn('Docker network "myploy-net" missing. Run "myploy setup".');
    }

    const nginxCheck = await ssh.exec("docker inspect -f '{{.State.Status}}' myploy-nginx 2>/dev/null");
    if (nginxCheck.stdout.trim() === 'running') {
      logger.success('Reverse proxy (myploy-nginx) is running');
    } else {
      logger.warn('Reverse proxy (myploy-nginx) is not running. Run "myploy setup".');
    }

    console.log('\n' + chalk.green.bold('Doctor check completed. Everything looks good!'));
  } catch (err: any) {
    logger.error('Remote diagnostics failed: ' + err.message);
  } finally {
    ssh.disconnect();
  }
}
