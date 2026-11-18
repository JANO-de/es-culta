"use strict";
// ¿Es culta? · cliente. Toda la lógica de las partidas está en el servidor (engine.js):
// aquí solo se envían intenciones con send() y se pinta el estado S que llega cada segundo.

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- identidad: el id público es el hash de un secreto que nunca sale del dispositivo ----------
let tok = store.get("culta.tok"), pid = "";
if (!tok) { tok = crypto.randomUUID() + crypto.randomUUID(); store.set("culta.tok", tok); }
const sha16 = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

// ---------- estado ----------
let S = null, G = null;                 // último estado del servidor y su parte de partida
let ws = null, status = "home";         // home | connecting | ready | retry
let tableCode = store.get("culta.table") || "";
let myName = (store.get("culta.name") || "").slice(0, 16), myAv = Number(store.get("culta.av")) || 0;
let notice = "", codeDraft = "", toastText = "", roundsPick = 5, rank = [], rankKey = 0, installEvt = null;
let chat = [], lastMsg = 0, tries = 0, retryT = null, stageKey = "", sideKey = "";

// ---------- red ----------
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function connect() {
  clearTimeout(retryT);
  const old = ws; if (old) { old.onclose = null; try { old.close(); } catch {} }
  status = "connecting";
  const sock = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?code=" + encodeURIComponent(tableCode));
  ws = sock; lastMsg = Date.now();
  sock.onopen = () => { tries = 0; send({ t: "join", pid, tok, name: myName, av: myAv }); };
  sock.onmessage = (ev) => { lastMsg = Date.now(); let m; try { m = JSON.parse(ev.data); } catch { return; } onMsg(m); };
  sock.onclose = () => {
    if (ws !== sock) return; ws = null;
    if (!tableCode) return;
    status = "retry"; retryT = setTimeout(connect, Math.min(5000, 700 * ++tries)); paint();
  };
  paint();
}
function onMsg(m) {
  if (m.t === "state") { S = m; G = m.g; status = "ready"; paint(); }
  else if (m.t === "chatlog") { chat = m.list || []; paintChat(); }
  else if (m.t === "chat") { chat.push(m.m); if (chat.length > 40) chat.shift(); paintChat(); }
  else if (m.t === "err") {
    if (["no_table", "other", "full", "auth"].includes(m.code)) leave(m.m);
    else if (m.code === "word" && $("wordErr")) $("wordErr").textContent = m.m;
    else toast(m.m);
  }
}
function enter(code) {
  tableCode = code; store.set("culta.table", code); S = G = null; chat = []; tries = 0; connect();
}
function leave(msg) {
  tableCode = ""; store.set("culta.table", ""); clearTimeout(retryT);
  const w = ws; ws = null; if (w) { w.onclose = null; try { w.close(); } catch {} }
  S = G = null; chat = []; status = "home"; notice = msg || ""; stageKey = sideKey = ""; paint(); loadRank();
}
function toast(t) { toastText = t; paint(); setTimeout(() => { if (toastText === t) { toastText = ""; paint(); } }, 3500); }
setInterval(() => {   // vigilante: el servidor emite cada segundo; si se calla, reconectamos
  if (tableCode && ws && ws.readyState === 1 && Date.now() - lastMsg > 6000) { try { ws.close(); } catch {} }
  if (tableCode && !ws && !retryT) connect();
}, 2000);
addEventListener("visibilitychange", () => { if (!document.hidden && tableCode && (!ws || ws.readyState > 1)) connect(); });

async function createTable() {
  try { const r = await fetch("/api/create", { method: "POST" }); const j = await r.json(); if (!j.code) throw 0; enter(j.code); }
  catch { notice = "No se pudo crear la mesa. Inténtalo de nuevo."; paint(); }
}
async function loadRank() {
  try { const r = await fetch("/api/ranking"); if (r.ok) { rank = await r.json(); rankKey++; if (!tableCode || (G && G.phase === "lobby")) paint(); } } catch {}
}
async function pickAvatar(file) {
  try {
    const bmp = await createImageBitmap(file), s = 128, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const m = Math.min(bmp.width, bmp.height); cv.getContext("2d").drawImage(bmp, (bmp.width - m) / 2, (bmp.height - m) / 2, m, m, 0, 0, s, s);
    let blob = await new Promise((r) => cv.toBlob(r, "image/webp", 0.8));
    if (!blob || blob.type !== "image/webp") blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.82));
    const r = await fetch("/api/avatar", { method: "POST", headers: { "x-tok": tok }, body: blob }), j = await r.json();
    if (!r.ok || !j.v) throw 0;
    myAv = j.v; store.set("culta.av", String(myAv)); notice = ""; paint();
  } catch { notice = "No se pudo subir la foto."; paint(); }
}

