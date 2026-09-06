/**
 * 墨圈猎场 · 节点2 最小 WS mock（协议对齐 WS协议-对战.md）
 * 默认端口 8787；环境变量可覆盖数值。
 */
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const CFG = {
  livesN: int('LIVES_N', 3),
  killTargetK: int('KILL_TARGET_K', 30),
  injectCooldownMs: int('INJECT_COOLDOWN_MS', 300),
  injectExtraCap: int('INJECT_EXTRA_CAP', 20),
  injectOverflow: process.env.INJECT_OVERFLOW || 'drop_oldest',
  lagDiff: int('LAG_DIFF', 8),
  lagSpeedBonus: float('LAG_SPEED_BONUS', 0.15),
  reviveMs: int('REVIVE_MS', 5000),
  heartbeatTimeoutMs: int('HEARTBEAT_TIMEOUT_MS', 30000),
  matchTimeoutMs: int('MATCH_TIMEOUT_MS', 15000),
  tickHz: int('TICK_HZ', 20),
};

function int(n, d) {
  const v = process.env[n];
  if (v === undefined || v === '') return d;
  const x = Number.parseInt(v, 10);
  return Number.isFinite(x) ? x : d;
}
function float(n, d) {
  const v = process.env[n];
  if (v === undefined || v === '') return d;
  const x = Number.parseFloat(v);
  return Number.isFinite(x) ? x : d;
}
function id(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}
function seed() {
  return randomBytes(4).readUInt32BE(0);
}
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function clientCfg() {
  return {
    livesN: CFG.livesN,
    killTargetK: CFG.killTargetK,
    injectCooldownMs: CFG.injectCooldownMs,
    injectExtraCap: CFG.injectExtraCap,
    lagDiff: CFG.lagDiff,
    lagSpeedBonus: CFG.lagSpeedBonus,
    reviveMs: CFG.reviveMs,
    heartbeatTimeoutMs: CFG.heartbeatTimeoutMs,
    matchTimeoutMs: CFG.matchTimeoutMs,
  };
}

/** @type {Map<import('ws').WebSocket, Player>} */
const clients = new Map();
/** @type {QueueEntry[]} */
const queue = [];
/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {{
 *   ws: import('ws').WebSocket,
 *   playerId: string,
 *   playerName: string,
 *   roomId: string|null,
 *   lastHeartbeat: number,
 * }} Player
 */

/**
 * @typedef {{
 *   player: Player,
 *   timer: NodeJS.Timeout,
 * }} QueueEntry
 */

/**
 * @typedef {{
 *   roomId: string,
 *   state: 'playing'|'ended',
 *   seed: number,
 *   players: RoomPlayer[],
 *   lagBonusOn: string|null,
 *   inject: Record<string,{lastAt:number,extra:number,ids:string[]}>,
 *   tick: NodeJS.Timeout|null,
 * }} Room
 *
 * @typedef {{
 *   playerId: string,
 *   playerName: string,
 *   slot: number,
 *   lives: number,
 *   kills: number,
 *   alive: boolean,
 *   reviveAt: number|null,
 *   speedMul: number,
 *   ws: import('ws').WebSocket,
 * }} RoomPlayer
 */

const VALID = new Set(['drifter', 'swift', 'watcher']);

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });
console.log(`[mock] listening ws://127.0.0.1:${PORT}  K=${CFG.killTargetK} N=${CFG.livesN}`);

wss.on('connection', (ws) => {
  const player = {
    ws,
    playerId: id('p'),
    playerName: '',
    roomId: null,
    lastHeartbeat: Date.now(),
  };
  clients.set(ws, player);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { type: 'error', code: 'bad_payload', message: 'invalid json' });
      return;
    }
    handle(player, msg);
  });

  ws.on('close', () => {
    onDisconnect(player);
    clients.delete(ws);
  });
});

function handle(player, msg) {
  const t = msg?.type;
  player.lastHeartbeat = Date.now();

  if (t === 'hello') {
    player.playerName = String(msg.playerName || '').slice(0, 24) || '猎人';
    send(player.ws, {
      type: 'welcome',
      playerId: player.playerId,
      config: clientCfg(),
    });
    return;
  }

  if (t === 'ping') {
    send(player.ws, { type: 'pong', t: msg.t ?? Date.now() });
    return;
  }

  if (t === 'match.join') {
    if (player.roomId || queue.some((q) => q.player.playerId === player.playerId)) {
      send(player.ws, { type: 'error', code: 'already_matched', message: '已在队列或房间中' });
      return;
    }
    const timer = setTimeout(() => {
      const idx = queue.findIndex((q) => q.player.playerId === player.playerId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        send(player.ws, { type: 'match.timeout' });
      }
    }, CFG.matchTimeoutMs);
    queue.push({ player, timer });
    send(player.ws, { type: 'match.queued', timeoutMs: CFG.matchTimeoutMs });
    tryMatch();
    return;
  }

  if (t === 'match.cancel') {
    const idx = queue.findIndex((q) => q.player.playerId === player.playerId);
    if (idx < 0) {
      send(player.ws, { type: 'error', code: 'not_in_queue', message: '不在匹配队列' });
      return;
    }
    clearTimeout(queue[idx].timer);
    queue.splice(idx, 1);
    return;
  }

  if (t === 'combat.kill') {
    applyKill(player, msg);
    return;
  }

  if (t === 'combat.hit') {
    applyHit(player, msg);
    return;
  }

  if (t === 'meta.levelup') {
    // MVP ignore / optional echo
    return;
  }
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    clearTimeout(a.timer);
    clearTimeout(b.timer);
    createRoom(a.player, b.player);
  }
}

