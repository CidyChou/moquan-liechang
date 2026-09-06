/**
 * 同图 v2 smoke：match + snapshot + move + loop 只杀己方 + inject + 复活 + levelup 超时 + 先到 K
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const URL = process.env.WS_URL || "ws://127.0.0.1:" + PORT;
const K = Number(process.env.KILL_TARGET_K || 5);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 45000);
const SELF_START = process.env.SMOKE_SELF_START !== "0";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function connectClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const state = { name, ws, playerId: null, team: null, inbox: [], waiters: [] };
    ws.on("open", () => resolve(state));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      state.inbox.push(msg);
      const pending = state.waiters.splice(0, state.waiters.length);
      for (const w of pending) w();
    });
  });
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
        reject(new Error("[" + client.name + "] timeout " + label + " inbox=" + JSON.stringify(client.inbox.slice(-12))));
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

function latestSnapshot(client) {
  for (let i = client.inbox.length - 1; i >= 0; i--) {
    if (client.inbox[i].type === "world.snapshot") return client.inbox[i];
  }
  return null;
}

async function waitSnapshot(client, pred, timeoutMs, label) {
  return waitFor(client, (m) => m.type === "world.snapshot" && (!pred || pred(m)), timeoutMs, label || "snapshot");
}

function fullMapLoop() {
  return [[0, 0], [900, 0], [900, 700], [0, 700]];
}

function startServerIfNeeded() {
  if (!SELF_START) return null;
  const env = {
    ...process.env,
    PORT: String(PORT),
    KILL_TARGET_K: String(K),
    LEVELUP_TIMEOUT_MS: process.env.LEVELUP_TIMEOUT_MS || "800",
    REVIVE_MS: process.env.REVIVE_MS || "400",
    SPAWN_INTERVAL_MS: process.env.SPAWN_INTERVAL_MS || "500",
    SPAWN_CAP_PER_OWNER: process.env.SPAWN_CAP_PER_OWNER || "12",
  };
  const child = spawn(process.execPath, [path.join(__dirname, "../src/index.js")], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  return child;
}

async function waitPort(ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(URL);
      await new Promise((res, rej) => {
        ws.once("open", () => { ws.close(); res(); });
        ws.once("error", rej);
      });
      return;
    } catch { await sleep(100); }
  }
  throw new Error("server not up on " + URL);
}

async function main() {
  const child = startServerIfNeeded();
  try {
    await waitPort();
    console.log("[smoke] connecting", URL, "K=" + K);

    const a = await connectClient("A");
    const b = await connectClient("B");
    send(a, { type: "hello", playerName: "SmokeA", clientVersion: "0.2" });
    send(b, { type: "hello", playerName: "SmokeB", clientVersion: "0.2" });
    const wa = await waitFor(a, (m) => m.type === "welcome", 5000, "welcome");
    const wb = await waitFor(b, (m) => m.type === "welcome", 5000, "welcome");
    a.playerId = wa.playerId; b.playerId = wb.playerId;
    if (wa.mode !== "shared_map") throw new Error("welcome mode != shared_map");
    if (wa.config.livesN !== 1) throw new Error("livesN expected 1 got " + wa.config.livesN);
    console.log("[smoke] welcome", a.playerId, b.playerId);

    send(a, { type: "match.join" });
    send(b, { type: "match.join" });
    await waitFor(a, (m) => m.type === "match.queued", 3000, "queued");
    await waitFor(b, (m) => m.type === "match.queued", 3000, "queued");

    const foundA = await waitFor(a, (m) => m.type === "match.found", 5000, "found");
    await waitFor(b, (m) => m.type === "match.found", 5000, "found");
    if (foundA.mode !== "shared_map") throw new Error("match.found mode");
    console.log("[smoke] matched", foundA.roomId);

    const startA = await waitFor(a, (m) => m.type === "room.start", 5000, "start");
    const startB = await waitFor(b, (m) => m.type === "room.start", 5000, "start");
    if (startA.mode !== "shared_map") throw new Error("room.start mode");
    if (!startA.you.team || !startA.opponent.team) throw new Error("missing team");
    if (startA.you.team === startA.opponent.team) throw new Error("same team");
    if (!["red", "blue"].includes(startA.you.team)) throw new Error("bad team");
    if (startA.you.lives !== 1) throw new Error("start lives");
    a.team = startA.you.team; b.team = startB.you.team;
    console.log("[smoke] room.start teams", a.team, b.team);

    const snapA = await waitSnapshot(a, (m) => m.players?.length === 2 && m.enemies?.length >= 2 && m.players.some((p) => p.playerId === b.playerId), 5000, "snap see opponent+enemies");
    await waitSnapshot(b, (m) => m.players?.length === 2 && m.enemies?.length >= 2, 5000, "snap B");
    const enemyTeams = new Set(snapA.enemies.map((e) => e.team));
    if (enemyTeams.size < 2) throw new Error("expected both team enemies in snapshot");
    console.log("[smoke] world.snapshot ok enemies=", snapA.enemies.length);

    const before = snapA.players.find((p) => p.playerId === a.playerId);
    send(a, { type: "input.move", x: 1, y: 0, seq: 1 });
    const moved = await waitSnapshot(a, (m) => {
      const p = m.players.find((x) => x.playerId === a.playerId);
      return p && p.x > before.x + 2;
    }, 3000, "move reflected");
    console.log("[smoke] input.move ok", before.x, "->", moved.players.find((p) => p.playerId === a.playerId).x);
    send(a, { type: "input.move", x: 0, y: 0, seq: 2 });

    const snapBefore = await waitSnapshot(a, null, 2000, "pre-opp-loop");
    const oppEnemies = snapBefore.enemies.filter((e) => e.ownerId === b.playerId);
    if (!oppEnemies.length) throw new Error("no opp enemies");
    const killsBefore = snapBefore.players.find((p) => p.playerId === a.playerId).kills;
    const t = oppEnemies[0];
    send(a, { type: "input.loop", points: [[t.x - 5, t.y - 5], [t.x + 5, t.y - 5], [t.x + 5, t.y + 5], [t.x - 5, t.y + 5]], seq: 10 });
    await sleep(200);
    const snapAfterOpp = latestSnapshot(a) || (await waitSnapshot(a, null, 2000, "post-opp"));
    const killsAfterOpp = snapAfterOpp.players.find((p) => p.playerId === a.playerId).kills;
    if (killsAfterOpp !== killsBefore) throw new Error("should not kill opponent enemies");
    console.log("[smoke] loop ignores opponent enemies ok");

    const killAckP = waitFor(a, (m) => m.type === "combat.kill_ack" && m.killerId === a.playerId, 5000, "kill_ack");
    const injectP = waitFor(a, (m) => m.type === "combat.inject" && m.to === b.playerId && m.ownerId === b.playerId && m.team === b.team, 5000, "inject");
    const injectBP = waitFor(b, (m) => m.type === "combat.inject" && m.to === b.playerId, 5000, "injectB");
    send(a, { type: "input.loop", points: fullMapLoop(), seq: 11 });
    const ack = await killAckP;
    const inj = await injectP;
    await injectBP;
    if (ack.kills < 1) throw new Error("kills not incremented");
    console.log("[smoke] kill+inject ok", inj.injectId, "kills=", ack.kills);

    const downP = waitFor(a, (m) => m.type === "combat.down" && m.playerId === a.playerId, 5000, "down");
    const reviveP = waitFor(a, (m) => m.type === "combat.revive" && m.playerId === a.playerId, 8000, "revive");
    send(a, { type: "combat.hit", damageLives: 1, seq: 20 });
    const down = await downP;
    if (!down.reviveAt) throw new Error("missing reviveAt");
    const rev = await reviveP;
    if (rev.lives !== 1) throw new Error("revive lives");
    console.log("[smoke] down+revive ok");

    const offerP = waitFor(a, (m) => m.type === "levelup.offer" && m.forPlayerId === a.playerId, 5000, "offer");
    const pauseP = waitFor(b, (m) => m.type === "world.pause" && m.reason === "levelup", 5000, "pauseB");
    send(a, { type: "levelup.request" });
    const offer = await offerP;
    await pauseP;
    if (!offer.options?.length) throw new Error("no options");
    const resolvedP = waitFor(a, (m) => m.type === "levelup.resolved" && m.forPlayerId === a.playerId && m.auto === true, 5000, "auto resolve");
    const resumeP = waitFor(b, (m) => m.type === "world.resume", 5000, "resume");
    const resolved = await resolvedP;
    await resumeP;
    console.log("[smoke] levelup auto-pick ok", resolved.optionId);

    let seq = 100;
    const endAP = waitFor(a, (m) => m.type === "room.end", 30000, "endA");
    const endBP = waitFor(b, (m) => m.type === "room.end", 30000, "endB");
    for (let i = 0; i < K * 8; i++) {
      if (a.inbox.some((m) => m.type === "room.end")) break;
      seq += 1;
      send(a, { type: "input.loop", points: fullMapLoop(), seq });
      await sleep(80);
    }
    const endA = await endAP;
    const endB = await endBP;
    if (endA.reason !== "kill_target") throw new Error("bad reason " + endA.reason);
    if (endA.winnerId !== a.playerId) throw new Error("bad winner");
    if (endA.you.kills < K) throw new Error("kills " + endA.you.kills);
    if (endB.winnerId !== a.playerId) throw new Error("B winner mismatch");
    console.log("[smoke] room.end first-to-K ok", endA.you.kills);

    send(a, { type: "ping", t: 12345 });
    await waitFor(a, (m) => m.type === "pong" && m.t === 12345, 3000, "pong");
    console.log("[smoke] PASS", { roomId: foundA.roomId, teams: [a.team, b.team], killsA: endA.you.kills, killsB: endA.opponent.kills });
    a.ws.close(); b.ws.close();
    if (child) { child.kill("SIGTERM"); await sleep(200); }
    process.exit(0);
  } catch (e) {
    console.error("[smoke] FAIL", e);
    if (child) child.kill("SIGTERM");
    process.exit(1);
  }
}

main();