// ---------- utilidades de pintado ----------
const HUES = ["#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#fe8019"];
const hueOf = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0; return HUES[Math.abs(h) % HUES.length]; };
function avatar(id, name, av, size) {
  const ini = esc((String(name || "?").trim()[0] || "?").toUpperCase());
  const img = av ? `<img src="/api/avatar/${esc(id)}?v=${av | 0}" alt="" loading="lazy" onerror="this.remove()">` : "";
  return `<span class="av" style="--s:${size || 32}px;--c:${hueOf(id)}"><b>${ini}</b>${img}</span>`;
}
const pname = (id) => { const p = S && S.players.find((x) => x.id === id); return p ? p.name : "Alguien"; };
const lemma = (w) => esc(w.slice(0, -1)) + "<b>" + esc(w.slice(-1)) + "</b>";
const ROUND = 15;
const RARITY = [
  { n: "Común", c: "#83a598", w: 5, L: "ACELMPRST" }, { n: "Poco común", c: "#8f3f71", w: 4, L: "BDFINO" },
  { n: "Rara", c: "#d3869b", w: 3, L: "GHUV" }, { n: "Muy rara", c: "#fb4934", w: 2, L: "JYZ" }, { n: "Legendaria", c: "#fabd2f", w: 1, L: "ÑQX" },
];
const rarityOf = (l) => RARITY.find((r) => r.L.includes(String(l).toUpperCase())) || RARITY[0];
const rarTag = (l) => { const r = rarityOf(l); return `<span class="rar" style="--rc:${r.c}">${r.n}</span>`; };
const timerHTML = (label, max) => `<div><div class="meta"><span>${label}</span><span><span id="tnum">${G.t}</span> s</span></div>
  <div class="bar" id="bar" data-max="${max || ROUND}"><i style="width:${(G.t / (max || ROUND)) * 100}%"></i></div></div>`;
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function weightedLetter(rand) {
  const pool = []; for (const r of RARITY) for (const l of r.L) pool.push([l, r.w]);
  let x = rand() * pool.reduce((s, p) => s + p[1], 0);
  for (const [l, w] of pool) { if ((x -= w) < 0) return l.toLowerCase(); }
  return "a";
}
const RULES = `<ul class="rules">
  <li><strong>Cadena:</strong> por turnos, cada jugador escribe una palabra en 15 segundos que empiece por la última letra de la anterior. Tiene que estar en el diccionario; los demás votan si es culta y, si gana el no, pierde una vida.</li>
  <li>Si tu palabra acaba en la misma letra con la que empieza, te llevas una falta. Dos faltas, una vida menos. Quedarse sin escribir también cuesta una vida.</li>
  <li><strong>Ruleta:</strong> sale una letra, todos escriben a la vez y luego se vota la más culta. La ganadora suma un punto.</li>
  <li><strong>Liars Bar:</strong> de 2 a 4 jugadores. Juras que tus cartas boca abajo son la carta de la mesa; si te gritan «¡mentiroso!» y te pillan, te toca el revólver.</li>
  <li><strong>Blackjack:</strong> contra la banca, apuesta fija de 10 fichas por ronda. Gana quien tenga más fichas al final.</li>
  <li><strong>Pistolero:</strong> espera a la señal y dispara el primero. Disparar antes de tiempo es falta. Gana quien más rondas se lleve.</li>
  <li>Si entras con la partida empezada, miras hasta que termine.</li>
</ul>`;

