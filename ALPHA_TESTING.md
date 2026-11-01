# MyPloy Alpha Testing Guide 🧪

Welcome to the **MyPloy Public Alpha (`v0.2.0-alpha.1`)** testing program!

MyPloy is built to provide a lightweight, zero-daemon, Dokploy-grade deployment and control plane for small VPS instances running Docker Compose.

---

## 🎯 Alpha Testing Objectives

During this alpha cycle, we want to validate:
1. **Zero-Error VPS Provisioning**: Bootstrapping Ubuntu 20.04/22.04/24.04 and Debian 11/12 VPS instances.
2. **Automated Ed25519 Key Management**: Eliminating SSH key permission and authorization headaches.
3. **Dokploy-Style Control Plane**: Live discovery of pre-existing containers, real-time telemetry, and container lifecycle actions without crashing or leaking memory.
4. **Zero-Downtime Blue/Green Deployments**: Atomic Nginx switching, health check timeouts, and automated Let's Encrypt SSL.
5. **Instant Rollback**: 1-second recovery from broken deploys.
6. **Managed Databases**: Seamless creation and snapshot backups for PostgreSQL, MySQL, Redis, and MongoDB.

---

## 🚀 How to Install for Alpha Testing

### Option 1: Install from GitHub with npm
```bash
npm install -g https://github.com/wellparth/myploy.git
```

### Option 2: Clone & Link Locally
```bash
git clone https://github.com/wellparth/myploy.git
cd myploy
npm install
npm run build
npm link
```

Verify your installation:
```bash
myploy --version
# Output: 0.2.0-alpha.1
```

---

## 🧪 Alpha Test Scenarios

### Scenario 1: Automated SSH Key Generation & VPS Authorization
```bash
# Generate high-security Ed25519 key and authorize it on your VPS
myploy ssh init --host <your-vps-ip> --user root

# Inspect your generated public key
myploy ssh public-key
```

### Scenario 2: Bootstrap Server Environment
```bash
myploy setup --host <your-vps-ip> --user root
```
- Verifies Docker & Docker Compose v2 installation.
- Configures UFW firewall (22, 80, 443).
- Launches isolated `myploy-nginx` and `myploy-certbot` reverse proxy containers.

### Scenario 3: Deploy an Application with Zero Downtime
In your project directory containing a `docker-compose.yml`:
```bash
# 1. Initialize config
myploy init

# 2. Deploy blue/green
myploy deploy

# 3. Test instant rollback
myploy rollback
```

### Scenario 4: Launch Web Control Plane & Container Discovery
```bash
myploy ui --port 4000
```
- Open `http://<your-ip>:4000` or `http://localhost:4000`.
- Initialize your master password on first launch (Timing-Safe Scrypt hashed).
- View all pre-existing containers on your VPS alongside MyPloy services.
- Inspect real-time memory usage and server uptime.
- View live container logs and trigger rollbacks directly from the browser.

### Scenario 5: Provision 1-Click Managed Databases
```bash
# Create PostgreSQL 16
myploy db create postgres mydb

# List database connection URLs
myploy db list

# Create a compressed snapshot backup
myploy db backup mydb
```

---

## 🐛 Feedback & Bug Reports

Found an issue or have an enhancement idea?
- Open a GitHub issue: [https://github.com/wellparth/myploy/issues](https://github.com/wellparth/myploy/issues)
- Tag your issue with `alpha` or select the **Alpha Bug Report** template.
- Include your OS, Node.js version, and VPS distribution.

Thank you for helping make MyPloy the best self-hosted deployment tool!
