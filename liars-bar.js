// =====================================================================================
// Liars Bar · modo de cartas de faroleo para «¿Es culta?»
//
// Este archivo NO tiene conexión propia. Se engancha al mismo estado compartido G y al
// mismo patrón que Cadena y Ruleta:
//   1. Cada jugador publica su acción con pub({ act: {...} })  (room.presence de siempre).
//   2. El anfitrión la lee en hostStep() -> lbStep() a través de roster().
//   3. El anfitrión aplica las reglas sobre G.lb y publica G como siempre.
//   4. Todos reciben G por evaluate() y pintan con lbView().
//
// Se carga ANTES del script principal y solo define funciones y variables con prefijo
// lb/LB_, así que no choca con nada del código existente. Las funciones del script
// principal (rng, esc, pname, timerHTML, pub, paint, G, pid…) se usan en tiempo de
// llamada, cuando ya existen.
//
// Privacidad: las manos viajan dentro de G (hace falta para que otro jugador pueda
// relevar al anfitrión si se cae). Van ofuscadas, NO cifradas: la interfaz solo
// enseña tu mano, pero alguien que inspeccione el tráfico podría reconstruirlas.
// De las cartas de la mesa solo se guarda la última jugada (la única que se puede
// destapar); las anteriores se reducen a un contador.
// =====================================================================================

const LB_MAX = 4, LB_HAND = 5, LB_TURN = 20, LB_DEAL = 4, LB_REVEAL = 6, LB_SHOT = 5, LB_CHAMBERS = 6, LB_AWAY = 5;
const LB_CARDS = {
  K: { n: "Rey", pl: "Reyes", s: "♚" },
  Q: { n: "Reina", pl: "Reinas", s: "♛" },
  A: { n: "As", pl: "Ases", s: "♠" },
  J: { n: "Comodín", pl: "Comodines", s: "★" },
};
const LB_ABC = "KQAJ";

// estado local de la interfaz (no se publica salvo la acción final)
let lbSel = [], lbSelKey = "", lbSent = -1, lbSeenSeq = -1, lbSeenRound = -1, lbSeenCall = "";

// ---------- utilidades ----------
const lbSeat = (lb, id) => (lb && lb.p.find((s) => s.id === id)) || null;
const lbAlive = (lb) => lb.p.filter((s) => !s.out);
function lbKey(g, id) {
  let h = 0x2f6b;
  for (const c of id + ":" + g.gid + ":" + g.r) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return h;
}
// Ofuscación ligera (no es cifrado): evita que las cartas se lean a simple vista en el estado.
function lbEnc(cards, g, id) {
  const r = rng(lbKey(g, id));
  return [...cards].map((c) => (LB_ABC.indexOf(c) + Math.floor(r() * 4)) % 4).join("");
}
function lbDec(str, g, id) {
  const r = rng(lbKey(g, id));
  return [...String(str || "")].map((d) => LB_ABC[(((Number(d) - Math.floor(r() * 4)) % 4) + 4) % 4]).join("");
}
function lbNextAfter(lb, id, needCards) {
  const n = lb.p.length, i0 = lb.p.findIndex((s) => s.id === id);
  for (let k = 1; k < n; k++) {
    const s = lb.p[(i0 + k) % n];
    if (!s.out && (!needCards || s.n > 0)) return s.id;
  }
  return null;
}
function lbFirstAlive(lb, id) {
  const s = lbSeat(lb, id);
  return s && !s.out ? id : lbNextAfter(lb, id, false);
}
// ¿Está obligado a destapar? Si no le quedan cartas, o si es el único que aún tiene.
function lbMustCall(lb, s) {
  if (!lb.last || !s) return false;
  return s.n === 0 || lbAlive(lb).every((o) => o.id === s.id || o.n === 0);
}
const lbCanCall = (lb, s) => !!(lb.last && s && lb.last.id !== s.id);
function lbValidPlay(g, s, cards) {
  const lb = g.lb;
  if (typeof cards !== "string" || cards.length < 1 || cards.length > 3 || !/^[KQAJ]+$/.test(cards)) return false;
  if (lbMustCall(lb, s)) return false;
  let hand = lbDec(s.h, g, s.id);
  for (const c of cards) { const i = hand.indexOf(c); if (i < 0) return false; hand = hand.slice(0, i) + hand.slice(i + 1); }
  return true;
}

