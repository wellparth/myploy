import { SSHClient } from '../remote/ssh.js';
import { renderHttpAppConfig, renderHttpsAppConfig } from '../templates/nginx.js';
import { Slot, SSLConfig } from '../types/config.js';
import { logger } from '../utils/logger.js';
import { escapeShellArg, sanitizeDomain, sanitizeAppName } from '../utils/security.js';

export async function hasExistingCertificate(ssh: SSHClient, domain: string): Promise<boolean> {
  const safeDomain = sanitizeDomain(domain);
  const certPath = `/var/lib/myploy/certbot/conf/live/${safeDomain}/fullchain.pem`;
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
  const safeApp = sanitizeAppName(appName);
  const safeDomain = sanitizeDomain(domain);
  const confPath = `/var/lib/myploy/nginx/conf.d/${safeApp}.conf`;

  const confContent = useHttps
    ? renderHttpsAppConfig({ appName: safeApp, domain: safeDomain, slot, appPort })
    : renderHttpAppConfig({ appName: safeApp, domain: safeDomain, slot, appPort });

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
  const safeApp = sanitizeAppName(appName);
  const safeDomain = sanitizeDomain(domain);
  const spinner = logger.step(`Checking SSL certificate for ${safeDomain}...`);

  const exists = await hasExistingCertificate(ssh, safeDomain);
  if (exists) {
    spinner.succeed(`Valid SSL certificate found for ${safeDomain}`);
    await applyNginxRouting(ssh, safeApp, safeDomain, slot, appPort, true);
    return true;
  }

  // 1. Apply HTTP-only config first so Let's Encrypt can reach /.well-known/acme-challenge/
  spinner.text = 'Applying HTTP challenge proxy configuration...';
  await applyNginxRouting(ssh, safeApp, safeDomain, slot, appPort, false);

  // 2. Execute Certbot ACME webroot challenge
  spinner.text = `Requesting Let's Encrypt SSL certificate for ${safeDomain}...`;
  const emailFlag = sslConfig.email
    ? `-m ${escapeShellArg(sslConfig.email)} --no-eff-email`
    : '--register-unsafely-without-email';
  const stagingFlag = sslConfig.staging ? '--staging' : '';

  const certbotCmd = `docker exec myploy-certbot certbot certonly --webroot -w /var/www/certbot -d ${escapeShellArg(safeDomain)} --non-interactive --agree-tos ${emailFlag} ${stagingFlag}`;

  const res = await ssh.exec(certbotCmd);

  if (res.code !== 0) {
    spinner.warn(`SSL provisioning was skipped or failed. Serving over HTTP.\nDetails: ${res.stderr || res.stdout}`);
    return false;
  }

  // 3. Switch to HTTPS configuration and reload
  spinner.text = 'Activating HTTPS & auto-redirects...';
  await applyNginxRouting(ssh, safeApp, safeDomain, slot, appPort, true);

  spinner.succeed(`SSL certificate activated for https://${safeDomain}!`);
  return true;
}
