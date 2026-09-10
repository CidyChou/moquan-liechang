/**
 * 同图权威战斗：圈杀己方怪 → 塞敌归属对面、受击/倒地/复活、落后补偿、升级暂停
 */
import { config } from './config.js';
import { randomId } from './ids.js';

const VALID_ENEMY = new Set(['drifter', 'swift', 'watcher']);
const LEVELUP_OPTIONS = [
  { id: 'hp', label: '生命', desc: '额外韧性' },
  { id: 'spd', label: '速度', desc: '移速提升' },
  { id: 'dmg', label: '伤害', desc: '圈杀更强' },
];

export { VALID_ENEMY, LEVELUP_OPTIONS };

/** 射线法点是否在多边形内 */
export function pointInPolygon(x, y, points) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = Number(points[i][0]);
    const yi = Number(points[i][1]);
    const xj = Number(points[j][0]);
    const yj = Number(points[j][1]);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      continue;
    }
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function updateLagBonus(room) {
  const [a, b] = room.players;
  if (!a || !b) return;

  const diff = a.kills - b.kills;
  if (Math.abs(diff) >= config.lagDiff) {
    if (diff > 0) {
      a.speedMul = 1;
      b.speedMul = 1 + config.lagSpeedBonus;
      room.lagBonusOn = b.playerId;
    } else {
      b.speedMul = 1;
      a.speedMul = 1 + config.lagSpeedBonus;
      room.lagBonusOn = a.playerId;
    }
  } else {
    a.speedMul = 1;
    b.speedMul = 1;
    room.lagBonusOn = null;
  }
}

/**
 * input.loop：仅杀己方归属怪
 */
export function applyLoop(room, killerId, payload) {
  const events = [];
  if (room.state !== 'playing') {
    return { ok: false, error: 'room_ended', events };
  }
  if (room.paused) {
    return { ok: true, events }; // 暂停时忽略
  }

  const killer = room.getPlayer(killerId);
  if (!killer) return { ok: false, error: 'not_in_room', events };
  if (!killer.alive) return { ok: true, events };

  const points = payload?.points;
  if (!Array.isArray(points) || points.length < 3) {
    return { ok: false, error: 'bad_payload', events };
  }

  const victim = room.getOpponent(killerId);
  const toKill = room.enemies.filter(
    (e) => e.ownerId === killerId && pointInPolygon(e.x, e.y, points),
  );

  for (const enemy of toKill) {
    room.removeEnemy(enemy.id);
    killer.kills += 1;

    events.push({
      type: 'combat.kill_ack',
      killerId,
      enemyId: enemy.id,
      enemyType: enemy.enemyType,
      kills: killer.kills,
    });

    updateLagBonus(room);

    if (killer.kills >= config.killTargetK) {
      events.push(...room.buildScoreEvents());
      events.push(...room.end('kill_target', killerId));
      return { ok: true, events };
    }

    if (victim) {
      const injectResult = tryInject(room, killerId, victim, enemy.enemyType);
      if (injectResult.denied) {
        events.push({
          type: 'combat.inject_denied',
          enemyType: enemy.enemyType,
          reason: injectResult.reason,
          _to: killerId,
        });
      } else if (injectResult.event) {
        events.push(injectResult.event);
      }
    }
  }

  if (toKill.length) {
    events.push(...room.buildScoreEvents());
  }

  return { ok: true, events };
}

function tryInject(room, fromId, victim, enemyType) {
  const now = Date.now();
  const st = room.injectState[fromId];
  if (!st) return { denied: true, reason: 'reject' };

  if (now - st.lastInjectAt < config.injectCooldownMs) {
    return { denied: true, reason: 'cooldown' };
  }

  if (st.extraOnOpponent >= config.injectExtraCap) {
    if (config.injectOverflow === 'reject') {
      return { denied: true, reason: 'cap' };
    }
    if (config.injectOverflow === 'drop_oldest') {
      if (st.extraIds.length > 0) {
        const oldId = st.extraIds.shift();
        room.removeEnemy(oldId);
        st.extraOnOpponent = Math.max(0, st.extraOnOpponent - 1);
      } else if (st.extraOnOpponent > 0) {
        st.extraOnOpponent -= 1;
      }
    }
  }

  st.lastInjectAt = now;
  st.extraOnOpponent += 1;

  const injectId = randomId('inj');
  const pos = room.spawnNear(victim);
  const enemy = room.addEnemy({
    id: injectId,
    ownerId: victim.playerId,
    team: victim.team,
    enemyType,
    x: pos.x,
    y: pos.y,
    hp: 1,
    injected: true,
  });
  st.extraIds.push(enemy.id);

  return {
    denied: false,
    event: {
      type: 'combat.inject',
      enemyType,
      to: victim.playerId,
      ownerId: victim.playerId,
      team: victim.team,
      injectId: enemy.id,
      x: enemy.x,
      y: enemy.y,
    },
  };
}

