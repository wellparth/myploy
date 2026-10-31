import http from 'node:http';
import { SSHClient } from '../remote/ssh.js';
import { MyPloyConfig } from '../types/config.js';
import { DatabaseManager } from '../core/database.js';
import { getDeploymentState } from '../core/bluegreen.js';
import { logger } from '../utils/logger.js';

export function startDashboard(config: MyPloyConfig, port = 4000): http.Server {
  const ssh = new SSHClient(config);
  const dbManager = new DatabaseManager(ssh);

  const server = http.createServer(async (req, res) => {
    // API routes
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

    if (req.url === '/api/apps') {
      try {
        await ssh.connect();
        const state = await getDeploymentState(ssh, config.app);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([state || { app: config.app, activeSlot: 'none', domain: config.domain }]));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === '/api/databases') {
      try {
        await ssh.connect();
        const dbs = await dbManager.list();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dbs));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Serve sleek dashboard HTML
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MyPloy Dashboard - Dokploy-grade VPS Manager</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #0b0f19; color: #f3f4f6; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="p-8 max-w-7xl mx-auto">
  <header class="flex justify-between items-center pb-6 border-b border-gray-800">
    <div class="flex items-center gap-3">
      <div class="h-10 w-10 bg-indigo-600 rounded-xl flex items-center justify-center font-black text-xl text-white shadow-lg shadow-indigo-500/30">🚀</div>
      <div>
        <h1 class="text-2xl font-bold tracking-tight">MyPloy Control Plane</h1>
        <p class="text-sm text-gray-400">Target Host: <span class="font-mono text-indigo-400">${config.user}@${config.host}</span></p>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span> Connected
      </span>
    </div>
  </header>

  <!-- Overview Stats -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6 my-8">
    <div class="bg-gray-900/60 border border-gray-800 rounded-2xl p-6">
      <div class="text-xs uppercase tracking-wider font-semibold text-gray-400">Target Application</div>
      <div class="text-3xl font-extrabold mt-2 text-white">${config.app}</div>
      <div class="text-sm text-indigo-400 mt-1 font-mono">${config.domain}</div>
    </div>
    <div class="bg-gray-900/60 border border-gray-800 rounded-2xl p-6">
      <div class="text-xs uppercase tracking-wider font-semibold text-gray-400">VPS Memory Load</div>
      <div id="vps-mem" class="text-3xl font-extrabold mt-2 text-white">Loading...</div>
      <div class="text-sm text-gray-400 mt-1" id="vps-uptime">Checking server uptime...</div>
    </div>
    <div class="bg-gray-900/60 border border-gray-800 rounded-2xl p-6">
      <div class="text-xs uppercase tracking-wider font-semibold text-gray-400">Architecture Mode</div>
      <div class="text-3xl font-extrabold mt-2 text-emerald-400">Zero-Downtime</div>
      <div class="text-sm text-gray-400 mt-1">Nginx + Blue/Green + Auto-SSL</div>
    </div>
  </div>

  <!-- Deployed Apps Section -->
  <section class="my-10">
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-xl font-bold tracking-tight">Active Applications</h2>
    </div>
    <div id="apps-container" class="bg-gray-900/40 border border-gray-800 rounded-2xl overflow-hidden">
      <div class="p-6 text-gray-400 text-sm">Loading applications...</div>
    </div>
  </section>

  <!-- Managed Databases Section -->
  <section class="my-10">
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-xl font-bold tracking-tight">Managed Databases (1-Click)</h2>
    </div>
    <div id="db-container" class="bg-gray-900/40 border border-gray-800 rounded-2xl overflow-hidden">
      <div class="p-6 text-gray-400 text-sm">Loading databases...</div>
    </div>
  </section>

  <!-- Real-time Container Stats -->
  <section class="my-10">
    <h2 class="text-xl font-bold tracking-tight mb-4">Live Container Telemetry</h2>
    <div id="containers-container" class="bg-gray-900/40 border border-gray-800 rounded-2xl overflow-hidden">
      <div class="p-6 text-gray-400 text-sm">Querying Docker stats...</div>
    </div>
  </section>

  <script>
    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('vps-mem').innerText = data.serverMemoryUsage || 'Normal';
        document.getElementById('vps-uptime').innerText = data.uptime || 'Uptime normal';

        const containerHtml = data.containers.length ? \`
          <table class="w-full text-left text-sm">
            <thead class="bg-gray-800/50 text-gray-400 text-xs uppercase">
              <tr>
                <th class="p-4">Container</th>
                <th class="p-4">CPU %</th>
                <th class="p-4">Memory</th>
                <th class="p-4">Threads (PIDs)</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800">
              \${data.containers.map(c => \`
                <tr>
                  <td class="p-4 font-mono font-medium text-indigo-300">\${c.name}</td>
                  <td class="p-4">\${c.cpu}</td>
                  <td class="p-4">\${c.mem}</td>
                  <td class="p-4 text-gray-400">\${c.pids}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \` : '<div class="p-6 text-gray-400">No active containers found.</div>';
        document.getElementById('containers-container').innerHTML = containerHtml;
      } catch (e) {
        console.error(e);
      }
    }

    async function loadApps() {
      try {
        const res = await fetch('/api/apps');
        const apps = await res.json();
        document.getElementById('apps-container').innerHTML = \`
          <table class="w-full text-left text-sm">
            <thead class="bg-gray-800/50 text-gray-400 text-xs uppercase">
              <tr>
                <th class="p-4">App Name</th>
                <th class="p-4">Active Slot</th>
                <th class="p-4">Domain</th>
                <th class="p-4">Updated</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800">
              \${apps.map(a => \`
                <tr>
                  <td class="p-4 font-bold text-white">\${a.app}</td>
                  <td class="p-4">
                    <span class="px-2.5 py-1 rounded-md text-xs font-bold \${a.activeSlot === 'blue' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'}">
                      \${a.activeSlot.toUpperCase()}
                    </span>
                  </td>
                  <td class="p-4 font-mono text-indigo-400"><a href="https://\${a.domain}" target="_blank" class="hover:underline">\${a.domain}</a></td>
                  <td class="p-4 text-gray-400 text-xs">\${a.updatedAt ? new Date(a.updatedAt).toLocaleString() : 'N/A'}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (e) {
        console.error(e);
      }
    }

    async function loadDatabases() {
      try {
        const res = await fetch('/api/databases');
        const dbs = await res.json();
        if (!dbs.length) {
          document.getElementById('db-container').innerHTML = '<div class="p-6 text-gray-400 text-sm">No databases provisioned yet. Use <code class="text-indigo-400">myploy db create postgres mydb</code> to create one.</div>';
          return;
        }
        document.getElementById('db-container').innerHTML = \`
          <table class="w-full text-left text-sm">
            <thead class="bg-gray-800/50 text-gray-400 text-xs uppercase">
              <tr>
                <th class="p-4">Name</th>
                <th class="p-4">Engine</th>
                <th class="p-4">Status</th>
                <th class="p-4">Internal Host:Port</th>
                <th class="p-4">Created</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800">
              \${dbs.map(d => \`
                <tr>
                  <td class="p-4 font-bold text-white">\${d.name}</td>
                  <td class="p-4 uppercase text-xs font-semibold text-indigo-300">\${d.type}</td>
                  <td class="p-4"><span class="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400 font-medium">\${d.status}</span></td>
                  <td class="p-4 font-mono text-xs text-gray-300">\${d.containerName}:\${d.port}</td>
                  <td class="p-4 text-gray-400 text-xs">\${new Date(d.createdAt).toLocaleDateString()}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (e) {
        console.error(e);
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

  server.listen(port, () => {
    logger.header('MyPloy Dashboard Online');
    console.log(`  🌐 Local Web UI:    http://localhost:${port}`);
    console.log(`  📡 Target Host:     ${config.user}@${config.host}`);
    console.log(`  📊 Real-time stats & Dokploy-grade management enabled\n`);
  });

  return server;
}
