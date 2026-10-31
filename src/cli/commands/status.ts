import { loadConfig } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { getDeploymentState } from '../../core/bluegreen.js';
import { hasExistingCertificate } from '../../core/ssl.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

export async function statusCommand(): Promise<void> {
  logger.header('MyPloy Deployment Status');

  const config = loadConfig();
  const ssh = new SSHClient(config);

  try {
    await ssh.connect();

    const state = await getDeploymentState(ssh, config.app);
    const activeSlot = state?.activeSlot || 'none';
    const previousSlot = state?.previousSlot || 'none';

    // Check containers
    const blueStatus = (
      await ssh.exec(`docker inspect -f '{{.State.Status}}' ${config.app}_blue 2>/dev/null`)
    ).stdout.trim() || 'not running';
    const greenStatus = (
      await ssh.exec(`docker inspect -f '{{.State.Status}}' ${config.app}_green 2>/dev/null`)
    ).stdout.trim() || 'not running';

    // Check Nginx & SSL
    const nginxStatus = (
      await ssh.exec(`docker inspect -f '{{.State.Status}}' myploy-nginx 2>/dev/null`)
    ).stdout.trim() || 'not running';
    const hasCert = await hasExistingCertificate(ssh, config.domain);

    console.log(chalk.bold('Application:'));
    logger.table([
      ['Name', config.app],
      ['Domain', `${hasCert ? 'https' : 'http'}://${config.domain}`],
      ['Active Slot', activeSlot.toUpperCase()],
      ['Standby Slot', previousSlot.toUpperCase()],
      ['Last Updated', state?.updatedAt ? new Date(state.updatedAt).toLocaleString() : 'N/A']
    ]);

    console.log('\n' + chalk.bold('Container Slots:'));
    logger.table([
      [`Slot [BLUE] (${config.app}_blue)`, formatStatus(blueStatus, activeSlot === 'blue')],
      [`Slot [GREEN] (${config.app}_green)`, formatStatus(greenStatus, activeSlot === 'green')]
    ]);

    console.log('\n' + chalk.bold('Infrastructure:'));
    logger.table([
      ['Edge Proxy (myploy-nginx)', formatStatus(nginxStatus, nginxStatus === 'running')],
      ['SSL Certificate', hasCert ? chalk.green('Active (Let\'s Encrypt)') : chalk.yellow('None (HTTP only)')]
    ]);
    console.log();
  } finally {
    ssh.disconnect();
  }
}

function formatStatus(status: string, isActive: boolean): string {
  if (status === 'running') {
    return isActive ? chalk.green.bold('RUNNING (ACTIVE)') : chalk.blue('RUNNING (STANDBY)');
  }
  return chalk.dim(status);
}
