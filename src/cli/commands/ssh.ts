import prompts from 'prompts';
import chalk from 'chalk';
import { ensureSSHKeyPair, authorizeKeyOnVPS } from '../../remote/keygen.js';
import { loadConfig } from '../../core/config.js';
import { logger } from '../../utils/logger.js';

export async function sshInitCommand(options: { host?: string; user?: string }): Promise<void> {
  logger.header('MyPloy SSH Key Automation');

  const spinner = logger.step('Checking local SSH keys...');
  const keyInfo = await ensureSSHKeyPair();

  if (keyInfo.isNew) {
    spinner.succeed(`Generated new Ed25519 SSH keypair at: ${keyInfo.privateKeyPath}`);
  } else {
    spinner.succeed(`Found existing SSH keypair at: ${keyInfo.privateKeyPath}`);
  }

  console.log('\n' + chalk.bold('Your Public Key (add this to VPS authorized_keys or cloud console):'));
  console.log(chalk.cyan.bold(keyInfo.publicKeyContent) + '\n');

  let host = options.host;
  let user = options.user || 'root';

  if (!host) {
    try {
      const config = loadConfig();
      host = config.host;
      user = config.user || 'root';
    } catch {
      // no config
    }
  }

  if (host) {
    const response = await prompts({
      type: 'confirm',
      name: 'copyNow',
      message: `Would you like to install this key on ${user}@${host} using password authentication?`,
      initial: true
    });

    if (response.copyNow) {
      const pwResponse = await prompts({
        type: 'password',
        name: 'password',
        message: `Enter SSH password for ${user}@${host}:`,
        validate: (v) => (v ? true : 'Password is required')
      });

      if (pwResponse.password) {
        const copySpinner = logger.step(`Installing public key on ${host}...`);
        try {
          await authorizeKeyOnVPS({
            host,
            user,
            password: pwResponse.password,
            publicKey: keyInfo.publicKeyContent
          });
          copySpinner.succeed(`Key successfully installed on ${host}!`);
          logger.success('Future MyPloy commands will authenticate automatically with zero errors.');
        } catch (err: any) {
          copySpinner.fail(`Failed to install key: ${err.message}`);
        }
      }
    }
  }
}

export async function sshPublicKeyCommand(): Promise<void> {
  const keyInfo = await ensureSSHKeyPair();
  console.log(keyInfo.publicKeyContent);
}
