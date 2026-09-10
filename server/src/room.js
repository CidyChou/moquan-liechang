/**
 * 同图权威房间：共享世界、阵营、tick 广播 world.snapshot
 */
import { config, roomStartConfig } from './config.js';
import { randomId, randomSeed } from './ids.js';
import { tickRevives, updateLagBonus, VALID_ENEMY } from './combat.js';

const TEAMS = ['red', 'blue'];
const ENEMY_TYPES = ['drifter', 'swift', 'watcher'];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function shuffleTeams() {
  return Math.random() < 0.5 ? ['red', 'blue'] : ['blue', 'red'];
}

export class Room {
  /**
   * @param {{ playerId: string, playerName: string, send: Function }[]} players
   */
  constructor(players) {
    this.roomId = randomId('r');
    this.mode = 'shared_map';
    this.state = 'playing';
    this.seed = randomSeed();
    this.createdAt = Date.now();
    this.lagBonusOn = null;
    this.endedReason = null;
    this.winnerId = null;

    this.paused = false;
    this.pauseReason = null;
    this.levelup = null;
    this._levelupTimer = null;

    this.seq = 0;
    /** @type {object[]} */
    this.enemies = [];

    const teams = shuffleTeams();
    const spawnPoints = [
      { x: 150, y: config.mapHeight / 2 },
      { x: config.mapWidth - 150, y: config.mapHeight / 2 },
    ];

    this.players = players.map((p, i) => ({
      playerId: p.playerId,
      playerName: p.playerName || '',
      slot: i,
      team: teams[i],
      lives: config.livesN,
      kills: 0,
      alive: true,
      reviveAt: null,
      speedMul: 1,
      levelSpeedBonus: 0,
      x: spawnPoints[i].x,
      y: spawnPoints[i].y,
      vx: 0,
      vy: 0,
      /** 最近一次 input.move 方向（单位化前的原始） */
      inputDx: 0,
      inputDy: 0,
      send: p.send,
      lastHeartbeat: Date.now(),
      lastSpawnAt: 0,
    }));

    /** @type {Record<string, { lastInjectAt: number, extraOnOpponent: number, extraIds: string[] }>} */
    this.injectState = {};
    for (const p of this.players) {
      this.injectState[p.playerId] = {
        lastInjectAt: 0,
        extraOnOpponent: 0,
        extraIds: [],
      };
    }

    // 开局各刷几只本底怪，保证首帧 snapshot 含双方 enemies
    for (const p of this.players) {
      for (let i = 0; i < 3; i++) {
        this.spawnAmbientFor(p);
      }
    }

    this._tickTimer = null;
    this._dt = 1 / config.tickHz;
  }

  getPlayer(playerId) {
    return this.players.find((p) => p.playerId === playerId) || null;
  }

  getOpponent(playerId) {
    return this.players.find((p) => p.playerId !== playerId) || null;
  }

  spawnNear(player) {
    const ang = Math.random() * Math.PI * 2;
    const r = 40 + Math.random() * config.spawnRadius;
    return {
      x: clamp(player.x + Math.cos(ang) * r, 20, config.mapWidth - 20),
      y: clamp(player.y + Math.sin(ang) * r, 20, config.mapHeight - 20),
    };
  }

  addEnemy(partial) {
    const enemy = {
      id: partial.id || randomId('e'),
      ownerId: partial.ownerId,
      team: partial.team,
      enemyType: partial.enemyType,
      x: partial.x,
      y: partial.y,
      hp: partial.hp ?? 1,
      injected: !!partial.injected,
      angle: Math.random() * Math.PI * 2,
      wanderT: 0.5 + Math.random() * 2,
      alert: 0,
      attackCd: 0,
      state: 'wander',
    };
    this.enemies.push(enemy);
    return enemy;
  }

  removeEnemy(id) {
    const idx = this.enemies.findIndex((e) => e.id === id);
    if (idx >= 0) {
      this.enemies.splice(idx, 1);
      return true;
    }
    return false;
  }

  countOwned(ownerId, { injectedOnly = false } = {}) {
    return this.enemies.filter(
      (e) => e.ownerId === ownerId && (!injectedOnly || e.injected),
    ).length;
  }

