// Motor de la mesa. Todo el estado y las reglas viven aquí (servidor): los clientes solo envían
// intenciones y reciben su vista. Las cartas ocultas, los votos y los tiempos nunca salen de aquí.
const ROUND = 15, REVEAL = 5, LIVES = 3, MAX_SEATED = 12, MAX_TOTAL = 16, SPIN = 7;
const LB = { MAX: 4, HAND: 5, TURN: 20, DEAL: 4, REVEAL: 6, SHOT: 5, CH: 6, AWAY: 5 };
const BJ = { PLAY: 25, RES: 6, BET: 10, START: 100 };
const DUEL = { MIN: 2000, MAX: 6000, FIRE: 4, RES: 4 };
const MODES = ["chain", "roul", "liars", "bj", "duel"];
const RARITY = [
  { w: 5, L: "ACELMPRST" }, { w: 4, L: "BDFINO" }, { w: 3, L: "GHUV" }, { w: 2, L: "JYZ" }, { w: 1, L: "ÑQX" },
];

export const norm = (w) => String(w).trim().toLowerCase().replace(/ñ/g, "\u0001").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0001/g, "ñ");
const lastLetter = (w) => norm(w).slice(-1);
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const shuffle = (a, rand) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function weightedLetter(rand, used) {
  const pool = [];
  for (const r of RARITY) for (const l of r.L) if (!used.includes(l.toLowerCase())) pool.push([l, r.w]);
  if (!pool.length) { used.length = 0; return weightedLetter(rand, used); }
  let x = rand() * pool.reduce((s, p) => s + p[1], 0);
  for (const [l, w] of pool) { if ((x -= w) < 0) return l.toLowerCase(); }
  return pool[0][0].toLowerCase();
}

// ---- blackjack ----
const SUITS = ["♠", "♥", "♦", "♣"], RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const newDeck = (rand) => { const d = []; for (let k = 0; k < 2; k++) for (const s of SUITS) for (const r of RANKS) d.push(r + s); return shuffle(d, rand); };
export function bjScore(cards) {
  let t = 0, aces = 0;
  for (const c of cards) { const r = c.slice(0, -1); if (r === "A") { aces++; t += 11; } else t += "JQK".includes(r) ? 10 : parseInt(r, 10); }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}

export class Table {
  // io: { dict(word)->bool|null, report(info), now(), rand(), later(fn, ms)->handle, clear(handle) }
  constructor(io) {
    this.io = Object.assign({ dict: null, report: () => {}, now: Date.now, rand: Math.random, later: setTimeout, clear: clearTimeout }, io);
    this.code = ""; this.P = new Map(); this.conns = new Set(); this.chat = []; this.cid = 0;
    this.priv = {}; this.g = this.fresh(1); this.timer = null; this.lastEmpty = 0;
  }
  fresh(gid) {
    return { gid, mode: "chain", total: 5, phase: "lobby", r: 0, t: 0, turn: "", letter: "", word: "", hist: [], used: [], yes: 0, no: 0, voted: 0,
      res: "", lost: false, rep: 0, falta: 0, win: [], spin: 0, props: [], tally: [], wi: [], subs: 0, rm: 0, lb: null, bj: null, gs: null };
  }
  rand() { return this.io.rand(); }
  seated() { return [...this.P.values()].filter((p) => !p.spec); }
  live() { return this.seated().filter((p) => p.conn); }
  get(id) { return this.P.get(id); }

