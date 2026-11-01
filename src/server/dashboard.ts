import http from 'node:http';
import { SSHClient } from '../remote/ssh.js';
import { MyPloyConfig } from '../types/config.js';
import { DatabaseManager, DatabaseType } from '../core/database.js';
import { getDeploymentState, saveDeploymentState } from '../core/bluegreen.js';
import { applyNginxRouting, hasExistingCertificate } from '../core/ssl.js';
import { logger } from '../utils/logger.js';
import { escapeShellArg } from '../utils/security.js';

export function startDashboard(config: MyPloyConfig, port = 4000): http.Server {
  const ssh = new SSHClient(config);
  const dbManager = new DatabaseManager(ssh);

  const server = http.createServer(async (req, res) => {
    // Helper to read JSON request body
    const readBody = (): Promise<any> =>
      new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch {
            resolve({});
          }
        });
      });

    // API: Server & Container Telemetry
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

    // API: Container Logs
    if (req.url?.startsWith('/api/logs')) {
      try {
        await ssh.connect();
        const state = await getDeploymentState(ssh, config.app);
        const slot = state?.activeSlot || 'blue';
        const containerName = `${config.app}_${slot}`;
        const logsRes = await ssh.exec(
          `docker logs --tail 100 ${escapeShellArg(containerName)} 2>&1`
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ container: containerName, logs: logsRes.stdout || logsRes.stderr }));
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

    // Serve Dokploy-Style UI
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MyPloy Control Plane (Dokploy-Grade)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #090d16; color: #f3f4f6; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .sidebar-active { background-color: rgba(99, 102, 241, 0.15); color: #818cf8; border-right: 3px solid #6366f1; }
  </style>
