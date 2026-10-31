import http from 'node:http';

const PORT = process.env.PORT || 3000;
const VERSION = process.env.APP_VERSION || '1.0.0';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), version: VERSION }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>MyPloy Deployed App</title>
        <style>
          body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
          .card { text-align: center; padding: 2.5rem; background: #1e293b; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; background: #0284c7; color: white; font-weight: bold; margin-bottom: 1rem; }
          h1 { margin: 0 0 0.5rem; }
          p { color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">v${VERSION}</div>
          <h1>🚀 MyPloy Application Live!</h1>
          <p>Zero-downtime, automated SSL, Docker Compose deployment.</p>
        </div>
      </body>
    </html>
  `);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} (version ${VERSION})`);
});
