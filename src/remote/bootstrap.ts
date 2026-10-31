import { SSHClient } from './ssh.js';
import { logger } from '../utils/logger.js';
import { renderProxyCompose } from '../templates/nginx.js';

export async function checkServerPrerequisites(ssh: SSHClient): Promise<{
  osName: string;
  hasDocker: boolean;
  dockerVersion?: string;
  hasCompose: boolean;
  composeVersion?: string;
  isUfwActive: boolean;
}> {
  // OS check
  const osRelease = await ssh.exec('cat /etc/os-release');
  const match = osRelease.stdout.match(/PRETTY_NAME="([^"]+)"/);
  const osName = match ? match[1] : 'Linux Server';

  // Docker check
  const dockerCheck = await ssh.exec('docker --version');
  const hasDocker = dockerCheck.code === 0;
  const dockerVersion = hasDocker ? dockerCheck.stdout.trim() : undefined;

  // Docker compose v2 check
  const composeCheck = await ssh.exec('docker compose version');
  const hasCompose = composeCheck.code === 0;
  const composeVersion = hasCompose ? composeCheck.stdout.trim() : undefined;

  // UFW check
  const ufwCheck = await ssh.exec('which ufw && ufw status | grep -q "Status: active" && echo "active" || echo "inactive"');
  const isUfwActive = ufwCheck.stdout.includes('active');

  return {
    osName,
    hasDocker,
    dockerVersion,
    hasCompose,
    composeVersion,
    isUfwActive
  };
}

export async function bootstrapServer(ssh: SSHClient): Promise<void> {
  const spinner = logger.step('Inspecting server environment...');
  const prereqs = await checkServerPrerequisites(ssh);
  spinner.text = `Found target host: ${prereqs.osName}`;

  // 1. Install Docker Engine if missing
  if (!prereqs.hasDocker) {
    spinner.text = 'Docker not found. Installing Docker Engine via get.docker.com...';
    await ssh.execOrThrow('curl -fsSL https://get.docker.com | sh');
    await ssh.execOrThrow('systemctl enable --now docker');
    logger.success('Docker Engine successfully installed');
  } else {
    logger.info(`Docker already installed: ${prereqs.dockerVersion}`);
  }

  // 2. Install Docker Compose plugin if missing
  if (!prereqs.hasCompose) {
    spinner.text = 'Installing Docker Compose v2 plugin...';
    await ssh.execOrThrow('apt-get update && apt-get install -y docker-compose-plugin || yum install -y docker-compose-plugin');
    logger.success('Docker Compose v2 plugin installed');
  } else {
    logger.info(`Docker Compose ready: ${prereqs.composeVersion}`);
  }

  // 3. Configure firewall (UFW)
  spinner.text = 'Checking firewall rules (allowing ports 22, 80, 443)...';
  const hasUfw = (await ssh.exec('which ufw')).code === 0;
  if (hasUfw) {
    await ssh.exec('ufw allow 22/tcp');
    await ssh.exec('ufw allow 80/tcp');
    await ssh.exec('ufw allow 443/tcp');
    await ssh.exec('ufw --force enable');
    logger.info('UFW firewall configured (ports 22, 80, 443 allowed)');
  }

  // 4. Create base directories
  spinner.text = 'Setting up MyPloy runtime directories...';
  await ssh.execOrThrow(`
    mkdir -p /var/lib/myploy/nginx/conf.d
    mkdir -p /var/lib/myploy/certbot/www
    mkdir -p /var/lib/myploy/certbot/conf
    mkdir -p /var/lib/myploy/apps
  `);

  // 5. Create Docker network if not exists
  spinner.text = 'Configuring Docker isolated network (myploy-net)...';
  await ssh.execOrThrow(`
    docker network inspect myploy-net >/dev/null 2>&1 || docker network create myploy-net
  `);

  // 6. Write and start Nginx & Certbot proxy containers
  spinner.text = 'Deploying MyPloy reverse proxy (Nginx & Certbot)...';
  const proxyCompose = renderProxyCompose();
  await ssh.writeFile('/var/lib/myploy/docker-compose.proxy.yml', proxyCompose);

  // Start proxy containers
  await ssh.execOrThrow('docker compose -f /var/lib/myploy/docker-compose.proxy.yml up -d');

  spinner.succeed('VPS bootstrapped successfully! Edge proxy & Docker ready for deployments.');
}
