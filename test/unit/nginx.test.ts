import { describe, it, expect } from 'vitest';
import {
  renderHttpAppConfig,
  renderHttpsAppConfig,
  renderCloudflareRealIpConfig,
  renderOriginCloakingConfig
} from '../../src/templates/nginx.js';

describe('Nginx Template Renderer', () => {
  it('renders HTTP proxy configuration with upstream and certbot challenge path', () => {
    const config = renderHttpAppConfig({
      appName: 'myapp',
      domain: 'myapp.com',
      slot: 'blue',
      appPort: 3000
    });

    expect(config).toContain('upstream myapp_upstream');
    expect(config).toContain('server myapp_blue:3000');
    expect(config).toContain('server_name myapp.com');
    expect(config).toContain('location /.well-known/acme-challenge/');
    expect(config).toContain('proxy_pass http://myapp_upstream');
    expect(config).toContain('server_tokens off;');
    expect(config).toContain('add_header X-Frame-Options "SAMEORIGIN" always;');
    expect(config).toContain('add_header X-Content-Type-Options "nosniff" always;');
  });

  it('renders HTTPS proxy configuration with SSL certs and 301 redirect', () => {
    const config = renderHttpsAppConfig({
      appName: 'myapp',
      domain: 'secure.myapp.com',
      slot: 'green',
      appPort: 8080
    });

    expect(config).toContain('server myapp_green:8080');
    expect(config).toContain('return 301 https://$host$request_uri');
    expect(config).toContain('listen 443 ssl http2');
    expect(config).toContain('ssl_certificate /etc/letsencrypt/live/secure.myapp.com/fullchain.pem');
    expect(config).toContain('ssl_certificate_key /etc/letsencrypt/live/secure.myapp.com/privkey.pem');
    expect(config).toContain('proxy_pass http://myapp_upstream');
    expect(config).toContain('Strict-Transport-Security');
    expect(config).toContain('Referrer-Policy "strict-origin-when-cross-origin"');
  });

  it('renders Cloudflare Real-IP restoration configuration', () => {
    const cf = renderCloudflareRealIpConfig();
    expect(cf).toContain('real_ip_header CF-Connecting-IP;');
    expect(cf).toContain('set_real_ip_from 173.245.48.0/20;');
  });

  it('renders Origin Cloaking default server to drop raw IP scans', () => {
    const cloaking = renderOriginCloakingConfig();
    expect(cloaking).toContain('listen 80 default_server;');
    expect(cloaking).toContain('return 444;');
  });
});