// ---------- anfitrión ----------
function lbStart(g, R) {
  const seats = g.players.filter((p) => R.has(p.id)).slice(0, LB_MAX);
  g.lb = { p: seats.map((p) => ({ id: p.id, h: "", n: 0, sh: 0, out: 0 })), table: "", last: null, pile: 0, seq: 0, call: null, round: 0 };
  g.r = 0;
  lbNewRound(g, seats[0].id);
}
function lbNewRound(g, starter) {
  const lb = g.lb;
  g.r += 1; lb.round += 1;
  const deck = [];
  for (const c of "KQA") for (let i = 0; i < 6; i++) deck.push(c);
  deck.push("J", "J");
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  lb.table = "KQA"[Math.floor(Math.random() * 3)];
  for (const s of lb.p) {
    if (s.out) { s.h = ""; s.n = 0; continue; }
    const hand = deck.splice(0, LB_HAND).join("");
    s.h = lbEnc(hand, g, s.id); s.n = hand.length;
  }
  lb.last = null; lb.pile = 0; lb.call = null; lb.seq += 1;
  g.turn = lbFirstAlive(lb, starter);
  g.phase = "lbdeal"; g.t = LB_DEAL;
}
function lbPlay(g, s, cards, auto) {
  const lb = g.lb;
  let hand = lbDec(s.h, g, s.id);
  for (const c of cards) { const i = hand.indexOf(c); hand = hand.slice(0, i) + hand.slice(i + 1); }
  s.h = lbEnc(hand, g, s.id); s.n = hand.length;
  // solo se guarda la última jugada; las anteriores ya no se pueden destapar
  lb.last = { id: s.id, n: cards.length, c: lbEnc(cards, g, "~" + s.id), auto: auto ? 1 : 0 };
  lb.pile += cards.length; lb.seq += 1;
  g.turn = lbNextAfter(lb, s.id, true) || lbNextAfter(lb, s.id, false);
  g.phase = "lbturn"; g.t = LB_TURN;
}
function lbCall(g, s, auto) {
  const lb = g.lb, on = lb.last.id, shown = lbDec(lb.last.c, g, "~" + on);
  const lie = [...shown].some((c) => c !== lb.table && c !== "J");
  lb.call = { by: s.id, on, shown, lie: lie ? 1 : 0, shooter: lie ? on : s.id, bang: -1, auto: auto ? 1 : 0 };
  lb.seq += 1;
  g.phase = "lbreveal"; g.t = LB_REVEAL;
}
function lbAuto(g, s) {
  const lb = g.lb;
  if (lbMustCall(lb, s) || s.n === 0) { if (lbCanCall(lb, s)) lbCall(g, s, true); return; }
  const hand = lbDec(s.h, g, s.id);
  lbPlay(g, s, [...hand].find((c) => c === lb.table || c === "J") || hand[0], true);
}
// Se llama desde hostStep() cuando G.mode === "liars". Una sola acción por paso, la del
// jugador con el turno y con el número de secuencia actual: no puede haber dos turnos a la vez.
function lbStep(g, R, isTick) {
  const lb = g.lb;
  if (!lb) { g.phase = "over"; g.win = []; g.t = 0; return; }
  const down = () => isTick && --g.t <= 0;
  if (g.phase === "lbdeal") {
    if (down()) { g.phase = "lbturn"; g.t = LB_TURN; }
  } else if (g.phase === "lbturn") {
    const s = lbSeat(lb, g.turn);
    if (!s || s.out) { g.turn = lbFirstAlive(lb, g.turn); return; }
    const p = R.get(g.turn), a = p && p.act;
    if (a && a.gid === g.gid && a.r === g.r && a.s === lb.seq) {
      if (a.lb === "call" && lbCanCall(lb, s)) { lbCall(g, s, false); return; }
      if (a.lb === "play" && lbValidPlay(g, s, a.c)) { lbPlay(g, s, a.c, false); return; }
    }
    if (!p && g.t > LB_AWAY) g.t = LB_AWAY;      // desconectado: no se espera el turno entero
    if (down()) lbAuto(g, s);
  } else if (g.phase === "lbreveal") {
    if (down()) {
      const sh = lbSeat(lb, lb.call.shooter);
      lb.call.bang = Math.random() < 1 / Math.max(1, LB_CHAMBERS - sh.sh) ? 1 : 0;
      g.phase = "lbshot"; g.t = LB_SHOT;
    }
  } else if (g.phase === "lbshot") {
    if (down()) {
      const sh = lbSeat(lb, lb.call.shooter);
      sh.sh += 1; if (lb.call.bang) sh.out = 1;     // se aplica al final para no destripar el disparo
      const alive = lbAlive(lb);
      if (alive.length <= 1) { g.phase = "over"; g.t = 0; g.win = alive.map((x) => x.id); }
      else lbNewRound(g, sh.id);
    }
  }
}

