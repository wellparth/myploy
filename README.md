# MyPloy 🚀

> 🧪 **STATUS: PUBLIC ALPHA (v0.2.0-alpha.1)**  
> MyPloy is actively in public alpha testing! We are inviting developers, sysadmins, and indie hackers to test MyPloy on development/staging VPS instances. Please report feedback or edge cases in [GitHub Issues](https://github.com/wellparth/myploy/issues).

> **Dokploy-grade, lightweight zero-downtime deploy tool for Docker Compose apps & databases on small VPS instances.**  
> One command to turn a fresh Ubuntu/Debian server into a production-ready, SSL-secured, blue/green deployment target with 1-click databases and web control plane.

[![GitHub Release](https://img.shields.io/github/v/release/wellparth/myploy?include_prereleases&label=alpha%20release&color=orange)](https://github.com/wellparth/myploy/releases)
[![CI & Tests](https://github.com/wellparth/myploy/actions/workflows/ci.yml/badge.svg)](https://github.com/wellparth/myploy/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-v2-blue.svg)](https://docs.docker.com/compose/)
[![Security Audit](https://img.shields.io/badge/Security%20Audit-Passing%20(0%20vulns)-brightgreen.svg)](#-security-hardening--edge-defense)

---

## 💡 Why MyPloy? (The Dokploy / Coolify / Kamal Comparison)

If you have a Docker Compose app and a $5 VPS (Hetzner, DigitalOcean, Linode, Lightsail), you're currently forced to choose between two extremes:

1. **Manual SSH & Bash gymnastics**: SSH in, install Docker, write Nginx reverse proxy configs, set up Certbot with cron jobs, pray that `docker compose up -d` doesn't drop active HTTP connections, and scramble when a bad deploy breaks production.
2. **Heavy platforms**:
   - **Coolify / Dokploy (Self-Hosted mode)**: Excellent tools, but their self-hosted agent and database orchestrators consume **1–2 GB of RAM** before your application even runs.
   - **Kamal**: Requires a custom `deploy.yml` DSL, external container registries (Docker Hub/GHCR), and lacks 1-click database management.

### The MyPloy Advantage:

| Feature | Manual VPS | Coolify / Dokploy (Host) | Kamal | **MyPloy** |
| :--- | :--- | :--- | :--- | :--- |
| **Server Footprint** | None | ⚠️ High (1–2 GB RAM agent & DB) | None | **✅ Zero Agent / Zero Daemon (<35MB Nginx)** |
| **Configuration Format** | Custom Nginx/scripts | Web UI / Custom YAML | Custom `deploy.yml` | **✅ Standard `docker-compose.yml`** |
| **External Registry** | Optional | Optional | ⚠️ Required (Docker Hub/GHCR) | **✅ None required (direct SSH stream or Git)** |
| **Traffic Cutover** | Downtime | Zero-downtime | Zero-downtime | **✅ Zero-downtime Blue/Green with Healthcheck** |
| **1-Click Databases** | Manual config | Yes | No | **✅ 1-Click Postgres, MySQL, Redis, Mongo** |
| **Instant Rollback** | Painful manual restart | Web UI | `kamal rollback` | **✅ Instant 1-second `myploy rollback`** |
| **Git Deployment** | Git pull + rebuild | Yes | No | **✅ Direct Git URL deploy (`myploy git`)** |
| **Web Dashboard** | None | Yes | No | **✅ Embedded Web UI (`myploy ui`)** |

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
  "appPort": 3000,
  "healthcheck": {
    "path": "/health",
    "timeoutSeconds": 30
  }
}
```

### 3. Bootstrap your VPS (One-Time)
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
1. **Candidate Slot Spin-up**: If `blue` is live, it builds and spins up `green` alongside it without host port collisions.
2. **Health Verification**: Polls `http://localhost:<port>/health` inside the candidate container. If it fails, the candidate is discarded, error logs are streamed to your console, and **active traffic is untouched**.
3. **Atomic Nginx Switch**: If healthy, Nginx upstream configuration is updated and reloaded atomically with zero dropped packets.
4. **SSL Provisioning**: Automatically acquires or refreshes Let's Encrypt certificates.
5. **Standby Retention**: The previous slot remains running in standby for instant recovery.

### 5. Instant Rollback
```bash
myploy rollback
```
Traffic switches right back to the previous stable slot immediately in <1s.

---

## 🗄️ 1-Click Managed Databases & Backups (Dokploy-Grade)

Provision production databases on an internal, isolated network without exposing database ports to the public internet:

```bash
# Provision PostgreSQL 16
myploy db create postgres mydb

# Provision Redis 7, MySQL 8, or MongoDB 7
myploy db create redis mycache
myploy db create mysql mystore
myploy db create mongo mydocs

# List all active databases & connection strings
myploy db list

# Instant snapshot backup (pg_dump / mysqldump / mongodump / redis save)
myploy db backup mydb
```

---

## 🐙 Remote Git Deployments

Deploy directly from a GitHub or GitLab repository without needing local files on your machine:

```bash
myploy git https://github.com/org/repo.git --branch main --domain api.example.com
```

---

## 🔑 Automated SSH Key Management

Never worry about SSH key generation errors or permissions:

```bash
# Auto-generate a high-security Ed25519 key and optionally install it on your VPS
myploy ssh init --host 198.51.100.25

# Print your public key to easily paste into DigitalOcean, Hetzner, or AWS consoles
myploy ssh public-key
```

If your SSH key is not yet authorized when you run `myploy setup`, MyPloy automatically offers to install it for you using password authentication once, so all future commands are 100% passwordless and error-free!

---

## 🖥️ Web Dashboard & Control Plane (Dokploy-Style)

Launch the embedded dashboard to view apps, databases, container telemetry, and trigger deploys:

```bash
myploy ui --port 4000
```
Open [http://127.0.0.1:4000](http://127.0.0.1:4000) to access the **Dokploy-style control plane**:
- 🚀 **Applications**: Visual cards showing active/standby Blue-Green slots, domains, and 1-click rollback.
- 🗄️ **Databases**: 1-Click creation modal for PostgreSQL, MySQL, Redis, MongoDB, and snapshot backups.
- 📊 **Monitoring**: Live VPS memory gauges and real-time Docker container telemetry (CPU%, Memory, PIDs).
- 📜 **Terminal Logs**: Live container log viewer.
- 🛡️ **Security**: Origin Cloaking, Cloudflare Real-IP translation, and UFW firewall status.

---

## 🛠 Command Reference

| Command | Description |
| :--- | :--- |
| `myploy init` | Interactive wizard to generate `myploy.json` |
| `myploy setup [--host <ip>]` | Bootstrap Docker, Compose, UFW, Nginx & Certbot on fresh VPS (with self-healing SSH setup) |
| `myploy ssh init [--host <ip>]` | Auto-generate Ed25519 key and authorize it on your VPS |
| `myploy ssh public-key` | Print public SSH key to clipboard / cloud console |
| `myploy deploy` | Upload code, start candidate slot, verify health, and switch traffic |
| `myploy rollback` | Instantly switch traffic back to the previous active slot |
| `myploy git <repoUrl>` | Deploy directly from remote Git repository with branch selection |
| `myploy db create <type> <name>` | Provision 1-click database (`postgres`, `mysql`, `redis`, `mongo`) |
| `myploy db list` | List active databases, internal hostnames, and connection strings |
| `myploy db backup <name>` | Create automated compressed snapshot backup |
| `myploy ui [--port <port>]` | Launch Dokploy-style web dashboard and visual VPS control plane |
| `myploy status` | View active slot, container health, and proxy routing status |
| `myploy logs [--follow]` | Stream logs from the active production container over SSH |
| `myploy doctor` | Test SSH credentials and remote server readiness |

---

## 🧪 Alpha Testing Guidelines

MyPloy is currently in **Public Alpha (`v0.2.0-alpha.1`)**. We welcome developers, DevOps engineers, and self-hosters to test MyPloy on development or staging VPS servers.

### Recommended Test Scenarios:
1. **Fresh VPS Setup**: Run `myploy setup` on a fresh Ubuntu 22.04/24.04 or Debian 12 VPS.
2. **Automated SSH Keys**: Test `myploy ssh init --host <ip>` to verify automated Ed25519 key generation and zero-error VPS authorization.
3. **Docker Discovery**: Launch the Web Control Plane with `myploy ui --port 4000` to inspect existing standalone containers and MyPloy apps.
4. **Zero-Downtime Blue/Green**: Deploy a sample web app, edit code, and redeploy while confirming continuous zero-dropped packets.
5. **Instant Rollback**: Trigger `myploy rollback` (CLI or UI) to confirm 1-second instantaneous cutover to previous slot.
6. **1-Click Databases**: Run `myploy db create postgres testdb` and take a compressed snapshot with `myploy db backup testdb`.

### Reporting Issues & Feedback:
- 🐛 **Bug Reports**: Open an issue using the [Alpha Bug Report](https://github.com/wellparth/myploy/issues/new?template=alpha_bug_report.md).
- 💡 **Feature Requests**: Submit proposals using the [Feature Request Template](https://github.com/wellparth/myploy/issues/new?template=feature_request.md).

---

## 📄 License
MIT © Parth Gorde
