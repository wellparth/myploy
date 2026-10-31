import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../core/config.js';
import { SSHClient } from '../../remote/ssh.js';
import { uploadDirectoryAsTar } from '../../remote/sftp.js';
import {
  getDeploymentState,
  saveDeploymentState,
  determineNextSlot,
  generateComposeOverride
} from '../../core/bluegreen.js';
import { waitForHealthy } from '../../core/healthcheck.js';
import { provisionSslCertificate, applyNginxRouting } from '../../core/ssl.js';
import { logger } from '../../utils/logger.js';
import { Slot, DeploymentState } from '../../types/config.js';

export async function deployCommand(): Promise<void> {
  logger.header('MyPloy Zero-Downtime Deploy');

  const config = loadConfig();
  const composePath = path.resolve(process.cwd(), config.composeFile || 'docker-compose.yml');

  if (!fs.existsSync(composePath)) {
    throw new Error(`Cannot find compose file at: ${composePath}`);
  }

  const baseComposeContent = fs.readFileSync(composePath, 'utf-8');

  logger.table([
    ['Application', config.app],
    ['Target Domain', config.domain],
    ['VPS Host', `${config.user}@${config.host}`],
    ['Container Port', String(config.appPort)],
    ['Health Endpoint', config.healthcheck?.path || '/']
  ]);
  console.log();

  const ssh = new SSHClient(config);

  try {
    const connSpinner = logger.step(`Connecting to ${config.user}@${config.host}...`);
    await ssh.connect();
    connSpinner.succeed(`Connected to ${config.host}`);

    // 1. Determine active and candidate slots
    const state = await getDeploymentState(ssh, config.app);
    const activeSlot: Slot | undefined = state?.activeSlot;
    const candidateSlot: Slot = determineNextSlot(activeSlot);

    logger.info(
      activeSlot
        ? `Currently active slot: [${activeSlot.toUpperCase()}]. Deploying candidate slot: [${candidateSlot.toUpperCase()}]`
        : `Initial deployment. Setting up primary slot: [${candidateSlot.toUpperCase()}]`
    );

    const remoteSlotDir = `/var/lib/myploy/apps/${config.app}/slots/${candidateSlot}`;

    // 2. Stream project files to target slot
    const uploadSpinner = logger.step(`Uploading project archive to slot [${candidateSlot}]...`);
    await uploadDirectoryAsTar(ssh, process.cwd(), remoteSlotDir);
    uploadSpinner.succeed(`Uploaded project files to remote slot [${candidateSlot}]`);

    // 3. Write compose override to isolate container name and bind to myploy-net
    const overrideYaml = generateComposeOverride(baseComposeContent, config.app, candidateSlot);
    await ssh.writeFile(`${remoteSlotDir}/docker-compose.override.yml`, overrideYaml);

    // 4. Upload envFile if specified
    if (config.envFile) {
      const localEnvPath = path.resolve(process.cwd(), config.envFile);
      if (fs.existsSync(localEnvPath)) {
        await ssh.writeFile(`${remoteSlotDir}/.env`, fs.readFileSync(localEnvPath));
        logger.info(`Uploaded environment variables from ${config.envFile}`);
      }
    }

    // 5. Build and launch candidate slot
    const buildSpinner = logger.step(`Building & starting container in slot [${candidateSlot}]...`);
    const projectName = `${config.app}_${candidateSlot}`;
    await ssh.execOrThrow(
      `docker compose -p "${projectName}" -f docker-compose.yml -f docker-compose.override.yml up -d --build`,
      {
        // run in slot dir
      }
    );
    // Actually run with cwd in remoteSlotDir
    await ssh.execOrThrow(
      `cd "${remoteSlotDir}" && docker compose -p "${projectName}" up -d --build`
    );
    buildSpinner.succeed(`Candidate container [${projectName}] started.`);

    // 6. Perform health check verification
    const healthConfig = {
      path: config.healthcheck?.path || '/',
      port: config.appPort,
      timeoutSeconds: config.healthcheck?.timeoutSeconds ?? 30,
      intervalSeconds: config.healthcheck?.intervalSeconds ?? 2
    };

    const isHealthy = await waitForHealthy(
      ssh,
      config.app,
      candidateSlot,
      config.appPort,
      healthConfig
    );

    if (!isHealthy) {
      logger.error(`Deployment aborted: Candidate slot [${candidateSlot}] failed healthcheck.`);
      logger.step('Tearing down failed candidate container...');
      await ssh.exec(`cd "${remoteSlotDir}" && docker compose -p "${projectName}" down`);
      logger.warn(`Active traffic remains safely on slot [${activeSlot || 'none'}] with zero downtime.`);
      process.exit(1);
    }

    // 7. Atomic traffic switch & SSL provisioning
    const sslEnabled = typeof config.ssl === 'boolean' ? config.ssl : config.ssl?.enabled ?? true;
    const sslOpts = typeof config.ssl === 'object' ? config.ssl : {};

    if (sslEnabled) {
      await provisionSslCertificate(
        ssh,
        config.app,
        config.domain,
        candidateSlot,
        config.appPort,
        sslOpts
      );
    } else {
      const switchSpinner = logger.step(`Switching Nginx proxy traffic to [${candidateSlot}]...`);
      await applyNginxRouting(ssh, config.app, config.domain, candidateSlot, config.appPort, false);
      switchSpinner.succeed(`Traffic routed to [${candidateSlot}]`);
    }

    // 8. Update deployment state
    const newState: DeploymentState = {
      app: config.app,
      activeSlot: candidateSlot,
      previousSlot: activeSlot,
      domain: config.domain,
      updatedAt: new Date().toISOString()
    };
    await saveDeploymentState(ssh, newState);

    // 9. Standby retention handling
    if (!config.keepPreviousRunning && activeSlot) {
      logger.info(`Shutting down previous slot [${activeSlot}]...`);
      const oldSlotDir = `/var/lib/myploy/apps/${config.app}/slots/${activeSlot}`;
      await ssh.exec(`cd "${oldSlotDir}" && docker compose -p "${config.app}_${activeSlot}" down`);
    } else if (activeSlot) {
      logger.info(`Previous slot [${activeSlot}] is kept running in standby for instant rollback.`);
    }

    console.log();
    logger.header('✨ Deployment Succeeded!');
    console.log(`  🌐 URL:          ${sslEnabled ? 'https' : 'http'}://${config.domain}`);
    console.log(`  🎯 Active Slot:  ${candidateSlot.toUpperCase()}`);
    console.log(`  🔄 Rollback:     run "myploy rollback" to revert in <1s\n`);
  } finally {
    ssh.disconnect();
  }
}
