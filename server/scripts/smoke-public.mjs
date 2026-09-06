/**
 * 节点3–4 协议冒烟：匹配、塞敌同种、冷却、上限、倒地复活、落后补偿
 */
import WebSocket from "ws";

const PORT = Number(process.env.PORT || 8787);
const URL = process.env.WS_URL || "wss://violet-lamps-refuse.loca.lt";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function connectClient(name) {
  const state = await new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'bypass-tunnel-reminder': 'true',
      },
    });
    const s = { name, ws, playerId: null, inbox: [], waiters: [] };
    ws.on("open", () => resolve(s));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      s.inbox.push(msg);
      const pending = s.waiters.splice(0, s.waiters.length);
      for (const w of pending) w();
    });
  });
  await sleep(200); // tunnel/proxy settle before caller sends hello
  return state;
}

function send(c, msg) { c.ws.send(JSON.stringify(msg)); }

function waitFor(client, predicate, timeoutMs, label) {
  timeoutMs = timeoutMs || TIMEOUT_MS;
  label = label || "event";
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const idx = client.inbox.findIndex(predicate);
      if (idx >= 0) { const msg = client.inbox.splice(idx, 1)[0]; resolve(msg); return; }
      if (Date.now() > deadline) {
        reject(new Error("[" + client.name + "] timeout " + label + " recent=" + JSON.stringify(client.inbox.slice(-10))));
        return;
      }
      client.waiters.push(tryOnce);
      setTimeout(() => {
        const i = client.waiters.indexOf(tryOnce);
        if (i >= 0) { client.waiters.splice(i, 1); tryOnce(); }
      }, 30);
    };
    tryOnce();
  });
}

function drain(client) { client.inbox.length = 0; }

async function matchPair(suffix) {
  const a = await connectClient("A" + suffix);
  const b = await connectClient("B" + suffix);
  send(a, { type: "hello", playerName: "SmokeA" + suffix, clientVersion: "0.1" });
  send(b, { type: "hello", playerName: "SmokeB" + suffix, clientVersion: "0.1" });
  const wa = await waitFor(a, (m) => m.type === "welcome", 10000, "welcome");
  const wb = await waitFor(b, (m) => m.type === "welcome", 10000, "welcome");
  a.playerId = wa.playerId; b.playerId = wb.playerId;
  send(a, { type: "match.join" });
  send(b, { type: "match.join" });
  await waitFor(a, (m) => m.type === "match.found", 8000, "found");
  await waitFor(b, (m) => m.type === "match.found", 8000, "found");
  await waitFor(a, (m) => m.type === "room.start", 5000, "start");
  await waitFor(b, (m) => m.type === "room.start", 5000, "start");
  return { a, b };
}

async function testInjectSameType() {
  const { a, b } = await matchPair("_inj");
  drain(a); drain(b);
  const scoreAP = waitFor(a, (m) => m.type === "room.score" && (m.you?.kills|0) >= 1, 5000, "scoreA");
  const injP = waitFor(b, (m) => m.type === "combat.inject" && m.enemyType === "watcher", 5000, "inject");
  send(a, { type: "combat.kill", enemyType: "watcher", seq: 1 });
  await scoreAP;
  const inj = await injP;
  if (inj.to !== b.playerId) throw new Error("inject to wrong player");
  a.ws.close(); b.ws.close();
  return { detail: "A kill watcher → B combat.inject watcher" };
}

async function testInjectCooldown() {
  const { a, b } = await matchPair("_cd");
  drain(a); drain(b);
  send(a, { type: "combat.kill", enemyType: "drifter", seq: 1 });
  await waitFor(b, (m) => m.type === "combat.inject", 5000, "inj1");
  const deniedP = waitFor(a, (m) => m.type === "combat.inject_denied" && m.reason === "cooldown", 3000, "denied");
  send(a, { type: "combat.kill", enemyType: "swift", seq: 2 });
  await deniedP;
  await sleep(350);
  drain(a); drain(b);
  const inj2 = waitFor(b, (m) => m.type === "combat.inject" && m.enemyType === "swift", 5000, "inj2");
  send(a, { type: "combat.kill", enemyType: "swift", seq: 3 });
  await inj2;
  a.ws.close(); b.ws.close();
  return { detail: "instant 2nd inject denied cooldown; after 350ms ok" };
}

