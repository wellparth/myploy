import { loadConfig } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { bootstrapServer } from '../../remote/bootstrap.js';
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

  logger.info(`Target Server: ${config.user}@${config.host}`);

  const ssh = new SSHClient(config);

  try {
    const spinner = logger.step(`Connecting to ${config.user}@${config.host}...`);
    await ssh.connect();
    spinner.succeed(`Connected to ${config.host}`);

    await bootstrapServer(ssh);

    logger.success('Server is fully prepared for zero-downtime MyPloy deployments!');
  } finally {
    ssh.disconnect();
  }
}