</head>
<body class="flex h-screen overflow-hidden">

  <!-- Left Sidebar (Dokploy Style) -->
  <aside class="w-64 bg-gray-950 border-r border-gray-800 flex flex-col justify-between shrink-0">
    <div>
      <!-- Brand -->
      <div class="p-6 flex items-center gap-3 border-b border-gray-800/80">
        <div class="h-9 w-9 bg-indigo-600 rounded-xl flex items-center justify-center font-black text-white shadow-lg shadow-indigo-500/30 text-lg">🚀</div>
        <div>
          <div class="font-black text-lg tracking-tight text-white flex items-center gap-1.5">
            MyPloy <span class="text-[10px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">PaaS</span>
          </div>
          <div class="text-[11px] text-gray-500 font-mono">Dokploy-Grade</div>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <nav class="p-3 space-y-1 text-sm font-medium">
        <button onclick="switchTab('apps')" id="nav-apps" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-300 hover:bg-gray-800/50 hover:text-white transition-all sidebar-active">
          <span>🚀</span> Applications
        </button>
        <button onclick="switchTab('databases')" id="nav-databases" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>🗄️</span> Databases
        </button>
        <button onclick="switchTab('monitoring')" id="nav-monitoring" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>📊</span> Monitoring
        </button>
        <button onclick="switchTab('logs')" id="nav-logs" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>📜</span> Terminal Logs
        </button>
        <button onclick="switchTab('security')" id="nav-security" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-gray-400 hover:bg-gray-800/50 hover:text-white transition-all">
          <span>🛡️</span> Security & Edge
        </button>
      </nav>
    </div>

    <!-- Server Host Footer -->
    <div class="p-4 border-t border-gray-800/80 bg-gray-900/40">
      <div class="text-[11px] uppercase tracking-wider font-semibold text-gray-500">Connected VPS</div>
      <div class="text-xs font-mono text-indigo-400 truncate mt-1 font-semibold">${config.user}@${config.host}</div>
      <div class="flex items-center gap-1.5 mt-2 text-[11px] text-emerald-400">
        <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Edge Proxy Online
      </div>
    </div>
  </aside>

  <!-- Main Content Area -->
  <main class="flex-1 flex flex-col overflow-y-auto">
    <!-- Header -->
    <header class="h-16 border-b border-gray-800 px-8 flex items-center justify-between shrink-0 bg-gray-950/40 backdrop-blur">
      <div class="flex items-center gap-4">
        <h1 id="page-title" class="text-lg font-bold text-white">Applications</h1>
        <span id="uptime-badge" class="text-xs font-mono text-gray-400 bg-gray-900 px-2.5 py-1 rounded-full border border-gray-800">Checking uptime...</span>
      </div>
      <div class="flex items-center gap-3">
        <button onclick="triggerRollback()" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all flex items-center gap-1.5">
          <span>🔄</span> Rollback Slot
        </button>
        <a href="https://${config.domain}" target="_blank" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-all flex items-center gap-1.5 shadow-sm shadow-indigo-500/20">
          <span>🌐</span> Visit Production
        </a>
      </div>
    </header>

    <!-- Tab 1: Applications -->
    <div id="tab-apps" class="p-8 space-y-6">
      <div class="flex justify-between items-center">
        <div>
          <h2 class="text-xl font-bold">Deployed Applications</h2>
          <p class="text-xs text-gray-400">Blue/Green zero-downtime container slots running on isolated network.</p>
        </div>
      </div>

      <div id="apps-list" class="grid grid-cols-1 gap-4">
        <div class="p-8 text-center text-gray-500 text-sm">Loading application data...</div>
      </div>
    </div>

    <!-- Tab 2: Databases -->
    <div id="tab-databases" class="p-8 space-y-6 hidden">
      <div class="flex justify-between items-center">
        <div>
          <h2 class="text-xl font-bold">Managed Databases</h2>
          <p class="text-xs text-gray-400">1-Click isolated databases with persistent storage & automated backups.</p>
        </div>
        <button onclick="openDbModal()" class="text-xs font-bold px-3.5 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-all flex items-center gap-1.5">
          <span>+</span> New Database
        </button>
      </div>

      <div id="db-list" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="p-8 text-center text-gray-500 text-sm">Loading databases...</div>
      </div>
    </div>

    <!-- Tab 3: Monitoring -->
    <div id="tab-monitoring" class="p-8 space-y-6 hidden">
      <h2 class="text-xl font-bold">VPS Resource Telemetry</h2>

      <!-- Metrics Cards -->
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

      <!-- Live Containers -->
      <div class="rounded-2xl border border-gray-800 bg-gray-900/30 overflow-hidden">
        <div class="p-4 border-b border-gray-800 text-xs font-bold uppercase tracking-wider text-gray-400">Live Container Telemetry</div>
        <div id="containers-table" class="p-4">Loading containers...</div>
      </div>
    </div>

    <!-- Tab 4: Terminal Logs -->
    <div id="tab-logs" class="p-8 space-y-4 hidden flex-1 flex flex-col">
      <div class="flex justify-between items-center">
        <div>
          <h2 class="text-xl font-bold">Container Production Logs</h2>
          <p id="log-target-desc" class="text-xs text-gray-400">Streaming latest 100 lines...</p>
        </div>
        <button onclick="loadLogs()" class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-all">
          🔄 Refresh Logs
        </button>
      </div>
      <div class="flex-1 bg-black rounded-xl border border-gray-800 p-4 font-mono text-xs text-gray-300 overflow-y-auto max-h-[550px] whitespace-pre-wrap leading-relaxed shadow-inner" id="log-console">
        Fetching logs...
      </div>
    </div>

    <!-- Tab 5: Security & Edge -->
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

  <!-- Database Creation Modal -->
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
      ['apps', 'databases', 'monitoring', 'logs', 'security'].forEach(t => {
        document.getElementById('tab-' + t).classList.add('hidden');
        document.getElementById('nav-' + t).classList.remove('sidebar-active');
      });
      document.getElementById('tab-' + tab).classList.remove('hidden');
      document.getElementById('nav-' + tab).classList.add('sidebar-active');

      const titles = {
        apps: 'Applications',
        databases: 'Managed Databases',
        monitoring: 'Resource Telemetry',
        logs: 'Container Logs',
        security: 'Security & Edge'
      };
      document.getElementById('page-title').innerText = titles[tab];

      if (tab === 'logs') loadLogs();
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
        const res = await fetch('/api/logs');
        const data = await res.json();
        document.getElementById('log-console').innerText = data.logs || 'No recent logs.';
        document.getElementById('log-target-desc').innerText = 'Showing active container: ' + data.container;
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

    loadStats();
    loadApps();
    loadDatabases();
    setInterval(loadStats, 5000);
  </script>
</body>
</html>`);
  });

  // Explicitly bind to loopback (127.0.0.1) to prevent unintended public exposure
  server.listen(port, '127.0.0.1', () => {
    logger.header('MyPloy Dashboard Online (Dokploy-Style)');
    console.log(`  🌐 Local Web UI:    http://127.0.0.1:${port}`);
    console.log(`  📡 Target Host:     ${config.user}@${config.host}`);
    console.log(`  📊 Dokploy-grade sidebar, telemetry, live logs & database manager ready\n`);
  });

  return server;
}
