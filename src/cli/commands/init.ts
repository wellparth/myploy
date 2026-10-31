import prompts from 'prompts';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { logger } from '../../utils/logger.js';
import { saveConfig } from '../../core/config.js';
import { MyPloyConfig } from '../../types/config.js';

export async function initCommand(): Promise<void> {
  logger.header('Initialize MyPloy Project');

  const defaultAppName = path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const defaultKey = fs.existsSync(path.join(os.homedir(), '.ssh', 'id_ed25519'))
    ? '~/.ssh/id_ed25519'
    : '~/.ssh/id_rsa';

  const response = await prompts([
    {
      type: 'text',
      name: 'app',
      message: 'Application name:',
      initial: defaultAppName
    },
    {
      type: 'text',
      name: 'domain',
      message: 'Production domain (e.g. app.example.com):',
      validate: (value) => (value ? true : 'Domain is required for SSL and routing.')
    },
    {
      type: 'text',
      name: 'host',
      message: 'Target VPS IP address or hostname:',
      validate: (value) => (value ? true : 'VPS Host is required.')
    },
    {
      type: 'text',
      name: 'user',
      message: 'SSH user:',
      initial: 'root'
    },
    {
      type: 'text',
      name: 'sshKey',
      message: 'SSH private key path:',
      initial: defaultKey
    },
    {
      type: 'number',
      name: 'appPort',
      message: 'Internal container application port:',
      initial: 3000
    },
    {
      type: 'text',
      name: 'healthPath',
      message: 'Healthcheck endpoint path:',
      initial: '/health'
    }
  ]);

  if (!response.app || !response.domain || !response.host) {
    logger.warn('Initialization aborted.');
    return;
  }

  const config: MyPloyConfig = {
    app: response.app,
    domain: response.domain,
    host: response.host,
    user: response.user || 'root',
    sshKey: response.sshKey,
    appPort: response.appPort || 3000,
    healthcheck: {
      path: response.healthPath || '/health',
      timeoutSeconds: 30,
      intervalSeconds: 2
    },
    ssl: true,
    keepPreviousRunning: true
  };

  saveConfig(config, 'myploy.json');
  logger.success('Created myploy.json successfully!');

  // Check if docker-compose.yml exists, if not generate starter
  if (!fs.existsSync(path.join(process.cwd(), 'docker-compose.yml'))) {
    const starterCompose = `version: '3.8'

services:
  web:
    build: .
    restart: always
    environment:
      - NODE_ENV=production
      - PORT=${config.appPort}
`;
    fs.writeFileSync('docker-compose.yml', starterCompose, 'utf-8');
    logger.info('Created starter docker-compose.yml');
  }

  console.log('\nNext steps:');
  console.log('  1. Bootstrap your VPS:   npx myploy setup');
  console.log('  2. Deploy your app:       npx myploy deploy\n');
}
