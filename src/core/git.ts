import { SSHClient } from '../remote/ssh.js';
import { escapeShellArg, sanitizeAppName, sanitizeDomain, sanitizeGitRef } from '../utils/security.js';
import { logger } from '../utils/logger.js';
import { determineNextSlot, sanitizeComposeForSlot, getDeploymentState, saveDeploymentState } from './bluegreen.js';
import { waitForHealthy } from './healthcheck.js';
import { provisionSslCertificate, applyNginxRouting } from './ssl.js';
import { DeploymentState, Slot } from '../types/config.js';

export interface GitDeployOptions {
  repoUrl: string;
  branch?: string;
  app?: string;
  domain?: string;
  port?: number;
  healthPath?: string;
  ssl?: boolean;
}

export async function deployFromGit(ssh: SSHClient, options: GitDeployOptions): Promise<void> {
  const branch = sanitizeGitRef(options.branch || 'main');
  const inferredAppName = options.app || options.repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'app';
  const app = sanitizeAppName(inferredAppName);
  const domain = sanitizeDomain(options.domain || `${app}.localhost`);
  const appPort = options.port || 3000;
  const healthPath = options.healthPath || '/';

  logger.header(`Git Deployment: ${app} (${branch})`);
  logger.info(`Source Repository: ${options.repoUrl}`);

  // 1. Determine blue/green slots
  const state = await getDeploymentState(ssh, app);
  const activeSlot: Slot | undefined = state?.activeSlot;
  const candidateSlot: Slot = determineNextSlot(activeSlot);

  const repoDir = `/var/lib/myploy/git-repos/${app}`;
  const slotDir = `/var/lib/myploy/apps/${app}/slots/${candidateSlot}`;

  await ssh.execOrThrow(`mkdir -p ${escapeShellArg(repoDir)} ${escapeShellArg(slotDir)}`);

  // 2. Clone or pull repo on remote VPS
  const gitSpinner = logger.step(`Syncing git repository on remote VPS...`);
  const isGitRepo = (await ssh.exec(`test -d ${escapeShellArg(repoDir + '/.git')} && echo 1 || echo 0`)).stdout.trim() === '1';

  if (!isGitRepo) {
    await ssh.execOrThrow(`git clone --depth 1 -b ${escapeShellArg(branch)} ${escapeShellArg(options.repoUrl)} ${escapeShellArg(repoDir)}`);
  } else {
    await ssh.execOrThrow(`cd ${escapeShellArg(repoDir)} && git fetch origin ${escapeShellArg(branch)} && git checkout ${escapeShellArg(branch)} && git pull origin ${escapeShellArg(branch)}`);
  }
  gitSpinner.succeed(`Git source ready at branch [${branch}]`);

  // 3. Copy repo files into candidate slot directory
  await ssh.execOrThrow(`rsync -a --delete --exclude '.git' ${escapeShellArg(repoDir + '/')} ${escapeShellArg(slotDir + '/')}`);

  // 4. Handle docker-compose.yml or Dockerfile
  const hasCompose = (await ssh.exec(`test -f ${escapeShellArg(slotDir + '/docker-compose.yml')} && echo 1 || echo 0`)).stdout.trim() === '1';
  let composeContent = '';

  if (hasCompose) {
    composeContent = await ssh.readFile(`${slotDir}/docker-compose.yml`);
  } else {
    // Generate minimal compose for Dockerfile
    composeContent = `version: '3.8'
services:
  web:
    build: .
    restart: always
    environment:
      - PORT=${appPort}
`;
  }

  const { sanitizedCompose, overrideCompose } = sanitizeComposeForSlot(composeContent, app, candidateSlot);
  await ssh.writeFile(`${slotDir}/docker-compose.yml`, sanitizedCompose);
  await ssh.writeFile(`${slotDir}/docker-compose.override.yml`, overrideCompose);

  // 5. Build and launch candidate slot
  const buildSpinner = logger.step(`Building & starting container slot [${candidateSlot}]...`);
  const projectName = `${app}_${candidateSlot}`;
  await ssh.execOrThrow(
    `cd ${escapeShellArg(slotDir)} && docker compose -p ${escapeShellArg(projectName)} up -d --build`
  );
  buildSpinner.succeed(`Candidate container [${projectName}] started`);

  // 6. Health check
  const isHealthy = await waitForHealthy(ssh, app, candidateSlot, appPort, {
    path: healthPath,
    timeoutSeconds: 30,
    intervalSeconds: 2
  });

  if (!isHealthy) {
    logger.error(`Git deployment failed health check. Reverting candidate container.`);
    await ssh.exec(`cd ${escapeShellArg(slotDir)} && docker compose -p ${escapeShellArg(projectName)} down`);
    throw new Error(`Deployment health check failed for ${app}_${candidateSlot}`);
  }

  // 7. Atomic proxy routing & SSL
  const sslEnabled = options.ssl !== false;
  if (sslEnabled && domain !== 'localhost' && !domain.endsWith('.localhost')) {
    await provisionSslCertificate(ssh, app, domain, candidateSlot, appPort);
  } else {
    await applyNginxRouting(ssh, app, domain, candidateSlot, appPort, false);
  }

  // 8. Update deployment state
  const newState: DeploymentState = {
    app,
    activeSlot: candidateSlot,
    previousSlot: activeSlot,
    domain,
    updatedAt: new Date().toISOString()
  };
  await saveDeploymentState(ssh, newState);

  logger.success(`Successfully deployed ${app} from Git to https://${domain}!`);
}
