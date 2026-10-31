import { loadConfig } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { getDeploymentState, saveDeploymentState } from '../../core/bluegreen.js';
import { applyNginxRouting, hasExistingCertificate } from '../../core/ssl.js';
import { waitForHealthy } from '../../core/healthcheck.js';
import { logger } from '../../utils/logger.js';
import { DeploymentState } from '../../types/config.js';

export async function rollbackCommand(): Promise<void> {
  logger.header('MyPloy Instant Rollback');

  const config = loadConfig();
  const ssh = new SSHClient(config);

  try {
    const connSpinner = logger.step(`Connecting to ${config.user}@${config.host}...`);
    await ssh.connect();
    connSpinner.succeed(`Connected to ${config.host}`);

    const state = await getDeploymentState(ssh, config.app);

    if (!state || !state.previousSlot) {
      throw new Error(`Cannot rollback: No previous deployment slot found for app "${config.app}".`);
    }

    const currentSlot = state.activeSlot;
    const targetSlot = state.previousSlot;

    if (currentSlot === targetSlot) {
      throw new Error(`Cannot rollback: Previous slot is already active [${currentSlot}].`);
    }

    logger.info(`Rolling back from [${currentSlot.toUpperCase()}] -> [${targetSlot.toUpperCase()}]`);

    const containerName = `${config.app}_${targetSlot}`;
    const targetDir = `/var/lib/myploy/apps/${config.app}/slots/${targetSlot}`;

    // Verify container is running, or start it
    const statusRes = await ssh.exec(`docker inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null`);
    if (statusRes.stdout.trim() !== 'running') {
      const startSpinner = logger.step(`Starting standby container [${containerName}]...`);
      await ssh.execOrThrow(`cd "${targetDir}" && docker compose -p "${config.app}_${targetSlot}" up -d`);
      startSpinner.succeed(`Container [${containerName}] is running.`);
    }

    // Health probe
    const healthConfig = {
      path: config.healthcheck?.path || '/',
      port: config.appPort,
      timeoutSeconds: 15,
      intervalSeconds: 1
    };

    const healthy = await waitForHealthy(ssh, config.app, targetSlot, config.appPort, healthConfig);
    if (!healthy) {
      throw new Error(`Rollback aborted: Target slot [${targetSlot}] failed healthcheck.`);
    }

    // Atomic proxy switch
    const switchSpinner = logger.step(`Switching Nginx proxy to slot [${targetSlot}]...`);
    const hasCert = await hasExistingCertificate(ssh, config.domain);
    await applyNginxRouting(ssh, config.app, config.domain, targetSlot, config.appPort, hasCert);
    switchSpinner.succeed(`Traffic successfully routed back to [${targetSlot.toUpperCase()}]!`);

    // Update state
    const newState: DeploymentState = {
      app: config.app,
      activeSlot: targetSlot,
      previousSlot: currentSlot,
      domain: config.domain,
      updatedAt: new Date().toISOString()
    };
    await saveDeploymentState(ssh, newState);

    logger.success(`Rollback complete! Active slot is now [${targetSlot.toUpperCase()}].`);
  } finally {
    ssh.disconnect();
  }
}