// ---------- pintar ----------
const lbPl = (c, n) => (n === 1 ? LB_CARDS[c].n : LB_CARDS[c].pl);
function lbFace(c, extra, attrs) {
  const k = LB_CARDS[c], tag = attrs ? "button" : "div";
  return `<${tag} class="lb-card lb-c${c} ${extra || ""}" ${attrs || ""}><span class="lb-corner">${c === "J" ? "★" : c}</span><span class="lb-glyph">${k.s}</span><span class="lb-name">${k.n}</span></${tag}>`;
}
const lbBack = (extra, style) => `<div class="lb-card lb-back ${extra || ""}" ${style ? `style="${style}"` : ""} aria-hidden="true"></div>`;
function lbChambers(n, label) {
  return `<span class="lb-gun" role="img" aria-label="${esc(label)}: ${n} de ${LB_CHAMBERS} recámaras disparadas">${
    Array.from({ length: LB_CHAMBERS }, (_, i) => `<i class="${i < n ? "lb-used" : ""}"></i>`).join("")}</span>`;
}

function lbView(g) {
  const lb = g.lb;
  if (!lb) return ["lb|wait", `<p class="lead">Preparando la mesa…</p>`];
  const me = lbSeat(lb, pid), T = LB_CARDS[lb.table], ph = g.phase;
  const freshPlay = lb.seq !== lbSeenSeq; lbSeenSeq = lb.seq;
  const freshDeal = g.r !== lbSeenRound; lbSeenRound = g.r;
  const selKey = g.gid + "|" + g.r + "|" + lb.seq;
  if (selKey !== lbSelKey) { lbSel = []; lbSelKey = selKey; }
  const hand = me && !me.out ? lbDec(me.h, g, pid) : "";
  lbSel = lbSel.filter((i) => i < hand.length);
  const myTurn = ph === "lbturn" && me && !me.out && g.turn === pid;
  const pending = lbSent === lb.seq;
  const mustCall = myTurn && lbMustCall(lb, me);
  const canPlay = myTurn && !mustCall && hand.length > 0 && !pending;
  const canCall = myTurn && lbCanCall(lb, me) && !pending;
  const C = lb.call, showCall = C && (ph === "lbreveal" || ph === "lbshot");

  // asientos
  const seats = lb.p.map((s) => {
    const cls = ["lb-seat",
      ph === "lbturn" && s.id === g.turn ? "lb-active" : "",
      s.out ? "lb-dead" : "", s.id === pid ? "lb-me" : "",
      showCall && C.by === s.id ? "lb-caller" : "",
      showCall && C.shooter === s.id ? "lb-shooter" : ""].join(" ");
    const backs = Array.from({ length: Math.min(s.n, LB_HAND) }, () => '<i></i>').join("");
    const badge = showCall && C.by === s.id ? '<span class="lb-badge lb-bcall">¡Mentiroso!</span>'
      : showCall && C.on === s.id ? `<span class="lb-badge ${C.lie ? "lb-blie" : "lb-btrue"}">${C.lie ? "Pillado" : "Decía la verdad"}</span>`
      : ph === "lbturn" && s.id === g.turn ? '<span class="lb-badge lb-bturn">Su turno</span>'
      : lb.last && lb.last.id === s.id && ph === "lbturn" ? `<span class="lb-badge">Jugó ${lb.last.n}</span>` : "";
    return `<div class="${cls}">
      <div class="lb-nm">${esc(pname(s.id))}${s.id === pid ? " <small>(tú)</small>" : ""}</div>
      <div class="lb-minis" aria-label="${s.n} cartas">${backs}</div>
      <div class="lb-sub">${s.out ? "Eliminado" : s.n + (s.n === 1 ? " carta" : " cartas")}</div>
      ${lbChambers(s.sh, "Revólver de " + pname(s.id))}${badge}</div>`;
  }).join("");

  // centro de la mesa
  let center;
  if (showCall) {
    const callKey = g.gid + "|" + g.r + "|" + C.by + "|" + C.on;
    const flip = callKey !== lbSeenCall; lbSeenCall = callKey;
    const cards = [...C.shown].map((c, i) => {
      const bad = c !== lb.table && c !== "J";
      return `<div class="lb-flip ${flip && ph === "lbreveal" ? "lb-anim" : ""} ${bad ? "lb-bad" : ""}" style="--d:${i * 0.35}s">${lbFace(c)}</div>`;
    }).join("");
    center = `<div class="lb-reveal ${C.lie ? "lb-caught" : ""}">${cards}</div>
      <div class="lb-stamp ${C.lie ? "lb-sl" : "lb-st"} ${ph === "lbreveal" ? "lb-late" : ""}">${C.lie ? "¡Farol!" : "Era verdad"}</div>`;
  } else {
    const prev = Math.max(0, lb.pile - (lb.last ? lb.last.n : 0));
    const stack = Array.from({ length: Math.min(prev, 8) }, (_, i) => lbBack("lb-pilecard", `--x:${(i % 4) * 5 - 8}px;--y:${-i * 2}px;--rot:${(i * 37) % 24 - 12}deg`)).join("");
    const last = lb.last ? Array.from({ length: lb.last.n }, (_, i) =>
      lbBack("lb-pilecard lb-top" + (freshPlay ? " lb-fly" : ""), `--x:${i * 16 - 10}px;--y:${-Math.min(prev, 8) * 2 - 4}px;--rot:${i * 9 - 6}deg;--d:${i * 0.08}s`)).join("") : "";
    center = `<div class="lb-pile" aria-label="${lb.pile} cartas boca abajo en la mesa">${stack}${last}${lb.pile ? "" : '<span class="lb-empty">Mesa vacía</span>'}</div>`;
  }

  const tableChip = `<div class="lb-tablecard"><span>Carta de la mesa</span><strong>${T.s} ${T.pl}</strong></div>`;
  const claim = lb.last && !showCall
    ? `<p class="lb-claim"><strong>${esc(pname(lb.last.id))}</strong> dice: ${lb.last.n} × ${lbPl(lb.table, lb.last.n)}${lb.last.auto ? ' <small>(jugada automática por tiempo)</small>' : ""}</p>`
    : !showCall ? `<p class="lb-claim">Nadie ha jugado aún en esta ronda.</p>` : "";

  // texto de la fase
  let head, foot = "";
  const who = esc(pname(g.turn));
  if (ph === "lbdeal") {
    head = `<div class="meta"><span>Ronda ${lb.round} · repartiendo</span><span>${lbAlive(lb).length} en pie</span></div>
      <p class="lead">Nueva ronda: la carta de la mesa es <strong>${T.pl}</strong>. Abre ${who}.</p>`;
  } else if (ph === "lbturn") {
    head = `${timerHTML("Ronda " + lb.round + " · " + (myTurn ? "te toca" : "turno de " + who), LB_TURN)}`;
    if (!me) foot = `<p class="muted">Estás mirando: Liars Bar se juega de 2 a 4. Podrás sentarte en la próxima partida.</p>`;
    else if (me.out) foot = `<p class="muted">Te han eliminado. Sigue la partida desde la barra.</p>`;
    else if (!myTurn) foot = `<p class="muted">${who} está decidiendo…</p>`;
    else if (pending) foot = `<p class="muted">Enviando tu jugada…</p>`;
    else if (mustCall) foot = `<p class="lb-hint">${me.n === 0 ? "No te quedan cartas" : "Eres el único con cartas"}: tienes que destapar la jugada de ${esc(pname(lb.last.id))}.</p>`;
    else foot = `<p class="lb-hint">Elige de 1 a 3 cartas y júralas como <strong>${T.pl}</strong>${lb.last ? `, o llama mentiroso a ${esc(pname(lb.last.id))}` : ""}.</p>`;
  } else if (ph === "lbreveal") {
    const sh = lbSeat(lb, C.shooter), left = LB_CHAMBERS - sh.sh;
    head = `<div class="meta"><span>Ronda ${lb.round} · ¡mentiroso!</span><span>${T.s} ${T.pl}</span></div>
      <p class="lead"><strong>${esc(pname(C.by))}</strong> llama mentiroso a <strong>${esc(pname(C.on))}</strong>${C.auto ? " <small>(por tiempo)</small>" : ""}.</p>`;
    foot = `<p class="lb-late">${C.lie ? `Había cartas que no eran ${T.pl} ni comodines.` : `Todas eran ${T.pl} o comodines.`}
      <strong>${esc(pname(C.shooter))}</strong> se apunta con el revólver: 1 bala entre ${left} ${left === 1 ? "recámara" : "recámaras"}.</p>`;
  } else {
    const sh = lbSeat(lb, C.shooter);
    head = `<div class="meta"><span>Ronda ${lb.round} · el revólver</span><span>${T.s} ${T.pl}</span></div>
      <p class="lead"><strong>${esc(pname(C.shooter))}</strong> aprieta el gatillo…</p>`;
    center = `<div class="lb-shot ${C.bang ? "lb-bang" : "lb-click"}"><div class="lb-cyl" aria-hidden="true">${
      Array.from({ length: LB_CHAMBERS }, (_, i) => `<i style="--a:${i * 60}deg" class="${i < sh.sh ? "lb-used" : ""}"></i>`).join("")}</div>
      <div class="lb-result">${C.bang ? "¡BANG!" : "Clic."}</div></div>`;
    foot = `<p class="lb-late2">${C.bang ? `${esc(pname(C.shooter))} queda eliminado.` : `${esc(pname(C.shooter))} sobrevive… de momento.`}</p>`;
  }

  // mano propia
  let handHTML = "";
  if (me && !me.out && hand) {
    const cards = [...hand].map((c, i) => {
      const extra = (lbSel.includes(i) ? "lb-sel " : "") + (freshDeal ? "lb-deal" : "");
      const style = `style="--d:${i * 0.09}s"`;
      return canPlay ? lbFace(c, extra, `type="button" data-lbc="${i}" aria-pressed="${lbSel.includes(i)}" aria-label="${LB_CARDS[c].n}" ${style}`)
        : lbFace(c, extra).replace("<div ", `<div ${style} `);
    }).join("");
    handHTML = `<div class="lb-handbox"><div class="lb-handtitle"><span>Tu mano</span><span>solo la ves tú</span></div><div class="lb-hand">${cards}</div></div>`;
  } else if (me && !me.out && ph !== "lbshot" && ph !== "lbreveal") {
    handHTML = `<p class="muted lb-nohand">Te has quedado sin cartas.</p>`;
  }
  const actions = myTurn ? `<div class="lb-actions">
      <button type="button" class="lb-play" data-lba="play" ${canPlay && lbSel.length ? "" : "disabled"}>${lbSel.length ? `Jugar ${lbSel.length} como ${lbPl(lb.table, lbSel.length)}` : "Elige cartas"}</button>
      <button type="button" class="lb-liar" data-lba="call" ${canCall ? "" : "disabled"}>¡MENTIROSO!</button></div>` : "";

  const key = ["lb", g.gid, g.r, ph, lb.seq, myTurn, pending, lbSel.join(",")].join("|");
  return [key, `${head}
    <div class="lb-felt">
      <div class="lb-seats">${seats}</div>
      <div class="lb-center">${tableChip}${center}${claim}</div>
    </div>
    ${foot}${handHTML}${actions}
    <details class="lb-rules"><summary>Reglas de Liars Bar</summary><ul class="rules">
      <li>Baraja de 20: 6 Reyes, 6 Reinas, 6 Ases y 2 Comodines. Cada jugador recibe 5 cartas y cada ronda sale una carta de la mesa.</li>
      <li>En tu turno pones de 1 a 3 cartas boca abajo y juras que son de la carta de la mesa. Puedes mentir. Los comodines valen siempre.</li>
      <li>Antes de jugar, puedes gritar <strong>¡MENTIROSO!</strong> a quien jugó justo antes. Se destapan sus cartas: si alguna no es de la mesa ni comodín, dispara él; si eran buenas, disparas tú.</li>
      <li>Cada uno tiene un revólver de 6 recámaras con una bala: cada disparo es más peligroso que el anterior. Si sale la bala, quedas eliminado.</li>
      <li>Tras cada disparo se reparte otra vez. Quien se queda sin cartas pasa; si eres el único que aún tiene, tienes que destapar. Gana el último en pie.</li>
      <li>${LB_TURN} s por turno: si se acaba el tiempo, se juega una carta por ti (o se destapa si estás obligado).</li>
      <li>Tu mano solo aparece en tu pantalla, pero la mesa se sincroniza entre todos los dispositivos: no es un secreto a prueba de trampas.</li>
    </ul></details>`];
}

