/**
 * 权威战斗裁决：击杀→塞敌、冷却/上限、受击/倒地/复活、落后补偿
 */
import { config } from './config.js';
import { randomId } from './ids.js';

const VALID_ENEMY = new Set(['drifter', 'swift', 'watcher']);

/**
 * @param {import('./room.js').Room} room
 * @param {string} killerId
 * @param {{ enemyType: string, enemyId?: string, seq?: number }} payload
 * @returns {{ ok: boolean, error?: string, events: object[] }}
 */
export function applyKill(room, killerId, payload) {
  const events = [];
  if (room.state !== 'playing') {
    return { ok: false, error: 'room_ended', events };
  }

  const enemyType = payload?.enemyType;
  if (!VALID_ENEMY.has(enemyType)) {
    return { ok: false, error: 'bad_payload', events };
  }

  const killer = room.getPlayer(killerId);
  const victim = room.getOpponent(killerId);
  if (!killer || !victim) {
    return { ok: false, error: 'not_in_room', events };
  }

  killer.kills += 1;

  // 落后补偿（基于击杀分差）
  updateLagBonus(room);

  // 先检查胜负
  if (killer.kills >= config.killTargetK) {
    events.push(...room.buildScoreEvents());
    const endEvents = room.end('kill_target', killerId);
    events.push(...endEvents);
    return { ok: true, events };
  }

  // 尝试塞敌给对手
  const injectResult = tryInject(room, killerId, victim.playerId, enemyType);
  events.push(...room.buildScoreEvents());
  if (injectResult.denied) {
    events.push({
      type: 'combat.inject_denied',
      enemyType,
      reason: injectResult.reason,
      _to: killerId, // 仅发给击杀方
    });
  } else if (injectResult.event) {
    events.push(injectResult.event);
  }

  return { ok: true, events };
}

/**
 * @param {import('./room.js').Room} room
 * @param {string} fromId - 击杀方
 * @param {string} toId - 对手
 * @param {string} enemyType
 */
function tryInject(room, fromId, toId, enemyType) {
  const now = Date.now();
  const st = room.injectState[fromId];
  if (!st) {
    return { denied: true, reason: 'reject' };
  }

  if (now - st.lastInjectAt < config.injectCooldownMs) {
    return { denied: true, reason: 'cooldown' };
  }

  const extraCount = st.extraOnOpponent;
  const overflow = config.injectOverflow;

  if (extraCount >= config.injectExtraCap) {
    if (overflow === 'reject') {
      return { denied: true, reason: 'cap' };
    }
    if (overflow === 'queue') {
      st.queue.push(enemyType);
      st.lastInjectAt = now;
      const injectId = randomId('inj');
      return {
        denied: false,
        event: {
          type: 'combat.inject',
          enemyType,
          to: toId,
          injectId,
          queued: true,
          _to: toId,
        },
      };
    }
    // drop_oldest：丢弃最旧的一条额外怪计数位，仍塞新怪
    if (st.extraIds.length > 0) {
      st.extraIds.shift();
      st.extraOnOpponent = Math.max(0, st.extraOnOpponent - 1);
    } else if (st.extraOnOpponent > 0) {
      st.extraOnOpponent -= 1;
    }
  }

  st.lastInjectAt = now;
  st.extraOnOpponent += 1;
  const injectId = randomId('inj');
  st.extraIds.push(injectId);

  return {
    denied: false,
    event: {
      type: 'combat.inject',
      enemyType,
      to: toId,
      injectId,
      queued: false,
      _to: toId,
    },
  };
}

/**
 * 对手击杀了注入怪时可选回收配额（MVP：前端不回报消化，
 * 用 drop_oldest / 简单计数即可；提供 API 供 room tick 或外部调用）
 */
export function releaseInjectSlot(room, injectorId, injectId) {
  const st = room.injectState[injectorId];
  if (!st) return;
  const idx = st.extraIds.indexOf(injectId);
  if (idx >= 0) {
    st.extraIds.splice(idx, 1);
    st.extraOnOpponent = Math.max(0, st.extraOnOpponent - 1);
  }
}

/**
 * @param {import('./room.js').Room} room
 * @param {string} playerId
 * @param {{ damageLives?: number, seq?: number }} payload
 */
export function applyHit(room, playerId, payload) {
  const events = [];
  if (room.state !== 'playing') {
    return { ok: false, error: 'room_ended', events };
  }

  const p = room.getPlayer(playerId);
  if (!p) return { ok: false, error: 'not_in_room', events };
  if (!p.alive) {
    // 倒地期间忽略额外 hit
    return { ok: true, events };
  }

  const dmg = Number.isFinite(payload?.damageLives) ? Math.max(1, Math.floor(payload.damageLives)) : 1;
  p.lives = Math.max(0, p.lives - dmg);

  if (p.lives <= 0) {
    p.alive = false;
    p.reviveAt = Date.now() + config.reviveMs;
    events.push(...room.buildScoreEvents());
    events.push({
      type: 'combat.down',
      playerId: p.playerId,
      reviveAt: p.reviveAt,
    });
  } else {
    events.push(...room.buildScoreEvents());
  }

  return { ok: true, events };
}

/** 检查并执行到期复活 */
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

export function updateLagBonus(room) {
  const [a, b] = room.players;
  if (!a || !b) return;

  const diff = a.kills - b.kills;
  if (Math.abs(diff) >= config.lagDiff) {
    if (diff > 0) {
      // a 领先 → b 获得补偿
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
