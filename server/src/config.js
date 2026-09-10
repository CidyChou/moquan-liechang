/**
 * 同图对战 v2 配置（环境变量可覆盖）
 * 对齐 WS协议-同图对战-v2.md §0
 */

function intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function strEnv(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  port: intEnv('PORT', 8788),
  livesN: intEnv('LIVES_N', 1),
  killTargetK: intEnv('KILL_TARGET_K', 30),
  injectCooldownMs: intEnv('INJECT_COOLDOWN_MS', 300),
  injectExtraCap: intEnv('INJECT_EXTRA_CAP', 20),
  injectOverflow: strEnv('INJECT_OVERFLOW', 'drop_oldest'),
  lagDiff: intEnv('LAG_DIFF', 8),
  lagSpeedBonus: floatEnv('LAG_SPEED_BONUS', 0.15),
  reviveMs: intEnv('REVIVE_MS', 5000),
  levelupTimeoutMs: intEnv('LEVELUP_TIMEOUT_MS', 8000),
  heartbeatTimeoutMs: intEnv('HEARTBEAT_TIMEOUT_MS', 30000),
  matchTimeoutMs: intEnv('MATCH_TIMEOUT_MS', 15000),
  tickHz: intEnv('TICK_HZ', 20),
  /** 玩家基础移速（单位/秒） */
  baseSpeed: floatEnv('BASE_SPEED', 180),
  /** 本底刷怪间隔 ms */
  spawnIntervalMs: intEnv('SPAWN_INTERVAL_MS', 450),
  /** 每位主人本底怪上限 */
  spawnCapPerOwner: intEnv('SPAWN_CAP_PER_OWNER', 45),
  /** 刷怪距主人半径 */
  spawnRadius: floatEnv('SPAWN_RADIUS', 120),
  mapWidth: floatEnv('MAP_WIDTH', 1600),
  mapHeight: floatEnv('MAP_HEIGHT', 1000),
};

export function clientConfig() {
  return {
    livesN: config.livesN,
    killTargetK: config.killTargetK,
    injectCooldownMs: config.injectCooldownMs,
    injectExtraCap: config.injectExtraCap,
    lagDiff: config.lagDiff,
    lagSpeedBonus: config.lagSpeedBonus,
    reviveMs: config.reviveMs,
    levelupTimeoutMs: config.levelupTimeoutMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    matchTimeoutMs: config.matchTimeoutMs,
    tickHz: config.tickHz,
    mapWidth: config.mapWidth,
    mapHeight: config.mapHeight,
    baseSpeed: config.baseSpeed,
  };
}

export function roomStartConfig() {
  return {
    livesN: config.livesN,
    killTargetK: config.killTargetK,
    levelupTimeoutMs: config.levelupTimeoutMs,
  };
}
