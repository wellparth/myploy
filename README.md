# MyPloy 🚀

> **Dokploy-grade, lightweight zero-downtime deploy tool for Docker Compose apps & databases on small VPS instances.**  
> One command to turn a fresh Ubuntu/Debian server into a production-ready, SSL-secured, blue/green deployment target with 1-click databases and web control plane.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-v2-blue.svg)](https://docs.docker.com/compose/)

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

## 🖥️ Web Dashboard & Control Plane

Launch the embedded dashboard to view apps, databases, container telemetry, and trigger deploys:

```bash
myploy ui --port 4000
```
Open [http://localhost:4000](http://localhost:4000) to inspect real-time CPU/RAM stats, active deployment slots, and 1-click database backups.

---

## 🛠 Command Reference

| Command | Description |
| :--- | :--- |
| `myploy init` | Interactive wizard to generate `myploy.json` |
| `myploy setup [--host <ip>]` | Bootstrap Docker, Compose, UFW, Nginx & Certbot on fresh VPS |
| `myploy deploy` | Upload code, start candidate slot, verify health, and switch traffic |
| `myploy rollback` | Instantly switch traffic back to the previous active slot |
| `myploy git <repoUrl>` | Deploy directly from remote Git repository with branch selection |
| `myploy db create <type> <name>` | Provision 1-click database (`postgres`, `mysql`, `redis`, `mongo`) |
| `myploy db list` | List active databases, internal hostnames, and connection strings |
| `myploy db backup <name>` | Create automated compressed snapshot backup |
| `myploy ui [--port <port>]` | Launch web dashboard and visual VPS control plane |
| `myploy status` | View active slot, container health, and proxy routing status |
| `myploy logs [--follow]` | Stream logs from the active production container over SSH |
| `myploy doctor` | Test SSH credentials and remote server readiness |

---

## 📄 License
MIT © Parth Gorde