  // ---------- conexión ----------
  open(conn) { conn.id = ++this.cid; conn.pid = null; conn.tokens = 30; conn.lastChat = 0; this.conns.add(conn); }
  join(conn, m) {
    const pid = String(m.pid || ""), name = clean(m.name, 16) || "Jugador", av = Math.max(0, parseInt(m.av, 10) || 0);
    let p = this.P.get(pid);
    if (p) {
      if (p.conn && p.conn !== conn) { p.conn.send({ t: "err", code: "other", m: "Has abierto la mesa en otro sitio." }); p.conn.pid = null; try { p.conn.close(); } catch {} }
      p.conn = conn; p.name = name; p.av = av; p.left = 0;
    } else {
      if (this.P.size >= MAX_TOTAL) { conn.send({ t: "err", code: "full", m: "La mesa está llena." }); return; }
      const inGame = !["lobby", "over"].includes(this.g.phase);
      p = { id: pid, name, av, conn, spec: inGame, lives: LIVES, f: 0, pts: 0, chips: BJ.START, left: 0 };
      this.P.set(pid, p);
    }
    conn.pid = pid;
    conn.send({ t: "chatlog", list: this.chat });
    this.pushAll();
  }
  profile(p, m) { p.name = clean(m.name, 16) || p.name; p.av = Math.max(0, parseInt(m.av, 10) || 0); this.pushAll(); }
  close(conn) {
    this.conns.delete(conn);
    const p = conn.pid && this.P.get(conn.pid);
    if (p && p.conn === conn) { p.conn = null; p.left = this.io.now(); this.afterLeave(p); }
    if (!this.conns.size) this.lastEmpty = this.io.now();
    this.pushAll();
  }
  // una desconexión puede desbloquear una fase que esperaba a todos
  afterLeave(p) { this.checkAll(); if (this.g.phase === "over") this.checkRematch(); }

  // ---------- entrada de mensajes ----------
  message(conn, m) {
    if (!m || typeof m !== "object" || typeof m.t !== "string") return;
    if (conn.tokens < 1) return;   // límite de mensajes por segundo (se rellena en tick())
    conn.tokens--;
    const p = conn.pid && this.P.get(conn.pid);
    if (!p || p.conn !== conn) return;
    const g = this.g;
    switch (m.t) {
      case "profile": return this.profile(p, m);
      case "chat": return this.onChat(conn, p, m);
      case "start": return this.onStart(conn, p, m);
      case "word": return this.onWord(conn, p, m);
      case "vote": return this.onVote(p, m);
      case "pick": return this.onPick(p, m);
      case "lb": return this.onLb(p, m);
      case "bj": return this.onBj(p, m);
      case "shoot": return this.onShoot(p);
      case "rematch": return this.onRematch(p);
      case "lobby": if (g.phase === "over" && !p.spec) { this.toLobby(); } return;
    }
  }
  err(p, text, code) { if (p.conn) p.conn.send({ t: "err", code: code || "msg", m: text }); }
  onChat(conn, p, m) {
    const now = this.io.now(); if (now - conn.lastChat < 700) return; conn.lastChat = now;
    const text = clean(m.m, 200); if (!text) return;
    const msg = { id: now + "-" + p.id.slice(0, 4), p: p.id, n: p.name, tx: text, ts: now };
    this.chat.push(msg); if (this.chat.length > 40) this.chat.shift();
    for (const c of this.conns) c.send({ t: "chat", m: msg });
  }

  // ---------- inicio y fin ----------
  onStart(conn, p, m) {
    if (this.g.phase !== "lobby" || p.spec) return;
    const mode = MODES.includes(m.mode) ? m.mode : "chain";
    if (this.live().length < 2) return this.err(p, "Hacen falta al menos 2 jugadores.");
    this.begin(mode, Math.min(15, Math.max(1, parseInt(m.n, 10) || 5)));
  }
  begin(mode, total) {
    for (const p of [...this.P.values()]) if (!p.conn && !p.spec) this.P.delete(p.id);
    const gid = this.g.gid; this.clearTimer();
    this.g = this.fresh(gid); const g = this.g; this.priv = {};
    Object.assign(g, { mode, total, r: 1 });
    const seated = this.seated(); seated.forEach((p) => { p.lives = LIVES; p.f = 0; p.pts = 0; p.chips = BJ.START; });
    g.ids = seated.map((p) => p.id);
    if (mode === "roul") this.spinRound();
    else if (mode === "liars") { this.lbStart(); g.ids = g.lb.p.map((s) => s.id); }
    else if (mode === "bj") this.bjDeal();
    else if (mode === "duel") this.duelRound();
    else { g.turn = seated[0].id; g.phase = "write"; g.t = ROUND; this.priv.votes = {}; }
    this.pushAll();
  }
  toLobby() {
    const gid = this.g.gid + 1; this.clearTimer(); this.g = this.fresh(gid); this.priv = {};
    for (const p of [...this.P.values()]) { p.spec = false; if (!p.conn) this.P.delete(p.id); }
    this.pushAll();
  }
  finish(win) {
    const g = this.g; if (g.phase === "over") return;
    g.phase = "over"; g.t = 0; g.win = win; this.clearTimer(); this.priv.rematch = new Set(); g.rm = 0;
    const ids = (g.ids || []).filter((id) => this.P.has(id));
    if (ids.length >= 2) this.io.report({ mode: g.mode, players: ids.map((id) => ({ id, name: this.P.get(id).name })), winners: win.filter((id) => ids.includes(id)) });
    for (const p of this.P.values()) p.spec = false;   // los espectadores se sientan al acabar la partida
  }
  onRematch(p) {
    const g = this.g; if (g.phase !== "over" || p.spec) return;
    this.priv.rematch.add(p.id); this.checkRematch(); this.pushAll();
  }
  checkRematch() {
    const g = this.g; if (g.phase !== "over" || !this.priv.rematch) return;
    const live = this.live(); g.rm = live.filter((p) => this.priv.rematch.has(p.id)).length;
    if (live.length >= 2 && g.rm === live.length) { this.g.gid += 1; this.begin(g.mode, g.total); }
  }

