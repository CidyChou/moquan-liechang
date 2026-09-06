/**
 * 服务端可配置默认（环境变量可覆盖）
 * 对齐 ws-protocol.md §0
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
  port: intEnv('PORT', 8787),
  livesN: intEnv('LIVES_N', 3),
  killTargetK: intEnv('KILL_TARGET_K', 30),
  injectCooldownMs: intEnv('INJECT_COOLDOWN_MS', 300),
  injectExtraCap: intEnv('INJECT_EXTRA_CAP', 20),
  injectOverflow: strEnv('INJECT_OVERFLOW', 'drop_oldest'), // drop_oldest | queue | reject
  lagDiff: intEnv('LAG_DIFF', 8),
  lagSpeedBonus: floatEnv('LAG_SPEED_BONUS', 0.15),
  reviveMs: intEnv('REVIVE_MS', 5000),
  heartbeatTimeoutMs: intEnv('HEARTBEAT_TIMEOUT_MS', 30000),
  matchTimeoutMs: intEnv('MATCH_TIMEOUT_MS', 15000),
  tickHz: intEnv('TICK_HZ', 20),
};

/** welcome / room.start 下发给客户端的配置子集 */
export function clientConfig() {
  return {
    livesN: config.livesN,
    killTargetK: config.killTargetK,
    injectCooldownMs: config.injectCooldownMs,
    injectExtraCap: config.injectExtraCap,
    lagDiff: config.lagDiff,
    lagSpeedBonus: config.lagSpeedBonus,
    reviveMs: config.reviveMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    matchTimeoutMs: config.matchTimeoutMs,
  };
}

export function roomStartConfig() {
  return {
    livesN: config.livesN,
    killTargetK: config.killTargetK,
  };
}
