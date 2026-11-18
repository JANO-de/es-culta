import { Table } from "./engine.js";

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/;
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// ---------- una mesa = un Durable Object con el motor de engine.js ----------
export class Room {
  constructor(state, env) {
    this.env = env; this.created = false; this.dict = null; this.loading = null; this.interval = null; this.idle = null;
    this.mk();
  }
  mk() { this.table = new Table({ dict: (w) => (this.dict ? this.dict(w) : true), report: (r) => this.report(r) }); }
  report(r) {
    try { this.env.HUB.get(this.env.HUB.idFromName("global")).fetch("https://hub/result", { method: "POST", body: JSON.stringify(r) }).catch(() => {}); } catch {}
  }
  async ensureDict() {
    if (this.dict) return;
    if (!this.loading) this.loading = (async () => {
      try {
        const r = await this.env.ASSETS.fetch("https://assets.local/words.txt");
        if (r.ok) { const txt = await r.text(); this.dict = (w) => txt.includes("\n" + w + "\n"); }
      } catch {}
      this.loading = null;
    })();
    await this.loading;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/init") {
      if (this.created) return new Response("exists", { status: 409 });
      this.created = true; this.table.code = url.searchParams.get("code") || ""; this.touchIdle();
      return new Response("ok");
    }
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair); server.accept();
    const conn = { send: (o) => { try { server.send(JSON.stringify(o)); } catch {} }, close: () => { try { server.close(1000, "bye"); } catch {} } };
    if (!this.created) { conn.send({ t: "err", code: "no_table", m: "Esa mesa no existe o ya se cerró." }); conn.close(); return new Response(null, { status: 101, webSocket: client }); }
    this.table.open(conn); this.start();
    server.addEventListener("message", (ev) => this.onMsg(conn, ev.data));
    const end = () => { this.table.close(conn); this.maybeStop(); };
    server.addEventListener("close", end); server.addEventListener("error", end);
    return new Response(null, { status: 101, webSocket: client });
  }
  async onMsg(conn, data) {
    if (typeof data !== "string" || data.length > 4000) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.t === "join") {
      if (conn.pid) return;
      const tok = String(m.tok || "");
      if (tok.length < 16 || tok.length > 200 || (await sha(tok)).slice(0, 16) !== m.pid) { conn.send({ t: "err", code: "auth", m: "Identidad no válida." }); return; }
      await this.ensureDict();
      if (conn.pid) return;
      this.table.join(conn, m); return;
    }
    this.table.message(conn, m);
  }
  start() { clearTimeout(this.idle); if (!this.interval) this.interval = setInterval(() => this.table.tick(), 1000); }
  maybeStop() {
    if (this.table.conns.size) return;
    clearInterval(this.interval); this.interval = null; this.touchIdle();
  }
  touchIdle() {   // una mesa vacía durante 5 minutos deja de existir
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.table.conns.size) { this.created = false; this.mk(); } }, 5 * 60 * 1000);
  }
}

// ---------- ranking y avatares globales ----------
export class Hub {
  constructor(state) { this.s = state.storage; this.cache = null; this.cacheAt = 0; }
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    if (p === "/result" && req.method === "POST") {
      const r = await req.json();
      for (const pl of r.players || []) {
        const k = "p:" + pl.id, cur = (await this.s.get(k)) || { n: "", w: 0, g: 0 };
        cur.n = String(pl.name).slice(0, 16); cur.g += 1; if ((r.winners || []).includes(pl.id)) cur.w += 1;
        await this.s.put(k, cur);
      }
      this.cache = null; return new Response("ok");
    }
    if (p === "/ranking") {
      if (!this.cache || Date.now() - this.cacheAt > 15000) {
        const all = await this.s.list({ prefix: "p:", limit: 5000 }), arr = [];
        for (const [k, v] of all) arr.push({ id: k.slice(2), n: v.n, w: v.w, g: v.g });
        arr.sort((a, b) => b.w - a.w || a.g - b.g);
        const top = arr.slice(0, 20);
        for (const r of top) r.v = (await this.s.get("v:" + r.id)) || 0;
        this.cache = top; this.cacheAt = Date.now();
      }
      return json(this.cache);
    }
    if (p === "/avatar" && req.method === "POST") {
      const pid = url.searchParams.get("pid") || "", b = new Uint8Array(await req.arrayBuffer());
      if (!/^[0-9a-f]{16}$/.test(pid) || b.length < 100 || b.length > 60000) return json({ error: "size" }, 400);
      const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e, jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
      const webp = b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
      if (!png && !jpg && !webp) return json({ error: "type" }, 400);
      const v = Date.now();
      await this.s.put("a:" + pid, { ct: png ? "image/png" : jpg ? "image/jpeg" : "image/webp", d: b });
      await this.s.put("v:" + pid, v); this.cache = null;
      return json({ v });
    }
    if (p.startsWith("/avatar/")) {
      const a = await this.s.get("a:" + p.slice(8));
      if (!a) return new Response("nf", { status: 404 });
      return new Response(a.d, { headers: { "content-type": a.ct, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    }
    return new Response("nf", { status: 404 });
  }
}

// ---------- puerta de entrada ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (!(p.startsWith("/api/") || p === "/ws")) return env.ASSETS.fetch(req);
    const o = req.headers.get("Origin");
    if (o) { try { if (new URL(o).host !== url.host) return new Response("origin", { status: 403 }); } catch { return new Response("origin", { status: 403 }); } }
    const hub = env.HUB.get(env.HUB.idFromName("global"));
    if (p === "/ws") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      if (!CODE_RE.test(code)) return new Response("code", { status: 400 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("ws", { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(req);
    }
    if (p === "/api/create" && req.method === "POST") {
      for (let i = 0; i < 8; i++) {
        let code = ""; const r = crypto.getRandomValues(new Uint8Array(5)); for (const x of r) code += ALPHA[x % ALPHA.length];
        const res = await env.ROOM.get(env.ROOM.idFromName(code)).fetch("https://room/init?code=" + code, { method: "POST" });
        if (res.ok) return json({ code });
      }
      return json({ error: "busy" }, 503);
    }
    if (p === "/api/ranking") return hub.fetch("https://hub/ranking");
    if (p === "/api/avatar" && req.method === "POST") {
      const tok = req.headers.get("x-tok") || "";
      if (tok.length < 16 || tok.length > 200) return json({ error: "auth" }, 400);
      if (Number(req.headers.get("content-length") || 0) > 80000) return json({ error: "size" }, 413);
      return hub.fetch("https://hub/avatar?pid=" + (await sha(tok)).slice(0, 16), { method: "POST", body: await req.arrayBuffer() });
    }
    if (p.startsWith("/api/avatar/")) {
      const pid = p.slice(12);
      if (!/^[0-9a-f]{16}$/.test(pid)) return new Response("nf", { status: 404 });
      return hub.fetch("https://hub/avatar/" + pid);
    }
    return new Response("nf", { status: 404 });
  },
};
