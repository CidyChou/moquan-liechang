/**
 * 房间状态机：playing → ended
 */
import { config, roomStartConfig } from './config.js';
import { randomId, randomSeed } from './ids.js';
import { tickRevives, updateLagBonus } from './combat.js';

/**
 * @typedef {{
 *   playerId: string,
 *   playerName: string,
 *   slot: number,
 *   lives: number,
 *   kills: number,
 *   alive: boolean,
 *   reviveAt: number|null,
 *   speedMul: number,
 *   send: (msg: object) => void,
 *   lastHeartbeat: number,
 * }} RoomPlayer
 */

export class Room {
  /**
   * @param {RoomPlayer[]} players - length 2
   */
  constructor(players) {
    this.roomId = randomId('r');
    this.state = 'playing'; // playing | ended
    this.players = players.map((p, i) => ({
      playerId: p.playerId,
      playerName: p.playerName || '',
      slot: i,
      lives: config.livesN,
      kills: 0,
      alive: true,
      reviveAt: null,
      speedMul: 1,
      send: p.send,
      lastHeartbeat: Date.now(),
    }));
    this.seed = randomSeed();
    this.lagBonusOn = null;
    this.endedReason = null;
    this.winnerId = null;
    this.createdAt = Date.now();

    /** @type {Record<string, { lastInjectAt: number, extraOnOpponent: number, extraIds: string[], queue: string[] }>} */
    this.injectState = {};
    for (const p of this.players) {
      this.injectState[p.playerId] = {
        lastInjectAt: 0,
        extraOnOpponent: 0,
        extraIds: [],
        queue: [],
      };
    }

    this._tickTimer = null;
  }

  getPlayer(playerId) {
    return this.players.find((p) => p.playerId === playerId) || null;
  }

  getOpponent(playerId) {
    return this.players.find((p) => p.playerId !== playerId) || null;
  }

  startTick(onEvents) {
    const interval = Math.max(16, Math.floor(1000 / config.tickHz));
    this._tickTimer = setInterval(() => {
      if (this.state !== 'playing') return;
      const now = Date.now();
      const events = tickRevives(this, now);
      // 心跳超时判负
      for (const p of this.players) {
        if (now - p.lastHeartbeat > config.heartbeatTimeoutMs) {
          const opp = this.getOpponent(p.playerId);
          const endEv = this.end('opponent_disconnect', opp?.playerId ?? null, p.playerId);
          onEvents?.(endEv, this);
          return;
        }
      }
      if (events.length) onEvents?.(events, this);
    }, interval);
  }

  stopTick() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  touchHeartbeat(playerId) {
    const p = this.getPlayer(playerId);
    if (p) p.lastHeartbeat = Date.now();
  }

  /**
   * 为每位玩家生成视角化的 room.score
   * @returns {object[]} 带 _to 的消息
   */
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
        },
        opponent: {
          kills: opp.kills,
          lives: opp.lives,
          alive: opp.alive,
          reviveAt: opp.reviveAt,
          speedMul: opp.speedMul,
        },
        lagBonusOn,
        _to: you.playerId,
      };
    });
  }

  /**
   * @param {'kill_target'|'opponent_disconnect'|'you_disconnect'} reason
   * @param {string|null} winnerId
   * @param {string|null} disconnectedId - 断线方（用于 you_disconnect 视角）
   */
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
        // 断线方看到 you_disconnect，对手看到 opponent_disconnect
        viewReason = you.playerId === disconnectedId ? 'you_disconnect' : 'opponent_disconnect';
      }
      return {
        type: 'room.end',
        reason: viewReason,
        winnerId,
        you: { kills: you.kills, lives: you.lives },
        opponent: { kills: opp.kills, lives: opp.lives },
        _to: you.playerId,
      };
    });
  }

  /** 开局消息（视角化） */
  buildStartEvents() {
    const now = Date.now();
    return this.players.map((you) => {
      const opp = this.getOpponent(you.playerId);
      return {
        type: 'room.start',
        roomId: this.roomId,
        you: {
          playerId: you.playerId,
          slot: you.slot,
          lives: you.lives,
          kills: you.kills,
        },
        opponent: {
          playerId: opp.playerId,
          slot: opp.slot,
          lives: opp.lives,
          kills: opp.kills,
        },
        config: roomStartConfig(),
        serverTime: now,
        _to: you.playerId,
      };
    });
  }

  /** match.found 视角化 */
  buildMatchFoundEvents() {
    return this.players.map((you) => {
      const opp = this.getOpponent(you.playerId);
      return {
        type: 'match.found',
        roomId: this.roomId,
        you: you.playerId,
        opponent: {
          playerId: opp.playerId,
          playerName: opp.playerName || '',
        },
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

  /**
   * 分发带 _to 的事件列表；无 _to 则广播
   * @param {object[]} events
   */
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
/** @type {Map<string, string>} playerId → roomId */
export const playerRoom = new Map();

export function registerRoom(room) {
  roomsById.set(room.roomId, room);
  for (const p of room.players) {
    playerRoom.set(p.playerId, room.roomId);
  }
}

export function unregisterRoom(room) {
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