  // ---------- palabras (cadena y ruleta) ----------
  wordError(word) {
    const g = this.g, n = norm(word);
    if (!/^[a-zñ]{2,24}$/.test(n)) return "Escribe una sola palabra, solo con letras.";
    if (g.letter && n[0] !== g.letter) return "Tiene que empezar por «" + g.letter.toUpperCase() + "».";
    if (g.hist.some((h) => norm(h) === n)) return "Esa palabra ya ha salido en esta partida.";
    if (this.io.dict && !this.io.dict(n)) return "No está en el diccionario.";
    return null;
  }
  onWord(conn, p, m) {
    const g = this.g; if (p.spec || g.phase !== "write" || typeof m.w !== "string") return;
    if (g.mode === "chain" && g.turn === p.id) {
      const e = this.wordError(m.w); if (e) return this.err(p, e, "word");
      g.word = m.w.trim().toLowerCase().slice(0, 24); g.phase = "vote"; g.t = ROUND; g.voted = 0; this.priv.votes = {};
      g.rep = g.letter && lastLetter(g.word) === g.letter ? 1 : 0;
      this.pushAll();
    } else if (g.mode === "roul") {
      const e = this.wordError(m.w); if (e) return this.err(p, e, "word");
      (this.priv.words = this.priv.words || {})[p.id] = m.w.trim().toLowerCase().slice(0, 24);
      g.subs = Object.keys(this.priv.words).length; this.checkAll(); this.pushAll();
    }
  }
  onVote(p, m) {
    const g = this.g; if (p.spec || g.mode !== "chain" || g.phase !== "vote" || g.turn === p.id) return;
    this.priv.votes[p.id] = m.v ? 1 : 0; g.voted = Object.keys(this.priv.votes).length; this.checkAll(); this.pushAll();
  }
  onPick(p, m) {
    const g = this.g; if (p.spec || g.mode !== "roul" || g.phase !== "vote") return;
    const i = Number(m.i); if (!Number.isInteger(i) || !g.props[i] || g.props[i].id === p.id) return;
    (this.priv.picks = this.priv.picks || {})[p.id] = i; g.voted = Object.keys(this.priv.picks).length; this.checkAll(); this.pushAll();
  }
  // ¿han actuado ya todos los que tienen que actuar? (se llama tras cada acción o desconexión)
  checkAll() {
    const g = this.g, live = this.live();
    if (g.mode === "chain" && g.phase === "vote") {
      const elig = live.filter((p) => p.id !== g.turn);
      if (elig.length && elig.every((p) => p.id in this.priv.votes)) this.chainTally();
    } else if (g.mode === "roul" && g.phase === "write") {
      if (live.length && live.every((p) => this.priv.words && p.id in this.priv.words)) this.roulWriteDone();
    } else if (g.mode === "roul" && g.phase === "vote") {
      if (live.length && live.every((p) => this.priv.picks && p.id in this.priv.picks)) this.roulTally();
    }
  }
  toReveal(res, lost) {
    const g = this.g; g.phase = "reveal"; g.t = REVEAL; g.res = res; g.lost = lost; g.falta = 0;
    const p = this.P.get(g.turn); if (!p) return;
    if (lost) p.lives = Math.max(0, p.lives - 1);
    if (g.rep) { p.f = (p.f || 0) + 1; if (p.f >= 2) { p.f = 0; p.lives = Math.max(0, p.lives - 1); g.falta = 2; } else g.falta = 1; }
  }
  chainTally() {
    const g = this.g; let yes = 0, no = 0;
    for (const id in this.priv.votes) { if (this.priv.votes[id]) yes++; else no++; }
    g.yes = yes; g.no = no; this.toReveal("vote", no > yes);
  }
  chainNext() {
    const g = this.g;
    if (g.word) { g.hist.push(g.word); if (g.hist.length > 40) g.hist.shift(); g.letter = lastLetter(g.word); }
    g.word = ""; g.yes = g.no = g.voted = 0; g.res = ""; g.lost = false; g.rep = 0; g.falta = 0; this.priv.votes = {};
    const seated = this.seated(), alive = seated.filter((p) => p.lives > 0);
    if (alive.length <= 1) return this.finish(alive.map((p) => p.id));
    const n = seated.length; let i = seated.findIndex((p) => p.id === g.turn);
    do { i = (i + 1) % n; } while (seated[i].lives <= 0);
    g.turn = seated[i].id; g.r += 1; g.phase = "write"; g.t = ROUND;
  }
  spinRound() {
    const g = this.g; g.letter = weightedLetter(() => this.rand(), g.used); g.used.push(g.letter);
    g.spin = Math.floor(this.rand() * 1e9); g.phase = "spin"; g.t = SPIN; g.props = []; g.tally = []; g.wi = []; g.voted = 0; g.subs = 0;
    this.priv.words = {}; this.priv.picks = {};
  }
  roulWriteDone() {
    const g = this.g, props = Object.entries(this.priv.words || {}).map(([id, w]) => ({ id, w }));
    shuffle(props, () => this.rand()); g.props = props; g.tally = props.map(() => 0); g.subs = 0; g.voted = 0; this.priv.picks = {};
    if (props.length < 2) { g.res = props.length ? "solo" : "none"; this.roulFinish(props.length ? [0] : []); }
    else { g.res = "vote"; g.phase = "vote"; g.t = ROUND; }
  }
  roulTally() {
    const g = this.g, tally = g.props.map(() => 0);
    for (const id in this.priv.picks) tally[this.priv.picks[id]]++;
    g.tally = tally; const max = Math.max(...tally);
    this.roulFinish(max > 0 ? tally.map((v, i) => (v === max ? i : -1)).filter((i) => i >= 0) : []);
  }
  roulFinish(idxs) {
    const g = this.g; g.phase = "reveal"; g.t = REVEAL + 2; g.wi = idxs;
    for (const i of idxs) {
      const p = this.P.get(g.props[i].id); if (p) p.pts = (p.pts || 0) + 1;
      g.hist.push(g.props[i].w); if (g.hist.length > 40) g.hist.shift();
    }
  }

