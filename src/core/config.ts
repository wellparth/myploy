import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { MyPloyConfig } from '../types/config.js';

const CONFIG_FILENAMES = [
  'myploy.json',
  '.myploy.json',
  'myploy.yml',
  'myploy.yaml',
  '.myploy.yml',
  '.myploy.yaml'
];

export function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

export function findConfigFile(dir = process.cwd()): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const fullPath = path.join(dir, filename);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

export function loadConfig(configPath?: string): MyPloyConfig {
  const resolvedPath = configPath || findConfigFile();

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(
      'Could not find a MyPloy configuration file (myploy.json or myploy.yml). Run "myploy init" to create one.'
    );
  }

  const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
  let raw: Partial<MyPloyConfig>;

  if (resolvedPath.endsWith('.json')) {
    raw = JSON.parse(fileContent);
  } else {
    raw = yaml.parse(fileContent);
  }

  return normalizeConfig(raw);
}

export function normalizeConfig(raw: Partial<MyPloyConfig>): MyPloyConfig {
  if (!raw.app) {
    throw new Error('Configuration error: "app" name is required');
  }
  if (!raw.domain) {
    throw new Error('Configuration error: "domain" is required (e.g. app.example.com)');
  }
  if (!raw.host) {
    throw new Error('Configuration error: "host" is required (VPS IP or hostname)');
  }

  const defaultKeyPath = fs.existsSync(expandTilde('~/.ssh/id_ed25519'))
    ? '~/.ssh/id_ed25519'
    : '~/.ssh/id_rsa';

  const healthcheck = {
    path: raw.healthcheck?.path || '/',
    port: raw.healthcheck?.port || raw.appPort || 3000,
    timeoutSeconds: raw.healthcheck?.timeoutSeconds ?? 30,
    intervalSeconds: raw.healthcheck?.intervalSeconds ?? 2
  };

  return {
    app: raw.app.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
    domain: raw.domain.trim().toLowerCase(),
    host: raw.host.trim(),
    user: raw.user || 'root',
    port: raw.port || 22,
    sshKey: raw.sshKey ? expandTilde(raw.sshKey) : expandTilde(defaultKeyPath),
    password: raw.password,
    appPort: raw.appPort || 3000,
    healthcheck,
    envFile: raw.envFile,
    ssl: raw.ssl ?? true,
    composeFile: raw.composeFile || 'docker-compose.yml',
    keepPreviousRunning: raw.keepPreviousRunning ?? true
  };
}

export function saveConfig(config: MyPloyConfig, filepath = 'myploy.json'): void {
  fs.writeFileSync(filepath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