function createRoom(pa, pb) {
  const roomId = id('r');
  const s = seed();
  /** @type {Room} */
  const room = {
    roomId,
    state: 'playing',
    seed: s,
    players: [
      makeRP(pa, 0),
      makeRP(pb, 1),
    ],
    lagBonusOn: null,
    inject: {
      [pa.playerId]: { lastAt: 0, extra: 0, ids: [] },
      [pb.playerId]: { lastAt: 0, extra: 0, ids: [] },
    },
    tick: null,
  };
  rooms.set(roomId, room);
  pa.roomId = roomId;
  pb.roomId = roomId;

  for (const rp of room.players) {
    const you = rp;
    const opp = room.players.find((p) => p.playerId !== you.playerId);
    send(rp.ws, {
      type: 'match.found',
      roomId,
      you: you.playerId,
      opponent: { playerId: opp.playerId, playerName: opp.playerName },
      seed: s,
    });
    send(rp.ws, {
      type: 'room.start',
      roomId,
      you: { playerId: you.playerId, slot: you.slot, lives: you.lives, kills: 0 },
      opponent: { playerId: opp.playerId, slot: opp.slot, lives: opp.lives, kills: 0 },
      config: { livesN: CFG.livesN, killTargetK: CFG.killTargetK },
      serverTime: Date.now(),
    });
  }

  const interval = Math.max(16, Math.floor(1000 / CFG.tickHz));
  room.tick = setInterval(() => tickRoom(room), interval);
}

function makeRP(p, slot) {
  return {
    playerId: p.playerId,
    playerName: p.playerName || '猎人',
    slot,
    lives: CFG.livesN,
    kills: 0,
    alive: true,
    reviveAt: null,
    speedMul: 1,
    ws: p.ws,
  };
}

function getRoom(player) {
  if (!player.roomId) return null;
  return rooms.get(player.roomId) || null;
}

function scorePayload(room, viewerId) {
  const you = room.players.find((p) => p.playerId === viewerId);
  const opp = room.players.find((p) => p.playerId !== viewerId);
  let lagBonusOn = null;
  if (room.lagBonusOn === viewerId) lagBonusOn = 'you';
  else if (room.lagBonusOn === opp.playerId) lagBonusOn = 'opponent';
  return {
    type: 'room.score',
    you: {
      kills: you.kills,
      lives: you.lives,
      alive: you.alive,
      reviveAt: you.reviveAt,
      speedMul: you.speedMul,
    },
    opponent: {
      kills: opp.kills,
      lives: opp.lives,
      alive: opp.alive,
      reviveAt: opp.reviveAt,
      speedMul: opp.speedMul,
    },
    lagBonusOn,
  };
}

function pushScore(room) {
  for (const p of room.players) send(p.ws, scorePayload(room, p.playerId));
}

function updateLag(room) {
  const [a, b] = room.players;
  const diff = a.kills - b.kills;
  if (Math.abs(diff) < CFG.lagDiff) {
    a.speedMul = 1;
    b.speedMul = 1;
    room.lagBonusOn = null;
    return;
  }
  if (diff >= CFG.lagDiff) {
    a.speedMul = 1;
    b.speedMul = 1 + CFG.lagSpeedBonus;
    room.lagBonusOn = b.playerId;
  } else {
    b.speedMul = 1;
    a.speedMul = 1 + CFG.lagSpeedBonus;
    room.lagBonusOn = a.playerId;
  }
}