  // ---------- Liars Bar ----------
  lbSeat(id) { return this.g.lb && this.g.lb.p.find((s) => s.id === id) || null; }
  lbAlive() { return this.g.lb.p.filter((s) => !s.out); }
  lbNextAfter(id, needCards) {
    const lb = this.g.lb, n = lb.p.length, i0 = lb.p.findIndex((s) => s.id === id);
    for (let k = 1; k < n; k++) { const s = lb.p[(i0 + k) % n]; if (!s.out && (!needCards || s.n > 0)) return s.id; }
    return null;
  }
  lbFirstAlive(id) { const s = this.lbSeat(id); return s && !s.out ? id : this.lbNextAfter(id, false); }
  lbMustCall(s) { const lb = this.g.lb; if (!lb.last || !s) return false; return s.n === 0 || this.lbAlive().every((o) => o.id === s.id || o.n === 0); }
  lbCanCall(s) { const lb = this.g.lb; return !!(lb.last && s && lb.last.id !== s.id); }
  lbStart() {
    const g = this.g, seats = this.live().slice(0, LB.MAX);
    g.lb = { p: seats.map((p) => ({ id: p.id, n: 0, sh: 0, out: 0 })), table: "", last: null, pile: 0, seq: 0, call: null, round: 0 };
    g.r = 0; this.priv.hands = {}; this.lbNewRound(seats[0].id);
  }
  lbNewRound(starter) {
    const g = this.g, lb = g.lb; g.r += 1; lb.round += 1;
    const deck = []; for (const c of "KQA") for (let i = 0; i < 6; i++) deck.push(c); deck.push("J", "J"); shuffle(deck, () => this.rand());
    lb.table = "KQA"[Math.floor(this.rand() * 3)]; this.priv.hands = {};
    for (const s of lb.p) { if (s.out) { s.n = 0; continue; } const hand = deck.splice(0, LB.HAND).join(""); this.priv.hands[s.id] = hand; s.n = hand.length; }
    lb.last = null; lb.pile = 0; lb.call = null; lb.seq += 1; this.priv.lastCards = "";
    g.turn = this.lbFirstAlive(starter); g.phase = "lbdeal"; g.t = LB.DEAL;
  }
  lbValid(s, cards) {
    if (typeof cards !== "string" || cards.length < 1 || cards.length > 3 || !/^[KQAJ]+$/.test(cards)) return false;
    if (this.lbMustCall(s)) return false;
    let hand = this.priv.hands[s.id] || "";
    for (const c of cards) { const i = hand.indexOf(c); if (i < 0) return false; hand = hand.slice(0, i) + hand.slice(i + 1); }
    return true;
  }
  lbPlay(s, cards, auto) {
    const g = this.g, lb = g.lb; let hand = this.priv.hands[s.id];
    for (const c of cards) { const i = hand.indexOf(c); hand = hand.slice(0, i) + hand.slice(i + 1); }
    this.priv.hands[s.id] = hand; s.n = hand.length; this.priv.lastCards = cards;
    lb.last = { id: s.id, n: cards.length, auto: auto ? 1 : 0 }; lb.pile += cards.length; lb.seq += 1;
    g.turn = this.lbNextAfter(s.id, true) || this.lbNextAfter(s.id, false); g.phase = "lbturn"; g.t = LB.TURN;
  }
  lbCall(s, auto) {
    const g = this.g, lb = g.lb, on = lb.last.id, shown = this.priv.lastCards;
    const lie = [...shown].some((c) => c !== lb.table && c !== "J");
    lb.call = { by: s.id, on, shown, lie: lie ? 1 : 0, shooter: lie ? on : s.id, bang: -1, auto: auto ? 1 : 0 };
    lb.seq += 1; g.phase = "lbreveal"; g.t = LB.REVEAL;
  }
  lbAuto(s) {
    const lb = this.g.lb;
    if (this.lbMustCall(s) || s.n === 0) { if (this.lbCanCall(s)) this.lbCall(s, true); return; }
    const hand = this.priv.hands[s.id];
    this.lbPlay(s, [...hand].find((c) => c === lb.table || c === "J") || hand[0], true);
  }
  onLb(p, m) {
    const g = this.g, lb = g.lb; if (g.mode !== "liars" || g.phase !== "lbturn" || !lb || g.turn !== p.id || m.s !== lb.seq) return;
    const s = this.lbSeat(p.id); if (!s || s.out) return;
    if (m.a === "call" && this.lbCanCall(s)) { this.lbCall(s, false); this.pushAll(); }
    else if (m.a === "play" && this.lbValid(s, m.c)) { this.lbPlay(s, m.c, false); this.pushAll(); }
  }
  lbTick() {
    const g = this.g, lb = g.lb; if (!lb) return this.finish([]);
    const down = () => --g.t <= 0;
    if (g.phase === "lbdeal") { if (down()) { g.phase = "lbturn"; g.t = LB.TURN; } }
    else if (g.phase === "lbturn") {
      const s = this.lbSeat(g.turn); if (!s || s.out) { g.turn = this.lbFirstAlive(g.turn); return; }
      const pl = this.P.get(g.turn); if ((!pl || !pl.conn) && g.t > LB.AWAY) g.t = LB.AWAY;
      if (down()) this.lbAuto(s);
    } else if (g.phase === "lbreveal") {
      if (down()) { const sh = this.lbSeat(lb.call.shooter); lb.call.bang = this.rand() < 1 / Math.max(1, LB.CH - sh.sh) ? 1 : 0; g.phase = "lbshot"; g.t = LB.SHOT; }
    } else if (g.phase === "lbshot") {
      if (down()) {
        const sh = this.lbSeat(lb.call.shooter); sh.sh += 1; if (lb.call.bang) sh.out = 1;
        const alive = this.lbAlive();
        if (alive.length <= 1) this.finish(alive.map((x) => x.id)); else this.lbNewRound(sh.id);
      }
    }
  }

