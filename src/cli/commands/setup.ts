import prompts from 'prompts';
import { loadConfig } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { bootstrapServer } from '../../remote/bootstrap.js';
import { ensureSSHKeyPair, authorizeKeyOnVPS } from '../../remote/keygen.js';
import { logger } from '../../utils/logger.js';

export interface SetupOptions {
  host?: string;
  user?: string;
  key?: string;
}

export async function setupCommand(options: SetupOptions): Promise<void> {
  logger.header('MyPloy VPS Bootstrap');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!options.host) {
      throw new Error(
        'No myploy.json found. Please run "myploy init" first or specify --host <ip>'
      );
    }
    config = {
      app: 'system',
      domain: 'localhost',
      host: options.host,
      user: options.user || 'root',
      sshKey: options.key,
      appPort: 3000
    };
  }

  if (options.host) config.host = options.host;
  if (options.user) config.user = options.user;
  if (options.key) config.sshKey = options.key;

  // 1. Ensure SSH Keypair exists locally
  const keyInfo = await ensureSSHKeyPair(config.sshKey);
  config.sshKey = keyInfo.privateKeyPath;

  logger.info(`Target Server: ${config.user}@${config.host}`);
  logger.info(`Using SSH Key: ${config.sshKey}`);

  let ssh = new SSHClient(config);

  try {
    const spinner = logger.step(`Connecting to ${config.user}@${config.host}...`);
    try {
      await ssh.connect();
      spinner.succeed(`Connected to ${config.host}`);
    } catch (err: any) {
      spinner.fail(`SSH key authentication failed: ${err.message}`);

      // Self-healing SSH key authorization
      const response = await prompts({
        type: 'password',
        name: 'password',
        message: `Enter VPS root password once to automatically authorize your SSH key on ${config.host}:`
      });

      if (!response.password) {
        throw new Error('Authentication aborted. SSH key could not be verified.');
      }

      const authSpinner = logger.step(`Authorizing key on ${config.host}...`);
      await authorizeKeyOnVPS({
        host: config.host,
        user: config.user,
        password: response.password,
        publicKey: keyInfo.publicKeyContent
      });
      authSpinner.succeed('SSH key authorized on VPS!');

      // Reconnect with newly installed key
      ssh = new SSHClient(config);
      await ssh.connect();
      logger.success(`Connected via authorized SSH key to ${config.host}`);
    }

    await bootstrapServer(ssh);

    logger.success('Server is fully prepared for zero-downtime MyPloy deployments!');
  } finally {
    ssh.disconnect();
  }
}
