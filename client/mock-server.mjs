/**
 * 墨圈猎场 · 同图对战 v2 最小 WS mock（协议对齐 WS协议-同图对战-v2.md；保留 v1 击杀/塞敌骨架）
 * 默认端口 8788；环境变量可覆盖数值。
 */
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8788);
const CFG = {
  // same-map v2 defaults (override via env); keep match/WS skeleton intact
  livesN: int('LIVES_N', 1),
  killTargetK: int('KILL_TARGET_K', 30),
  injectCooldownMs: int('INJECT_COOLDOWN_MS', 300),
  injectExtraCap: int('INJECT_EXTRA_CAP', 20),
  injectOverflow: process.env.INJECT_OVERFLOW || 'drop_oldest',
  lagDiff: int('LAG_DIFF', 8),
  lagSpeedBonus: float('LAG_SPEED_BONUS', 0.15),
  reviveMs: int('REVIVE_MS', 5000),
  levelupTimeoutMs: int('LEVELUP_TIMEOUT_MS', 8000),
  heartbeatTimeoutMs: int('HEARTBEAT_TIMEOUT_MS', 30000),
  matchTimeoutMs: int('MATCH_TIMEOUT_MS', 15000),
  tickHz: int('TICK_HZ', 20),
  mode: process.env.BATTLE_MODE || 'shared_map',
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
    levelupTimeoutMs: CFG.levelupTimeoutMs,
    heartbeatTimeoutMs: CFG.heartbeatTimeoutMs,
    matchTimeoutMs: CFG.matchTimeoutMs,
    mode: CFG.mode,
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
console.log(`[mock] listening ws://127.0.0.1:${PORT}  mode=${CFG.mode} K=${CFG.killTargetK} N=${CFG.livesN}`);

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

  if (t === 'input.move') {
    const room = getRoom(player);
    if (!room || room.state !== 'playing') return;
    const rp = room.players.find((p) => p.playerId === player.playerId);
    if (!rp || !rp.alive) return;
    const dx = Number(msg.x);
    const dy = Number(msg.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    rp.inputDx = Math.max(-1, Math.min(1, dx));
    rp.inputDy = Math.max(-1, Math.min(1, dy));
    return;
  }

  if (t === 'input.loop') {
    // mock：按 points 粗略杀己方怪；节点2最小闭环
    applyLoop(player, msg);
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
  // Random red/blue assignment (same-map v2)
  const aTeam = Math.random() < 0.5 ? 'red' : 'blue';
  const bTeam = aTeam === 'red' ? 'blue' : 'red';
  /** @type {Room} */
  const room = {
    roomId,
    state: 'playing',
    seed: s,
    mode: CFG.mode,
    players: [
      makeRP(pa, 0, aTeam),
      makeRP(pb, 1, bTeam),
    ],
    lagBonusOn: null,
    inject: {
      [pa.playerId]: { lastAt: 0, extra: 0, ids: [] },
      [pb.playerId]: { lastAt: 0, extra: 0, ids: [] },
    },
    enemies: [],
    seq: 0,
    tick: null,
  };
  // 最小双方怪，方便节点2同图可见冒烟
  for (const rp of room.players) {
    for (let i = 0; i < 8; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 120 + Math.random() * 280;
      room.enemies.push({
        id: id('e'),
        ownerId: rp.playerId,
        team: rp.team,
        enemyType: i % 5 === 0 ? 'swift' : i % 7 === 0 ? 'watcher' : 'drifter',
        x: rp.x + Math.cos(ang) * rad,
        y: rp.y + Math.sin(ang) * rad,
        hp: 1,
      });
    }
  }
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
      opponent: { playerId: opp.playerId, playerName: opp.playerName, team: opp.team },
      youTeam: you.team,
      seed: s,
      mode: CFG.mode,
    });
    send(rp.ws, {
      type: 'room.start',
      roomId,
      mode: CFG.mode,
      you: { playerId: you.playerId, slot: you.slot, team: you.team, lives: you.lives, kills: 0 },
      opponent: { playerId: opp.playerId, slot: opp.slot, team: opp.team, lives: opp.lives, kills: 0 },
      config: {
        livesN: CFG.livesN,
        killTargetK: CFG.killTargetK,
        levelupTimeoutMs: CFG.levelupTimeoutMs,
        reviveMs: CFG.reviveMs,
      },
      seed: s,
      serverTime: Date.now(),
    });
  }

  const interval = Math.max(16, Math.floor(1000 / CFG.tickHz));
  room.tick = setInterval(() => tickRoom(room), interval);
}