  // ---------- Blackjack ----------
  draw() { const d = this.priv.deck; if (!d || d.length < 30) this.priv.deck = newDeck(() => this.rand()); return this.priv.deck.pop(); }
  bjDeal() {
    const g = this.g, seats = this.seated().filter((p) => g.ids.includes(p.id));
    const bj = { p: seats.map((p) => ({ id: p.id, c: [this.draw(), this.draw()], st: "play", res: "", d: 0 })), dealer: [this.draw(), this.draw()], reveal: false };
    for (const s of bj.p) { const pl = this.P.get(s.id); if (bjScore(s.c) === 21) s.st = "bj"; else if (!pl || !pl.conn) s.st = "stand"; }
    g.bj = bj; g.phase = "bjplay"; g.t = BJ.PLAY;
    if (bj.p.every((s) => s.st !== "play")) this.bjFinish();
  }
  onBj(p, m) {
    const g = this.g; if (g.mode !== "bj" || g.phase !== "bjplay") return;
    const s = g.bj.p.find((x) => x.id === p.id); if (!s || s.st !== "play") return;
    if (m.a === "hit") { s.c.push(this.draw()); const v = bjScore(s.c); if (v > 21) s.st = "bust"; else if (v === 21) s.st = "stand"; }
    else if (m.a === "stand") s.st = "stand"; else return;
    if (g.bj.p.every((x) => x.st !== "play")) this.bjFinish();
    this.pushAll();
  }
  bjFinish() {
    const g = this.g, bj = g.bj; bj.reveal = true;
    while (bjScore(bj.dealer) < 17) bj.dealer.push(this.draw());
    const dv = bjScore(bj.dealer), dbj = bj.dealer.length === 2 && dv === 21;
    for (const s of bj.p) {
      const v = bjScore(s.c);
      if (s.st === "bust") { s.res = "lose"; s.d = -BJ.BET; }
      else if (s.st === "bj") { if (dbj) { s.res = "push"; s.d = 0; } else { s.res = "bj"; s.d = Math.round(BJ.BET * 1.5); } }
      else if (dv > 21 || v > dv) { s.res = "win"; s.d = BJ.BET; }
      else if (v === dv && !dbj) { s.res = "push"; s.d = 0; }
      else { s.res = "lose"; s.d = -BJ.BET; }
      const p = this.P.get(s.id); if (p) { p.chips += s.d; p.pts = p.chips; }
    }
    g.phase = "bjres"; g.t = BJ.RES;
  }
  bjTick() {
    const g = this.g;
    if (g.phase === "bjplay") { if (--g.t <= 0) { for (const s of g.bj.p) if (s.st === "play") s.st = "stand"; this.bjFinish(); } }
    else if (g.phase === "bjres" && --g.t <= 0) {
      if (g.r >= g.total) {
        const ps = g.bj.p.map((s) => this.P.get(s.id)).filter(Boolean), max = Math.max(...ps.map((p) => p.chips));
        this.finish(ps.filter((p) => p.chips === max).map((p) => p.id));
      } else { g.r += 1; this.bjDeal(); }
    }
  }

