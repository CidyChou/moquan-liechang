/**
 * FIFO 1v1 匹配队列
 */
import { config } from './config.js';
import { Room, registerRoom, unregisterRoom } from './room.js';

/** @type {any[]} */
const queue = [];

export function joinQueue(opts) {
  const { playerId, playerName, send, onMatched, onTimeout, isBusy } = opts;

  if (isBusy()) {
    send({ type: 'error', code: 'already_matched', message: '已在队列或房间中' });
    return false;
  }

  if (queue.some((e) => e.playerId === playerId)) {
    send({ type: 'error', code: 'already_matched', message: '已在匹配队列' });
    return false;
  }

  const entry = {
    playerId,
    playerName: playerName || '',
    send,
    joinedAt: Date.now(),
    timeoutTimer: null,
    onMatched,
    onTimeout,
  };

  entry.timeoutTimer = setTimeout(() => {
    const idx = queue.findIndex((e) => e.playerId === playerId);
    if (idx >= 0) {
      queue.splice(idx, 1);
      send({ type: 'match.timeout' });
      onTimeout?.();
    }
  }, config.matchTimeoutMs);

  queue.push(entry);
  send({ type: 'match.queued', timeoutMs: config.matchTimeoutMs });

  tryMatch();
  return true;
}

export function cancelQueue(playerId, send) {
  const idx = queue.findIndex((e) => e.playerId === playerId);
  if (idx < 0) {
    send?.({ type: 'error', code: 'not_in_queue', message: '不在匹配队列' });
    return false;
  }
  const [entry] = queue.splice(idx, 1);
  if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
  return true;
}

export function isInQueue(playerId) {
  return queue.some((e) => e.playerId === playerId);
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (a.timeoutTimer) clearTimeout(a.timeoutTimer);
    if (b.timeoutTimer) clearTimeout(b.timeoutTimer);

    const room = new Room([
      { playerId: a.playerId, playerName: a.playerName, send: a.send },
      { playerId: b.playerId, playerName: b.playerName, send: b.send },
    ]);
    registerRoom(room);

    room.dispatch(room.buildMatchFoundEvents());
    room.dispatch(room.buildStartEvents());
    // 立刻推一帧世界，方便客户端/smoke 不等第一个 tick
    room.dispatch([room.buildSnapshot()]);

    room.startTick((events) => {
      room.dispatch(events);
      if (room.state === 'ended') {
        setTimeout(() => unregisterRoom(room), 100);
      }
    });

    a.onMatched?.(room);
    b.onMatched?.(room);
  }
}

export function leaveOnDisconnect(playerId) {
  cancelQueue(playerId, null);
}