async function testInjectCap() {
  const { a, b } = await matchPair("_cap");
  drain(a); drain(b);
  for (let i = 0; i < 20; i++) {
    send(a, { type: "combat.kill", enemyType: "drifter", seq: i + 1 });
    await sleep(320);
  }
  await sleep(200);
  drain(a); drain(b);
  send(a, { type: "combat.kill", enemyType: "swift", seq: 99 });
  let denied = null;
  let inj = null;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !denied && !inj) {
    for (const m of a.inbox) if (m.type === "combat.inject_denied") denied = m;
    for (const m of b.inbox) if (m.type === "combat.inject") inj = m;
    if (!denied && !inj) await sleep(40);
  }
  a.ws.close(); b.ws.close();
  if (denied && denied.reason === "cap") return { detail: "cap deny: " + JSON.stringify(denied) };
  if (inj) return { detail: "overflow allows inject: " + (inj.queued ? "queued" : "drop_oldest/inject") };
  throw new Error("no cap deny and no inject after 20 fills");
}

async function testReviveAndOpponentContinues() {
  const { a, b } = await matchPair("_rev");
  drain(a); drain(b);
  send(a, { type: "combat.hit", damageLives: 1, seq: 1 });
  await waitFor(a, (m) => m.type === "room.score" && (m.you?.lives|0) === 2, 5000, "lives2");
  send(a, { type: "combat.hit", damageLives: 1, seq: 2 });
  await waitFor(a, (m) => m.type === "room.score" && (m.you?.lives|0) === 1, 5000, "lives1");
  const downP = waitFor(a, (m) => m.type === "combat.down" && m.playerId === a.playerId, 5000, "down");
  send(a, { type: "combat.hit", damageLives: 1, seq: 3 });
  const down = await downP;
  const t0 = Date.now();
  drain(b);
  send(b, { type: "combat.kill", enemyType: "drifter", seq: 10 });
  await waitFor(b, (m) => m.type === "room.score" && (m.you?.kills|0) >= 1, 5000, "BkillWhileADown");
  await waitFor(a, (m) => m.type === "combat.inject", 5000, "injWhileDown");
  const revive = await waitFor(a, (m) => m.type === "combat.revive" && m.playerId === a.playerId, 8000, "revive");
  const dt = Date.now() - t0;
  if ((revive.lives|0) < 1) throw new Error("revive lives bad");
  a.ws.close(); b.ws.close();
  return { detail: `down→revive ~${dt}ms; B killed+injected while A down; reviveAt=${down.reviveAt}` };
}

async function testLagBonus() {
  const { a, b } = await matchPair("_lag");
  drain(a); drain(b);
  for (let i = 0; i < 8; i++) {
    send(a, { type: "combat.kill", enemyType: "drifter", seq: i + 1 });
    await sleep(320);
  }
  let found = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !found) {
    for (const m of b.inbox) {
      if (m.type === "room.score" && m.you && Number(m.you.speedMul) > 1.01) { found = m; break; }
    }
    for (const m of a.inbox) {
      if (m.type === "room.score" && m.opponent && Number(m.opponent.speedMul) > 1.01) { found = m; break; }
    }
    if (!found) await sleep(40);
  }
  a.ws.close(); b.ws.close();
  if (!found) throw new Error("lag bonus speedMul not observed after +8 lead");
  return { detail: "speedMul bonus: " + JSON.stringify(found.you || found.opponent) };
}

async function testLevelupEcho() {
  const { a, b } = await matchPair("_lv");
  drain(a);
  send(a, { type: "meta.levelup", level: 2, choiceId: "轻步" });
  const echo = await waitFor(a, (m) => m.type === "meta.levelup" && m.choiceId === "轻步", 3000, "lv");
  a.ws.close(); b.ws.close();
  return { detail: "meta.levelup echo ok" };
}

const results = [];
async function run(name, fn) {
  try {
    const r = await fn();
    results.push({ name, pass: true, detail: r.detail || "" });
    console.log("[PASS]", name, r.detail || "");
  } catch (e) {
    results.push({ name, pass: false, detail: String(e && e.message || e) });
    console.error("[FAIL]", name, e && e.message || e);
  }
}

async function main() {
  console.log("[smoke-public] URL=", URL);
  await run("S1 match+start", async () => {
    const { a, b } = await matchPair("_m");
    a.ws.close(); b.ws.close();
    return { detail: "match.found + room.start" };
  });
  await run("S3 inject same type", testInjectSameType);
  await run("S5 revive + opp continues", testReviveAndOpponentContinues);
  await run("S6 meta.levelup echo", testLevelupEcho);
  await run("S7 inject cooldown", testInjectCooldown);
  await run("S7 inject cap/overflow", testInjectCap);
  await run("S7 lag speed bonus", testLagBonus);
  const failed = results.filter((r) => !r.pass);
  console.log(JSON.stringify({ summary: failed.length ? "FAIL" : "PASS", results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