function applyKill(player, msg) {
  const room = getRoom(player);
  if (!room || room.state !== 'playing') {
    send(player.ws, { type: 'error', code: 'not_in_room', message: '不在对局中' });
    return;
  }
  const enemyType = msg.enemyType;
  if (!VALID.has(enemyType)) {
    send(player.ws, { type: 'error', code: 'bad_payload', message: 'bad enemyType' });
    return;
  }
  const killer = room.players.find((p) => p.playerId === player.playerId);
  const victim = room.players.find((p) => p.playerId !== player.playerId);
  if (!killer || !victim) return;

  killer.kills += 1;
  updateLag(room);

  if (killer.kills >= CFG.killTargetK) {
    pushScore(room);
    endRoom(room, 'kill_target', killer.playerId);
    return;
  }

  // inject to opponent
  const inj = tryInject(room, killer.playerId, victim.playerId, enemyType);
  pushScore(room);
  if (inj.denied) {
    send(killer.ws, {
      type: 'combat.inject_denied',
      enemyType,
      reason: inj.reason,
    });
  } else if (inj.event) {
    send(victim.ws, inj.event);
  }
}

function tryInject(room, fromId, toId, enemyType) {
  const now = Date.now();
  const st = room.inject[fromId];
  if (now - st.lastAt < CFG.injectCooldownMs) {
    return { denied: true, reason: 'cooldown' };
  }
  if (st.extra >= CFG.injectExtraCap) {
    if (CFG.injectOverflow === 'reject') {
      return { denied: true, reason: 'cap' };
    }
    if (CFG.injectOverflow === 'drop_oldest') {
      st.ids.shift();
      st.extra = Math.max(0, st.extra - 1);
    } else {
      // queue — still mark as queued event
      const injectId = id('inj');
      st.lastAt = now;
      return {
        denied: false,
        event: {
          type: 'combat.inject',
          enemyType,
          to: toId,
          injectId,
          queued: true,
        },
      };
    }
  }
  const injectId = id('inj');
  st.lastAt = now;
  st.extra += 1;
  st.ids.push(injectId);
  return {
    denied: false,
    event: {
      type: 'combat.inject',
      enemyType,
      to: toId,
      injectId,
      queued: false,
    },
  };
}

function applyHit(player, msg) {
  const room = getRoom(player);
  if (!room || room.state !== 'playing') {
    send(player.ws, { type: 'error', code: 'not_in_room', message: '不在对局中' });
    return;
  }
  const rp = room.players.find((p) => p.playerId === player.playerId);
  if (!rp || !rp.alive) return;

  const dmg = Math.max(1, Number(msg.damageLives) || 1);
  rp.lives = Math.max(0, rp.lives - dmg);
  if (rp.lives <= 0) {
    rp.alive = false;
    rp.reviveAt = Date.now() + CFG.reviveMs;
    pushScore(room);
    for (const p of room.players) {
      send(p.ws, {
        type: 'combat.down',
        playerId: rp.playerId,
        reviveAt: rp.reviveAt,
      });
    }
  } else {
    pushScore(room);
  }
}

function tickRoom(room) {
  if (room.state !== 'playing') return;
  const now = Date.now();

  // revive
  for (const rp of room.players) {
    if (!rp.alive && rp.reviveAt && now >= rp.reviveAt) {
      rp.alive = true;
      rp.lives = CFG.livesN;
      rp.reviveAt = null;
      for (const p of room.players) {
        send(p.ws, {
          type: 'combat.revive',
          playerId: rp.playerId,
          lives: CFG.livesN,
        });
      }
      pushScore(room);
    }
  }

  // heartbeat disconnect
  for (const rp of room.players) {
    if (now - (clients.get(rp.ws)?.lastHeartbeat || 0) > CFG.heartbeatTimeoutMs) {
      const winner = room.players.find((p) => p.playerId !== rp.playerId);
      endRoom(room, 'opponent_disconnect', winner?.playerId || null);
      return;
    }
  }
}

function endRoom(room, reason, winnerId) {
  if (room.state === 'ended') return;
  room.state = 'ended';
  if (room.tick) {
    clearInterval(room.tick);
    room.tick = null;
  }
  for (const rp of room.players) {
    const you = rp;
    const opp = room.players.find((p) => p.playerId !== you.playerId);
    let r = reason;
    if (reason === 'opponent_disconnect') {
      // viewer perspective: if winner is you, opponent disconnected; else you_disconnect
      r = winnerId === you.playerId ? 'opponent_disconnect' : 'you_disconnect';
    }
    send(rp.ws, {
      type: 'room.end',
      reason: r,
      winnerId,
      you: { kills: you.kills, lives: you.lives },
      opponent: { kills: opp.kills, lives: opp.lives },
    });
    const pl = clients.get(rp.ws);
    if (pl) pl.roomId = null;
  }
  rooms.delete(room.roomId);
}

function onDisconnect(player) {
  const qi = queue.findIndex((q) => q.player.playerId === player.playerId);
  if (qi >= 0) {
    clearTimeout(queue[qi].timer);
    queue.splice(qi, 1);
  }
  const room = getRoom(player);
  if (room && room.state === 'playing') {
    const winner = room.players.find((p) => p.playerId !== player.playerId);
    endRoom(room, 'opponent_disconnect', winner?.playerId || null);
  }
}
