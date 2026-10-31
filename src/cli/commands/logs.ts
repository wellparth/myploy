import { loadConfig } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { getDeploymentState } from '../../core/bluegreen.js';
import { logger } from '../../utils/logger.js';
import { Slot } from '../../types/config.js';

export interface LogsOptions {
  slot?: string;
  tail?: string;
  follow?: boolean;
}

export async function logsCommand(options: LogsOptions): Promise<void> {
  const config = loadConfig();
  const ssh = new SSHClient(config);

  try {
    await ssh.connect();

    let targetSlot = options.slot as Slot;
    if (!targetSlot) {
      const state = await getDeploymentState(ssh, config.app);
      if (!state || !state.activeSlot) {
        throw new Error('No active deployment slot found. Specify --slot <blue|green>');
      }
      targetSlot = state.activeSlot;
    }

    const containerName = `${config.app}_${targetSlot}`;
    const tailCount = options.tail || '100';
    const followFlag = options.follow ? '-f' : '';

    logger.info(`Streaming logs for container [${containerName}]...`);

    await ssh.exec(`docker logs ${followFlag} --tail ${tailCount} ${containerName}`, {
      streamOutput: true
    });
  } finally {
    ssh.disconnect();
  }
}
