import { loadConfig } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { deployFromGit } from '../../core/git.js';
import { logger } from '../../utils/logger.js';

export interface GitCliOptions {
  branch?: string;
  app?: string;
  domain?: string;
  port?: string;
}

export async function gitDeployCommand(repoUrl: string, options: GitCliOptions): Promise<void> {
  const config = loadConfig();
  const ssh = new SSHClient(config);

  try {
    const spinner = logger.step(`Connecting to ${config.user}@${config.host}...`);
    await ssh.connect();
    spinner.succeed(`Connected to ${config.host}`);

    await deployFromGit(ssh, {
      repoUrl,
      branch: options.branch || 'main',
      app: options.app || config.app,
      domain: options.domain || config.domain,
      port: options.port ? parseInt(options.port, 10) : config.appPort
    });
  } finally {
    ssh.disconnect();
  }
}
