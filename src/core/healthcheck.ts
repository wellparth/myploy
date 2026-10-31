import { SSHClient } from '../remote/ssh.js';
import { Slot, HealthcheckConfig } from '../types/config.js';
import { logger } from '../utils/logger.js';
import { escapeShellArg, sanitizePath } from '../utils/security.js';

export async function waitForHealthy(
  ssh: SSHClient,
  appName: string,
  slot: Slot,
  port: number,
  healthcheck: HealthcheckConfig
): Promise<boolean> {
  const containerName = `${appName}_${slot}`;
  const safePath = sanitizePath(healthcheck.path);
  const url = `http://${containerName}:${port}${safePath}`;

  const startTime = Date.now();
  const timeoutMs = healthcheck.timeoutSeconds * 1000;
  const intervalMs = healthcheck.intervalSeconds * 1000;

  const spinner = logger.step(`Probing health check at ${url}...`);

  while (Date.now() - startTime < timeoutMs) {
    // 1. Verify container is still running (not crashed)
    const statusRes = await ssh.exec(`docker inspect -f '{{.State.Status}}' ${escapeShellArg(containerName)} 2>/dev/null`);
    const containerStatus = statusRes.stdout.trim();

    if (containerStatus === 'exited' || containerStatus === 'dead') {
      spinner.fail(`Candidate container ${containerName} crashed or exited.`);
      const logs = await ssh.exec(`docker logs --tail 50 ${escapeShellArg(containerName)}`);
      logger.error('Container crash logs:\n' + (logs.stderr || logs.stdout));
      return false;
    }

    // 2. Perform HTTP probe via wget inside myploy-nginx container
    const probeCmd = `docker exec myploy-nginx wget -q -O /dev/null -T 4 ${escapeShellArg(url)}`;
    const res = await ssh.exec(probeCmd);

    if (res.code === 0) {
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      spinner.succeed(`Health check passed in ${elapsedSec}s! (HTTP 200 OK)`);
      return true;
    }

    // Sleep before next probe
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  spinner.fail(`Health check timed out after ${healthcheck.timeoutSeconds}s.`);
  const logs = await ssh.exec(`docker logs --tail 50 ${escapeShellArg(containerName)}`);
  logger.error('Container logs during failed healthcheck:\n' + (logs.stderr || logs.stdout));
  return false;
}
