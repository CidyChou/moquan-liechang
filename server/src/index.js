/**
 * 墨圈猎场 · 同图对战 v2 权威 WebSocket 服务入口
 * 默认端口 8788（避免与 v1 8787 冲突）
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
      `[moquan-battle-v2] shared_map ws://0.0.0.0:${port}  K=${config.killTargetK}  lives=${config.livesN}  tickHz=${config.tickHz}  levelupTimeout=${config.levelupTimeoutMs}ms`,
    );
  });

  wss.on('error', (err) => {
    console.error('[moquan-battle-v2] server error', err);
    process.exit(1);
  });

  return wss;
}

const wss = createServer();

function shutdown() {
  console.log('[moquan-battle-v2] shutting down…');
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { createServer };