export function applyHit(room, playerId, payload) {
  const events = [];
  if (room.state !== 'playing') {
    return { ok: false, error: 'room_ended', events };
  }

  const p = room.getPlayer(playerId);
  if (!p) return { ok: false, error: 'not_in_room', events };
  if (!p.alive) return { ok: true, events };

  const dmg = Number.isFinite(payload?.damageLives)
    ? Math.max(1, Math.floor(payload.damageLives))
    : 1;
  p.lives = Math.max(0, p.lives - dmg);

  if (p.lives <= 0) {
    p.alive = false;
    p.vx = 0;
    p.vy = 0;
    p.reviveAt = Date.now() + config.reviveMs;
    events.push({
      type: 'combat.hit',
      playerId: p.playerId,
      lives: p.lives,
    });
    events.push({
      type: 'combat.down',
      playerId: p.playerId,
      reviveAt: p.reviveAt,
    });
    events.push(...room.buildScoreEvents());
  } else {
    events.push({
      type: 'combat.hit',
      playerId: p.playerId,
      lives: p.lives,
    });
    events.push(...room.buildScoreEvents());
  }

  return { ok: true, events };
}

export function tickRevives(room, now = Date.now()) {
  const events = [];
  if (room.state !== 'playing') return events;

  for (const p of room.players) {
    if (!p.alive && p.reviveAt != null && now >= p.reviveAt) {
      p.alive = true;
      p.lives = config.livesN;
      p.reviveAt = null;
      events.push({
        type: 'combat.revive',
        playerId: p.playerId,
        lives: p.lives,
      });
      events.push(...room.buildScoreEvents());
    }
  }
  return events;
}

/** 发起升级三选一：双方暂停 */
export function startLevelup(room, forPlayerId) {
  const events = [];
  if (room.state !== 'playing' || room.paused) {
    return { ok: false, error: 'busy', events };
  }
  const p = room.getPlayer(forPlayerId);
  if (!p) return { ok: false, error: 'not_in_room', events };

  const deadline = Date.now() + config.levelupTimeoutMs;
  room.paused = true;
  room.pauseReason = 'levelup';
  room.levelup = {
    forPlayerId,
    options: LEVELUP_OPTIONS.map((o) => ({ ...o })),
    deadline,
    resolved: false,
  };

  events.push({
    type: 'levelup.offer',
    forPlayerId,
    options: room.levelup.options,
    deadline,
    timeoutMs: config.levelupTimeoutMs,
  });
  events.push({
    type: 'world.pause',
    reason: 'levelup',
    forPlayerId,
    deadline,
  });

  room._levelupTimer = setTimeout(() => {
    if (!room.levelup || room.levelup.resolved) return;
    const pick = LEVELUP_OPTIONS[Math.floor(Math.random() * LEVELUP_OPTIONS.length)];
    const resolved = resolveLevelup(room, forPlayerId, pick.id, true);
    room.dispatch(resolved.events);
  }, config.levelupTimeoutMs);

  return { ok: true, events };
}

export function resolveLevelup(room, forPlayerId, optionId, auto = false) {
  const events = [];
  if (!room.levelup || room.levelup.resolved) {
    return { ok: false, error: 'no_levelup', events };
  }
  if (room.levelup.forPlayerId !== forPlayerId) {
    return { ok: false, error: 'not_your_levelup', events };
  }

  const valid = room.levelup.options.some((o) => o.id === optionId);
  const finalId = valid
    ? optionId
    : room.levelup.options[Math.floor(Math.random() * room.levelup.options.length)].id;

  room.levelup.resolved = true;
  if (room._levelupTimer) {
    clearTimeout(room._levelupTimer);
    room._levelupTimer = null;
  }

  // 简版：spd 立即加成
  const p = room.getPlayer(forPlayerId);
  if (p && finalId === 'spd') {
    p.levelSpeedBonus = (p.levelSpeedBonus || 0) + 0.1;
  }

  events.push({
    type: 'levelup.resolved',
    forPlayerId,
    optionId: finalId,
    auto: !!auto,
  });

  room.paused = false;
  room.pauseReason = null;
  room.levelup = null;

  events.push({ type: 'world.resume' });
  return { ok: true, events };
}