function makeRP(p, slot, team) {
  // slot0 偏左、slot1 偏右，便于同图可见
  const x = slot === 0 ? 1640 : 1960;
  const y = 1800;
  return {
    playerId: p.playerId,
    playerName: p.playerName || '猎人',
    slot,
    team: team || 'red',
    lives: CFG.livesN,
    kills: 0,
    alive: true,
    reviveAt: null,
    speedMul: 1,
    ws: p.ws,
    x,
    y,
    vx: 0,
    vy: 0,
    inputDx: 0,
    inputDy: 0,
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
      team: you.team,
    },
    opponent: {
      kills: opp.kills,
      lives: opp.lives,
      alive: opp.alive,
      reviveAt: opp.reviveAt,
      speedMul: opp.speedMul,
      team: opp.team,
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
  const toPlayer = room.players.find((p) => p.playerId === toId);
  return {
    denied: false,
    event: {
      type: 'combat.inject',
      enemyType,
      to: toId,
      ownerId: toId,
      team: toPlayer ? toPlayer.team : null,
      injectId,
      queued: false,
      // TODO(backend): also push x/y spawn into shared world.snapshot
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

function pointInPoly(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    const hit = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function applyLoop(player, msg) {
  const room = getRoom(player);
  if (!room || room.state !== 'playing') return;
  const killer = room.players.find((p) => p.playerId === player.playerId);
  const victim = room.players.find((p) => p.playerId !== player.playerId);
  if (!killer || !killer.alive) return;
  const points = msg.points;
  if (!Array.isArray(points) || points.length < 3) return;
  const toKill = room.enemies.filter((e) => e.ownerId === killer.playerId && pointInPoly(e.x, e.y, points));
  for (const enemy of toKill) {
    room.enemies = room.enemies.filter((e) => e.id !== enemy.id);
    killer.kills += 1;
    for (const p of room.players) {
      send(p.ws, {
        type: 'combat.kill_ack',
        killerId: killer.playerId,
        enemyId: enemy.id,
        enemyType: enemy.enemyType,
        kills: killer.kills,
      });
    }
    updateLag(room);
    if (killer.kills >= CFG.killTargetK) {
      pushScore(room);
      endRoom(room, 'kill_target', killer.playerId);
      return;
    }
    if (victim) {
      const inj = tryInject(room, killer.playerId, victim.playerId, enemy.enemyType);
      if (inj.denied) {
        send(killer.ws, { type: 'combat.inject_denied', enemyType: enemy.enemyType, reason: inj.reason });
      } else if (inj.event) {
        // 塞敌进共享世界
        if (!inj.event.queued) {
          const ang = Math.random() * Math.PI * 2;
          const rad = 160 + Math.random() * 220;
          room.enemies.push({
            id: inj.event.injectId || id('e'),
            ownerId: victim.playerId,
            team: victim.team,
            enemyType: enemy.enemyType,
            x: victim.x + Math.cos(ang) * rad,
            y: victim.y + Math.sin(ang) * rad,
            hp: 1,
          });
        }
        send(victim.ws, inj.event);
      }
    }
  }
  if (toKill.length) pushScore(room);
}

function buildSnapshot(room) {
  room.seq = (room.seq || 0) + 1;
  updateLag(room);
  return {
    type: 'world.snapshot',
    seq: room.seq,
    serverTime: Date.now(),
    paused: false,
    pauseReason: null,
    players: room.players.map((p) => ({
      playerId: p.playerId,
      team: p.team,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      vx: Math.round((p.vx || 0) * 100) / 100,
      vy: Math.round((p.vy || 0) * 100) / 100,
      alive: p.alive,
      lives: p.lives,
      kills: p.kills,
      speedMul: p.speedMul,
      reviveAt: p.reviveAt,
    })),
    enemies: (room.enemies || []).map((e) => ({
      id: e.id,
      ownerId: e.ownerId,
      team: e.team,
      enemyType: e.enemyType,
      x: Math.round(e.x * 100) / 100,
      y: Math.round(e.y * 100) / 100,
      hp: e.hp,
    })),
  };
}

function tickRoom(room) {
  if (room.state !== 'playing') return;
  const now = Date.now();
  const dt = 1 / CFG.tickHz;

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

  // integrate input.move
  for (const rp of room.players) {
    if (!rp.alive) {
      rp.vx = 0;
      rp.vy = 0;
      continue;
    }
    let dx = rp.inputDx || 0;
    let dy = rp.inputDy || 0;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      dx /= len;
      dy /= len;
    } else {
      dx = 0;
      dy = 0;
    }
    const speed = 220 * (rp.speedMul || 1);
    rp.vx = dx * speed;
    rp.vy = dy * speed;
    rp.x = Math.max(16, Math.min(3600 - 16, rp.x + rp.vx * dt));
    rp.y = Math.max(16, Math.min(3600 - 16, rp.y + rp.vy * dt));
  }

  // broadcast shared world
  const snap = buildSnapshot(room);
  for (const p of room.players) send(p.ws, snap);

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
      you: { kills: you.kills, lives: you.lives, team: you.team },
      opponent: { kills: opp.kills, lives: opp.lives, team: opp.team },
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