  // ---------- Pistolero (duelo de reflejos) ----------
  clearTimer() { if (this.timer) { this.io.clear(this.timer); this.timer = null; } }
  duelRound() {
    const g = this.g; g.gs = { out: [], winner: "", ms: 0 }; g.phase = "duelwait"; g.t = 0;
    this.priv.fireAt = this.io.now() + DUEL.MIN + this.rand() * (DUEL.MAX - DUEL.MIN);
    this.clearTimer(); this.timer = this.io.later(() => this.duelFire(), this.priv.fireAt - this.io.now());
  }
  duelFire() {
    const g = this.g; this.clearTimer(); if (g.phase !== "duelwait") return;
    g.phase = "duelfire"; g.t = DUEL.FIRE; this.priv.fireTime = this.io.now(); this.pushAll();
  }
  onShoot(p) {
    const g = this.g; if (g.mode !== "duel" || p.spec || !g.gs || !g.ids.includes(p.id) || g.gs.out.includes(p.id)) return;
    if (g.phase === "duelwait") {
      g.gs.out.push(p.id);
      if (this.live().filter((x) => g.ids.includes(x.id)).every((x) => g.gs.out.includes(x.id))) { this.clearTimer(); this.duelEnd(); }
      this.pushAll();
    } else if (g.phase === "duelfire" && !g.gs.winner) {
      g.gs.winner = p.id; g.gs.ms = Math.max(1, this.io.now() - this.priv.fireTime); p.pts = (p.pts || 0) + 1; this.duelEnd(); this.pushAll();
    }
  }
  duelEnd() { const g = this.g; g.phase = "duelres"; g.t = DUEL.RES; }
  duelTick() {
    const g = this.g;
    if (g.phase === "duelwait") { if (this.io.now() >= this.priv.fireAt) this.duelFire(); }
    else if (g.phase === "duelfire") { if (--g.t <= 0) this.duelEnd(); }
    else if (g.phase === "duelres" && --g.t <= 0) {
      if (g.r >= g.total) {
        const ps = this.seated().filter((p) => g.ids.includes(p.id)), max = Math.max(...ps.map((p) => p.pts || 0));
        this.finish(max > 0 ? ps.filter((p) => (p.pts || 0) === max).map((p) => p.id) : []);
      } else { g.r += 1; this.duelRound(); }
    }
  }

