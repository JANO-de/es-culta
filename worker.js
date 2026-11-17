export class Room {
  constructor(state, env) { this.peers = new Map(); }
  async fetch(request) {
    const b = await request.json();
    const now = Date.now();
    if (b.bye) this.peers.delete(b.id);
    else if (typeof b.id === "string" && b.id.length < 64 && typeof b.s === "number" && b.p && typeof b.p === "object")
      this.peers.set(b.id, { p: b.p, s: b.s, at: now });
    for (const [k, v] of this.peers) if (now - v.at > 10000) this.peers.delete(k);
    const peers = [...this.peers].map(([id, v]) => ({ id, p: v.p, s: v.s }));
    return Response.json({ peers });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/sync") {
      if (req.method !== "POST") return new Response("method", { status: 405 });
      const text = await req.text();
      if (text.length > 50000) return new Response("big", { status: 413 });
      let b;
      try { b = JSON.parse(text); } catch { return new Response("bad", { status: 400 }); }
      if (!b || !/^[a-z0-9]{4,12}$/.test(b.code || "")) return new Response("bad", { status: 400 });
      const stub = env.ROOM.get(env.ROOM.idFromName(b.code));
      return stub.fetch("https://room/", { method: "POST", body: text });
    }
    return env.ASSETS.fetch(req);
  },
};
