# MyPloy 🚀

> **Lightweight, zero-downtime deploy tool for Docker Compose apps on small VPS instances.**  
> One command to turn a fresh Ubuntu/Debian server into a production-ready, SSL-secured, blue/green deployment target.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-v2-blue.svg)](https://docs.docker.com/compose/)

---

## 💡 Why MyPloy? (The Difference)

If you have a Docker Compose app and a $5 VPS (Hetzner, DigitalOcean, Linode, Lightsail), you're currently forced to choose between two extremes:

1. **Manual SSH & Bash gymnastics**: SSH in, install Docker, write Nginx reverse proxy configs, set up Certbot with cron jobs, pray that `docker compose up -d` doesn't drop active HTTP connections, and scramble when a bad deploy breaks production.
2. **Heavy platforms**:
   - **Coolify** is great, but it runs a full web UI, PostgreSQL, and Redis orchestrator on your server—eating **1–2 GB of RAM** before your app even launches.
   - **Kamal** (by 37signals) requires learning a proprietary `deploy.yml` DSL, depends on external Docker registries (Docker Hub / GHCR), and targets larger multi-server architectures.

### The MyPloy Sweet Spot:

| Feature | Manual VPS | Coolify | Kamal | **MyPloy** |
| :--- | :--- | :--- | :--- | :--- |
| **Server Footprint** | None | ⚠️ High (1–2 GB RAM UI/DB) | None (stateless) | **✅ Zero Agent / Zero Daemon (<35MB Nginx)** |
| **Configuration Format** | Custom Nginx/scripts | Web UI / Custom YAML | Custom `deploy.yml` | **✅ Standard `docker-compose.yml`** |
| **External Registry Required** | Optional | Optional | ⚠️ Required (Docker Hub/GHCR) | **✅ None required (direct SSH stream or registry)** |
| **Traffic Cutover** | Downtime | Zero-downtime | Zero-downtime | **✅ Zero-downtime Blue/Green with Healthcheck** |
| **Instant Rollback** | Painful manual restart | Web UI | `kamal rollback` | **✅ Instant 1-second `myploy rollback`** |
| **SSL / HTTPS** | Manual Certbot + cron | Automated | Automated | **✅ Automated Certbot & Nginx management** |

---

## ⚡ Quickstart

### 1. Install MyPloy
```bash
npm install -g myploy
# or run via npx
npx myploy --help
```

### 2. Initialize in your project
Navigate to any project with a `docker-compose.yml` and run:
```bash
myploy init
```
This generates a minimal `myploy.json`:
```json
{
  "app": "myapp",
  "domain": "myapp.example.com",
  "host": "198.51.100.25",
  "user": "root",
  "sshKey": "~/.ssh/id_ed25519",
  "port": 3000,
  "healthcheck": {
    "path": "/health",
    "timeoutSeconds": 30
  }
}
```

### 3. Bootstrap your VPS (One-Time)
Have a brand new Ubuntu/Debian VPS? Run:
```bash
myploy setup
```
MyPloy will:
- Connect over SSH securely using your keys.
- Check and install Docker Engine & Docker Compose v2 if missing.
- Configure UFW firewall (allowing ports `22`, `80`, `443`).
- Start the lightweight shared `myploy-nginx` and `myploy-certbot` reverse proxy on an isolated Docker bridge network.

### 4. Deploy with Zero Downtime
```bash
myploy deploy
```
What happens under the hood:
1. **Candidate Slot Spin-up**: If `blue` is live, it builds and spins up `green` alongside it.
2. **Health Verification**: Polls `http://localhost:<port>/health` inside the candidate container. If it fails, the candidate is discarded, error logs are streamed to your console, and **active traffic is untouched**.
3. **Atomic Nginx Switch**: If healthy, Nginx upstream configuration is updated and reloaded atomically with zero dropped packets.
4. **SSL Provisioning**: Automatically acquires or refreshes Let's Encrypt certificates.
5. **Standby Retention**: The previous slot remains running in standby for instant recovery.

### 5. Rollback Instantly
Deployed a breaking change? Roll back in less than one second:
```bash
myploy rollback
```
Traffic switches right back to the previous stable slot immediately.

---

## 🛠 Commands

| Command | Description |
| :--- | :--- |
| `myploy init` | Interactive wizard to generate `myploy.json` |
| `myploy setup [--host <ip>]` | Bootstrap Docker, Compose, UFW, Nginx & Certbot on fresh VPS |
| `myploy deploy` | Upload code, start candidate slot, verify health, and switch traffic |
| `myploy rollback` | Instantly switch traffic back to the previous active slot |
| `myploy status` | View active slot, container health, and proxy routing status |
| `myploy logs [--follow]` | Stream logs from the active production container over SSH |
| `myploy doctor` | Test SSH credentials and remote server readiness |

---

## 🏗 Architecture

```
Developer Machine                    Target VPS
+------------------+                 +------------------------------------------------+
| myploy CLI       |                 |  myploy-net (Docker Bridge Network)            |
|                  |                 |                                                |
| 1. Stream code   | --- SSH / SFTP -|-> /var/lib/myploy/apps/myapp/                  |
| 2. Compose up    |                 |                                                |
| 3. Test /health  |                 |  +--------------------+  +------------------+  |
| 4. Reload proxy  |                 |  | myapp_blue (Active)|  | myapp_green      |  |
+------------------+                 |  | Port 3000          |  | Port 3000 (Idle) |  |
                                     |  +--------------------+  +------------------+  |
                                     |            ^                       ^           |
                                     |            | (traffic switched)    |           |
                                     |  +------------------------------------------+  |
                                     |  | myploy-nginx (Port 80/443 Reverse Proxy) |  |
                                     |  +------------------------------------------+  |
                                     |  | myploy-certbot (Auto-SSL Manager)        |  |
                                     |  +------------------------------------------+  |
                                     +------------------------------------------------+
```

---

## 📄 License
MIT © Parth Gorde
