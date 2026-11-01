import http from 'node:http';
import { SSHClient } from '../remote/ssh.js';
import { MyPloyConfig } from '../types/config.js';
import { DatabaseManager, DatabaseType } from '../core/database.js';
import { getDeploymentState, saveDeploymentState } from '../core/bluegreen.js';
import { applyNginxRouting, hasExistingCertificate } from '../core/ssl.js';
import { AuthManager } from './auth.js';
import {
  listAllVPSContainers,
  startVPSContainer,
  stopVPSContainer,
  restartVPSContainer,
  getVPSContainerLogs
} from './containers.js';
import { logger } from '../utils/logger.js';
import { escapeShellArg } from '../utils/security.js';

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function startDashboard(config: MyPloyConfig, port = 4000, host = '0.0.0.0'): http.Server {
  const ssh = new SSHClient(config);
  const dbManager = new DatabaseManager(ssh);
  const authManager = new AuthManager();

  const server = http.createServer(async (req, res) => {
    const clientIp = req.socket.remoteAddress || 'unknown';

    // Set defensive HTTP security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Parse cookies safely (prevent URIError crash on malformed input)
    const cookies: Record<string, string> = {};
    const cookieHeader = req.headers.cookie || '';
    if (cookieHeader) {
      for (const item of cookieHeader.split(';')) {
        const [k, ...v] = item.trim().split('=');
        if (k) {
          try {
            cookies[k] = decodeURIComponent(v.join('='));
          } catch {
            cookies[k] = v.join('=');
          }
        }
      }
    }

    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const sessionToken = cookies['myploy_session'] || bearerToken;
    const isAuthenticated = authManager.validateSession(sessionToken);

    // Read JSON Body helper with bounded buffer (64KB max) to prevent memory exhaustion DoS
    const MAX_BODY_BYTES = 64 * 1024;
    const readBody = (): Promise<any> =>
      new Promise((resolve, reject) => {
        let body = '';
        let receivedBytes = 0;
        req.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_BODY_BYTES) {
            req.destroy(new Error('Payload Too Large'));
            reject(new Error('Payload Too Large'));
            return;
          }
          body += chunk;
        });
        req.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch {
            resolve({});
          }
        });
        req.on('error', reject);
      });

    // --- AUTH ROUTES ---
    if (req.url === '/api/auth/status') {
      const state = authManager.getAuthState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ isConfigured: state.isConfigured, isAuthenticated }));
      return;
    }

    if (req.url === '/api/auth/setup' && req.method === 'POST') {
      const body = await readBody();
      try {
        const state = authManager.getAuthState();
        if (state.isConfigured) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Admin password is already configured.' }));
          return;
        }
        authManager.setupAdminPassword(body.password);
        const token = authManager.createSession();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `myploy_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`
        });
        res.end(JSON.stringify({ success: true, token }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody();
      try {
        const valid = authManager.verifyPassword(body.password || '', clientIp);
        if (!valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid admin password.' }));
          return;
        }
        const token = authManager.createSession();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `myploy_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`
        });
        res.end(JSON.stringify({ success: true, token }));
      } catch (err: any) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === '/api/auth/logout') {
      if (sessionToken) authManager.revokeSession(sessionToken);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'myploy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // --- PROTECTED API ROUTES (Require Authentication) ---
    if (req.url?.startsWith('/api/')) {
      if (!isAuthenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Admin authentication required.' }));
        return;
      }

      // API: Telemetry
      if (req.url === '/api/stats') {
        try {
          await ssh.connect();
          const dockerStatsRes = await ssh.exec(
            'docker stats --no-stream --format \'{"name":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","pids":"{{.PIDs}}"}\''
          );
          const containers = dockerStatsRes.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          const memoryRes = await ssh.exec("free -m | awk 'NR==2{printf \"%.2f%%\", $3*100/$2 }'");
          const uptimeRes = await ssh.exec('uptime -p');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              containers,
              serverMemoryUsage: memoryRes.stdout.trim(),
              uptime: uptimeRes.stdout.trim()
            })
          );
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // API: All VPS Services & Containers Discovery
      if (req.url === '/api/services') {
        try {
          await ssh.connect();
          const containers = await listAllVPSContainers(ssh);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(containers));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // API: Container Lifecycle Management
      if (req.url === '/api/containers/start' && req.method === 'POST') {
        try {
          await ssh.connect();
          const body = await readBody();
          await startVPSContainer(ssh, body.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.url === '/api/containers/stop' && req.method === 'POST') {
        try {
          await ssh.connect();
          const body = await readBody();
          await stopVPSContainer(ssh, body.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.url === '/api/containers/restart' && req.method === 'POST') {
        try {
          await ssh.connect();
          const body = await readBody();
          await restartVPSContainer(ssh, body.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.url?.startsWith('/api/containers/logs')) {
        try {
          await ssh.connect();
          const urlObj = new URL(req.url, 'http://localhost');
          const id = urlObj.searchParams.get('id') || '';
          const logs = await getVPSContainerLogs(ssh, id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ logs }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // API: Applications List
      if (req.url === '/api/apps') {
        try {
          await ssh.connect();
          const state = await getDeploymentState(ssh, config.app);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify([state || { app: config.app, activeSlot: 'none', domain: config.domain }])
          );
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // API: Managed Databases List
      if (req.url === '/api/databases') {
        try {
          await ssh.connect();
          const dbs = await dbManager.list();
          const safeDbs = dbs.map((d) => ({
            ...d,
            password: d.password ? '••••••••' : undefined,
            connectionUrl: d.connectionUrl.replace(/:([^:@]+)@/, ':••••••••@')
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(safeDbs));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // API: 1-Click Database Creation
      if (req.url === '/api/databases/create' && req.method === 'POST') {
        try {
          await ssh.connect();
          const body = await readBody();
          if (!body.name || !body.type) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Name and type are required' }));
            return;
          }
          const result = await dbManager.create({
            type: body.type as DatabaseType,
            name: body.name
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // API: Database Snapshot Backup
      if (req.url === '/api/databases/backup' && req.method === 'POST') {
        try {
          await ssh.connect();
          const body = await readBody();
          const path = await dbManager.backup(body.name);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, path }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // API: Instant Rollback
      if (req.url === '/api/rollback' && req.method === 'POST') {
        try {
          await ssh.connect();
          const state = await getDeploymentState(ssh, config.app);
          if (!state?.previousSlot) {
            throw new Error('No previous slot available for rollback.');
          }
          const targetSlot = state.previousSlot;
          const currentSlot = state.activeSlot;
          const hasCert = await hasExistingCertificate(ssh, config.domain);
          await applyNginxRouting(ssh, config.app, config.domain, targetSlot, config.appPort, hasCert);
          await saveDeploymentState(ssh, {
            app: config.app,
            activeSlot: targetSlot,
            previousSlot: currentSlot,
            domain: config.domain,
            updatedAt: new Date().toISOString()
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, activeSlot: targetSlot }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
    }

    // --- HTML RENDERER ---
    const authState = authManager.getAuthState();

    // 1. Initial Setup Screen (if no admin password set yet)
    if (!authState.isConfigured) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Setup Admin - MyPloy PaaS</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body { background-color: #090d16; color: #f3f4f6; font-family: ui-sans-serif, system-ui, sans-serif; }</style>
</head>
<body class="flex items-center justify-center h-screen p-4">
  <div class="max-w-md w-full bg-gray-900 border border-gray-800 rounded-3xl p-8 shadow-2xl space-y-6">
    <div class="text-center space-y-2">
      <div class="h-14 w-14 bg-indigo-600 rounded-2xl flex items-center justify-center font-black text-white text-2xl mx-auto shadow-lg shadow-indigo-500/30">🚀</div>
      <h1 class="text-2xl font-black text-white tracking-tight">Welcome to MyPloy</h1>
      <p class="text-xs text-gray-400">Initialize your self-hosted control plane by creating your master admin password.</p>
    </div>
    <form onsubmit="handleSetup(event)" class="space-y-4">
      <div>
        <label class="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Create Admin Password</label>
        <input type="password" id="setup-pw" minlength="8" required placeholder="Min 8 characters" class="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-sm text-white focus:outline-none focus:border-indigo-500" />
      </div>
      <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-xl transition-all shadow-lg shadow-indigo-600/30">
        Initialize MyPloy Control Plane
      </button>
    </form>
  </div>
  <script>
    async function handleSetup(e) {
      e.preventDefault();
      const pw = document.getElementById('setup-pw').value;
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json();
      if (data.success) {
        window.location.reload();
      } else {
        alert(data.error || 'Setup failed');
      }
    }
  </script>
</body>
</html>`);
      return;
    }

    // 2. Login Screen (if not authenticated)
    if (!isAuthenticated) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Login - MyPloy PaaS</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body { background-color: #090d16; color: #f3f4f6; font-family: ui-sans-serif, system-ui, sans-serif; }</style>
</head>
<body class="flex items-center justify-center h-screen p-4">
  <div class="max-w-md w-full bg-gray-900 border border-gray-800 rounded-3xl p-8 shadow-2xl space-y-6">
    <div class="text-center space-y-2">
      <div class="h-14 w-14 bg-indigo-600 rounded-2xl flex items-center justify-center font-black text-white text-2xl mx-auto shadow-lg shadow-indigo-500/30">🚀</div>
      <h1 class="text-2xl font-black text-white tracking-tight">MyPloy Control Plane</h1>
      <p class="text-xs text-gray-400 font-mono">Target: ${escapeHtml(config.user)}@${escapeHtml(config.host)}</p>
    </div>
    <form onsubmit="handleLogin(event)" class="space-y-4">
      <div>
        <label class="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Master Password</label>
        <input type="password" id="login-pw" required placeholder="Enter password" class="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-sm text-white focus:outline-none focus:border-indigo-500" />
      </div>
      <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-xl transition-all shadow-lg shadow-indigo-600/30">
        Unlock Dashboard
      </button>
    </form>
  </div>
  <script>
    async function handleLogin(e) {
      e.preventDefault();
      const pw = document.getElementById('login-pw').value;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json();
      if (data.success) {
        window.location.reload();
      } else {
        alert(data.error || 'Authentication failed');
      }
    }
  </script>
</body>
</html>`);
      return;
    }

    // 3. Authenticated Dokploy-Style Control Plane with All-Services Discovery
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MyPloy Control Plane</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #090d16; color: #f3f4f6; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .sidebar-active { background-color: rgba(99, 102, 241, 0.15); color: #818cf8; border-right: 3px solid #6366f1; }
  </style>
</head>
<body class="flex h-screen overflow-hidden">

  <!-- Sidebar -->
  <aside class="w-64 bg-gray-950 border-r border-gray-800 flex flex-col justify-between shrink-0">
    <div>
      <div class="p-6 flex items-center gap-3 border-b border-gray-800/80">
        <div class="h-9 w-9 bg-indigo-600 rounded-xl flex items-center justify-center font-black text-white shadow-lg shadow-indigo-500/30 text-lg">🚀</div>
        <div>
          <div class="font-black text-lg tracking-tight text-white flex items-center gap-1.5">
            MyPloy <span class="text-[10px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">PaaS</span>
          </div>
          <div class="text-[11px] text-gray-500 font-mono">Self-Hosted VPS</div>
        </div>
      </div>

      <nav class="p-3 space-y-1 text-sm font-medium">
        <button onclick="switchTab('services')" id="nav-services" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-800/50 hover:text-white transition-all sidebar-active">
          <span>🖥️</span> All VPS Services
        </button>
        <button onclick="switchTab('apps')" id="nav-apps" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>🚀</span> Blue/Green Apps
        </button>
        <button onclick="switchTab('databases')" id="nav-databases" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>🗄️</span> Databases
        </button>
        <button onclick="switchTab('monitoring')" id="nav-monitoring" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>📊</span> Telemetry
        </button>
        <button onclick="switchTab('logs')" id="nav-logs" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>📜</span> Logs
        </button>
        <button onclick="switchTab('security')" id="nav-security" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>🛡️</span> Security & Edge
        </button>
      </nav>
    </div>

    <div class="p-4 border-t border-gray-800/80 bg-gray-900/40 space-y-2">
      <div class="flex justify-between items-center">
        <span class="text-[11px] font-mono text-indigo-400 font-semibold">${escapeHtml(config.user)}@${escapeHtml(config.host)}</span>
        <button onclick="logout()" class="text-[11px] text-gray-400 hover:text-red-400 transition-colors">Logout</button>
      </div>
      <div class="flex items-center gap-1.5 text-[11px] text-emerald-400">
        <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Authorized Access
      </div>
    </div>
  </aside>

  <!-- Main View -->
  <main class="flex-1 flex flex-col overflow-y-auto">
    <header class="h-16 border-b border-gray-800 px-8 flex items-center justify-between shrink-0 bg-gray-950/40 backdrop-blur">
      <div class="flex items-center gap-4">
        <h1 id="page-title" class="text-lg font-bold text-white">All VPS Services</h1>
        <span id="uptime-badge" class="text-xs font-mono text-gray-400 bg-gray-900 px-2.5 py-1 rounded-full border border-gray-800">Uptime checking...</span>
      </div>
      <div class="flex items-center gap-3">
        <button onclick="loadServices()" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 transition-all flex items-center gap-1.5">
          <span>🔄</span> Refresh Services
        </button>
        <a href="https://${escapeHtml(config.domain)}" target="_blank" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-all flex items-center gap-1.5 shadow-sm shadow-indigo-500/20">
          <span>🌐</span> Visit Domain
        </a>
      </div>
    </header>

    <!-- Tab: All VPS Services Discovery -->
    <div id="tab-services" class="p-8 space-y-6">
      <div class="flex justify-between items-center">
        <div>
          <h2 class="text-xl font-bold">All Running VPS Services & Containers</h2>
          <p class="text-xs text-gray-400">Auto-discovered containers across your entire VPS (both MyPloy apps and manual standalone services).</p>
        </div>
      </div>
      <div class="bg-gray-900/40 border border-gray-800 rounded-2xl overflow-hidden">
        <div id="services-table" class="p-4 text-xs font-mono text-gray-500">Querying VPS containers...</div>
      </div>
    </div>

    <!-- Tab: Blue/Green Apps -->
    <div id="tab-apps" class="p-8 space-y-6 hidden">
      <div class="flex justify-between items-center">
        <div>
          <h2 class="text-xl font-bold">Zero-Downtime Blue/Green Applications</h2>
          <p class="text-xs text-gray-400">Managed apps with automatic health checking and atomic Nginx traffic switching.</p>
        </div>
        <button onclick="triggerRollback()" class="text-xs font-bold px-3.5 py-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all">
          🔄 1-Click Rollback Slot
        </button>
      </div>
      <div id="apps-list" class="grid grid-cols-1 gap-4">
        <div class="p-8 text-center text-gray-500 text-sm">Loading applications...</div>
      </div>
    </div>

    <!-- Tab: Databases -->
    <div id="tab-databases" class="p-8 space-y-6 hidden">
      <div class="flex justify-between items-center">
        <div>
          <h2 class="text-xl font-bold">Managed Databases</h2>
          <p class="text-xs text-gray-400">1-Click isolated databases with persistent volumes & zero host port exposure.</p>
        </div>
        <button onclick="openDbModal()" class="text-xs font-bold px-3.5 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-all flex items-center gap-1.5">
          <span>+</span> New Database
        </button>
      </div>
      <div id="db-list" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="p-8 text-center text-gray-500 text-sm">Loading databases...</div>
      </div>
    </div>

    <!-- Tab: Telemetry -->
    <div id="tab-monitoring" class="p-8 space-y-6 hidden">
      <h2 class="text-xl font-bold">VPS Host Telemetry</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="p-6 rounded-2xl bg-gray-900/50 border border-gray-800">
          <div class="text-xs font-semibold uppercase text-gray-400 tracking-wider">Memory Allocation</div>
          <div id="vps-mem-val" class="text-3xl font-black mt-2 text-white">...</div>
          <div class="w-full bg-gray-800 rounded-full h-2 mt-4 overflow-hidden">
            <div id="vps-mem-bar" class="bg-indigo-500 h-2 rounded-full transition-all duration-500" style="width: 0%"></div>
          </div>
        </div>
        <div class="p-6 rounded-2xl bg-gray-900/50 border border-gray-800">
          <div class="text-xs font-semibold uppercase text-gray-400 tracking-wider">Deployment Model</div>
          <div class="text-3xl font-black mt-2 text-emerald-400">Zero-Downtime</div>
          <div class="text-xs text-gray-400 mt-2">Nginx Reverse Proxy + Bridge Network Isolation</div>
        </div>
      </div>
      <div class="rounded-2xl border border-gray-800 bg-gray-900/30 overflow-hidden">
        <div class="p-4 border-b border-gray-800 text-xs font-bold uppercase tracking-wider text-gray-400">Live Telemetry</div>
        <div id="containers-table" class="p-4">Loading containers...</div>
      </div>
    </div>

    <!-- Tab: Logs -->
    <div id="tab-logs" class="p-8 space-y-4 hidden flex-1 flex flex-col">
      <div class="flex justify-between items-center">
        <div>
          <h2 class="text-xl font-bold">Live Container Console</h2>
          <p id="log-target-desc" class="text-xs text-gray-400">Streaming recent logs...</p>
        </div>
        <button onclick="loadLogs()" class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-all">
          🔄 Refresh
        </button>
      </div>
      <div class="flex-1 bg-black rounded-xl border border-gray-800 p-4 font-mono text-xs text-gray-300 overflow-y-auto max-h-[550px] whitespace-pre-wrap leading-relaxed shadow-inner" id="log-console">
        Select a container or view active logs...
      </div>
    </div>

    <!-- Tab: Security & Edge -->
    <div id="tab-security" class="p-8 space-y-6 hidden">
      <h2 class="text-xl font-bold">Security, Firewall & Edge Shielding</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="p-6 rounded-2xl bg-gray-900/40 border border-gray-800 flex items-start gap-4">
          <div class="text-2xl">🛡️</div>
          <div>
            <div class="font-bold text-white">Origin Cloaking (HTTP 444)</div>
            <div class="text-xs text-gray-400 mt-1">Direct IP queries without a valid domain header are dropped with HTTP 444, shielding the server from automated Shodan/Censys scanners.</div>
            <span class="inline-block mt-3 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">ENABLED</span>
          </div>
        </div>
        <div class="p-6 rounded-2xl bg-gray-900/40 border border-gray-800 flex items-start gap-4">
          <div class="text-2xl">☁️</div>
          <div>
            <div class="font-bold text-white">Cloudflare Real-IP Translation</div>
            <div class="text-xs text-gray-400 mt-1">Nginx restores real visitor IP from <code class="text-indigo-400">CF-Connecting-IP</code> header using official Cloudflare CIDR blocks.</div>
            <span class="inline-block mt-3 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">ACTIVE</span>
          </div>
        </div>
        <div class="p-6 rounded-2xl bg-gray-900/40 border border-gray-800 flex items-start gap-4">
          <div class="text-2xl">🔒</div>
          <div>
            <div class="font-bold text-white">Zero Public Port Exposure</div>
            <div class="text-xs text-gray-400 mt-1">Host port mappings are stripped on internal containers. Databases and microservices are reachable only through Docker bridge interfaces.</div>
            <span class="inline-block mt-3 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">ENFORCED</span>
          </div>
        </div>
        <div class="p-6 rounded-2xl bg-gray-900/40 border border-gray-800 flex items-start gap-4">
          <div class="text-2xl">🔑</div>
          <div>
            <div class="font-bold text-white">Process Credential Isolation</div>
            <div class="text-xs text-gray-400 mt-1">Secrets are stored in <code class="text-indigo-400">chmod 600</code> env files, protecting database passwords from process sniffing (<code class="text-indigo-400">ps aux</code>).</div>
            <span class="inline-block mt-3 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">VERIFIED</span>
          </div>
        </div>
      </div>
    </div>
  </main>

  <!-- Database Modal -->
  <div id="db-modal" class="fixed inset-0 bg-black/70 backdrop-blur-sm hidden flex items-center justify-center p-4 z-50">
    <div class="bg-gray-900 border border-gray-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
      <div class="flex justify-between items-center">
        <h3 class="font-bold text-white text-lg">Provision New Database</h3>
        <button onclick="closeDbModal()" class="text-gray-400 hover:text-white">&times;</button>
      </div>
      <div>
        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Database Engine</label>
        <select id="new-db-type" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
          <option value="postgres">PostgreSQL 16</option>
          <option value="mysql">MySQL 8.0</option>
          <option value="redis">Redis 7</option>
          <option value="mongo">MongoDB 7</option>
          <option value="mariadb">MariaDB 11</option>
        </select>
      </div>
      <div>
        <label class="block text-xs font-semibold uppercase text-gray-400 mb-1">Database Name</label>
        <input type="text" id="new-db-name" placeholder="e.g. production_db" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-indigo-500" />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button onclick="closeDbModal()" class="px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white">Cancel</button>
        <button onclick="createDatabase()" class="px-4 py-2 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-all">Provision Database</button>
      </div>
    </div>
  </div>

  <script>
    function switchTab(tab) {
      ['services', 'apps', 'databases', 'monitoring', 'logs', 'security'].forEach(t => {
        document.getElementById('tab-' + t).classList.add('hidden');
        document.getElementById('nav-' + t).classList.remove('sidebar-active');
      });
      document.getElementById('tab-' + tab).classList.remove('hidden');
      document.getElementById('nav-' + tab).classList.add('sidebar-active');

      const titles = {
        services: 'All VPS Services & Containers',
        apps: 'Blue/Green Applications',
        databases: 'Managed Databases',
        monitoring: 'Resource Telemetry',
        logs: 'Live Console Logs',
        security: 'Security & Edge'
      };
      document.getElementById('page-title').innerText = titles[tab];

      if (tab === 'services') loadServices();
      if (tab === 'logs') loadLogs();
    }

    async function logout() {
      await fetch('/api/auth/logout');
      window.location.reload();
    }

    async function loadServices() {
      try {
        const res = await fetch('/api/services');
        const data = await res.json();
        if (!data.length) {
          document.getElementById('services-table').innerHTML = '<div class="p-6 text-gray-500 text-xs">No active containers found on VPS.</div>';
          return;
        }
        document.getElementById('services-table').innerHTML = \`
          <table class="w-full text-left text-xs font-mono">
            <thead class="text-gray-500 border-b border-gray-800">
              <tr>
                <th class="p-3">Container Name</th>
                <th class="p-3">Image</th>
                <th class="p-3">Status</th>
                <th class="p-3">Ports</th>
                <th class="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800/50">
              \${data.map(c => \`
                <tr class="hover:bg-gray-800/20">
                  <td class="p-3 font-bold text-white flex items-center gap-2">
                    \${c.isMyPloy ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">MYPLOY</span>' : '<span class="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">STANDALONE</span>'}
                    \${c.name}
                  </td>
                  <td class="p-3 text-gray-400">\${c.image}</td>
                  <td class="p-3">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold \${c.state === 'running' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}">
                      \${c.status}
                    </span>
                  </td>
                  <td class="p-3 text-gray-500 text-[11px]">\${c.ports || 'internal'}</td>
                  <td class="p-3 text-right space-x-1.5">
                    \${c.state === 'running' ? 
                      \`<button onclick="controlContainer('\${c.id}', 'restart')" class="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 text-[10px]">Restart</button>
                       <button onclick="controlContainer('\${c.id}', 'stop')" class="px-2 py-1 rounded bg-red-950/40 text-red-400 hover:bg-red-900/40 text-[10px]">Stop</button>\` :
                      \`<button onclick="controlContainer('\${c.id}', 'start')" class="px-2 py-1 rounded bg-emerald-950/40 text-emerald-400 hover:bg-emerald-900/40 text-[10px]">Start</button>\`
                    }
                    <button onclick="viewContainerLogs('\${c.id}', '\${c.name}')" class="px-2 py-1 rounded bg-indigo-950/40 text-indigo-400 hover:bg-indigo-900/40 text-[10px]">Logs</button>
                  </td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (e) {
        console.error(e);
      }
    }

    async function controlContainer(id, action) {
      try {
        await fetch('/api/containers/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        loadServices();
      } catch (e) {
        alert(e.message);
      }
    }

    async function viewContainerLogs(id, name) {
      try {
        switchTab('logs');
        document.getElementById('log-target-desc').innerText = 'Showing container: ' + name;
        document.getElementById('log-console').innerText = 'Loading logs for ' + name + '...';
        const res = await fetch('/api/containers/logs?id=' + encodeURIComponent(id));
        const data = await res.json();
        document.getElementById('log-console').innerText = data.logs || 'No logs.';
      } catch (e) {
        alert(e.message);
      }
    }

    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('uptime-badge').innerText = data.uptime || 'Uptime normal';
        document.getElementById('vps-mem-val').innerText = data.serverMemoryUsage || 'Normal';
        document.getElementById('vps-mem-bar').style.width = data.serverMemoryUsage || '30%';

        const html = data.containers && data.containers.length ? \`
          <table class="w-full text-left text-xs font-mono">
            <thead class="text-gray-500 border-b border-gray-800">
              <tr>
                <th class="pb-2">Container</th>
                <th class="pb-2">CPU</th>
                <th class="pb-2">Memory Usage</th>
                <th class="pb-2">PIDs</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800/50">
              \${data.containers.map(c => \`
                <tr>
                  <td class="py-2.5 text-indigo-400 font-bold">\${c.name}</td>
                  <td class="py-2.5 text-gray-300">\${c.cpu}</td>
                  <td class="py-2.5 text-gray-300">\${c.mem}</td>
                  <td class="py-2.5 text-gray-500">\${c.pids}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \` : '<div class="text-gray-500 text-xs">No active containers found.</div>';
        document.getElementById('containers-table').innerHTML = html;
      } catch (e) {
        console.error(e);
      }
    }

    async function loadApps() {
      try {
        const res = await fetch('/api/apps');
        const apps = await res.json();
        document.getElementById('apps-list').innerHTML = apps.map(a => \`
          <div class="p-6 rounded-2xl bg-gray-900/40 border border-gray-800 flex items-center justify-between">
            <div class="flex items-center gap-4">
              <div class="h-12 w-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-2xl font-black text-indigo-400">📦</div>
              <div>
                <div class="font-bold text-white text-base">\${a.app}</div>
                <div class="text-xs font-mono text-indigo-400 mt-0.5"><a href="https://\${a.domain}" target="_blank" class="hover:underline">https://\${a.domain}</a></div>
                <div class="text-[11px] text-gray-500 mt-1">Last Deploy: \${a.updatedAt ? new Date(a.updatedAt).toLocaleString() : 'N/A'}</div>
              </div>
            </div>
            <div class="flex items-center gap-4">
              <span class="px-3 py-1 rounded-full text-xs font-bold \${a.activeSlot === 'blue' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}">
                SLOT: \${(a.activeSlot || 'BLUE').toUpperCase()}
              </span>
              <button onclick="triggerRollback()" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 transition-all">
                Rollback
              </button>
            </div>
          </div>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function loadDatabases() {
      try {
        const res = await fetch('/api/databases');
        const dbs = await res.json();
        if (!dbs.length) {
          document.getElementById('db-list').innerHTML = '<div class="col-span-2 p-8 text-center text-gray-500 text-xs">No databases provisioned yet. Click "+ New Database" above.</div>';
          return;
        }
        document.getElementById('db-list').innerHTML = dbs.map(d => \`
          <div class="p-6 rounded-2xl bg-gray-900/40 border border-gray-800 space-y-3">
            <div class="flex justify-between items-start">
              <div>
                <span class="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">\${d.type}</span>
                <div class="font-bold text-white text-base mt-1">\${d.name}</div>
              </div>
              <span class="text-[11px] text-emerald-400 flex items-center gap-1">
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> \${d.status}
              </span>
            </div>
            <div class="bg-gray-950 p-2.5 rounded-lg font-mono text-[11px] text-gray-400 break-all select-all border border-gray-800/80">
              \${d.connectionUrl}
            </div>
            <div class="flex justify-between items-center pt-2">
              <span class="text-[11px] text-gray-500">Internal: \${d.containerName}:\${d.port}</span>
              <button onclick="backupDatabase('\${d.name}')" class="text-xs font-semibold px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">
                💾 Backup
              </button>
            </div>
          </div>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function loadLogs() {
      try {
        const res = await fetch('/api/containers/logs?id=' + encodeURIComponent('${encodeURIComponent(config.app)}_blue'));
        const data = await res.json();
        document.getElementById('log-console').innerText = data.logs || 'No recent logs.';
      } catch (e) {
        console.error(e);
      }
    }

    async function triggerRollback() {
      if (!confirm('Roll back to the previous deployment slot immediately?')) return;
      try {
        const res = await fetch('/api/rollback', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('Rollback successful! Active slot is now: ' + data.activeSlot.toUpperCase());
          loadApps();
        } else {
          alert('Rollback error: ' + data.error);
        }
      } catch (e) {
        alert(e.message);
      }
    }

    function openDbModal() { document.getElementById('db-modal').classList.remove('hidden'); }
    function closeDbModal() { document.getElementById('db-modal').classList.add('hidden'); }

    async function createDatabase() {
      const type = document.getElementById('new-db-type').value;
      const name = document.getElementById('new-db-name').value.trim();
      if (!name) return alert('Database name is required');
      try {
        const res = await fetch('/api/databases/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, name })
        });
        const data = await res.json();
        if (data.name) {
          closeDbModal();
          loadDatabases();
        } else {
          alert(data.error || 'Failed to create database');
        }
      } catch (e) {
        alert(e.message);
      }
    }

    async function backupDatabase(name) {
      try {
        const res = await fetch('/api/databases/backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.success) {
          alert('Backup created at: ' + data.path);
        } else {
          alert(data.error);
        }
      } catch (e) {
        alert(e.message);
      }
    }

    loadServices();
    loadStats();
    loadApps();
    loadDatabases();
    setInterval(loadStats, 5000);
  </script>
</body>
</html>`);
  });

  server.listen(port, host, () => {
    logger.header('MyPloy Self-Hosted Control Plane Online');
    console.log(`  🌐 Dashboard URL:    http://${host === '0.0.0.0' ? '0.0.0.0' : host}:${port}`);
    console.log(`  📡 Target VPS:       ${config.user}@${config.host}`);
    console.log(`  🔒 Security:         Admin Password Auth Enforced (Timing-safe + Scrypt)`);
    console.log(`  🔍 Auto-Discovery:   Monitoring all containers and manual services on VPS\n`);
  });

  return server;
}
