/**
 * WebSocket 消息路由（权威入口的连接处理）
 */
import { clientConfig } from './config.js';
import { randomId } from './ids.js';
import { applyKill, applyHit } from './combat.js';
import {
  joinQueue,
  cancelQueue,
  isInQueue,
  leaveOnDisconnect,
} from './matchmaking.js';
import {
  getRoomForPlayer,
  unregisterRoom,
} from './room.js';

/** @typedef {{ playerId: string, playerName: string, ws: import('ws').WebSocket, roomId: string|null }} Client */

/** @type {Map<import('ws').WebSocket, Client>} */
const clients = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function error(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

function dispatchEvents(room, events) {
  room.dispatch(events);
  if (room.state === 'ended') {
    setTimeout(() => unregisterRoom(room), 100);
  }
}

function isBusy(playerId) {
  return isInQueue(playerId) || !!getRoomForPlayer(playerId);
}

function handleMessage(client, msg) {
  const { ws, playerId } = client;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    error(ws, 'bad_payload', '消息格式无效');
    return;
  }

  switch (msg.type) {
    case 'hello':
      return;

    case 'ping': {
      const t = typeof msg.t === 'number' ? msg.t : Date.now();
      send(ws, { type: 'pong', t });
      getRoomForPlayer(playerId)?.touchHeartbeat(playerId);
      return;
    }

    case 'match.join': {
      joinQueue({
        playerId,
        playerName: client.playerName,
        send: (m) => send(ws, m),
        isBusy: () => isBusy(playerId),
        onMatched: (room) => {
          client.roomId = room.roomId;
        },
        onTimeout: () => {},
      });
      return;
    }

    case 'match.cancel': {
      cancelQueue(playerId, (m) => send(ws, m));
      return;
    }

    case 'combat.kill': {
      const room = getRoomForPlayer(playerId);
      if (!room) {
        error(ws, 'not_in_room', '不在房间中');
        return;
      }
      if (room.state !== 'playing') {
        error(ws, 'room_ended', '房间已结束');
        return;
      }
      room.touchHeartbeat(playerId);
      const result = applyKill(room, playerId, msg);
      if (!result.ok) {
        error(ws, result.error || 'bad_payload', result.error || '击杀无效');
        return;
      }
      dispatchEvents(room, result.events);
      return;
    }

    case 'combat.hit': {
      const room = getRoomForPlayer(playerId);
      if (!room) {
        error(ws, 'not_in_room', '不在房间中');
        return;
      }
      if (room.state !== 'playing') {
        error(ws, 'room_ended', '房间已结束');
        return;
      }
      room.touchHeartbeat(playerId);
      const result = applyHit(room, playerId, msg);
      if (!result.ok) {
        error(ws, result.error || 'bad_payload', result.error || '受击无效');
        return;
      }
      dispatchEvents(room, result.events);
      return;
    }

    case 'meta.levelup': {
      send(ws, { type: 'meta.levelup', level: msg.level, choiceId: msg.choiceId });
      return;
    }

    default:
      error(ws, 'bad_payload', `未知消息类型: ${msg.type}`);
  }
}

function onDisconnect(client) {
  const { playerId, ws } = client;
  leaveOnDisconnect(playerId);
  const room = getRoomForPlayer(playerId);
  if (room && room.state === 'playing') {
    const opp = room.getOpponent(playerId);
    const events = room.end('opponent_disconnect', opp?.playerId ?? null, playerId);
    dispatchEvents(room, events);
  }
  clients.delete(ws);
}

/** 挂到一条新连接上 */
export function attachConnection(ws) {
  /** @type {Client|null} */
  let client = null;
  const helloTimer = setTimeout(() => {
    if (!client) {
      error(ws, 'bad_payload', '请先发送 hello');
      ws.close();
    }
  }, 10000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      error(ws, 'bad_payload', 'JSON 解析失败');
      return;
    }

    if (!client) {
      if (!msg || msg.type !== 'hello') {
        error(ws, 'bad_payload', '连接后须先发送 hello');
        return;
      }
      clearTimeout(helloTimer);
      const playerId = randomId('p');
      const playerName =
        typeof msg.playerName === 'string' ? msg.playerName.slice(0, 32) : '';
      client = { playerId, playerName, ws, roomId: null };
      clients.set(ws, client);
      send(ws, { type: 'welcome', playerId, config: clientConfig() });
      return;
    }

    handleMessage(client, msg);
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (client) onDisconnect(client);
  });

  ws.on('error', () => {});
}
