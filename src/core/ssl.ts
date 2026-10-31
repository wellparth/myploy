import { SSHClient } from '../remote/ssh.js';
import { renderHttpAppConfig, renderHttpsAppConfig } from '../templates/nginx.js';
import { Slot, SSLConfig } from '../types/config.js';
import { logger } from '../utils/logger.js';

export async function hasExistingCertificate(ssh: SSHClient, domain: string): Promise<boolean> {
  const certPath = `/var/lib/myploy/certbot/conf/live/${domain}/fullchain.pem`;
  return await ssh.fileExists(certPath);
}

export async function applyNginxRouting(
  ssh: SSHClient,
  appName: string,
  domain: string,
  slot: Slot,
  appPort: number,
  useHttps: boolean
): Promise<void> {
  const confPath = `/var/lib/myploy/nginx/conf.d/${appName}.conf`;

  const confContent = useHttps
    ? renderHttpsAppConfig({ appName, domain, slot, appPort })
    : renderHttpAppConfig({ appName, domain, slot, appPort });

  await ssh.writeFile(confPath, confContent);

  // Validate Nginx config and reload
  const testRes = await ssh.exec('docker exec myploy-nginx nginx -t');
  if (testRes.code !== 0) {
    throw new Error(`Nginx configuration error:\n${testRes.stderr || testRes.stdout}`);
  }

  await ssh.execOrThrow('docker exec myploy-nginx nginx -s reload');
}

export async function provisionSslCertificate(
  ssh: SSHClient,
  appName: string,
  domain: string,
  slot: Slot,
  appPort: number,
  sslConfig: Partial<SSLConfig> = {}
): Promise<boolean> {
  const spinner = logger.step(`Checking SSL certificate for ${domain}...`);

  const exists = await hasExistingCertificate(ssh, domain);
  if (exists) {
    spinner.succeed(`Valid SSL certificate found for ${domain}`);
    await applyNginxRouting(ssh, appName, domain, slot, appPort, true);
    return true;
  }

  // 1. Apply HTTP-only config first so Let's Encrypt can reach /.well-known/acme-challenge/
  spinner.text = 'Applying HTTP challenge proxy configuration...';
  await applyNginxRouting(ssh, appName, domain, slot, appPort, false);

  // 2. Execute Certbot ACME webroot challenge
  spinner.text = `Requesting Let's Encrypt SSL certificate for ${domain}...`;
  const emailFlag = sslConfig.email
    ? `-m ${sslConfig.email} --no-eff-email`
    : '--register-unsafely-without-email';
  const stagingFlag = sslConfig.staging ? '--staging' : '';

  const certbotCmd = `docker exec myploy-certbot certbot certonly --webroot -w /var/www/certbot -d ${domain} --non-interactive --agree-tos ${emailFlag} ${stagingFlag}`;

  const res = await ssh.exec(certbotCmd);

  if (res.code !== 0) {
    spinner.warn(`SSL provisioning was skipped or failed. Serving over HTTP.\nDetails: ${res.stderr || res.stdout}`);
    return false;
  }

  // 3. Switch to HTTPS configuration and reload
  spinner.text = 'Activating HTTPS & auto-redirects...';
  await applyNginxRouting(ssh, appName, domain, slot, appPort, true);

  spinner.succeed(`SSL certificate activated for https://${domain}!`);
  return true;
}
