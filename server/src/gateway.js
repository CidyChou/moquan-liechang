/**
 * 统一入口：静态 H5 + WebSocket（同端口，利于单条公网隧道）
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { attachConnection } from './ws-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = process.env.STATIC_ROOT || path.resolve(__dirname, '../../client');
const PORT = Number(process.env.GATEWAY_PORT || process.env.PORT || 8790);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent((reqPath || '/').split('?')[0]);
  let rel = decoded === '/' ? '/battle.html' : decoded;
  if (rel === '/battle') rel = '/battle.html';
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(path.normalize(root + path.sep)) && full !== path.normalize(root)) {
    return null;
  }
  return full;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const filePath = safeJoin(STATIC_ROOT, req.url || '/');
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    sendFile(res, filePath);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => attachConnection(ws));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[moquan-gateway] http://0.0.0.0:${PORT}  static=${STATIC_ROOT}  K=${config.killTargetK}`);
});

function shutdown() {
  console.log('[moquan-gateway] shutting down…');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