// ---------- vistas ----------
function homeView() {
  const rows = rank.length ? rank.map((r, i) => `<li class="${i < 3 ? "win" : ""}"><span class="rk">${i + 1}</span>${avatar(r.id, r.n, r.v, 28)}<span class="w">${esc(r.n)}</span><span class="n">${r.w} ${r.w === 1 ? "victoria" : "victorias"}</span></li>`).join("") : '<li class="muted">Aún no hay partidas.</li>';
  return ["home|" + notice + "|" + myAv + "|" + rankKey + "|" + (installEvt ? 1 : 0), `
    <div class="homehead">
      <label class="avpick" title="Cambiar foto"><input type="file" id="avFile" accept="image/*" hidden>${avatar(pid, myName || "?", myAv, 56)}<span>Foto</span></label>
      <input type="text" id="nameInput" maxlength="16" autocomplete="off" placeholder="Tu nombre" aria-label="Tu nombre" value="${esc(myName)}">
    </div>
    <div class="homeacts">
      <button class="primary" type="button" data-act="create">Crear mesa</button>
      <form id="joinForm" class="row"><input type="text" id="codeInput" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Código de mesa" aria-label="Código de mesa" value="${esc(codeDraft)}">
      <button type="submit">Unirse</button></form>
    </div>
    <p class="err">${esc(notice)}</p>
    ${installEvt ? '<div><button class="small" type="button" data-act="install">Instalar app en el móvil</button></div>' : ""}
    <h2>Ranking</h2><ul class="results">${rows}</ul>${RULES}`];
}
function lobbyView(g) {
  const n = S.players.filter((p) => !p.away).length, ok = n >= 2;
  const opts = [3, 5, 8, 10].map((v) => `<option value="${v}" ${v === roundsPick ? "selected" : ""}>${v} rondas</option>`).join("");
  const top = rank.slice(0, 3).map((r, i) => `<li class="${i === 0 ? "win" : ""}"><span class="rk">${i + 1}</span>${avatar(r.id, r.n, r.v, 24)}<span class="w">${esc(r.n)}</span><span class="n">${r.w}</span></li>`).join("");
  return ["lobby|" + g.gid + "|" + ok + "|" + roundsPick + "|" + S.code + "|" + rankKey, `
    <div class="codebox"><div><p class="muted">Código de la mesa</p><div class="codebig">${esc(S.code)}</div></div>
      <button class="small" type="button" data-act="copycode">Copiar código</button></div>
    <p class="lead">${ok ? "Todo listo. Cualquiera puede elegir modo y empezar." : "Esperando a que llegue alguien más."}</p>
    ${ok ? "" : '<p class="muted">Hacen falta al menos 2 jugadores. Pásales el código: lo escriben en «Unirse».</p>'}
    <div class="row"><label for="roundsSel" class="muted">Rondas (ruleta, blackjack, pistolero)</label><select id="roundsSel">${opts}</select></div>
    <div class="modes">
      <div class="mode"><h3>Cadena</h3><p>Por turnos y con 3 vidas. Cada palabra empieza por la última letra de la anterior.</p><button class="primary" type="button" data-go="chain" ${ok ? "" : "disabled"}>Jugar cadena</button></div>
      <div class="mode"><h3>Ruleta</h3><p>Letra al azar, todos escriben a la vez y gana la más culta.</p><button class="primary" type="button" data-go="roul" ${ok ? "" : "disabled"}>Jugar ruleta</button></div>
      <div class="mode"><h3>Blackjack</h3><p>Contra la banca. 100 fichas, 10 por ronda: plántate o pide.</p><button class="primary" type="button" data-go="bj" ${ok ? "" : "disabled"}>Jugar blackjack</button></div>
      <div class="mode"><h3>Pistolero</h3><p>Duelo de reflejos: dispara tras la señal, nunca antes.</p><button class="primary" type="button" data-go="duel" ${ok ? "" : "disabled"}>Jugar pistolero</button></div>
      <div class="mode lb-mode"><h3>Liars Bar</h3><p>De 2 a 4 jugadores. Cartas boca abajo, faroles, «¡mentiroso!» y un revólver de seis recámaras. Si hay más, el resto mira.</p>
        <button class="primary" type="button" data-go="liars" ${ok ? "" : "disabled"}>Jugar Liars Bar</button></div>
    </div>
    ${top ? `<h2>Ranking · top 3</h2><ul class="results">${top}</ul>` : ""}${RULES}`];
}
function chainView(g) {
  const myTurn = g.turn === pid, who = esc(pname(g.turn)), L = g.letter ? g.letter.toUpperCase() : "", spec = S.spec;
  if (g.phase === "write") {
    const key = ["write", g.gid, g.r, myTurn && !spec].join("|");
    if (myTurn && !spec) return [key, `${timerHTML("Ronda " + g.r + " · te toca escribir")}
      ${L ? `<p class="lead">Escribe una palabra que empiece por</p><div class="letter">${esc(L)}</div><p class="muted">Si también acaba en ${esc(L)}, te llevas una falta.</p>` : '<p class="lead">Abres la partida: escribe la palabra que quieras.</p>'}
      <form id="wordForm" class="row"><input type="text" id="wordInput" maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Tu palabra"><button class="primary" type="submit">Enviar</button></form><p class="err" id="wordErr"></p>`];
    return [key, `${timerHTML("Ronda " + g.r)}<p class="lead">${who} está pensando una palabra${L ? " que empiece por" : ""}…</p>${L ? `<div class="letter">${esc(L)}</div>` : ""}`];
  }
  if (g.phase === "vote") {
    const v = S.my.vote === undefined ? null : S.my.vote, key = ["vote", g.gid, g.r, myTurn, spec, v].join("|");
    const head = `${timerHTML("Ronda " + g.r + " · votación")}<div><div class="lemma">${lemma(g.word)}</div><p class="gloss">palabra propuesta por ${who}</p></div>`;
    if (myTurn) return [key, head + `<p class="lead">Los demás están votando si es culta.</p><p class="muted">Votos emitidos: <span id="voted">${g.voted}</span></p>`];
    if (spec) return [key, head + `<p class="muted">Votos emitidos: <span id="voted">${g.voted}</span></p>`];
    return [key, head + `<div class="votes"><button class="y" type="button" data-v="1" aria-pressed="${v === 1}">Es culta</button><button class="n" type="button" data-v="0" aria-pressed="${v === 0}">No es culta</button></div>
      <p class="muted">${v === null ? "Elige antes de que acabe el tiempo." : "Voto registrado. Puedes cambiarlo mientras quede tiempo."} Votos emitidos: <span id="voted">${g.voted}</span></p>`];
  }
  const p = S.players.find((x) => x.id === g.turn), outNow = p && p.lives <= 0;
  const lifeMsg = g.lost ? `${who} pierde una vida.` : g.res === "vote" ? `${who} conserva sus vidas por la votación.` : "";
  const faltaMsg = g.falta === 1 ? `Falta para ${who} por repetir la ${esc(L)}. A la segunda falta, pierde una vida.` : g.falta === 2 ? `Segunda falta para ${who} por repetir la ${esc(L)}: pierde una vida.` : "";
  const tail = `${lifeMsg ? `<p>${lifeMsg}</p>` : ""}${faltaMsg ? `<p class="falta">${faltaMsg}</p>` : ""}${outNow ? `<p><strong>${who} se queda sin vidas y cae eliminado.</strong></p>` : ""}`;
  const key = "reveal|" + g.gid + "|" + g.r;
  if (g.res === "timeout") return [key, `<p class="lead">Se acabó el tiempo y no hay palabra.</p>${tail}`];
  return [key, `<div><div class="lemma">${lemma(g.word)}</div><p class="gloss">palabra propuesta por ${who}</p></div>
    <div class="stamp ${g.lost ? "n" : "y"}">${g.lost ? "No es culta" : "Culta"}</div>
    <p>${g.yes} ${g.yes === 1 ? "voto" : "votos"} a favor · ${g.no} en contra${g.yes === g.no ? " · el empate salva la palabra" : ""}</p>${tail}`];
}
function roulView(g) {
  const L = g.letter.toUpperCase(), label = "Ronda " + g.r + " de " + g.total, spec = S.spec;
  if (g.phase === "spin") return ["spin|" + g.gid + "|" + g.r, `<div class="meta"><span>${label} · ruleta</span></div>
    <div class="case" id="case"><div class="strip" id="strip"></div></div><p class="lead" id="spinRes">Girando la ruleta…</p>`];
  if (g.phase === "write") {
    return ["rwrite|" + g.gid + "|" + g.r + "|" + spec, `${timerHTML(label + " · todos escriben")}
      <div class="letterline"><div class="letter">${esc(L)}</div>${rarTag(L)}</div>
      ${spec ? '<p class="lead">Los jugadores están escribiendo.</p>' : `<p class="lead">Escribe la palabra más culta que se te ocurra con la ${esc(L)}.</p>
      <form id="wordForm" class="row"><input type="text" id="wordInput" maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Tu propuesta"><button class="primary" type="submit">Enviar</button></form><p class="err" id="wordErr"></p>`}
      <p class="muted" id="subInfo"></p>`];
  }
  if (g.phase === "vote") {
    const pick = S.my.pick === undefined ? null : S.my.pick;
    const list = g.props.map((p, i) => p.id === pid ? `<button type="button" disabled>${esc(p.w)}<span class="own">tu propuesta</span></button>`
      : `<button type="button" data-pick="${i}" aria-pressed="${pick === i}" ${spec ? "disabled" : ""}>${esc(p.w)}</button>`).join("");
    return ["rvote|" + g.gid + "|" + g.r + "|" + pick + "|" + spec, `${timerHTML(label + " · votación")}
      <p class="lead">${spec ? "Los jugadores están votando." : "¿Cuál es la más culta? No puedes votar la tuya."}</p><div class="opts">${list}</div>
      <p class="muted">${spec ? "" : pick === null ? "Elige antes de que acabe el tiempo. " : "Voto registrado. Puedes cambiarlo mientras quede tiempo. "}Votos emitidos: <span id="voted">${g.voted}</span></p>`];
  }
  const key = "rreveal|" + g.gid + "|" + g.r;
  if (g.res === "none") return [key, `<div class="letterline"><div class="letter">${esc(L)}</div>${rarTag(L)}</div><p class="lead">Nadie escribió una palabra válida. Esta ronda no suma puntos.</p>`];
  const order = g.props.map((p, i) => i).sort((a, b) => (g.tally[b] || 0) - (g.tally[a] || 0));
  const rows = order.map((i) => { const p = g.props[i], n = g.tally[i] || 0;
    return `<li class="${g.wi.includes(i) ? "win" : ""}"><span class="w">${esc(p.w)} <span class="by">de ${esc(pname(p.id))}</span></span><span class="n">${g.res === "solo" ? "sin rival" : n + (n === 1 ? " voto" : " votos")}</span></li>`; }).join("");
  const head = g.res === "solo" ? "Solo hubo una propuesta: gana sin votación." : g.wi.length === 0 ? "Nadie votó. Esta ronda no suma puntos."
    : g.wi.length > 1 ? "Empate: todas las más votadas suman un punto." : `Gana la propuesta de ${esc(pname(g.props[g.wi[0]].id))}.`;
  return [key, `<div class="letterline"><div class="letter">${esc(L)}</div>${rarTag(L)}</div><p class="lead">${head}</p><ul class="results pr">${rows}</ul>`];
}
// blackjack
function bjScore(cards) {
  let t = 0, aces = 0;
  for (const c of cards) { if (c === "?") continue; const r = c.slice(0, -1); if (r === "A") { aces++; t += 11; } else t += "JQK".includes(r) ? 10 : parseInt(r, 10); }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}
const cardHTML = (c) => c === "?" ? '<span class="bj-card bj-back"></span>' : `<span class="bj-card ${"♥♦".includes(c.slice(-1)) ? "red" : ""}"><b>${esc(c.slice(0, -1))}</b><i>${c.slice(-1)}</i></span>`;
const BJST = { play: "Jugando", stand: "Plantado", bust: "Pasado", bj: "¡Blackjack!" };
const BJRES = { win: "Gana +10", bj: "Blackjack +15", push: "Empate", lose: "Pierde −10" };
function bjView(g) {
  const bj = g.bj, label = "Ronda " + g.r + " de " + g.total, me = bj.p.find((s) => s.id === pid), res = g.phase === "bjres";
  const rows = bj.p.map((s) => { const pl = S.players.find((x) => x.id === s.id) || {};
    return `<div class="bjrow"><span class="who">${avatar(s.id, pname(s.id), pl.av, 28)}${esc(pname(s.id))}${s.id === pid ? ' <small class="muted">(tú)</small>' : ""}</span>
      <span class="bjcards">${s.c.map(cardHTML).join("")}</span><span class="bjsc">${bjScore(s.c)}</span>
      <span class="bjst ${res ? s.res : s.st}">${res ? BJRES[s.res] : BJST[s.st]}</span></div>`; }).join("");
  const key = ["bj", g.gid, g.r, g.phase, bj.dealer.length, JSON.stringify(bj.p.map((s) => [s.st, s.c.length]))].join("|");
  const canAct = g.phase === "bjplay" && me && me.st === "play" && !S.spec;
  return [key, `${timerHTML(label + (res ? " · resultado" : " · tu jugada"), res ? 6 : 25)}
    <div class="bjdealer"><div class="meta"><span>Banca</span><span>${bj.reveal ? bjScore(bj.dealer) : ""}</span></div><div class="bjcards">${bj.dealer.map(cardHTML).join("")}</div></div>
    <div>${rows}</div>
    ${canAct ? '<div class="votes"><button class="y" type="button" data-bj="hit">Pedir carta</button><button class="n" type="button" data-bj="stand">Plantarse</button></div>'
      : `<p class="muted">${S.spec ? "Estás mirando." : me ? (res ? "Siguiente ronda en unos segundos." : "Esperando a los demás…") : ""}</p>`}`];
}
// pistolero
function duelView(g) {
  const gs = g.gs, label = "Ronda " + g.r + " de " + g.total, foul = gs.out.includes(pid), mine = !S.spec && g.ids.includes(pid);
  const fouls = gs.out.length ? `<p class="muted">Falta (dispararon antes): ${gs.out.map((id) => esc(pname(id))).join(", ")}.</p>` : "";
  if (g.phase === "duelwait") return ["duel|w|" + g.gid + "|" + g.r + "|" + gs.out.length + "|" + foul, `<div class="meta"><span>${label} · pistolero</span></div>
    <div class="duel"><p class="duelbig">Preparados…</p><p class="muted">Espera la señal. Si disparas antes, es falta.</p></div>${fouls}
    <button class="duelbtn" type="button" data-shoot ${mine && !foul ? "" : "disabled"}>${foul ? "Falta: esperas la ronda siguiente" : "DISPARAR"}</button>`];
  if (g.phase === "duelfire") return ["duel|f|" + g.gid + "|" + g.r + "|" + foul, `<div class="meta"><span>${label} · pistolero</span></div>
    <div class="duel go"><p class="duelbig">¡FUEGO!</p></div>${fouls}
    <button class="duelbtn go" type="button" data-shoot ${mine && !foul ? "" : "disabled"}>DISPARAR</button>`];
  const w = gs.winner;
  return ["duel|r|" + g.gid + "|" + g.r, `<div class="meta"><span>${label} · pistolero</span></div>
    <div class="duel"><p class="duelbig">${w ? esc(pname(w)) + " dispara primero" : "Nadie dispara a tiempo"}</p>${w ? `<p class="muted">${gs.ms} ms (incluye la red)</p>` : ""}</div>${fouls}`];
}
function overHTML(g) {
  const w = g.win || [];
  if (g.mode === "liars") return lbOverHTML(g);
  if (g.mode === "chain") return "";
  const key = g.mode === "bj" ? "chips" : "pts", unit = g.mode === "bj" ? "fichas" : "puntos";
  return `<ul class="results">${S.players.filter((p) => (g.ids || []).includes(p.id)).sort((a, b) => (b[key] || 0) - (a[key] || 0)).map((p) =>
    `<li class="${w.includes(p.id) ? "win" : ""}">${avatar(p.id, p.name, p.av, 28)}<span class="w">${esc(p.name)}</span><span class="n">${p[key] || 0} ${unit}</span></li>`).join("")}</ul>`;
}
function stageView() {
  if (!tableCode) return homeView();
  if (!S) return ["wait|" + status, `<p class="lead">${status === "retry" ? "Reconectando con la mesa…" : "Entrando en la mesa " + esc(tableCode) + "…"}</p>`];
  const g = G;
  if (g.phase === "lobby") return lobbyView(g);
  if (g.phase === "over") {
    const w = g.win || [], live = S.players.filter((p) => !p.away).length, rm = S.my.rm;
    const title = w.length === 0 ? "Nadie gana esta vez" : w.length === 1 ? "Gana " + esc(pname(w[0])) : "Empate: " + w.map((id) => esc(pname(id))).join(" y ");
    return ["over|" + g.gid + "|" + g.rm + "|" + live + "|" + rm + "|" + JSON.stringify(g.win), `<p class="muted">Fin de la partida</p><div class="lemma">${title}</div>${overHTML(g)}
      <div class="row"><button class="primary" type="button" data-act="rematch" ${rm ? "disabled" : ""}>${rm ? "Esperando… " : "Revancha "}(${g.rm}/${live})</button>
      <button type="button" data-act="lobby">Volver a la sala</button></div>`];
  }
  let v = g.mode === "roul" ? roulView(g) : g.mode === "liars" ? lbView(g) : g.mode === "bj" ? bjView(g) : g.mode === "duel" ? duelView(g) : chainView(g);
  if (S.spec) v = [v[0] + "|spec", `<p class="specnote">Estás de espectador: entrarás a jugar cuando acabe la partida.</p>` + v[1]];
  return v;
}
// la ruleta: misma tira para todos (sale de la semilla del servidor), se para en la letra elegida
const SPIN = 7, SPIN_MS = 5200;
function runSpin(g) {
  const caseEl = $("case"), strip = $("strip"); if (!caseEl || !strip) return;
  const rand = rng(g.spin), TARGET = 38, STEP = 78, tiles = [];
  for (let i = 0; i < 46; i++) tiles.push(i === TARGET ? g.letter : weightedLetter(rand));
  strip.innerHTML = tiles.map((l, i) => `<div class="tile" data-i="${i}" style="--rc:${rarityOf(l).c}">${esc(l.toUpperCase())}</div>`).join("");
  const jitter = (rand() - 0.5) * 50, end = caseEl.clientWidth / 2 - (TARGET * STEP + 36 + jitter), elapsed = (SPIN - g.t) * 1000;
  const done = () => {
    const hit = strip.querySelector(`[data-i="${TARGET}"]`); if (hit) hit.classList.add("hit");
    const r = rarityOf(g.letter), res = $("spinRes");
    if (res) res.innerHTML = `Ha salido la <strong>${esc(g.letter.toUpperCase())}</strong> <span class="rar" style="--rc:${r.c}">${r.n}</span>`;
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || elapsed > 1500) { strip.style.transform = `translateX(${end}px)`; done(); return; }
  strip.style.transform = "translateX(0px)"; strip.getBoundingClientRect();
  strip.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.8, 0.18, 1)`; strip.style.transform = `translateX(${end}px)`;
  setTimeout(done, SPIN_MS);
}

// ---------- pintar ----------
function paint() {
  const home = !tableCode;
  $("codeBtn").hidden = home; $("leaveBtn").hidden = home; if (!home) $("codeBtn").textContent = "Mesa " + tableCode;
  const bn = toastText || (!home && status !== "ready" && S ? "Reconectando con la mesa…" : "");
  $("banner").hidden = !bn; $("banner").textContent = bn;
  const [key, html] = stageView();
  if (key !== stageKey) {
    const keepWord = $("wordInput") && key.startsWith("rwrite") && stageKey.startsWith("rwrite") ? $("wordInput").value : null;
    stageKey = key; $("stage").innerHTML = html; $("stage").classList.toggle("lb-stage", key.startsWith("lb|"));
    if (keepWord !== null && $("wordInput")) $("wordInput").value = keepWord;
    const wi = $("wordInput"); if (wi) wi.focus();
    if (key.startsWith("spin|")) runSpin(G);
  }
  if (G && S) {
    const tn = $("tnum"), bar = $("bar"), vt = $("voted"), si = $("subInfo");
    if (tn) tn.textContent = G.t;
    if (bar) { bar.firstElementChild.style.width = (G.t / Number(bar.dataset.max)) * 100 + "%"; bar.classList.toggle("low", G.t <= 5); }
    if (vt) vt.textContent = G.voted;
    if (si) {
      const present = S.players.filter((p) => !p.away && !p.spec).length;
      si.textContent = (S.my.sent ? "Propuesta enviada: «" + S.my.sent + "». Puedes cambiarla mientras quede tiempo. " : "") + "Propuestas: " + G.subs + " de " + present + ".";
    }
  }
  paintSide(); $("chatSec").hidden = home;
}
function paintSide() {
  const sk = G && S ? JSON.stringify([G.mode, G.phase, G.turn, G.hist, S.players, G.lb ? G.lb.p : 0, tableCode]) : "";
  if (sk === sideKey) return; sideKey = sk;
  $("playersSec").hidden = !G || !S || !S.players.length; $("chainSec").hidden = !G || !G.hist.length;
  if (!G || !S) return;
  const playing = G.phase !== "lobby" && G.phase !== "over";
  $("players").innerHTML = S.players.map((p) => {
    const cls = [playing && G.mode === "chain" && p.id === G.turn ? "turn" : "", G.mode === "chain" && playing && p.lives <= 0 && !p.spec ? "out" : "", p.away ? "away" : "",
      playing && G.mode === "liars" && G.lb ? lbSideClass(G, p) : ""].join(" ");
    const tag = [p.id === pid ? "tú" : "", p.spec ? "espectador" : "", p.away ? "desconectado" : ""].filter(Boolean).join(" · ");
    let side = "";
    if (!p.spec && G.phase !== "lobby") {
      if (G.mode === "liars" && G.lb) side = lbSide(G, p);
      else if (G.mode === "roul" || G.mode === "duel") side = `<span class="pts">${p.pts || 0} ${p.pts === 1 ? "punto" : "puntos"}</span>`;
      else if (G.mode === "bj") side = `<span class="pts">${p.chips} fichas</span>`;
      else side = `${p.f ? '<span class="fl" title="Una falta: a la segunda pierde una vida">1 falta</span>' : ""}<span class="lives" role="img" aria-label="${p.lives} de 3 vidas">${[0, 1, 2].map((i) => `<i class="${i < p.lives ? "on" : ""}"></i>`).join("")}</span>`;
    }
    return `<li class="${cls}">${avatar(p.id, p.name, p.av, 30)}<span class="nm">${esc(p.name)}${tag ? `<span class="tag">${tag}</span>` : ""}</span>${side}</li>`;
  }).join("");
  $("chainTitle").textContent = G.mode === "roul" ? "Palabras ganadoras" : "Cadena de palabras";
  $("chain").classList.toggle("arrows", G.mode !== "roul");
  $("chain").innerHTML = G.hist.map((w) => `<span>${G.mode === "roul" ? esc(w) : lemma(w)}</span>`).join("");
}
function paintChat() {
  const el = $("chatLog"), atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  el.innerHTML = chat.length ? chat.map((m) => `<p><b>${esc(m.n)}</b>${esc(m.tx)}</p>`).join("") : '<p class="muted">Aún no hay mensajes.</p>';
  if (atEnd) el.scrollTop = el.scrollHeight;
}

// ---------- acciones ----------
$("stage").addEventListener("input", (e) => {
  if (e.target.id === "nameInput") myName = e.target.value.slice(0, 16);
  else if (e.target.id === "codeInput") { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); codeDraft = e.target.value; }
});
$("stage").addEventListener("change", (e) => {
  if (e.target.id === "roundsSel") roundsPick = Number(e.target.value) || 5;
  else if (e.target.id === "avFile" && e.target.files[0]) pickAvatar(e.target.files[0]);
});
$("stage").addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "joinForm") {
    const name = myName.trim();
    if (!name) { notice = "Escribe tu nombre primero."; paint(); return; }
    myName = name; store.set("culta.name", name);
    const code = codeDraft.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 5) { notice = "El código tiene 5 caracteres."; paint(); return; }
    notice = ""; enter(code);
  } else if (e.target.id === "wordForm" && G && G.phase === "write") {
    const w = $("wordInput").value.trim(); if (!w) return;
    $("wordErr").textContent = ""; send({ t: "word", w });
  }
});
$("stage").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.act === "create") {
    const name = myName.trim(); if (!name) { notice = "Escribe tu nombre primero."; paint(); return; }
    myName = name; store.set("culta.name", name); notice = ""; createTable();
  } else if (b.dataset.act === "install" && installEvt) { installEvt.prompt(); installEvt = null; paint(); }
  else if (b.dataset.act === "copycode") {
    const done = () => { b.textContent = "Código copiado"; setTimeout(() => { b.textContent = "Copiar código"; }, 2000); };
    try { navigator.clipboard.writeText(tableCode).then(done, () => {}); } catch {}
  } else if (!G || !S) return;
  else if (b.dataset.go) send({ t: "start", mode: b.dataset.go, n: roundsPick });
  else if (b.dataset.act === "rematch") send({ t: "rematch" });
  else if (b.dataset.act === "lobby") send({ t: "lobby" });
  else if (b.dataset.v !== undefined && G.mode === "chain" && G.phase === "vote" && G.turn !== pid) send({ t: "vote", v: Number(b.dataset.v) });
  else if (b.dataset.pick !== undefined && G.mode === "roul" && G.phase === "vote") send({ t: "pick", i: Number(b.dataset.pick) });
  else if (b.dataset.bj) send({ t: "bj", a: b.dataset.bj });
  else if (b.dataset.shoot !== undefined && e.detail === 0) send({ t: "shoot" });   // teclado
});
$("stage").addEventListener("pointerdown", (e) => {   // el disparo reacciona al tocar, no al soltar
  const b = e.target.closest("[data-shoot]"); if (b && !b.disabled) { e.preventDefault(); send({ t: "shoot" }); }
});
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault(); const v = $("chatInput").value.trim(); if (!v) return; send({ t: "chat", m: v }); $("chatInput").value = "";
});
$("leaveBtn").addEventListener("click", () => leave(""));
$("codeBtn").addEventListener("click", () => { try { navigator.clipboard.writeText(tableCode); toast("Código " + tableCode + " copiado"); } catch {} });
$("themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const next = cur === "light" ? "dark" : "light"; document.documentElement.dataset.theme = next; store.set("culta.theme", next);
  document.querySelector('meta[name="theme-color"]').content = next === "light" ? "#fbf1c7" : "#282828";
});
if (store.get("culta.theme")) { document.documentElement.dataset.theme = store.get("culta.theme"); document.querySelector('meta[name="theme-color"]').content = store.get("culta.theme") === "light" ? "#fbf1c7" : "#282828"; }
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; if (!tableCode) paint(); });
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

// ---------- arranque ----------
(async () => {
  pid = await sha16(tok);
  paint(); loadRank();
  if (tableCode) connect();
})();
