import WebSocket from "ws";
const URL = process.env.WS_URL || "wss://violet-lamps-refuse.loca.lt";
console.log("URL", URL);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, {
      headers: { "bypass-tunnel-reminder": "1", "User-Agent": "moquan-smoke/1.0" },
    });
    const st = { name, ws, inbox: [], waiters: [], playerId: null };
    const timer = setTimeout(() => reject(new Error(name + " open timeout")), 10000);
    ws.on("open", () => { clearTimeout(timer); resolve(st); });
    ws.on("error", (e) => reject(e));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      console.log(name, "<-", m.type || m);
      st.inbox.push(m);
      const pending = st.waiters.splice(0, st.waiters.length);
      for (const w of pending) w();
    });
  });
}
function send(c, m) { console.log(c.name, "->", m.type); c.ws.send(JSON.stringify(m)); }
function waitFor(c, pred, ms, label) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const i = c.inbox.findIndex(pred);
      if (i >= 0) { resolve(c.inbox.splice(i, 1)[0]); return; }
      if (Date.now() > deadline) {
        reject(new Error("[" + c.name + "] timeout " + label + " recent=" + JSON.stringify(c.inbox.slice(-8))));
        return;
      }
      c.waiters.push(tick);
      setTimeout(() => {
        const j = c.waiters.indexOf(tick);
        if (j >= 0) { c.waiters.splice(j, 1); tick(); }
      }, 40);
    };
    tick();
  });
}

const a = await connect("A");
const b = await connect("B");
await new Promise((r) => setTimeout(r, 200));
send(a, { type: "hello", playerName: "PubA", clientVersion: "0.1" });
const wa = await waitFor(a, (m) => m.type === "welcome", 8000, "welcome");
a.playerId = wa.playerId;
send(b, { type: "hello", playerName: "PubB", clientVersion: "0.1" });
const wb = await waitFor(b, (m) => m.type === "welcome", 8000, "welcome");
b.playerId = wb.playerId;
send(a, { type: "match.join" });
send(b, { type: "match.join" });
await waitFor(a, (m) => m.type === "match.found", 15000, "found");
await waitFor(b, (m) => m.type === "match.found", 15000, "found");
await waitFor(a, (m) => m.type === "room.start", 8000, "start");
await waitFor(b, (m) => m.type === "room.start", 8000, "start");
console.log("PUBLIC_MATCH_PASS", a.playerId, b.playerId);
a.ws.close(); b.ws.close();
process.exit(0);
