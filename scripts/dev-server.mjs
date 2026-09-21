#!/usr/bin/env node
// Dev server with no-store cache headers so file edits are always reflected
// immediately. Usage: node scripts/dev-server.mjs [port]  (default 8420)
import { createServer } from 'http';
import { createReadStream, statSync } from 'fs';
import { join, extname, resolve } from 'path';
import { fileURLToPath } from 'url';

const PORT = parseInt(process.argv[2] || '8420', 10);
const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = url.pathname;
  if (pathname.endsWith('/')) pathname += 'index.html';

  const abs = join(ROOT, pathname);
  if (!abs.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try { stat = statSync(abs); } catch {
    res.writeHead(404).end('Not found');
    return;
  }

  if (stat.isDirectory()) {
    res.writeHead(301, { Location: pathname + '/' }).end();
    return;
  }

  const ext = extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });

  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(abs).pipe(res);
}).listen(PORT, () => {
  console.log(`Country Explorer  →  http://localhost:${PORT}/`);
});
