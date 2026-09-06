import WebSocket from "ws";

const PORT = Number(process.env.PORT || 8787);
const URL = process.env.WS_URL || "ws://127.0.0.1:" + PORT;
const K = Number(process.env.KILL_TARGET_K || 30);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 30000);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function connectClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const state = { name, ws, playerId: null, inbox: [], waiters: [] };
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
        reject(new Error("[" + client.name + "] timeout " + label + " inbox=" + JSON.stringify(client.inbox.slice(-8))));
        return;
      }
      client.waiters.push(tryOnce);
      setTimeout(() => {
        const i = client.waiters.indexOf(tryOnce);
        if (i >= 0) { client.waiters.splice(i, 1); tryOnce(); }
      }, 40);
    };
    tryOnce();
  });
}

async function main() {
  console.log("[smoke] connecting to", URL, "K=" + K);
  const a = await connectClient("A");
  const b = await connectClient("B");
  send(a, { type: "hello", playerName: "SmokeA", clientVersion: "0.1" });
  send(b, { type: "hello", playerName: "SmokeB", clientVersion: "0.1" });
  const wa = await waitFor(a, (m) => m.type === "welcome", 5000, "welcome");
  const wb = await waitFor(b, (m) => m.type === "welcome", 5000, "welcome");
  a.playerId = wa.playerId; b.playerId = wb.playerId;
  console.log("[smoke] welcome", a.playerId, b.playerId);

  send(a, { type: "match.join" });
  send(b, { type: "match.join" });
  await waitFor(a, (m) => m.type === "match.queued", 3000, "queued");
  await waitFor(b, (m) => m.type === "match.queued", 3000, "queued");
  const foundA = await waitFor(a, (m) => m.type === "match.found", 5000, "found");
  await waitFor(b, (m) => m.type === "match.found", 5000, "found");
  console.log("[smoke] matched", foundA.roomId);
  await waitFor(a, (m) => m.type === "room.start", 5000, "start");
  await waitFor(b, (m) => m.type === "room.start", 5000, "start");
  console.log("[smoke] room.start ok");

  const scoreAP = waitFor(a, (m) => m.type === "room.score" && m.you.kills >= 1, 5000, "scoreA");
  const scoreBP = waitFor(b, (m) => m.type === "room.score" && m.opponent.kills >= 1, 5000, "scoreB");
  const injP = waitFor(b, (m) => m.type === "combat.inject" && m.to === b.playerId, 5000, "inject");
  send(a, { type: "combat.kill", enemyType: "drifter", seq: 1 });
  await scoreAP;
  await scoreBP;
  const inj = await injP;
  if (inj.enemyType !== "drifter") throw new Error("bad inject type");
  console.log("[smoke] inject ok", inj.injectId);

  const bScoreP = waitFor(b, (m) => m.type === "room.score" && m.you.kills >= 1, 5000, "Bkill");
  const injAP = waitFor(a, (m) => m.type === "combat.inject" && m.to === a.playerId, 5000, "injectA");
  send(b, { type: "combat.kill", enemyType: "swift", seq: 1 });
  await bScoreP;
  await injAP;
  console.log("[smoke] inject to A ok");

  let seq = 1;
  for (let i = 0; i < K - 2; i++) {
    seq += 1;
    const t = i % 3 === 0 ? "drifter" : i % 3 === 1 ? "swift" : "watcher";
    send(a, { type: "combat.kill", enemyType: t, seq });
    if (i % 10 === 0) await sleep(15);
  }
  const endAP = waitFor(a, (m) => m.type === "room.end", 15000, "endA");
  const endBP = waitFor(b, (m) => m.type === "room.end", 15000, "endB");
  seq += 1;
  send(a, { type: "combat.kill", enemyType: "drifter", seq });
  const endA = await endAP;
  const endB = await endBP;
  console.log("[smoke] room.end", JSON.stringify(endA));
  if (endA.reason !== "kill_target") throw new Error("bad reason " + endA.reason);
  if (endA.winnerId !== a.playerId) throw new Error("bad winner");
  if (endA.you.kills < K) throw new Error("kills " + endA.you.kills);
  if (endB.winnerId !== a.playerId) throw new Error("B winner mismatch");
  send(a, { type: "ping", t: 12345 });
  await waitFor(a, (m) => m.type === "pong" && m.t === 12345, 3000, "pong");
  console.log("[smoke] PASS", { roomId: foundA.roomId, killsA: endA.you.kills, killsB: endA.opponent.kills });
  a.ws.close(); b.ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("[smoke] FAIL", e); process.exit(1); });