  // ---------- reloj ----------
  tick() {
    const now = this.io.now(), g = this.g;
    for (const c of this.conns) c.tokens = Math.min(30, c.tokens + 15);
    if (["lobby", "over"].includes(g.phase)) {
      for (const p of [...this.P.values()]) if (!p.conn && p.left && now - p.left > 15000) this.P.delete(p.id);
      if (g.phase === "over") this.checkRematch();
    }
    const down = () => --g.t <= 0;
    if (g.mode === "liars" && !["lobby", "over"].includes(g.phase)) this.lbTick();
    else if (g.mode === "bj" && !["lobby", "over"].includes(g.phase)) this.bjTick();
    else if (g.mode === "duel" && !["lobby", "over"].includes(g.phase)) this.duelTick();
    else if (g.mode === "chain") {
      if (g.phase === "write") { const tp = this.P.get(g.turn); if (tp && !tp.conn && g.t > 3) g.t = 3; if (down()) this.toReveal("timeout", true); }
      else if (g.phase === "vote") { if (down()) this.chainTally(); }
      else if (g.phase === "reveal") { if (down()) this.chainNext(); }
    } else if (g.mode === "roul") {
      if (g.phase === "spin") { if (down()) { g.phase = "write"; g.t = ROUND; this.priv.words = {}; g.subs = 0; } }
      else if (g.phase === "write") { if (down()) this.roulWriteDone(); }
      else if (g.phase === "vote") { if (down()) this.roulTally(); }
      else if (g.phase === "reveal" && down()) {
        if (g.r >= g.total) {
          const ps = this.seated().filter((p) => g.ids.includes(p.id)), max = Math.max(...ps.map((p) => p.pts || 0));
          this.finish(max > 0 ? ps.filter((p) => (p.pts || 0) === max).map((p) => p.id) : []);
        } else { g.r += 1; this.spinRound(); }
      }
    }
    this.pushAll();
  }

  // ---------- vistas ----------
  view(p) {
    const g = this.g, pg = Object.assign({}, g);
    if (g.bj && !g.bj.reveal) pg.bj = Object.assign({}, g.bj, { dealer: [g.bj.dealer[0], "?"] });
    const my = {};
    if (g.mode === "liars") my.hand = (this.priv.hands && this.priv.hands[p.id]) || "";
    if (g.mode === "chain" && this.priv.votes && p.id in this.priv.votes) my.vote = this.priv.votes[p.id];
    if (g.mode === "roul") { if (this.priv.picks && p.id in this.priv.picks) my.pick = this.priv.picks[p.id]; if (this.priv.words && this.priv.words[p.id]) my.sent = this.priv.words[p.id]; }
    if (g.phase === "over" && this.priv.rematch) my.rm = this.priv.rematch.has(p.id) ? 1 : 0;
    return { t: "state", me: p.id, code: this.code, spec: p.spec, g: pg, my,
      players: [...this.P.values()].map((q) => ({ id: q.id, name: q.name, av: q.av, lives: q.lives, f: q.f, pts: q.pts, chips: q.chips, away: !q.conn, spec: q.spec })) };
  }
  pushAll() {
    for (const c of this.conns) { const p = c.pid && this.P.get(c.pid); if (p && p.conn === c) c.send(this.view(p)); }
  }
}