  spawnAmbientFor(player) {
    const ambient = this.enemies.filter((e) => e.ownerId === player.playerId && !e.injected);
    if (ambient.length >= config.spawnCapPerOwner) return null;
    const enemyType = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)];
    const pos = this.spawnNear(player);
    return this.addEnemy({
      ownerId: player.playerId,
      team: player.team,
      enemyType,
      x: pos.x,
      y: pos.y,
      hp: 1,
      injected: false,
    });
  }

  applyMove(playerId, payload) {
    const p = this.getPlayer(playerId);
    if (!p || !p.alive || this.paused || this.state !== 'playing') return;
    const dx = Number(payload?.x);
    const dy = Number(payload?.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // 允许 0,0 急停；否则存方向，tick 里乘速度
    p.inputDx = clamp(dx, -1, 1);
    p.inputDy = clamp(dy, -1, 1);
  }

  _integratePlayers(dt) {
    if (this.paused) {
      for (const p of this.players) {
        p.vx = 0;
        p.vy = 0;
      }
      return;
    }
    for (const p of this.players) {
      if (!p.alive) {
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      const mul = p.speedMul * (1 + (p.levelSpeedBonus || 0));
      const speed = config.baseSpeed * mul;
      let dx = p.inputDx;
      let dy = p.inputDy;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        dx /= len;
        dy /= len;
      } else {
        dx = 0;
        dy = 0;
      }
      p.vx = dx * speed;
      p.vy = dy * speed;
      p.x = clamp(p.x + p.vx * dt, 16, config.mapWidth - 16);
      p.y = clamp(p.y + p.vy * dt, 16, config.mapHeight - 16);
    }
  }

  _tickSpawn(now) {
    if (this.paused) return;
    for (const p of this.players) {
      if (!p.alive) continue;
      if (now - p.lastSpawnAt < config.spawnIntervalMs) continue;
      p.lastSpawnAt = now;
      this.spawnAmbientFor(p);
    }
  }

  _enemyStats(type) {
    if (type === 'swift') return { r: 10, speed: 132, sight: 190, damage: 10 };
    if (type === 'watcher') return { r: 16, speed: 86, sight: 330, damage: 16 };
    return { r: 13, speed: 96, sight: 245, damage: 12 };
  }

  /** 权威敌人 AI：游荡 / 追主人（伤害仍由客户端 HP 结算上报） */
  _integrateEnemies(dt) {
    if (this.paused) return;
    for (const e of this.enemies) {
      const st = this._enemyStats(e.enemyType);
      const owner = this.getPlayer(e.ownerId);
      e.attackCd = Math.max(0, (e.attackCd || 0) - dt);

      let dx = 0;
      let dy = 0;
      let d = 0;
      if (owner && owner.alive) {
        dx = owner.x - e.x;
        dy = owner.y - e.y;
        d = Math.hypot(dx, dy);
        if (d < st.sight) {
          e.state = 'alert';
          e.alert = 1.1;
        } else if ((e.alert || 0) > 0) {
          e.alert -= dt;
          if (e.alert <= 0) e.state = 'wander';
        } else {
          e.state = 'wander';
        }
      } else {
        e.state = 'wander';
      }

      let vx = 0;
      let vy = 0;
      if (e.state === 'alert' && d > 1e-3) {
        const inv = 1 / d;
        vx = dx * inv * st.speed;
        vy = dy * inv * st.speed;
        e.angle = Math.atan2(vy, vx);
      } else {
        e.wanderT = (e.wanderT ?? 1) - dt;
        if (e.wanderT <= 0) {
          e.wanderT = 1 + Math.random() * 2.4;
          e.angle = (e.angle || 0) + (Math.random() * 3.2 - 1.6);
        }
        vx = Math.cos(e.angle || 0) * st.speed * 0.27;
        vy = Math.sin(e.angle || 0) * st.speed * 0.27;
      }
      e.x = clamp(e.x + vx * dt, st.r, config.mapWidth - st.r);
      e.y = clamp(e.y + vy * dt, st.r, config.mapHeight - st.r);
    }
  }


  buildSnapshot() {
    this.seq += 1;
    updateLagBonus(this);
    return {
      type: 'world.snapshot',
      seq: this.seq,
      serverTime: Date.now(),
      paused: this.paused,
      pauseReason: this.pauseReason,
      players: this.players.map((p) => ({
        playerId: p.playerId,
        team: p.team,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        vx: Math.round(p.vx * 100) / 100,
        vy: Math.round(p.vy * 100) / 100,
        alive: p.alive,
        lives: p.lives,
        kills: p.kills,
        speedMul: p.speedMul,
        reviveAt: p.reviveAt,
      })),
      enemies: this.enemies.map((e) => ({
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

  startTick(onEvents) {
    const interval = Math.max(16, Math.floor(1000 / config.tickHz));
    const dt = interval / 1000;
    this._tickTimer = setInterval(() => {
      if (this.state !== 'playing') return;
      const now = Date.now();
      const events = [];

      // 心跳超时判负
      for (const p of this.players) {
        if (now - p.lastHeartbeat > config.heartbeatTimeoutMs) {
          const opp = this.getOpponent(p.playerId);
          const endEv = this.end('opponent_disconnect', opp?.playerId ?? null, p.playerId);
          onEvents?.(endEv, this);
          return;
        }
      }

      events.push(...tickRevives(this, now));
      this._integratePlayers(dt);
      this._integrateEnemies(dt);
      this._tickSpawn(now);

      // 权威快照每 tick 广播
      events.push(this.buildSnapshot());

      if (events.length) onEvents?.(events, this);
    }, interval);
  }

  stopTick() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._levelupTimer) {
      clearTimeout(this._levelupTimer);
      this._levelupTimer = null;
    }
  }

  touchHeartbeat(playerId) {
    const p = this.getPlayer(playerId);
    if (p) p.lastHeartbeat = Date.now();
  }

  buildScoreEvents() {
    updateLagBonus(this);
    return this.players.map((you) => {
      const opp = this.getOpponent(you.playerId);
      let lagBonusOn = null;
      if (this.lagBonusOn === you.playerId) lagBonusOn = 'you';
      else if (this.lagBonusOn === opp?.playerId) lagBonusOn = 'opponent';

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
        _to: you.playerId,
      };
    });
  }

  end(reason, winnerId, disconnectedId = null) {
    if (this.state === 'ended') return [];
    this.state = 'ended';
    this.endedReason = reason;
    this.winnerId = winnerId;
    this.stopTick();

    return this.players.map((you) => {
      const opp = this.getOpponent(you.playerId);
      let viewReason = reason;
      if (reason === 'opponent_disconnect' && disconnectedId) {
        viewReason = you.playerId === disconnectedId ? 'you_disconnect' : 'opponent_disconnect';
      }
      return {
        type: 'room.end',
        reason: viewReason,
        winnerId,
        you: { kills: you.kills, lives: you.lives, team: you.team },
        opponent: { kills: opp.kills, lives: opp.lives, team: opp.team },
        _to: you.playerId,
      };
    });
  }

  buildStartEvents() {
    const now = Date.now();
    return this.players.map((you) => {
      const opp = this.getOpponent(you.playerId);
      return {
        type: 'room.start',
        roomId: this.roomId,
        mode: 'shared_map',
        you: {
          playerId: you.playerId,
          slot: you.slot,
          team: you.team,
          lives: you.lives,
          kills: you.kills,
        },
        opponent: {
          playerId: opp.playerId,
          slot: opp.slot,
          team: opp.team,
          lives: opp.lives,
          kills: opp.kills,
        },
        config: roomStartConfig(),
        seed: this.seed,
        serverTime: now,
        _to: you.playerId,
      };
    });
  }

  buildMatchFoundEvents() {
    return this.players.map((you) => {
      const opp = this.getOpponent(you.playerId);
      return {
        type: 'match.found',
        roomId: this.roomId,
        mode: 'shared_map',
        you: you.playerId,
        opponent: {
          playerId: opp.playerId,
          playerName: opp.playerName || '',
          team: opp.team,
        },
        youTeam: you.team,
        seed: this.seed,
        _to: you.playerId,
      };
    });
  }

  broadcast(msg) {
    for (const p of this.players) {
      p.send(msg);
    }
  }

  dispatch(events) {
    for (const ev of events) {
      const { _to, ...msg } = ev;
      if (_to) {
        const p = this.getPlayer(_to);
        p?.send(msg);
      } else {
        this.broadcast(msg);
      }
    }
  }
}

/** @type {Map<string, Room>} */
export const roomsById = new Map();
/** @type {Map<string, string>} */
export const playerRoom = new Map();

export function registerRoom(room) {
  roomsById.set(room.roomId, room);
  for (const p of room.players) {
    playerRoom.set(p.playerId, room.roomId);
  }
}

export function unregisterRoom(room) {
  room.stopTick();
  roomsById.delete(room.roomId);
  for (const p of room.players) {
    if (playerRoom.get(p.playerId) === room.roomId) {
      playerRoom.delete(p.playerId);
    }
  }
}

export function getRoomForPlayer(playerId) {
  const rid = playerRoom.get(playerId);
  if (!rid) return null;
  return roomsById.get(rid) || null;
}

// silence unused import lint-ish
void VALID_ENEMY;
