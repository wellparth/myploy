import { Slot } from '../types/config.js';

export function renderHttpAppConfig(params: {
  appName: string;
  domain: string;
  slot: Slot;
  appPort: number;
}): string {
  const upstreamName = `${params.appName}_upstream`;
  const targetHost = `${params.appName}_${params.slot}`;

  return `# MyPloy HTTP Configuration for ${params.appName} [Slot: ${params.slot}]
upstream ${upstreamName} {
    server ${targetHost}:${params.appPort};
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${params.domain};

    # Let's Encrypt ACME challenge webroot
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        try_files $uri =404;
    }

    location / {
        proxy_pass http://${upstreamName};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
        proxy_connect_timeout 10s;
    }
}
`;
}

export function renderHttpsAppConfig(params: {
  appName: string;
  domain: string;
  slot: Slot;
  appPort: number;
}): string {
  const upstreamName = `${params.appName}_upstream`;
  const targetHost = `${params.appName}_${params.slot}`;

  return `# MyPloy HTTPS Configuration for ${params.appName} [Slot: ${params.slot}]
upstream ${upstreamName} {
    server ${targetHost}:${params.appPort};
    keepalive 32;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name ${params.domain};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        try_files $uri =404;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# SSL Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${params.domain};

    ssl_certificate /etc/letsencrypt/live/${params.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${params.domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    location / {
        proxy_pass http://${upstreamName};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
        proxy_connect_timeout 10s;
    }
}
`;
}

export function renderProxyCompose(): string {
  return `version: '3.8'

services:
  nginx:
    image: nginx:1.27-alpine
    container_name: myploy-nginx
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/lib/myploy/nginx/conf.d:/etc/nginx/conf.d:ro
      - /var/lib/myploy/certbot/www:/var/www/certbot:ro
      - /var/lib/myploy/certbot/conf:/etc/letsencrypt:ro
    networks:
      - myploy-net

  certbot:
    image: certbot/certbot:latest
    container_name: myploy-certbot
    restart: unless-stopped
    volumes:
      - /var/lib/myploy/certbot/www:/var/www/certbot:rw
      - /var/lib/myploy/certbot/conf:/etc/letsencrypt:rw
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew --webroot -w /var/www/certbot --quiet && docker exec myploy-nginx nginx -s reload || true; sleep 12h & wait; done;'"
    networks:
      - myploy-net

networks:
  myploy-net:
    external: true
`;
}