// lista de jugadores (columna «Jugadores» del script principal)
function lbSideClass(g, p) {
  const s = lbSeat(g.lb, p.id); if (!s) return "";
  return s.out ? "out" : g.phase === "lbturn" && g.turn === p.id ? "turn" : "";
}
function lbSide(g, p) {
  const s = lbSeat(g.lb, p.id);
  if (!s) return '<span class="lb-watch">mirando</span>';
  return `${s.out ? "" : `<span class="lb-count">${s.n} ${s.n === 1 ? "carta" : "cartas"}</span>`}${lbChambers(s.sh, "Revólver")}`;
}
function lbOverHTML(g) {
  const lb = g.lb; if (!lb) return "";
  const w = g.win || [];
  return `<ul class="results">${[...lb.p].sort((a, b) => a.out - b.out || a.sh - b.sh).map((s) =>
    `<li class="${w.includes(s.id) ? "win" : ""}"><span class="w">${esc(pname(s.id))}</span><span class="n">${s.out ? "eliminado" : "en pie"} · ${s.sh}/${LB_CHAMBERS}</span></li>`).join("")}</ul>`;
}

// ---------- acciones del jugador: mismo pub({ act }) que los otros modos ----------
document.getElementById("stage").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || typeof G === "undefined" || !G || G.mode !== "liars" || G.phase !== "lbturn" || !G.lb || G.turn !== pid) return;
  const lb = G.lb, me = lbSeat(lb, pid);
  if (!me || me.out || lbSent === lb.seq) return;
  if (b.dataset.lbc !== undefined) {
    const i = Number(b.dataset.lbc), k = lbSel.indexOf(i);
    if (k >= 0) lbSel.splice(k, 1); else if (lbSel.length < 3) lbSel.push(i);
    paint();
  } else if (b.dataset.lba === "play" && lbSel.length) {
    const hand = lbDec(me.h, G, pid), cards = lbSel.map((i) => hand[i]).join("");
    lbSent = lb.seq;
    pub({ act: { gid: G.gid, r: G.r, s: lb.seq, lb: "play", c: cards } });
    paint();
  } else if (b.dataset.lba === "call" && lbCanCall(lb, me)) {
    lbSent = lb.seq;
    pub({ act: { gid: G.gid, r: G.r, s: lb.seq, lb: "call" } });
    paint();
  }
});
