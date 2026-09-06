/**
 * 墨圈猎场 · 权威对战 WebSocket 服务入口
 */
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { attachConnection } from './ws-handler.js';

function createServer(port = config.port) {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    attachConnection(ws);
  });

  wss.on('listening', () => {
    console.log(
      `[moquan-battle] ws://0.0.0.0:${port}  K=${config.killTargetK}  heartbeat=${config.heartbeatTimeoutMs}ms  matchTimeout=${config.matchTimeoutMs}ms`,
    );
  });

  wss.on('error', (err) => {
    console.error('[moquan-battle] server error', err);
    process.exit(1);
  });

  return wss;
}

const wss = createServer();

function shutdown() {
  console.log('[moquan-battle] shutting down…');
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { createServer };
