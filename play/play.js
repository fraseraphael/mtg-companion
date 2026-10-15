/* Play surface: the goldfish table as a game. You play your turn, press one button, the table moves.
   Rendering: one render() from game.state, but card DOM nodes are reconciled by `${zone}:${uid}` so
   animations (fx.js) run on real, stable elements. Every engine call goes through call(), which
   persists to localStorage `mf-play:<slug>`. Long sequences (cast, combat, turn change) are async
   and hold ui.busy so input can't interleave with an animation. */

import * as E from './engine.js';
import {
  PHASES as PHASE_LABELS, COLORS, esc, safe, faceOf, isCreatureFace, isLandFace, isPlaneswalkerFace,
  isSpellFace, hasKw, imgOf, pipHtml, costHtml, poolTotal,
} from './util.js';
import { layoutFan, initHandPeek } from './hand.js';
import { openRadial, closeRadial, initRadial, radialIsOpen, openSheet, closeSheet, initSheet, sheetIsOpen, confirmSheet } from './radial.js';
import {
  initPanels, openLibrary, closeLibrary, libIsOpen, renderLib, openTokenMaker, openOracle, closeOracle,
  oracleIsOpen, toggleLog, renderLog, logIsOpen, toggleKeys, keysIsOpen,
} from './panels.js';
import { fx } from './fx.js';

/* ================= module state ================= */
let G = null, DECK = null, KEY = '', BEST_KEY = '';
const ui = {
  atk: new Set(),          // String(uid) chosen to attack (combat phase only)
  busy: false,             // an animated sequence is running
  inter: false,            // the opponent interstitial is running (tap skips it)
  skippers: [],
  pendingDraw: new Set(),  // hand uids not shown yet (a draw animation is flying them in)
  prevWon: false,
  suppressUntil: 0,        // swallow the click that ends a long-press / drag
  winOpen: false,
  // rules layer (all inert while RULES is null)
  pick: null,              // board/zone pick: { id, mode: 'target'|'p1p1', zone, eligible: Set, chosen: Set, n, optional }
  pendId: null,            // id of the pending item the panel shows
  pendMin: false,          // panel collapsed to a docked bar
  pendX: 0,                // x stepper value
  quickDone: [],           // quick actions taken on the current prompt
  trigSeen: false,         // the rules layer emits 'trigger' events (else: derive the ribbon from the log)
  logTail: null,           // last log line already scanned for the ribbon
  extraTurn: false,        // the turn that just started is an extra turn (engine turnStart {extra:true})
  resume: null,            // a turn step paused on a pending trigger: 'turn' | 'combat' (continued after it resolves)
};
let handPeek = null;
/* Rules layer (RULES.md §5). attachRules(game, bundle) from ./rules.js + scripts/decks/<slug>.json; if either is
   missing the table plays exactly as before. `?rules=stub` loads ./rules-stub.js (local testing only). */
let RULES = null, RULES_MOD = null, BUNDLE = null;
const els = new Map();     // `${zone}:${uid}` -> element
const $ = id => document.getElementById(id);
const S = () => (G ? G.state : null);
const face = e => faceOf(DECK, e);
const LABEL = Object.fromEntries(PHASE_LABELS.map(([k, full, short]) => [k, { full, short }]));
const isMain = ph => ph === 'main1' || ph === 'main2';
const elOf = (zone, uid) => els.get(zone + ':' + uid) || null;
const CARD_BACK = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 488 680"><defs><radialGradient id="g" cx="50%" cy="48%" r="62%">' +
  '<stop offset="0" stop-color="#c58a3c"/><stop offset=".5" stop-color="#6a3c1b"/><stop offset="1" stop-color="#26170d"/></radialGradient></defs>' +
  '<rect width="488" height="680" rx="24" fill="#120c08"/><rect x="22" y="22" width="444" height="636" rx="14" fill="url(#g)"/>' +
  '<ellipse cx="244" cy="340" rx="150" ry="215" fill="none" stroke="#f0c879" stroke-width="10" opacity=".75"/>' +
  '<ellipse cx="244" cy="340" rx="96" ry="150" fill="#00000033" stroke="#f0c879" stroke-width="4" opacity=".6"/></svg>');
const DUMMY_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="12" r="7"/><path d="M24 19v24M10 25h28M24 43l-7 3M24 43l7 3"/><circle cx="24" cy="30" r="5" class="tgt"/></svg>`;

function findEntry(uid) {
  const s = S();
  if (!s || uid == null) return null;
  for (const z of ['bf', 'hand', 'cz', 'gy', 'ex', 'lib']) {
    const e = ((s.zones && s.zones[z]) || []).find(x => x && String(x.uid) === String(uid));
    if (e) return { entry: e, zone: z };
  }
  return null;
}
const isCmdr = name => safe(() => E.isCommander(G, name), name === DECK.commander);
const haste = (p, f) => safe(() => E.hasKeyword(safe(() => E.cardOf(G, p.uid), f), 'Haste'), hasKw(f, 'Haste'));
const vigilant = p => safe(() => E.hasKeyword(E.cardOf(G, p.uid), 'Vigilance'), hasKw(face(p), 'Vigilance'));
const pow = p => safe(() => E.power(G, p), parseInt(face(p).power, 10) || 0);
const tou = p => safe(() => E.toughness(G, p), parseInt(face(p).toughness, 10) || 0);
const animOf = p => (p && ((p.eot && p.eot.animated) || p.animated || (p.mod && p.mod.animated))) || null; // engine animate()
const permIsCreature = p => !!animOf(p) || (p.tok ? p.tokPower != null || p.tokToughness != null : isCreatureFace(face(p)));
const isLandOnly = f => isLandFace(f) && !isCreatureFace(f);
const isInstantSpeed = f => /\bInstant\b/.test(f.type_line || '') || hasKw(f, 'Flash');
function canAttack(p) {
  if (!permIsCreature(p) || p.tapped) return false;
  return !p.sick || haste(p, face(p));
}
function isManaSource(p, f) {
  if (p.tok || !(f.produced_mana || []).length) return false;
  return isLandFace(f) || /^\(?\{T\}(?:, [^:\n]*)?: Add /m.test(f.oracle_text || '');
}
const stackN = p => (p.tok ? (p.n || 1) : 1);
const reducedMotion = () => safe(() => matchMedia('(prefers-reduced-motion: reduce)').matches, false);

/* ================= feedback: one hint line under the hand label, never a toast stack ================= */
let hintTimer = 0;
function hint(msg, { html = false, kind = 'warn', ms = 3600 } = {}) {
  const el = $('hint');
  if (!el) return;
  if (html) el.innerHTML = msg; else el.textContent = msg;
  el.className = 'hint show ' + kind;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.className = 'hint'; }, ms);
}
const REASONS = {
  phase: 'Not in this phase', 'land already played': 'You already played a land this turn',
  'summoning sick': 'Summoning sick', 'not a mana source': 'Not a mana source', 'empty library': 'Library is empty',
  'nothing to undo': 'Nothing to undo', 'only before the game starts': 'Mulligans are for the opening hand',
  tapped: 'Already tapped', 'not in hand': 'That card is no longer in your hand',
  pending: 'Answer the trigger on the table first',
};
function reasonText(r) {
  if (!r) return 'Not allowed';
  if (r.reason === 'mana') return `Short ${r.short ?? '?'} mana`;
  if (r.reason === 'discard') return `Discard ${r.count ?? ''} to end your turn`;
  return REASONS[r.reason] || String(r.reason || 'Not allowed');
}

/* ================= engine access ================= */
/** Run one engine call, never throw, persist. Returns a result object. */
function call(fn) {
  if (!G) return { ok: false, reason: 'no game' };
  let r;
  try { r = fn(); } catch (err) {
    console.error(err);
    return { ok: false, reason: 'Engine error: ' + (err && err.message ? err.message : err) };
  }
  if (!r || typeof r !== 'object') r = { ok: true };
  persist();
  return r;
}
/** Synchronous action with feedback + render (used by panels, menus, judge actions). */
function act(fn, { ok: okMsg = '', silent = false } = {}) {
  if (ui.busy) return { ok: false, reason: 'busy' };
  const r = call(fn);
  if (r.ok === false) { if (!silent) hint(reasonText(r)); }
  else if (okMsg) hint(typeof okMsg === 'function' ? okMsg(r) : okMsg, { kind: 'info', ms: 2400 });
  render();
  return r;
}
function persist() {
  if (!G) return;
  try { localStorage.setItem(KEY, typeof G.save === 'function' ? G.save() : JSON.stringify(G.state)); } catch (_) { /* private mode */ }
}
function setBusy(on) {
  ui.busy = !!on;
  document.body.classList.toggle('busy', ui.busy);
  renderStatus(S());
}
/** A pause the player can skip by tapping (opponent interstitial). */
function beat(ms) {
  return new Promise(res => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); ui.skippers = ui.skippers.filter(f => f !== done); res(); }
    ui.skippers.push(done);
  });
}
function skipInterstitial() { ui.skippers.slice().forEach(f => f()); }

/* ================= boot ================= */
export function boot(deck) {
  if (typeof E.createGame !== 'function') throw new Error('engine.js does not export createGame');
  DECK = deck;
  KEY = 'mf-play:' + (deck.slug || 'deck');
  BEST_KEY = 'mf-play-best:' + (deck.slug || 'deck');
  if (deck.name) document.title = `${deck.name} · Play — Manaforge`;
  const handed = handFromUrl(deck);
  G = E.createGame(deck, handed || {});
  if (!handed) restore(); // a hand from the URL (Practice → "Play it out") always starts a fresh game
  ui.prevWon = !!S().won;
  if (typeof G.on === 'function') G.on('turnStart', pl => { ui.extraTurn = !!(pl && pl.extra); });
  initRadial();
  initSheet();
  initPanels({ game: () => G, deck: DECK, act, toast: (m, k) => hint(m, { kind: k === 'bad' ? 'warn' : 'info' }), power: pow, toughness: tou });
  handPeek = initHandPeek($('hand'));
  buildStatic();
  wire();
  wireRules();
  render();
  requestAnimationFrame(() => {
    layoutFan($('hand'));
    const s = S();
    fx.banner(`Turn ${s.turn}`, { sub: s.turn === 1 && s.onThePlay !== false && isMain(s.phase) && s.phase === 'main1' ? 'On the play — no draw' : (LABEL[s.phase] || {}).full || '' });
  });
  loadRules();
}
/** ?hand=<name>|<name>|…&owed=<n>: the exact opening hand handed over by the mulligan trainer. */
function handFromUrl(deck) {
  let q;
  try { q = new URLSearchParams(location.search); } catch (_) { return null; }
  if (!q.has('hand')) return null;
  const known = new Set([...(deck.list || []).map(l => l.name), ...Object.keys(deck.cards || {})]);
  const raw = String(q.get('hand') || '').split('|').map(x => x.trim()).filter(Boolean);
  const names = raw.filter(n => known.has(n));
  const bad = raw.filter(n => !known.has(n));
  if (bad.length) console.warn('Ignoring hand card(s) not in this deck:', bad.join(', '));
  const owed = Math.max(0, parseInt(q.get('owed'), 10) || 0);
  // drop the handover params so a reload resumes this game instead of dealing the same hand again
  try { q.delete('hand'); q.delete('owed'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch (_) { /* ok */ }
  return { hand: names, owedBottom: Math.min(owed, names.length) };
}
function restore() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (_) { return; }
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || parsed.deck !== DECK.slug || !parsed.zones) return;
    const r = G.load(saved);
    if (r && r.ok === false) throw new Error(r.reason);
  } catch (err) {
    console.warn('Saved game ignored:', err);
    G = E.createGame(DECK, {});
  }
}

/* ================= static scaffolding ================= */
function buildStatic() {
  const av = $('oppAvatar');
  if (av) av.innerHTML = DUMMY_SVG;
  const ob = $('oppLib');
  if (ob) ob.innerHTML = `<img src="${CARD_BACK}" alt=""><img class="opp-drawcard" src="${CARD_BACK}" alt="">`;
  const dn = $('deckName');
  if (dn) dn.textContent = DECK.name || DECK.slug || 'Goldfish';
  const classic = $('classicLink');
  if (classic) classic.href = 'index.html?deck=' + encodeURIComponent(DECK.slug || '');
}

/* ================= render ================= */
function render() {
  const s = S();
  if (!s) return;
  if (s.phase !== 'combat') ui.atk.clear();
  else ui.atk.forEach(u => { const f = findEntry(u); if (!f || f.zone !== 'bf' || !canAttack(f.entry)) ui.atk.delete(u); });
  syncPick(s);
  const wanted = new Set();
  renderOpp(s);
  renderBoard(s, wanted);
  renderHand(s, wanted);
  // drop elements whose card left their zone
  for (const [k, el] of els) if (!wanted.has(k)) { el.remove(); els.delete(k); }
  renderRail(s);
  renderStatus(s);
  renderPend(s);
  scanLog(s);
  if (libIsOpen()) renderLib();
  if (logIsOpen()) renderLog();
  persist();
  checkWin(s);
}

/** Keyed reconcile of a container's card children. */
function sync(container, zone, list, update, wanted) {
  if (!container) return;
  let prev = null;
  for (const e of list) {
    const key = zone + ':' + e.uid;
    wanted.add(key);
    let el = els.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'card';
      el.dataset.z = zone;
      el.dataset.uid = String(e.uid);
      const ov = document.createElement('div');
      ov.className = 'ov';
      el.appendChild(ov);
      els.set(key, el);
    }
    const ref = prev ? prev.nextSibling : container.firstChild;
    if (el !== ref) container.insertBefore(el, ref);
    update(el, e); // after insertion: fx.glow ignores detached elements
    prev = el;
  }
}
function setFace(el, e, size) {
  const f = face(e);
  const src = e.tok ? '' : imgOf(f, size);
  const sig = src || 'tok:' + (e.name || '');
  if (el._fsig === sig) return;
  el._fsig = sig;
  let n;
  if (src) {
    n = document.createElement('img');
    n.src = src; n.alt = f.name || ''; n.draggable = false; n.loading = 'lazy';
  } else {
    n = document.createElement('div');
    n.className = 'tokface';
    n.innerHTML = `<span>${esc(e.name || f.name || '?')}</span>`;
  }
  const old = el.querySelector(':scope > img, :scope > .tokface');
  if (old) old.replaceWith(n); else el.prepend(n);
}
function setOv(el, html) {
  if (el._ov === html) return;
  el._ov = html;
  const ov = el.querySelector(':scope > .ov');
  if (ov) ov.innerHTML = html;
}
function setCls(el, map) { for (const k in map) el.classList.toggle(k, !!map[k]); }

/* ---------- opponent ---------- */
function commanderNames(s) {
  const k = Object.keys(s.cmdTax || {});
  return k.length ? k : [DECK.commander].filter(Boolean);
}
function renderOpp(s) {
  const o = s.opp || { life: 40, cmdDamage: {} };
  const ln = $('oppLifeNum');
  if (ln) ln.textContent = String(o.life);
  const opp = $('opp');
  if (opp) opp.classList.toggle('dead', !!s.won);
  const sub = $('oppSub');
  if (sub && !ui.inter) sub.textContent = s.won ? `Defeated on turn ${s.wonOn ?? s.turn}` : 'never attacks · never blocks';
  const box = $('oppCmd');
  if (!box) return;
  const names = commanderNames(s);
  if (box.dataset.names !== names.join('|')) {
    box.dataset.names = names.join('|');
    box.innerHTML = names.map((n, i) => `<div class="cmdbar" data-i="${i}" title="Commander damage from ${esc(n)}">
      <span class="cmdname">${esc(String(n).split(',')[0])}</span><span class="cmdtrack"><i></i></span><b></b></div>`).join('');
  }
  names.forEach((n, i) => {
    const v = (o.cmdDamage || {})[n] || 0;
    const bar = box.querySelector(`[data-i="${i}"]`);
    if (!bar) return;
    bar.classList.toggle('lethal', v >= 21);
    bar.querySelector('i').style.width = Math.min(100, (v / 21) * 100).toFixed(1) + '%';
    bar.querySelector('b').textContent = `${v} / 21`;
  });
}

/* ---------- battlefield ---------- */
function permOv(p, s) {
  const f = face(p), id = String(p.uid);
  const cr = permIsCreature(p), pw = isPlaneswalkerFace(f);
  const c = p.counters || {};
  const n = stackN(p);
  let h = '';
  const md = modOf(p);
  if (cr) {
    const P = pow(p), T = tou(p);
    const an = animOf(p);
    const baseP = an ? (an.p | 0) : p.tok ? (p.tokPower ?? 0) : (parseInt(f.power, 10) || 0);
    let cls = (c.p1p1 || 0) > 0 || P > baseP ? 'up' : P < baseP ? 'down' : '';
    if (md.p || md.t) cls += ' mod';
    h += `<span class="pt ${cls}">${esc(P)}/${esc(T)}</span>`;
  }
  if (md.kw.length) h += `<span class="kws">${md.kw.slice(0, 3).map(k => `<i>${esc(k)}</i>`).join('')}${md.kw.length > 3 ? `<i class="more">+${md.kw.length - 3}</i>` : ''}</span>`;
  if (c.p1p1) h += `<span class="ctr">+${esc(c.p1p1)}/+${esc(c.p1p1)}</span>`;
  if (pw) h += `<span class="loy">${esc(c.loyalty ?? f.loyalty ?? 0)}</span>`;
  if (c.other) h += `<span class="oth">● ${esc(c.other)}</span>`;
  if (s.ringBearer != null && String(s.ringBearer) === id) h += `<span class="ringb" title="Ring-bearer · tempted ${esc(s.ringTempted || 0)}×">${RING_SVG}<b>${esc(Math.min(4, s.ringTempted || 0))}</b></span>`;
  if ((p.hidden || []).length) h += `<span class="hidc" title="${p.hidden.length} card${p.hidden.length > 1 ? 's' : ''} exiled face down with it"></span>`;
  if (c.lore) h += `<span class="lore" title="Lore ${esc(c.lore)}">${ROMAN[c.lore] || esc(c.lore)}</span>`;
  if (p.noUntap || (p.mod && p.mod.noUntap) || p.skipUntap > 0) h += `<span class="nountap" title="${p.skipUntap > 0 && !p.noUntap ? 'Doesn’t untap next untap step' : 'Doesn’t untap'}">${LOCK_SVG}</span>`;
  if (n > 1) h += `<span class="cnt">&times;${n}</span>`;
  if (p.copy) h += '<span class="copytag">copy</span>';
  const sel = ui.atk.has(id);
  const pk = ui.pick && ui.pick.zone === 'bf' ? ui.pick : null;
  if (pk) { if (pk.eligible.has(id)) h += pk.chosen.has(id) ? '<span class="pick-ok" title="Chosen">✓</span>' : '<span class="pick-q">Pick</span>'; }
  else if (s.phase === 'combat' && canAttack(p)) h += sel ? '<span class="sword" title="Attacking">⚔</span>' : '<span class="atk-q">Attack?</span>';
  else if (p.attacking) h += `<span class="sword" title="${p.blocked ? 'Blocked' : 'Attacking'}">${p.blocked ? '⛨' : '⚔'}</span>`;
  h += `<button class="menu" data-act="menu" data-arg="${id}" title="Actions" aria-label="Actions">&#8943;</button>`;
  return h;
}
function renderBoard(s, wanted) {
  const z = s.zones || {};
  const rows = { cre: [], oth: [], land: [] };
  (z.bf || []).forEach(p => {
    const f = face(p);
    if (permIsCreature(p)) rows.cre.push(p);
    else if (isLandFace(f)) rows.land.push(p);
    else rows.oth.push(p);
  });
  const combat = s.phase === 'combat';
  const pk = ui.pick && ui.pick.zone === 'bf' ? ui.pick : null;
  const pend = pendTop();
  const upd = (el, p) => {
    const f = face(p), sel = ui.atk.has(String(p.uid)), id = String(p.uid);
    setFace(el, p, 'small');
    setCls(el, {
      'can-pick': !!pk && pk.eligible.has(id) && !pk.chosen.has(id), 'pick-sel': !!pk && pk.chosen.has(id),
      'no-pick': !!pk && !pk.eligible.has(id), 'trig-src': !!pend && pend.perm != null && String(pend.perm) === id,
      modded: hasMod(p),
    });
    const tip = modTip(p);
    if (tip) el.title = tip; else if (el.title) el.removeAttribute('title');
    setCls(el, {
      tapped: p.tapped, token: p.tok, stack: stackN(p) > 1, flipped: p.flip, copy: p.copy,
      atk: p.attacking || sel, 'atk-sel': sel, blocked: p.blocked,
      'can-atk': combat && !pk && canAttack(p) && !sel,
      'is-sick': permIsCreature(p) && p.sick && !haste(p, f),
      src: !p.tapped && !combat && isManaSource(p, f),
    });
    setOv(el, permOv(p, s));
  };
  sync($('rowCre'), 'bf', rows.cre, upd, wanted);
  sync($('rowOth'), 'bf', rows.oth, upd, wanted);
  sync($('rowLand'), 'bf', rows.land, upd, wanted);
  $('rowOth')?.classList.toggle('empty-row', !rows.oth.length);
  // command zone slot
  const cz = (z.cz || []).filter(c => isCmdr(c.name));
  sync($('czCards'), 'cz', cz, (el, c) => {
    setFace(el, c, 'small');
    const tax = 2 * ((s.cmdTax || {})[c.name] || 0);
    const can = affordable(c, s);
    setCls(el, { dim: !can });
    fx.glow(el, can);
    setOv(el, tax ? `<span class="taxtag">tax +${tax}</span>` : '');
  }, wanted);
  // an outlined placeholder for each commander that is not in the command zone (on the battlefield, in a pile…)
  const czBox = $('czCards');
  if (czBox) {
    const away = commanderNames(s).filter(n => !cz.some(c => c.name === n));
    const sig = away.map(n => `${n}:${(s.cmdTax || {})[n] || 0}`).join('|');
    if (czBox._ph !== sig) {
      czBox._ph = sig;
      czBox.querySelectorAll(':scope > .cz-ph').forEach(n => n.remove());
      for (const n of away) {
        const ph = document.createElement('div');
        const tax = 2 * ((s.cmdTax || {})[n] || 0);
        ph.className = 'cz-ph';
        ph.title = `${n} is not in the command zone`;
        ph.innerHTML = tax ? `<span class="taxtag">tax +${tax}</span>` : '';
        czBox.appendChild(ph);
      }
    } else czBox.querySelectorAll(':scope > .cz-ph').forEach(n => czBox.appendChild(n)); // keep them after the cards
  }
  const slot = $('czSlot');
  if (slot) {
    slot.classList.toggle('vacant', !cz.length && !commanderNames(s).length);
    const lbl = slot.querySelector('.cz-label');
    if (lbl) {
      const names = commanderNames(s);
      const tax = 2 * ((s.cmdTax || {})[names[0]] || 0);
      lbl.textContent = cz.length ? 'Command' : (tax ? `Command · tax +${tax}` : 'Command');
    }
  }
  const board = $('board');
  if (board) board.classList.toggle('attack-mode', combat);
  const empty = $('bfEmpty');
  if (empty) empty.hidden = (z.bf || []).length > 0;
  // attack bar
  const ab = $('atkbar');
  if (ab) {
    if (combat) {
      const able = (z.bf || []).filter(canAttack);
      const all = able.length && able.every(p => ui.atk.has(String(p.uid)));
      ab.hidden = false;
      ab.innerHTML = able.length
        ? `<button class="atk-all${all ? ' on' : ''}" data-act="selectAll">${all ? 'Deselect all' : `Attack with all (${able.length})`}</button>
           <span class="atk-help">${all ? 'Everyone is in' : 'Tap creatures to choose attackers'}</span>`
        : '<span class="atk-help">Nothing can attack this turn</span>';
    } else { ab.hidden = true; ab.innerHTML = ''; }
  }
}

/* ---------- hand ---------- */
function affordable(c, s) {
  const f = face(c);
  if (s.owed > 0 || s.phase === 'cleanup') return false;
  if (isLandOnly(f)) return isMain(s.phase) && !s.landPlayed;
  if (!isInstantSpeed(f) && !isMain(s.phase)) return false;
  const cost = safe(() => E.castCost(G, c.name), null);
  return !!cost && safe(() => G.autoPay(cost).ok, false);
}
function renderHand(s, wanted) {
  const wrap = $('hand');
  if (!wrap) return;
  const hand = ((s.zones && s.zones.hand) || []).filter(c => !ui.pendingDraw.has(String(c.uid)));
  const gate = s.phase === 'cleanup' && s.zones.hand.length > 7;
  const owed = s.owed > 0;
  sync(wrap, 'hand', hand, (el, c) => {
    setFace(el, c, 'normal');
    const can = !gate && !owed && affordable(c, s);
    setCls(el, { dim: !can && !gate && !owed, pick: gate || owed, 'has-ab': abilitiesOf(c.uid).length > 0 });
    fx.glow(el, can);
  }, wanted);
  wrap.classList.toggle('gate', gate);
  wrap.classList.toggle('owed', owed);
  const lbl = $('handLabel');
  if (lbl) {
    lbl.classList.toggle('gate', gate || owed);
    lbl.textContent = gate ? `Discard ${s.zones.hand.length - 7}` : owed ? `Put ${s.owed} on the bottom` : `Hand · ${s.zones.hand.length}`;
  }
  const he = $('handEmpty');
  if (he) he.hidden = hand.length > 0;
  layoutFan(wrap);
}

/* ---------- side rail: physical piles ---------- */
function setPile(id, list, showTop) {
  const el = $(id);
  if (!el) return;
  const n = list.length;
  el.classList.toggle('empty', !n);
  el.style.setProperty('--depth', String(Math.min(6, Math.ceil(n / 12))));
  const img = el.querySelector('.pile-stack img');
  if (img) {
    const top = n ? list[n - 1] : null;
    const src = showTop ? (top ? (imgOf(face(top), 'small') || CARD_BACK) : '') : (n ? CARD_BACK : '');
    if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
    img.style.visibility = src ? '' : 'hidden';
    img.alt = showTop && top ? top.name : '';
  }
  const cnt = el.querySelector('.pile-n');
  if (cnt) cnt.textContent = String(n);
}
function renderRail(s) {
  const z = s.zones || {};
  setPile('pileLib', z.lib || [], false);
  setPile('pileGy', z.gy || [], true);
  setPile('pileEx', z.ex || [], true);
  const pl = playables();
  const hid = hiddenUids(s);
  const abIn = zone => (z[zone] || []).some(c => !hid.has(String(c.uid)) && abilitiesOf(c.uid).length);
  fx.glow($('pileGy'), pl.some(x => x.zone === 'gy') || abIn('gy'));
  fx.glow($('pileEx'), pl.some(x => x.zone === 'ex') || abIn('ex'));
  const lib = $('pileLib');
  if (lib) lib.classList.toggle('searched', !!s.searched);
  renderTopCard(s, pl.find(x => x.zone === 'lib'));
}

/** playFromTop: the library's top card shown face-up on the pile with a Cast / Play pill. */
function renderTopCard(s, top) {
  const lib = $('pileLib'), stack = lib && lib.querySelector('.pile-stack');
  if (!stack) return;
  let ov = stack.querySelector('.topcard');
  const entry = top ? ((s.zones || {}).lib || []).find(c => String(c.uid) === String(top.uid)) : null;
  fx.glow(lib, !!entry);
  if (!entry) { if (ov) ov.remove(); return; }
  const f = face(entry), can = affordable(entry, s);
  const html = `<img src="${esc(imgOf(f, 'small'))}" alt="${esc(entry.name)}" title="${esc(entry.name)} (top of library)">
    <span class="topplay${can ? ' can' : ''}" role="button" tabindex="0" data-act="playtop" data-arg="${esc(entry.uid)}">${isLandOnly(f) ? 'Play' : 'Cast'}</span>`;
  if (!ov) { ov = document.createElement('span'); ov.className = 'topcard'; stack.appendChild(ov); }
  if (ov._h !== html) { ov._h = html; ov.innerHTML = html; }
}

/* ---------- status: life, pool, turn, THE button ---------- */
function atkSummary() {
  const bf = (S().zones || {}).bf || [];
  const chosen = bf.filter(p => ui.atk.has(String(p.uid)));
  return { n: chosen.length, dmg: chosen.reduce((t, p) => t + Math.max(0, pow(p)) * stackN(p), 0) };
}
/** The state machine. Its label is the only phase UI the player sees. */
function primaryState(s) {
  if (!s) return { label: '…', disabled: true };
  if (ui.busy) return { label: ui.inter ? 'Their turn…' : '…', disabled: !ui.inter, fn: skipInterstitial };
  if (pendTop()) return { label: 'Resolve the trigger', disabled: true, kind: 'resolve', why: 'Answer the trigger on the table first' };
  if (s.owed > 0) return { label: `Bottom ${s.owed} first`, disabled: true, why: `Tap ${s.owed} card${s.owed > 1 ? 's' : ''} in your hand to put on the bottom` };
  const hand = (s.zones && s.zones.hand) || [];
  switch (s.phase) {
    case 'main1': {
      const any = ((s.zones && s.zones.bf) || []).some(canAttack);
      return any ? { label: 'Go to combat', fn: goCombat } : { label: 'End turn', fn: endTurn };
    }
    case 'combat': {
      const { n, dmg } = atkSummary();
      return n ? { label: `Attack with ${n} for ${dmg}`, fn: confirmAttack, kind: 'atk' } : { label: 'Skip combat', fn: skipCombat };
    }
    case 'combat-damage': return { label: 'Deal damage', fn: dealDamage, kind: 'atk' };
    case 'main2': case 'end': return { label: 'End turn', fn: endTurn };
    case 'cleanup':
      return hand.length > 7
        ? { label: `Discard ${hand.length - 7}`, disabled: true, why: 'Tap cards in your hand to discard down to 7' }
        : { label: 'End turn', fn: endTurn };
    default: return { label: 'Continue', fn: continueToMain };
  }
}
function renderStatus(s) {
  if (!s) return;
  const ln = $('lifeNum');
  if (ln) ln.textContent = String(s.life);
  const pool = s.pool || {};
  const orbs = $('orbs');
  if (orbs) {
    const html = COLORS.filter(c => (pool[c] || 0) > 0)
      .map(c => `<span class="orb orb-${c}" title="${c} mana">${c === 'C' ? '◇' : ''}<b>${esc(pool[c])}</b></span>`).join('');
    if (orbs._h !== html) { orbs._h = html; orbs.innerHTML = html || '<span class="orb-empty">no mana</span>'; }
    orbs.classList.toggle('has', poolTotal(pool) > 0);
  }
  renderPlayerCounters(s);
  renderEmblems(s);
  const t = $('turnLbl');
  if (t) t.innerHTML = `Turn ${esc(s.turn)} <span class="ph">${esc((LABEL[s.phase] || {}).full || s.phase)}</span>` +
    (s.searched ? ' <span class="warnc" title="You searched your library: shuffle">shuffle!</span>' : '');
  const b = $('primary');
  if (b) {
    const st = primaryState(s);
    if (b.textContent !== st.label) b.textContent = st.label;
    b.classList.toggle('soft', !!st.disabled);
    b.classList.toggle('atk', st.kind === 'atk');
    b.classList.toggle('resolve', st.kind === 'resolve');
    b.setAttribute('aria-disabled', st.disabled ? 'true' : 'false');
  }
}

/* ================= win ================= */
function damageByTurn(s) {
  const out = {};
  for (const line of s.log || []) {
    const m = /^T(\d+) [^:]*: (.*)$/.exec(line);
    if (!m) continue;
    const t = +m[1];
    let d = 0, x;
    if ((x = /^Combat damage: the dummy takes (\d+)/.exec(m[2]))) d = +x[1];
    else if ((x = /^Dummy life ([+-]?\d+)/.exec(m[2]))) d = -(+x[1]);
    if (d) out[t] = (out[t] || 0) + d;
  }
  return out;
}
function checkWin(s) {
  if (s.lost && !ui.prevLost && !ui.busy) { ui.prevLost = true; showLost(); return; }
  if (!s.lost) ui.prevLost = false;
  const won = !!s.won;
  if (won && !ui.prevWon && !ui.busy) { ui.prevWon = true; showWin(); return; }
  if (!won) ui.prevWon = false;
}
function showWin() {
  const s = S(), el = $('win');
  if (!s || !el) return;
  const turn = s.wonOn ?? s.turn;
  let best = null;
  try { best = parseInt(localStorage.getItem(BEST_KEY), 10); } catch (_) { /* storage blocked */ }
  const isBest = !Number.isFinite(best) || turn < best;
  if (isBest) { try { localStorage.setItem(BEST_KEY, String(turn)); } catch (_) { /* ok */ } }
  const dmg = damageByTurn(s);
  const turns = Array.from({ length: Math.max(1, turn) }, (_, i) => i + 1);
  const max = Math.max(1, ...turns.map(t => Math.max(0, dmg[t] || 0)));
  el.innerHTML = `<div class="win-card" role="dialog" aria-label="Victory">
    <div class="win-kicker">Victory</div>
    <div class="win-avatar">${DUMMY_SVG}</div>
    <h2>Training Dummy defeated</h2>
    <div class="win-turn">turn ${esc(turn)}</div>
    <div class="win-bars" aria-label="Damage per turn">${turns.map(t => {
      const v = Math.max(0, dmg[t] || 0);
      return `<div class="wb" title="Turn ${t}: ${v} damage"><span class="wbv">${v || ''}</span><i style="height:${((v / max) * 100).toFixed(0)}%"></i><span class="wbt">${t}</span></div>`;
    }).join('')}</div>
    <div class="win-best">${isBest ? (Number.isFinite(best) ? `New best — was turn ${esc(best)}` : 'First win with this deck') : `Best: turn ${esc(best)}`}</div>
    <div class="win-btns"><button class="btn primary" data-act="again">Play again</button><button class="btn" data-act="keep">Keep playing</button></div>
  </div>`;
  el.classList.add('open');
  ui.winOpen = true;
  fx.dimBoard(true);
}
function showLost() {
  const s = S(), el = $('win');
  if (!s || !el) return;
  el.innerHTML = `<div class="win-card lost" role="dialog" aria-label="Defeat">
    <div class="win-kicker">Defeat</div>
    <h2>You lost</h2>
    <div class="win-turn">turn ${esc(s.turn)}</div>
    <p class="lost-why">${esc(s.lostReason || 'a rules effect')}</p>
    <div class="win-btns"><button class="btn primary" data-act="again">Play again</button><button class="btn" data-act="undo">Undo</button></div>
  </div>`;
  el.classList.add('open');
  ui.winOpen = true;
  fx.dimBoard(true);
}
function closeWin() {
  const el = $('win');
  if (el) el.classList.remove('open');
  if (ui.winOpen) fx.dimBoard(false);
  ui.winOpen = false;
}

/* ================= animation helpers ================= */
function fxLayer() {
  let l = $('fx-layer');
  if (!l) { l = document.createElement('div'); l.id = 'fx-layer'; document.body.appendChild(l); }
  return l;
}
/** A free-floating copy of el in #fx-layer at el's on-screen spot (survives el being re-rendered away). */
function makeProxy(el) {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const w = el.offsetWidth || r.width, h = el.offsetHeight || r.height;
  const c = el.cloneNode(true);
  delete c.dataset.uid; delete c.dataset.z;
  c.classList.remove('glow', 'peek', 'tapped', 'dim', 'drag-src', 'pick');
  c.classList.add('fx-proxy');
  Object.assign(c.style, {
    position: 'absolute', left: `${r.left + r.width / 2 - w / 2}px`, top: `${r.top + r.height / 2 - h / 2}px`,
    width: `${w}px`, height: `${h}px`, margin: '0', transform: 'none', translate: 'none', rotate: 'none',
    transition: 'none', pointerEvents: 'none', visibility: 'visible', opacity: '1', zIndex: '1',
  });
  fxLayer().appendChild(c);
  return c;
}
async function flyProxy(proxy, dest, { duration, hideDest = true } = {}) {
  if (!proxy) return;
  const hide = hideDest && dest && dest.classList && dest.classList.contains('card');
  if (hide) dest.style.visibility = 'hidden';
  try { await fx.fly(proxy, dest, { clone: false, ...(duration ? { duration } : {}) }); } catch (_) { /* fx never throws, but */ }
  proxy.remove();
  if (hide) dest.style.visibility = '';
}
const pileTarget = id => $(id)?.querySelector('.pile-stack') || $(id);
const newBfUid = before => ((S().zones || {}).bf || []).map(p => p.uid).find(u => !before.has(u));

/* ================= playing cards ================= */
function shortfall(cost) {
  const full = safe(() => G.autoPay(cost), null);
  if (!full || full.ok) return null;
  let pips = (cost.pips || []).slice();
  const missing = [];
  let base = safe(() => G.autoPay({ generic: 0, pips }).short, 0);
  for (let i = 0; i < pips.length && base > 0;) {
    const trial = pips.slice(0, i).concat(pips.slice(i + 1));
    const sh = safe(() => G.autoPay({ generic: 0, pips: trial }).short, base);
    if (sh < base) { missing.push(pips[i]); pips = trial; base = sh; } else i++;
  }
  return { generic: Math.max(0, (full.short || 0) - missing.length), pips: missing, x: 0 };
}

/** Cast a spell / play a land from hand or the command zone, animated. Returns true if it left the zone.
    src: an existing proxy (the drag ghost) to fly from; the caller owns it when this returns false. */
async function playCard(uid, { force = false, x = null, src = null } = {}) {
  if (ui.busy) return false;
  const f = findEntry(uid);
  const fromPile = f && (f.zone === 'gy' || f.zone === 'ex' || f.zone === 'lib') && isPlayable(uid);
  if (!f || (f.zone !== 'hand' && f.zone !== 'cz' && !fromPile)) return false;
  const c = f.entry, fc = face(c), s = S();
  const el = elOf(f.zone, c.uid) || (fromPile ? (f.zone === 'lib' ? $('pileLib')?.querySelector('.topcard img') : pileTarget(f.zone === 'gy' ? 'pileGy' : 'pileEx')) : null);
  const before = new Set(((s.zones || {}).bf || []).map(p => p.uid));

  if (isLandOnly(fc) && f.zone !== 'cz') {
    if (!force && !isMain(s.phase)) { fx.shake(el); hint('Lands go down in a main phase — long-press for "Play anyway"'); return false; }
    if (!force && s.landPlayed) { fx.shake(el); hint('You already played a land this turn — long-press for "Play anyway"'); return false; }
    setBusy(true);
    try {
      const r = call(() => G.playLand(c.uid, { force }));
      if (r.ok === false) { hint(reasonText(r)); render(); return false; }
      const proxy = src || makeProxy(el);
      render();
      await flyProxy(proxy, elOf('bf', newBfUid(before)));
      return true;
    } finally { setBusy(false); render(); }
  }

  const cost = safe(() => E.castCost(G, c.name), null);
  if (!cost) { hint('No card data for ' + c.name); return false; }
  if (cost.x > 0 && x == null && !force) { askX(c.uid, c.name, force); return false; }
  if (!force && !isInstantSpeed(fc) && !isMain(s.phase)) { fx.shake(el); hint(`${c.name} needs a main phase`); return false; }
  const full = { generic: (cost.generic || 0) + Math.max(0, x | 0) * (cost.x || 0), pips: (cost.pips || []).slice(), x: 0 };
  const plan = safe(() => G.autoPay(full), null);
  if (!force && (!plan || !plan.ok)) {
    fx.shake(el);
    const need = shortfall(full);
    hint(need ? `Need ${costHtml(need)} more` : `Short ${plan ? plan.short : '?'} mana`, { html: true });
    return false;
  }
  setBusy(true);
  try {
    const tapEls = ((plan && plan.tap) || []).map(t => elOf('bf', t.uid)).filter(Boolean);
    if (tapEls.length) await fx.tapSequence(tapEls, 90);
    const opts = { force };
    if (x != null) opts.x = x;
    const r = call(() => G.cast(c.uid, opts));
    if (r.ok === false) {
      if (r.reason === 'mana') { const need = shortfall(full); hint(need ? `Need ${costHtml(need)} more` : reasonText(r), { html: !!need }); }
      else hint(reasonText(r));
      render();
      return false;
    }
    const proxy = src || makeProxy(el);
    render();
    if (r.to === 'gy') await resolveToGraveyard(proxy, c);
    else await flyProxy(proxy, elOf('bf', r.uid != null && elOf('bf', r.uid) ? r.uid : newBfUid(before)));
    if (r.short) hint(`Cast with ${r.short} unpaid (forced)`, { kind: 'info' });
    return true;
  } finally { setBusy(false); render(); }
}
/** Instant / sorcery: fly to the centre, hold a beat as "resolved", then to the graveyard pile. */
async function resolveToGraveyard(proxy, c) {
  const stage = $('stage');
  if (!proxy) return;
  if (!stage || reducedMotion()) { await flyProxy(proxy, pileTarget('pileGy')); return; }
  stage.innerHTML = `<img src="${esc(imgOf(face(c), 'normal'))}" alt=""><span class="stage-cap">Resolved</span>`;
  const img = stage.querySelector('img');
  img.style.visibility = 'hidden';
  await flyProxy(proxy, stage, { duration: 380 });
  img.style.visibility = '';
  stage.classList.add('show');
  await fx.sleep(520);
  const p2 = makeProxy(img);
  stage.classList.remove('show');
  stage.innerHTML = '';
  await flyProxy(p2, pileTarget('pileGy'), { duration: 360 });
}
function askX(uid, name, force) {
  openSheet({
    title: `Cast ${esc(name)}: choose X`,
    body: `<div class="row"><input type="number" id="xval" value="1" min="0" max="99" inputmode="numeric"></div>`,
    buttons: [{ label: 'Cast', primary: true, fn: () => playCard(uid, { force, x: Math.max(0, parseInt($('xval')?.value, 10) || 0) }) }, { label: 'Cancel' }],
  });
  setTimeout(() => $('xval')?.select(), 0);
}
async function discardCard(c, src = null) {
  if (ui.busy) return;
  const el = elOf('hand', c.uid);
  setBusy(true);
  try {
    const r = call(() => G.discard(c.uid));
    if (r.ok === false) { hint(reasonText(r)); return; }
    const proxy = src || makeProxy(el);
    render();
    await flyProxy(proxy, pileTarget('pileGy'), { duration: 340 });
  } finally { setBusy(false); render(); }
  const s = S();
  if (s.phase === 'cleanup' && s.zones.hand.length <= 7) await endTurn();
}
async function bottomCard(c) {
  if (ui.busy) return;
  const el = elOf('hand', c.uid);
  setBusy(true);
  try {
    const r = call(() => G.bottom(c.uid));
    if (r.ok === false) { hint(reasonText(r)); return; }
    const proxy = makeProxy(el);
    render();
    await flyProxy(proxy, pileTarget('pileLib'), { duration: 340 });
    hint(r.owed ? `${r.owed} more to the bottom` : 'Keeping this hand', { kind: 'info' });
  } finally { setBusy(false); render(); }
}
async function drawCards(n = 1) {
  if (ui.busy) return;
  const before = new Set(((S().zones || {}).hand || []).map(c => String(c.uid)));
  const r = call(() => G.draw(n));
  if (r.ok === false) { hint(reasonText(r)); render(); return; }
  await animateDraws(before);
}
/** Fly every hand card not in `before` from the library pile, one by one, then show it. */
async function animateDraws(before) {
  const drawn = ((S().zones || {}).hand || []).filter(c => !before.has(String(c.uid)));
  drawn.forEach(c => ui.pendingDraw.add(String(c.uid)));
  const wasBusy = ui.busy;
  if (!wasBusy) setBusy(true);
  try {
    render();
    for (const c of drawn) {
      await fx.draw(pileTarget('pileLib'), $('hand'), CARD_BACK, imgOf(face(c), 'normal'));
      ui.pendingDraw.delete(String(c.uid));
      render();
    }
  } finally {
    ui.pendingDraw.clear();
    if (!wasBusy) setBusy(false);
    render();
  }
}

/* ================= battlefield taps ================= */
function manaChoices(f) {
  const ids = new Set([...(DECK.pips || []), 'C']);
  const prod = [...new Set(f.produced_mana || [])];
  const inDeck = prod.filter(c => ids.has(c));
  return inDeck.length ? inDeck : prod;
}
function centerHtml(e, f, caption) {
  const img = imgOf(f, 'normal');
  const n = e && e.tok ? (e.n || 1) : 1;
  return (img ? `<img class="rcenter" src="${esc(img)}" alt="${esc(f.name)}">`
    : `<div class="rcenter tokface"><span>${esc(f.name)}${n > 1 ? `<br><b>&times;${n}</b>` : ''}</span></div>`) +
    (caption ? `<div class="rcaption">${esc(caption)}</div>` : '');
}
function colorWheel(p, colors, onPick, title) {
  openRadial(centerHtml(p, face(p), title), colors.map(c => ({ label: `${pipHtml(c)} ${c}`, fn: () => onPick(c) })));
}
async function tapForMana(p, color) {
  if (ui.busy) return;
  const el = elOf('bf', p.uid);
  setBusy(true);
  try {
    await fx.tap(el);
    const r = call(() => G.tapForMana(p.uid, color));
    if (r.ok === false) hint(reasonText(r));
  } finally { setBusy(false); render(); }
}
async function toggleTap(p) {
  if (ui.busy) return;
  const el = elOf('bf', p.uid);
  setBusy(true);
  try {
    await (p.tapped ? fx.untap(el) : fx.tap(el));
    const r = call(() => G.toggleTap(p.uid));
    if (r.ok === false) hint(reasonText(r));
  } finally { setBusy(false); render(); }
}
function bfClick(p) {
  const s = S(), f = face(p), id = String(p.uid), el = elOf('bf', p.uid);
  if (ui.pick && ui.pick.zone === 'bf') { pickToggle(id, el); return; }
  if (s.phase === 'combat' && permIsCreature(p)) {
    if (ui.atk.has(id)) ui.atk.delete(id);
    else if (p.tapped) { fx.shake(el); hint(`${p.name} is tapped`); return; }
    else if (p.sick && !haste(p, f)) { fx.shake(el); hint(`${p.name} is summoning sick`); return; }
    else ui.atk.add(id);
    render();
    return;
  }
  if (p.tok && /treasure/i.test(p.name) && !p.tapped) { sacrificeTreasure(p); return; }
  if (!p.tapped && isManaSource(p, f)) {
    const ch = manaChoices(f);
    if (ch.length > 1) colorWheel(p, ch, c => tapForMana(p, c), 'Tap for which colour?');
    else tapForMana(p, undefined);
    return;
  }
  toggleTap(p);
}
function sacrificeTreasure(p) {
  const colors = [...new Set([...(DECK.pips || []), 'C'])].filter(c => COLORS.includes(c));
  colorWheel(p, colors.length ? colors : COLORS, c => act(() => {
    const r = G.addMana(c, 1);
    if (r && r.ok === false) return r;
    return (p.n || 1) > 1 ? G.setTokenCount(p.uid, (p.n || 1) - 1) : G.move(p.uid, 'gy');
  }, { ok: `Sacrificed a Treasure for {${c}}` }), 'Sacrifice for which colour?');
}

/* ================= the turn ================= */
async function goCombat() {
  if (ui.busy) return;
  const r = call(() => G.nextPhase());
  if (r.ok === false) { hint(reasonText(r)); render(); return; }
  render();
  if (S().phase === 'combat') fx.banner('Combat', { sub: 'Tap creatures to attack', hold: 700 });
}
async function skipCombat() {
  if (ui.busy) return;
  ui.atk.clear();
  const r = call(() => G.nextPhase());
  if (r.ok === false) { hint(reasonText(r)); render(); return; }
  render();
  fx.banner('Main phase 2', { hold: 700 });
}
async function confirmAttack() {
  if (ui.busy) return;
  const ids = [...ui.atk].map(u => findEntry(u)).filter(f => f && f.zone === 'bf').map(f => f.entry.uid);
  if (!ids.length) return skipCombat();
  let paused = false;
  setBusy(true);
  try {
    const r1 = call(() => G.declareAttackers(ids));
    if (r1.ok === false) { hint(reasonText(r1)); return; }
    ui.atk.clear();
    if (r1.skipped && r1.skipped.length) {
      hint('Skipped: ' + r1.skipped.map(x => `${findEntry(x.uid)?.entry.name || x.uid} (${x.reason})`).join(', '));
    }
    const atk = (r1.attackers || []).map(u => findEntry(u)?.entry).filter(Boolean);
    const atkEls = atk.map(p => elOf('bf', p.uid)).filter(Boolean);
    atkEls.forEach(el => { el.classList.add('atk'); el.classList.remove('atk-sel', 'can-atk'); });
    await fx.tapSequence(atk.filter(p => !vigilant(p)).map(p => elOf('bf', p.uid)).filter(Boolean), 70);
    if (pendTop()) { paused = true; ui.resume = 'combat'; return; } // an attack trigger first; damage after it resolves
    await strike(atkEls);
  } finally { setBusy(false); render(); }
  if (!paused) afterCombat();
}
async function dealDamage() { // combat-damage restored from a reload
  if (ui.busy) return;
  setBusy(true);
  try {
    const atkEls = (S().attackers || []).map(u => elOf('bf', u)).filter(Boolean);
    await strike(atkEls);
  } finally { setBusy(false); render(); }
  afterCombat();
}
/** Lunge, resolve, and land the hits on the dummy. */
async function strike(atkEls) {
  const avatar = $('oppAvatar'), lifeEl = $('oppLifeNum');
  await Promise.all(atkEls.map((el, i) => fx.sleep(i * 90).then(() => fx.lunge(el, avatar))));
  const before = S().opp.life;
  const r = call(() => G.resolveCombat());
  if (r.ok === false) { hint(reasonText(r)); return; }
  const after = S().opp.life;
  const dmg = r.damage || 0;
  if (dmg > 0) {
    fx.shake($('opp'), Math.min(2, 0.8 + dmg / 12));
    fx.damage(avatar, dmg);
    await fx.countTo(lifeEl, before, after, 600);
  } else hint('No damage got through', { kind: 'info' });
}
function afterCombat() {
  const s = S();
  render();
  if (s.won) return;
  if (s.phase === 'main2') fx.banner('Main phase 2', { hold: 700 });
  else if (s.phase === 'combat') fx.banner('Additional combat', { sub: 'Tap creatures to attack', hold: 800 }); // extraCombat
}
async function attackAll() {
  if (ui.busy) return;
  if (pendTop()) { fx.shake($('primary'), 0.6); hint('Answer the trigger on the table first'); return; }
  let s = S();
  if (s.phase === 'main1') {
    if (!((s.zones.bf || []).some(canAttack))) { hint('Nothing can attack'); return; }
    const r = call(() => G.nextPhase());
    if (r.ok === false) { hint(reasonText(r)); render(); return; }
    s = S();
  }
  if (s.phase !== 'combat') { hint('Combat is over for this turn'); return; }
  const able = (s.zones.bf || []).filter(canAttack);
  if (!able.length) { render(); hint('Nothing can attack'); return; }
  ui.atk = new Set(able.map(p => String(p.uid)));
  render();
  await confirmAttack();
}
/** The pill: select every eligible attacker (or clear them if all are in); the primary button confirms. */
function selectAll() {
  if (ui.busy) return;
  const s = S();
  if (s.phase !== 'combat') return;
  const able = (s.zones.bf || []).filter(canAttack).map(p => String(p.uid));
  const all = able.length && able.every(u => ui.atk.has(u));
  ui.atk = all ? new Set() : new Set(able);
  render();
}
async function endTurn() {
  if (ui.busy) return;
  const s = S();
  const prevTapped = (s.zones.bf || []).filter(p => p.tapped).map(p => p.uid);
  const prevHand = new Set((s.zones.hand || []).map(c => String(c.uid)));
  const turnBefore = s.turn;
  ui.atk.clear();
  const r = call(() => G.passTurn());
  if (r.ok === false && r.reason === 'pending' && pendTop()) { // a trigger on the way (end step / upkeep) needs an answer
    ui.resume = 'turn';
    if (S().turn > turnBefore) await turnStart(prevTapped, prevHand);
    else { render(); fx.banner('End step', { sub: 'A trigger needs you', hold: 700 }); }
    return;
  }
  if (r.ok === false) {
    render();
    if (r.reason === 'discard') {
      hint(`Discard ${r.count} — tap cards in your hand`);
      fx.shake($('handLabel'));
      fx.banner('End of turn', { sub: `Discard down to 7`, hold: 700 });
    } else hint(reasonText(r));
    return;
  }
  await turnStart(prevTapped, prevHand);
}
async function opponentTurn() {
  const opp = $('opp'), sub = $('oppSub'), pile = $('oppLib');
  ui.inter = true;
  setBusy(true);
  opp?.classList.add('their-turn');
  if (sub) sub.textContent = 'Training Dummy’s turn';
  fx.dimBoard(true);
  pile?.classList.remove('drawing'); void pile?.offsetWidth; pile?.classList.add('drawing');
  await beat(700);
  if (sub) sub.textContent = 'passes';
  await beat(550);
  opp?.classList.remove('their-turn');
  pile?.classList.remove('drawing');
  await fx.dimBoard(false);
  ui.inter = false;
}
async function turnStart(prevTapped, prevHand) {
  setBusy(true);
  try {
    const extra = ui.extraTurn;
    ui.extraTurn = false;
    if (S().turn > 1 && !extra) await opponentTurn(); // an extra turn: the dummy doesn't get one in between
    await fx.untapAll(prevTapped.map(u => elOf('bf', u)).filter(Boolean));
    const s = S();
    const noDraw = s.turn === 1 && s.onThePlay !== false;
    const drawn = (s.zones.hand || []).some(c => !prevHand.has(String(c.uid)));
    const stopped = !isMain(s.phase) && !!pendTop();
    fx.banner(extra ? 'Extra turn' : `Turn ${s.turn}`, { sub: stopped ? 'A trigger needs you' : noDraw ? 'On the play — no draw' : drawn ? 'Untap · draw' : 'Library is empty — no draw', hold: 800 });
    await animateDraws(prevHand);
  } finally { ui.inter = false; setBusy(false); render(); }
}
function undo() {
  if (ui.busy) return;
  ui.atk.clear();
  ui.pendingDraw.clear();
  closeWin();
  ui.pick = null; ui.logTail = null;
  const r = call(() => G.undo());
  if (r.ok === false) hint(reasonText(r)); else hint('Undone', { kind: 'info', ms: 1600 });
  ui.prevLost = !!S().lost;
  ui.prevWon = !!S().won; // undoing out of a win and back in should celebrate again, not on every undo
  render();
}
function newGame(ask = true) {
  const go = () => {
    closeWin();
    ui.atk.clear(); ui.pendingDraw.clear();
    const r = call(() => G.restart({}));
    if (r.ok === false) { hint(reasonText(r)); return; }
    ui.pick = null; ui.pendId = null;
    attachRulesLayer(); // fresh game, fresh listeners
    ui.prevWon = false;
    render();
    fx.banner('Turn 1', { sub: 'On the play — no draw' });
  };
  if (!ask) { go(); return; }
  confirmSheet('New game?', `Shuffle up a fresh game of ${DECK.name}? (Undo can bring this one back.)`, 'New game', go);
}

/* ================= menus ================= */
function openCardMenu(uid) {
  const found = findEntry(uid);
  if (!found) return;
  const { entry: e, zone } = found;
  const f = face(e), s = S(), u = e.uid;
  const o = [];
  const add = (label, fn) => o.push({ label, fn });
  const mv = (to, label, opts) => add(label, () => act(() => G.move(u, to, opts || {})));
  const cmdr = isCmdr(e.name);
  if (zone === 'hand') {
    if (s.owed > 0) add('Bottom (mulligan)', () => bottomCard(e));
    if (isLandOnly(f)) {
      add('Play land', () => playCard(u));
      if (s.landPlayed || !isMain(s.phase)) add('Play anyway', () => playCard(u, { force: true }));
    } else {
      const cost = safe(() => E.castCost(G, e.name), null);
      const plan = cost ? safe(() => G.autoPay(cost), null) : null;
      add(`Cast ${costHtml(cost)}${plan && !plan.ok ? ` <small class="short">short ${plan.short}</small>` : ''}`, () => playCard(u));
      add('Cast anyway', () => playCard(u, { force: true, x: cost && cost.x ? null : undefined }));
    }
    for (const ab of abilitiesOf(u)) add(abLabel(ab), () => runAbility(u, ab)); // cycling, channel, adventure halves…
    add('Discard', () => discardCard(e));
    mv('bf', 'Onto battlefield (free)');
    mv('ex', 'Exile');
    mv('lib', 'Top of library', { top: true });
    mv('lib', 'Bottom of library');
  } else if (zone === 'cz') {
    const tax = 2 * ((s.cmdTax || {})[e.name] || 0);
    add(`Cast ${costHtml(safe(() => E.castCost(G, e.name), null))}${tax ? ` <small>tax +${tax}</small>` : ''}`, () => playCard(u));
    add('Cast anyway', () => playCard(u, { force: true }));
    mv('bf', 'Onto battlefield (free)');
    mv('hand', 'To hand');
  } else if (zone === 'bf') {
    const n = stackN(e);
    add(e.tapped ? 'Untap' : 'Tap', () => toggleTap(e));
    if (!e.tapped && isManaSource(e, f)) add('Tap for mana', () => bfClick(e));
    if (e.attacking) add(e.blocked ? 'Unblock' : 'Blocked (no damage)', () => act(() => G.markBlocked(u, !e.blocked)));
    if (DECK.cards?.[e.name]?.back && !e.tok) add('Transform', () => act(() => G.transform(u)));
    if (isPlaneswalkerFace(f)) {
      add('+1 loyalty', () => act(() => G.addCounter(u, 'loyalty', 1)));
      add('&minus;1 loyalty', () => act(() => G.addCounter(u, 'loyalty', -1)));
    }
    for (const ab of abilitiesOf(u)) add(abLabel(ab), () => runAbility(u, ab));
    add('+1/+1 counter', () => act(() => G.addCounter(u, 'p1p1', 1)));
    if ((e.counters || {}).p1p1 > 0) add('Remove +1/+1', () => act(() => G.addCounter(u, 'p1p1', -1)));
    add('Other counter +1', () => act(() => G.addCounter(u, 'other', 1)));
    if ((e.counters || {}).other > 0) add('Other counter &minus;1', () => act(() => G.addCounter(u, 'other', -1)));
    if (e.tok) {
      add('One more', () => act(() => G.setTokenCount(u, n + 1)));
      if (n > 1) {
        add('Split one off', () => act(() => G.splitToken(u)));
        add('Remove one', () => act(() => G.setTokenCount(u, n - 1)));
      }
      const twins = s.zones.bf.some(q => q !== e && q.tok && q.name.toLowerCase() === e.name.toLowerCase());
      if (twins) add('Merge same tokens', () => act(() => G.mergeTokens(u)));
      add(n > 1 ? `Remove all ${n}` : 'Remove token', () => act(() => G.setTokenCount(u, 0)));
    } else {
      mv('gy', 'To graveyard'); mv('hand', 'To hand'); mv('ex', 'To exile');
      mv('lib', 'Top of library', { top: true }); mv('lib', 'Bottom of library');
      if (cmdr) mv('cz', 'To command zone');
    }
    add('Copy', () => act(() => G.copyPermanent(u)));
  } else { // gy, ex, lib
    if (zone === 'gy' || zone === 'ex') for (const ab of abilitiesOf(u)) add(abLabel(ab), () => runAbility(u, ab));
    mv('hand', 'To hand'); mv('bf', 'To battlefield');
    mv('lib', 'Top of library', { top: true }); mv('lib', 'Bottom of library');
    if (zone === 'gy') mv('ex', 'Exile'); else if (zone === 'ex') mv('gy', 'To graveyard');
    if (cmdr) mv('cz', 'To command zone');
  }
  add('Card text', () => showOracle(e, zone));
  openRadial(centerHtml(e, f, zone === 'bf' ? modTip(e).split('\n')[0] : ''), o);
}
function openLibMenu() {
  const s = S();
  const n = (s.zones.lib || []).length;
  openRadial(`<img class="rcenter" src="${CARD_BACK}" alt="Library"><div class="rcaption">Library · ${n}</div>`, [
    { label: 'Draw a card', fn: () => drawCards(1) },
    { label: 'Search library', fn: () => openLibrary() },
    { label: 'Shuffle', fn: () => act(() => G.shuffle(), { ok: 'Library shuffled' }) },
    { label: 'Mill 1', fn: () => { const top = (S().zones.lib || [])[0]; if (top) act(() => G.move(top.uid, 'gy')); } },
    { label: 'Top to exile', fn: () => { const top = (S().zones.lib || [])[0]; if (top) act(() => G.move(top.uid, 'ex')); } },
  ]);
}
function browseZone(zone) {
  const s = S();
  const hid = zone === 'ex' ? hiddenUids(s) : new Set(); // hideaway cards are face down: not shown
  const list = ((s.zones || {})[zone] || []).filter(c => !hid.has(String(c.uid))).slice().reverse();
  const title = zone === 'gy' ? 'Graveyard' : 'Exile';
  // cards a rules effect lets you cast / play from here come first, with their own button
  const play = new Set(playables().filter(x => x.zone === zone).map(x => String(x.uid)));
  const rank = c => (play.has(String(c.uid)) || abilitiesOf(c.uid).length ? 1 : 0);
  list.sort((a, b) => rank(b) - rank(a));
  const tile = c => {
    const id = String(c.uid), can = play.has(id) && affordable(c, s);
    const abs = abilitiesOf(c.uid);
    const btn = (play.has(id) ? `<button class="btn zplay${can ? ' primary' : ''}" data-zplay="${esc(id)}">${isLandOnly(face(c)) ? 'Play' : 'Cast'}</button>` : '') +
      abs.map(ab => `<button class="btn zplay${ab.ok ? ' primary' : ''}" data-zab="${esc(id)}:${ab.index}" title="${esc(ab.text || '')}">${abLabel(ab)}</button>`).join('');
    return `<div class="zwrap${play.has(id) || abs.length ? ' playable' : ''}"><button class="zcard" data-zuid="${esc(id)}" title="${esc(c.name)}">
      <img loading="lazy" src="${esc(imgOf(face(c), 'small'))}" alt="${esc(c.name)}"></button>${btn}</div>`;
  };
  openSheet({
    title: `${title} · ${list.length}`, cls: 'wide',
    body: list.length ? `<div class="zgrid">${list.map(tile).join('')}</div>
      <p class="sheet-note">${play.size ? `${play.size} card${play.size > 1 ? 's' : ''} can be played from here. ` : ''}Tap a card for its options.</p>` : `<p class="sheet-text">Nothing in ${title.toLowerCase()}.</p>`,
    buttons: [{ label: 'Close' }],
    onClick: ev => {
      const pb = ev.target.closest('[data-zplay]');
      if (pb) { closeSheet(); playCard(+pb.dataset.zplay); return true; }
      const ab = ev.target.closest('[data-zab]');
      if (ab) {
        const [u, i] = ab.dataset.zab.split(':');
        const it = abilitiesOf(u).find(x => String(x.index) === i);
        closeSheet();
        if (it) runAbility(u, it);
        return true;
      }
      const b = ev.target.closest('[data-zuid]');
      if (!b) return false;
      closeSheet();
      openCardMenu(b.dataset.zuid);
      return true;
    },
  });
}
function openPoolSheet() {
  const draw = () => {
    const pool = S().pool || {};
    openSheet({
      title: 'Mana pool',
      body: `<div class="poolgrid">${COLORS.map(c => `<div class="poolrow">${pipHtml(c)}
        <button class="btn" data-pm="${c}:-1" aria-label="Remove ${c}">&minus;</button><b>${esc(pool[c] || 0)}</b>
        <button class="btn" data-pm="${c}:1" aria-label="Add ${c}">+</button></div>`).join('')}</div>
        <p class="sheet-note">For rituals and effects the engine doesn't model. Mana empties when the phase changes.</p>`,
      buttons: [{ label: 'Done', primary: true }],
      onClick: ev => {
        const b = ev.target.closest('[data-pm]');
        if (!b) return false;
        const [c, d] = b.dataset.pm.split(':');
        act(() => G.addMana(c, +d));
        draw();
        return true;
      },
    });
  };
  draw();
}
function openOppSheet() {
  const draw = () => {
    const o = S().opp || {};
    openSheet({
      title: 'Training Dummy',
      body: `<div class="oppadj"><button class="btn" data-od="-5">&minus;5</button><button class="btn" data-od="-1">&minus;1</button>
        <b>${esc(o.life)}</b><button class="btn" data-od="1">+1</button><button class="btn" data-od="5">+5</button></div>
        <p class="sheet-note">For burn, drain and anything else that isn't combat damage.</p>`,
      buttons: [{ label: 'Done', primary: true }],
      onClick: ev => {
        const b = ev.target.closest('[data-od]');
        if (!b) return false;
        const before = S().opp.life;
        act(() => G.oppLife(+b.dataset.od));
        const d = before - S().opp.life;
        if (d > 0) { fx.damage($('oppAvatar'), d); fx.shake($('opp'), 0.6); }
        if (S().won) { closeSheet(); return true; }
        draw();
        return true;
      },
    });
  };
  draw();
}
function toggleMore(force) {
  const m = $('moreMenu');
  if (!m) return;
  const open = force === undefined ? !m.classList.contains('open') : !!force;
  if (open) {
    const s = S();
    const mullOk = s.turn === 1 && !(s.zones.bf || []).length;
    m.innerHTML = [
      ['back', '← Back to Manaforge', ''], ['undo', 'Undo', 'U'], ['draw', 'Draw a card', ''], ['tokens', 'Create tokens', 'K'], ['lib', 'Search library', 'V'],
      ['shuffle', 'Shuffle library', ''], mullOk ? ['mull', 'Mulligan', ''] : null, ['pool', 'Mana pool…', ''],
      ['log', 'Game log', 'L'], ['keys', 'Help & keys', '?'], ['classic', 'Classic table', ''], ['newgame', 'New game', ''],
    ].filter(Boolean).map(([a, l, k]) => `<button class="mi" data-act="${a}" role="menuitem">${l}${k ? `<kbd>${k}</kbd>` : ''}</button>`).join('');
  }
  m.classList.toggle('open', open);
  $('moreBtn')?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/* ================= rules layer: triggers, pending answers, statics (RULES.md §5) ================= */
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
/** Activated abilities of a card wherever it is (battlefield, hand, graveyard, exile): game.activatable (pass 6) or rules. */
function abilitiesOf(uid) {
  if (G && typeof G.activatable === 'function') return safe(() => G.activatable(+uid), []) || [];
  if (RULES && typeof RULES.activatable === 'function') return safe(() => RULES.activatable(+uid), []) || [];
  return [];
}
async function runAbility(uid, ab) {
  if (ui.busy) return;
  const before = new Set(((S().zones || {}).hand || []).map(c => String(c.uid)));
  const fn = G && typeof G.activateAbility === 'function' ? () => G.activateAbility(+uid, ab.index, { force: !ab.ok }) : () => RULES.activate(+uid, ab.index, { force: !ab.ok });
  const r = act(fn);
  if (r.ok !== false) await animateDraws(before);
}
const abLabel = ab => `${esc(ab.label || 'Activate')}${ab.ok ? '' : ` <small class="short">${esc(ab.reason || '')}</small>`}`;
const hiddenUids = s => new Set(((s.zones || {}).bf || []).flatMap(p => p.hidden || []).map(String));
const RING_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="8" rx="6" ry="5.2"/></svg>';
function renderEmblems(s) {
  const life = document.querySelector('#status .me-life');
  if (!life) return;
  let box = $('emblems');
  const list = s.emblems || [];
  if (!list.length) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement('span'); box.id = 'emblems'; box.className = 'emblems'; life.after(box); }
  const html = list.map((e, i) => `<button type="button" class="emchip" data-act="emblem" data-arg="${i}" title="${esc(emblemText(e))}">Emblem — ${esc(String(e.name || '').replace(/^Emblem\s*[—-]\s*/i, ''))}</button>`).join('');
  if (box._h !== html) { box._h = html; box.innerHTML = html; }
}
function emblemText(e) {
  const sc = e.script || {};
  return e.text || sc.text || sc.source || sc.notes || explainText(e.name).join(' ') || 'An emblem: it stays for the rest of the game.';
}
const LOCK_SVG = '<svg viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="6" width="9" height="7" rx="1.5"/><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2" fill="none"/></svg>';
const playables = () => (G && typeof G.playableCards === 'function' ? safe(() => G.playableCards(), []) : []);
const isPlayable = uid => playables().some(x => String(x.uid) === String(uid));
function renderPlayerCounters(s) {
  const orbs = $('orbs');
  if (!orbs) return;
  let box = $('pctr');
  const ctr = Object.entries(s.counters || {}).filter(([, v]) => v);
  if (!ctr.length) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement('span'); box.id = 'pctr'; box.className = 'pctr'; orbs.after(box); }
  const html = ctr.map(([k, v]) => `<span class="pchip" title="${esc(k)} counters"><i>${esc(k)}</i><b>${esc(v)}</b></span>`).join('');
  if (box._h !== html) { box._h = html; box.innerHTML = html; }
}

async function loadRules() {
  const mode = safe(() => new URLSearchParams(location.search).get('rules'), null);
  if (mode === 'off') return;
  const stub = mode === 'stub';
  let mod = null, bundle = null;
  try { mod = await import(stub ? './rules-stub.js' : './rules.js'); } catch (err) { console.info('Rules layer not loaded:', err && err.message); return; }
  if (!mod || typeof mod.attachRules !== 'function') return;
  try {
    const res = await fetch(`scripts/decks/${encodeURIComponent(DECK.slug || '')}.json`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    bundle = await res.json();
  } catch (err) {
    if (!stub) { console.info('No card scripts for this deck:', err && err.message); return; }
    bundle = {};
  }
  RULES_MOD = mod; BUNDLE = bundle || {};
  attachRulesLayer();
  if (safe(() => new URLSearchParams(location.search).has('debug'), false)) window.__mf = { game: () => G, rules: () => RULES, render, bundle: () => BUNDLE, reattach: () => { attachRulesLayer(); render(); } };
  render();
}
function attachRulesLayer() {
  if (!RULES_MOD || !G) return;
  try { RULES?.detach?.(); } catch (err) { console.warn(err); }
  RULES = null;
  try { RULES = RULES_MOD.attachRules(G, BUNDLE) || null; } catch (err) { console.error('attachRules failed:', err); RULES = null; }
  ui.logTail = null; ui.pick = null;
  hookTriggerEvents();
}
const hooked = new WeakSet();
const seenEv = new WeakSet();
/** Auto-resolved triggers -> ribbon. Listens on the rules object and/or the game bus, whichever offers on('trigger'). */
function hookTriggerEvents() {
  for (const src of [RULES, G]) {
    if (!src || typeof src.on !== 'function' || hooked.has(src)) continue;
    hooked.add(src);
    // rules.js emits game 'triggerResolved' {card, perm, summary} after each auto-resolved batch; 'trigger' kept for safety
    try { src.on('triggerResolved', onTriggerEvent); src.on('trigger', onTriggerEvent); } catch (_) { /* no such event */ }
  }
}
function onTriggerEvent(ev) {
  if (!RULES || !ev || typeof ev !== 'object' || seenEv.has(ev)) return;
  seenEv.add(ev);
  ui.trigSeen = true;
  if (ev.pending || ev.kind === 'pending' || ev.auto === false) return; // it will show as the panel instead
  const name = ev.card || ev.name || (ev.perm && ev.perm.name) || (ev.source && ev.source.name) || '';
  const text = ev.summary || ev.did || ev.text || ev.label || '';
  const uid = ev.perm && typeof ev.perm === 'object' ? ev.perm.uid : (ev.perm ?? ev.uid ?? null);
  if (name || text) ribbon(name, text, uid);
}
/** Fallback when no 'trigger' event exists: rules runs effects in game.batch(label) -> one log line; show
    new lines that start with the name of a card that has triggers ("Name — did this" / "Name: did this"). */
function scanLog(s) {
  if (!RULES) return;
  const log = s.log || [];
  const last = log.length ? log[log.length - 1] : '';
  if (ui.logTail == null || ui.trigSeen) { ui.logTail = last; return; }
  if (last === ui.logTail) return;
  const at = log.lastIndexOf(ui.logTail);
  ui.logTail = last;
  if (at < 0) return; // undo / reload / new game: nothing new to announce
  for (const line of log.slice(at + 1)) {
    const m = /^T\d+ [^:]*: (?:Trigger(?:ed)?:?\s*|↳\s*)?(.+?)(?: — | – | - |: )(.+)$/.exec(line);
    if (!m) continue;
    const sc = BUNDLE && BUNDLE[m[1]];
    if (sc && ((sc.triggers || []).length || (sc.activated || []).length || (sc.spell || []).length)) ribbon(m[1], m[2], null);
  }
}

/* ---------- trigger ribbon ---------- */
function ribbon(name, text, uid) {
  const box = $('ribbon');
  if (!box) return;
  placePend();
  const f = face({ name });
  const img = imgOf(f, 'small');
  const it = document.createElement('button');
  it.type = 'button';
  it.className = 'rib';
  it.title = 'Card text';
  it.innerHTML = (img ? `<img src="${esc(img)}" alt="">` : '<span class="rib-tok"></span>') +
    `<span class="rib-t"><b>${esc(name || 'Trigger')}</b>${text ? ` — ${esc(text)}` : ''}</span>`;
  it.addEventListener('click', () => { if (name) showOracle({ name }, null); });
  box.prepend(it);
  while (box.children.length > 3) box.lastElementChild.remove();
  fx.slideIn(it);
  if (uid != null) requestAnimationFrame(() => fx.pulse(elOf('bf', uid)));
  const hold = 1600 + 500 * (box.children.length - 1);
  setTimeout(async () => { await fx.fadeOut(it, 450); it.remove(); }, hold);
}

/* ---------- statics: perm.mod (static) + perm.eot (until end of turn) ---------- */
function modOf(p) {
  const m = (p && p.mod) || {}, e = (p && p.eot) || {};
  const kw = [...new Set([...(m.kw || []), ...(e.kw || [])].map(String))];
  return { p: (m.p | 0) + (e.p | 0), t: (m.t | 0) + (e.t | 0), kw };
}
const hasMod = p => { const md = modOf(p); return !!(md.p || md.t || md.kw.length); };
const sgn = v => (v >= 0 ? '+' : '') + v;
function explainText(name) {
  if (!RULES || typeof RULES.explain !== 'function' || !name) return [];
  const r = safe(() => RULES.explain(name), '');
  const arr = Array.isArray(r) ? r : String(r || '').split('\n');
  return arr.map(x => (typeof x === 'string' ? x : (x && (x.text || x.label)) || '')).map(x => x.trim()).filter(Boolean);
}
/** "+1/+1, Trample from Goreclaw" etc. Sources come from mod.src/from/sources when rules provides them,
    else from the battlefield cards whose scripts have statics. */
function modTip(p) {
  if (!RULES || !p || !hasMod(p)) return '';
  const m = p.mod || {}, e = p.eot || {};
  const lines = [];
  let srcs = [].concat(m.src || m.from || m.sources || []).map(x => {
    if (x && typeof x === 'object') return x.name || '';
    const hit = findEntry(x);
    return hit ? hit.entry.name : String(x);
  }).filter(Boolean);
  if (!srcs.length) {
    srcs = ((S().zones || {}).bf || []).filter(q => (BUNDLE?.[q.name]?.statics || []).some(st => st && !st.prompt)).map(q => q.name);
  }
  srcs = [...new Set(srcs)];
  const part = (o, tail) => {
    const bits = [];
    if (o.p || o.t) bits.push(`${sgn(o.p | 0)}/${sgn(o.t | 0)}`);
    if ((o.kw || []).length) bits.push(o.kw.join(', '));
    if ((o.costLess | 0) > 0) bits.push(`costs {${o.costLess}} less`);
    if (bits.length) lines.push(bits.join(', ') + tail);
  };
  part(m, srcs.length ? ` from ${srcs.join(', ')}` : '');
  part(e, ' until end of turn');
  for (const n of srcs.slice(0, 3)) { const ex = explainText(n)[0]; if (ex) lines.push(`${n}: ${ex}`); }
  return lines.join('\n');
}

/* ---------- oracle panel + "What the game does" ---------- */
function showOracle(entry, zone) {
  openOracle(entry, zone);
  if (!RULES) return;
  const box = $('oracle')?.querySelector('.otext');
  if (!box) return;
  const name = entry && entry.name;
  if (!name || (entry.tok && !BUNDLE?.[name])) return;
  const sc = BUNDLE?.[name] || null;
  const ex = explainText(name);
  let h = '<div class="orules"><h4>What the game does</h4>';
  h += ex.length ? ex.map(l => `<p>${esc(l)}</p>`).join('') : '';
  if (!sc) h += '<p class="onote">Not scripted for this deck — the game does nothing for it; handle it by hand.</p>';
  else if (sc.status === 'prompt') h += '<p class="onote">Prompt-only: the game shows this card’s text when it triggers and you resolve it by hand.</p>';
  else if (!ex.length) h += '<p class="onote">Nothing to automate — keywords and mana are handled by the table.</p>';
  const tip = zone === 'bf' ? modTip(entry) : '';
  if (tip) h += `<p class="omod">${esc(tip).replace(/\n/g, '<br>')}</p>`;
  h += '</div>';
  box.insertAdjacentHTML('beforeend', h);
}

/* ---------- pending: the panel and pick mode ---------- */
function pendTop() {
  if (!RULES) return null;
  const s = S();
  let p;
  if (typeof RULES.pendingTop === 'function') p = safe(() => RULES.pendingTop(), undefined);
  if (p === undefined) p = (s && Array.isArray(s.pending) && s.pending[0]) || null;
  return p || null;
}
const PICK_TYPES = ['creature', 'land', 'artifact', 'enchantment', 'planeswalker', 'instant', 'sorcery', 'battle'];
function matchFilter(e, flt, srcUid) {
  if (flt == null || flt === true) return true;
  const f = face(e), tl = String(f.type_line || '');
  const isType = t => (t === 'creature' && e.tok ? permIsCreature(e) : new RegExp('\\b' + t + '\\b', 'i').test(tl));
  if (typeof flt === 'string') { // "creature-you-control", "any-you-control", "land", ...
    const t = flt.split('-')[0].toLowerCase();
    return t === 'any' || t === 'each' || !PICK_TYPES.includes(t) || isType(t);
  }
  if (typeof flt !== 'object') return true;
  if (flt.pick) return matchFilter(e, flt.pick, srcUid);
  for (const [k, v] of Object.entries(flt)) {
    if (v == null) continue;
    switch (k) {
      case 'creature': case 'land': case 'artifact': case 'enchantment': case 'planeswalker': case 'instant': case 'sorcery':
        if (!!v !== isType(k)) return false; break;
      case 'nonland': if (v && isType('land')) return false; break;
      case 'noncreature': if (v && isType('creature')) return false; break;
      case 'token': if (!!v !== !!e.tok) return false; break;
      case 'nontoken': if (v && e.tok) return false; break;
      case 'type': if (![].concat(v).some(t => new RegExp('\\b' + t + '\\b', 'i').test(tl))) return false; break;
      case 'subtype': { const sub = tl.split(/[—-]/)[1] || ''; if (![].concat(v).some(t => new RegExp('\\b' + t + '\\b', 'i').test(sub))) return false; break; }
      case 'controller': if (!['you', 'any', 'self'].includes(String(v))) return false; break; // the dummy has no board
      case 'powerGe': if (pow(e) < v) return false; break;
      case 'powerLe': if (pow(e) > v) return false; break;
      case 'toughnessGe': if (tou(e) < v) return false; break;
      case 'toughnessLe': if (tou(e) > v) return false; break;
      case 'cmcLe': if ((f.cmc ?? 0) > v) return false; break;
      case 'cmcGe': if ((f.cmc ?? 0) < v) return false; break;
      case 'colors': { const cs = f.colors || []; if (![].concat(v).some(c => cs.includes(c))) return false; break; }
      case 'name': if (![].concat(v).includes(e.name)) return false; break;
      case 'other': case 'another': if (v && srcUid != null && String(e.uid) === String(srcUid)) return false; break;
      case 'tapped': if (!!v !== !!e.tapped) return false; break;
      case 'untapped': if (v && e.tapped) return false; break;
      default: break; // unknown keys: the validator's problem, not the picker's
    }
  }
  return true;
}
function eligibleFor(p) {
  if (typeof RULES?.eligible === 'function') {
    const r = safe(() => RULES.eligible(p), null);
    const arr = r instanceof Set ? [...r] : Array.isArray(r) ? r : null;
    if (arr) return new Set(arr.map(x => String(x && typeof x === 'object' ? x.uid : x)));
  }
  if (Array.isArray(p.options) && p.options.length) return new Set(p.options.map(o => String(o.id))); // rules lists the legal picks
  if (Array.isArray(p.uids)) return new Set(p.uids.map(String));
  const zone = p.zone || p.from || 'bf';
  const list = ((S().zones || {})[zone] || []);
  return new Set(list.filter(e => matchFilter(e, p.filter, p.perm)).map(e => String(e.uid)));
}
/** Keep ui.pick in step with the pending queue (and the board: the eligible set is recomputed each render). */
function syncPick(s) {
  const p = pendTop();
  if (!p) { ui.pick = null; return; }
  if (ui.pick && ui.pick.id !== p.id) ui.pick = null;
  if (p.kind === 'target') {
    const zone = p.zone || p.from || 'bf';
    const eligible = eligibleFor(p);
    if (!ui.pick) ui.pick = { id: p.id, mode: 'target', zone, eligible, chosen: new Set(), n: Math.max(1, p.n | 0 || 1), optional: !!p.optional };
    else { ui.pick.eligible = eligible; ui.pick.chosen.forEach(u => { if (!eligible.has(u)) ui.pick.chosen.delete(u); }); }
  } else if (ui.pick && ui.pick.mode === 'p1p1') {
    ui.pick.eligible = new Set(((s.zones || {}).bf || []).filter(permIsCreature).map(q => String(q.uid)));
  }
}
function pickToggle(id, el) {
  const pk = ui.pick;
  if (!pk || ui.busy) return;
  if (!pk.eligible.has(id)) { fx.shake(el); hint(pk.mode === 'p1p1' ? 'Pick a creature' : 'Not a legal choice for this trigger'); return; }
  if (pk.mode === 'p1p1') {
    const name = findEntry(id)?.entry.name || 'creature';
    const r = act(() => G.addCounter(+id, 'p1p1', 1));
    if (r.ok !== false) { ui.quickDone.push(`+1/+1 on ${name}`); fx.pulse(elOf('bf', id)); }
    ui.pick = null; ui.pendMin = false;
    render();
    return;
  }
  if (pk.chosen.has(id)) pk.chosen.delete(id);
  else {
    if (pk.n === 1) pk.chosen.clear();
    else if (pk.chosen.size >= pk.n) { fx.shake(el, 0.5); hint(`Choose up to ${pk.n}`); return; }
    pk.chosen.add(id);
  }
  render();
}
function placePend() {
  const t = $('table'), b = $('board');
  if (!t || !b) return;
  t.style.setProperty('--bx', b.offsetLeft + 'px');
  t.style.setProperty('--by', b.offsetTop + 'px');
  t.style.setProperty('--bw', b.offsetWidth + 'px');
  t.style.setProperty('--bh', b.offsetHeight + 'px');
}
function markOracle(oracle, text) {
  const o = String(oracle || ''), t = String(text || '').trim();
  const lo = o.toLowerCase();
  let i = -1, len = 0;
  for (const cand of [t, t.split(/(?<=[.:])\s/)[0], t.replace(/^[^,]*,\s*/, '')]) {
    if (!cand || cand.length < 8) continue;
    i = lo.indexOf(cand.toLowerCase()); len = cand.length;
    if (i >= 0) break;
  }
  const br = x => esc(x).replace(/\n/g, '<br>');
  return { found: i >= 0, html: i >= 0 ? br(o.slice(0, i)) + '<mark>' + br(o.slice(i, i + len)) + '</mark>' + br(o.slice(i + len)) : br(o) };
}
function pendControls(p, pk) {
  const btn = (act, label, { arg = '', cls = 'btn', dis = false } = {}) =>
    `<button type="button" class="${cls}" data-pend="${act}"${arg !== '' ? ` data-arg="${esc(arg)}"` : ''}${dis ? ' disabled' : ''}>${label}</button>`;
  const opts = Array.isArray(p.options) ? p.options : [];
  if (p.kind === 'choice' || (p.kind === 'trigger' && opts.length)) {
    // the rules layer supplies its own Resolve/Skip options; no generic Skip here (only target + prompt get one)
    return `<div class="pend-opts">${opts.map(o => btn('opt', esc(o.label ?? o.id), { arg: o.id ?? o.label })).join('')}</div>`;
  }
  if (p.kind === 'x') {
    const lo = p.min ?? 0, hi = p.max ?? 99;
    return `<div class="pend-x">${btn('xm', '&minus;', { dis: ui.pendX <= lo })}<b>${esc(ui.pendX)}</b>${btn('xp', '+', { dis: ui.pendX >= hi })}</div>
      <div class="pend-row">${btn('x', `X = ${esc(ui.pendX)}`, { cls: 'btn primary' })}</div>`;
  }
  if (p.kind === 'target' && pk) {
    const need = Math.min(pk.n, pk.eligible.size);
    const k = pk.chosen.size;
    const okNow = pk.optional ? k > 0 : k === need;
    let h = '';
    if (pk.zone !== 'bf') {
      const opts = Array.isArray(p.options) && p.options.length ? p.options
        : ((S().zones || {})[pk.zone] || []).filter(e => pk.eligible.has(String(e.uid))).map(e => ({ id: e.uid, label: e.name }));
      h += `<div class="pend-grid">${opts.map(o => {
        const e = findEntry(o.id)?.entry || { uid: o.id, name: o.label };
        const im = imgOf(face(e), 'small'), id = String(o.id);
        return `<button type="button" class="pend-gc${pk.chosen.has(id) ? ' on' : ''}" data-pend="zpick" data-arg="${esc(id)}" title="${esc(e.name)}">${im ? `<img src="${esc(im)}" alt="${esc(e.name)}">` : `<span>${esc(e.name)}</span>`}</button>`;
      }).join('')}</div>`;
    }
    if (!pk.eligible.size) {
      return h + `<p class="pend-note">Nothing on your side can be chosen.</p><div class="pend-row">${btn('confirm', 'Continue', { cls: 'btn primary' })}</div>`;
    }
    return h + `<div class="pend-row">${btn('confirm', need > 1 || pk.n > 1 ? `Confirm ${k}/${pk.optional ? pk.n : need}` : 'Confirm', { cls: 'btn primary', dis: !okNow })}${pk.optional ? btn('skip', 'Skip') : ''}</div>`;
  }
  if (pk && pk.mode === 'p1p1') {
    return `<div class="pend-row">${btn('cancelpick', 'Cancel')}</div>`;
  }
  // prompt / trigger: do it by hand with quick actions, then Done
  return `<div class="pend-quick">${btn('q-draw', 'Draw a card')}${btn('q-p1p1', '+1/+1 counter on…')}${btn('q-token', 'Create token…')}
      <span class="pend-life">Life ${btn('q-life', '&minus;5', { arg: -5, cls: 'btn wide' })}${btn('q-life', '&minus;', { arg: -1 })}${btn('q-life', '+', { arg: 1 })}${btn('q-life', '+5', { arg: 5, cls: 'btn wide' })}</span>${btn('q-opp', 'Dummy &minus;1')}</div>
    ${ui.quickDone.length ? `<div class="pend-done">${ui.quickDone.map(esc).join(' · ')}</div>` : ''}
    <div class="pend-row">${btn('done', 'Done', { cls: 'btn primary' })}</div>`;
}
const KICKER = { prompt: 'Trigger · do it by hand', trigger: 'Trigger', target: 'Choose a target', choice: 'Choose one', x: 'Choose X' };
function renderPend(s) {
  const wrap = $('pend');
  if (!wrap) return;
  const p = pendTop();
  const board = $('board');
  const pk = ui.pick;
  board?.classList.toggle('pick-mode', !!(pk && pk.zone === 'bf'));
  if (!p) {
    ui.pendId = null; ui.quickDone = [];
    const old = wrap.querySelector('.pend-card');
    if (old && !old._leaving) { old._leaving = true; fx.sink(old).then(() => old.remove()); }
    wrap.classList.remove('docked', 'on');
    return;
  }
  const fresh = ui.pendId !== p.id;
  if (fresh) { ui.pendId = p.id; ui.pendMin = false; ui.quickDone = []; ui.pendX = Math.max(p.min ?? 0, p.default ?? p.x ?? 0); }
  placePend();
  const docked = !!(pk && pk.zone === 'bf') || ui.pendMin;
  wrap.classList.add('on');
  wrap.classList.toggle('docked', docked);
  const f = face({ name: p.card || '' });
  const img = imgOf(f, 'normal');
  const queue = Array.isArray(s.pending) && s.pending.length > 1 ? `1 of ${s.pending.length}` : '';
  const text = p.text || '';
  const say = pk && pk.mode === 'p1p1' ? 'Tap a creature to put a +1/+1 counter on it.'
    : pk && pk.zone === 'bf' && p.kind === 'target' ? (text || 'Tap a permanent to choose it.') : text;
  const mk = markOracle(f.oracle_text, text);
  const body = docked ? '' : `<div class="pend-body">
      ${img ? `<img class="pend-img" src="${esc(img)}" alt="${esc(f.name)}">` : ''}
      <div class="pend-txt">
        ${f.oracle_text && (mk.found || !text) ? `<div class="pend-oracle">${mk.html}</div>` : ''}
        ${text && !mk.found ? `<div class="pend-oracle">${f.oracle_text ? `<span class="dimtxt">${esc(f.oracle_text).replace(/\n/g, '<br>')}</span><br>` : ''}<mark>${esc(text)}</mark></div>` : ''}
      </div>
    </div>`;
  const html = `<div class="pend-head">
      <span class="pend-kicker">${esc(KICKER[p.kind] || 'Trigger')}</span>${queue ? `<span class="pend-q">${queue}</span>` : ''}
      <button type="button" class="pend-tog" data-pend="min" title="${docked ? 'Show the card' : 'Hide — see the board'}">${docked ? '▴' : '▾'}</button>
    </div>
    <h3 class="pend-name" data-pend="text" title="Card text">${esc(p.card || 'Trigger')}</h3>
    ${docked && say ? `<p class="pend-say">${esc(say)}</p>` : ''}
    ${body}
    <div class="pend-ctl">${pendControls(p, pk)}</div>
    <div class="pend-foot"><button type="button" class="linkbtn" data-pend="undo">Undo</button><button type="button" class="linkbtn" data-pend="text">Card text</button></div>`;
  let card = [...wrap.querySelectorAll('.pend-card')].find(c => !c._leaving);
  if (card && fresh) { const old = card; old._leaving = true; fx.sink(old).then(() => old.remove()); card = null; }
  if (!card) {
    card = document.createElement('div');
    card.className = 'pend-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Trigger to resolve');
    wrap.appendChild(card);
    card.innerHTML = html; card._h = html;
    fx.rise(card);
  } else if (card._h !== html) { card.innerHTML = html; card._h = html; }
  card.classList.toggle('docked', docked);
  card.dataset.kind = p.kind || '';
}
/** Resolve the top pending item, then play out what it did (draws fly in, the dummy takes hits). */
async function answer(ans) {
  const p = pendTop();
  if (!p || !RULES || ui.busy) return;
  const s0 = S();
  const before = { hand: new Set(((s0.zones || {}).hand || []).map(c => String(c.uid))), opp: (s0.opp || {}).life };
  const r = call(() => RULES.resolve(p.id, ans));
  if (r && r.ok === false) { hint(reasonText(r)); render(); return; }
  ui.pick = null; ui.pendMin = false;
  const s = S(), opp = (s.opp || {}).life;
  if (before.opp != null && opp < before.opp) {
    fx.shake($('opp'), 0.7); fx.damage($('oppAvatar'), before.opp - opp);
    fx.countTo($('oppLifeNum'), before.opp, opp, 500);
  }
  if (((s.zones || {}).hand || []).some(c => !before.hand.has(String(c.uid)))) await animateDraws(before.hand);
  else render();
  if (!pendTop()) await resumeFlow();
}
/** The queue is empty: carry on with whatever the trigger interrupted (combat damage, the rest of the turn). */
async function resumeFlow() {
  const how = ui.resume;
  ui.resume = null;
  const s = S();
  if (!s || s.won || ui.busy) return;
  if (s.phase === 'combat-damage') { await dealDamage(); return; }
  if (s.phase === 'untap' || s.phase === 'upkeep' || s.phase === 'draw') { await continueToMain(); return; }
  if (how === 'turn' && (s.phase === 'end' || s.phase === 'cleanup')) await endTurn();
}
async function continueToMain() {
  if (ui.busy) return;
  const turn = S().turn;
  const prevHand = new Set(((S().zones || {}).hand || []).map(c => String(c.uid)));
  for (let i = 0; i < 6 && S().phase !== 'main1' && S().turn === turn; i++) {
    const r = call(() => G.nextPhase());
    if (r.ok === false) { if (r.reason === 'pending') ui.resume = 'turn'; else hint(reasonText(r)); break; }
  }
  await animateDraws(prevHand);
  if (S().phase === 'main1') fx.banner(`Turn ${S().turn}`, { sub: 'Main phase', hold: 700 });
}
async function pendAction(a, arg) {
  const p = pendTop();
  if (!p || ui.busy) return;
  switch (a) {
    case 'min': ui.pendMin = !ui.pendMin; if (!ui.pendMin && ui.pick && ui.pick.mode === 'p1p1') ui.pick = null; render(); return;
    case 'text': if (p.card) showOracle(findEntry(p.perm)?.entry || { name: p.card }, findEntry(p.perm)?.zone || null); return;
    case 'undo': undo(); return;
    case 'done': await answer({ done: true }); return;
    case 'opt': {
      const o = (p.options || []).find(x => String(x.id ?? x.label) === String(arg));
      await answer({ option: o ? (o.id ?? o.label) : arg });
      return;
    }
    case 'skip': await answer(p.kind === 'target' ? { uids: [] } : { skip: true, option: null }); return;
    case 'xm': ui.pendX = Math.max(p.min ?? 0, ui.pendX - 1); render(); return;
    case 'xp': ui.pendX = Math.min(p.max ?? 99, ui.pendX + 1); render(); return;
    case 'x': await answer({ x: ui.pendX }); return;
    case 'zpick': pickToggle(String(arg), null); return;
    case 'confirm': {
      const pk = ui.pick;
      const uids = pk ? [...pk.chosen].map(u => (/^\d+$/.test(u) ? +u : u)) : [];
      await answer({ uids });
      return;
    }
    case 'cancelpick': ui.pick = null; ui.pendMin = false; render(); return;
    case 'q-draw': {
      const n = ((S().zones || {}).hand || []).length;
      await drawCards(1);
      if (((S().zones || {}).hand || []).length > n) ui.quickDone.push('Drew a card');
      render();
      return;
    }
    case 'q-p1p1': {
      const eligible = new Set(((S().zones || {}).bf || []).filter(permIsCreature).map(q => String(q.uid)));
      if (!eligible.size) { hint('No creature to put a counter on'); return; }
      ui.pick = { id: p.id, mode: 'p1p1', zone: 'bf', eligible, chosen: new Set(), n: 1, optional: true };
      render();
      return;
    }
    case 'q-token': openTokenMaker(); return;
    case 'q-life': { const d = +arg || 0; const r = act(() => G.life(d)); if (r.ok !== false) { ui.quickDone.push(`Life ${sgn(d)}`); render(); } return; }
    case 'q-opp': {
      const r = act(() => G.oppLife(-1));
      if (r.ok !== false) { fx.damage($('oppAvatar'), 1); fx.shake($('opp'), 0.5); ui.quickDone.push('Dummy −1'); render(); }
      return;
    }
    default: return;
  }
}
function wireRules() {
  const wrap = $('pend');
  if (wrap) {
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-pend]');
      if (!b || b.disabled) return;
      e.preventDefault();
      pendAction(b.dataset.pend, b.dataset.arg);
      if (b.tagName === 'BUTTON') b.blur();
    });
  }
  let rz = 0;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (pendTop()) placePend(); }, 120); });
}

/* ================= input ================= */
async function runPrimary() {
  if (ui.inter) { skipInterstitial(); return; }
  if (ui.busy) return;
  const st = primaryState(S());
  if (st.disabled) { fx.shake($('primary'), 0.6); if (st.why) hint(st.why); return; }
  if (st.fn) await st.fn();
}
const ACTS = {
  primary: runPrimary,
  more: () => toggleMore(),
  undo, attackAll, selectAll,
  draw: () => drawCards(1),
  tokens: () => openTokenMaker(),
  lib: () => openLibrary(),
  libpile: openLibMenu,
  gy: () => browseZone('gy'),
  ex: () => browseZone('ex'),
  shuffle: () => act(() => G.shuffle(), { ok: 'Library shuffled' }),
  mull: () => act(() => G.mulligan(), { ok: r => (r.owed ? `Mulligan — put ${r.owed} on the bottom` : 'Mulligan (free)') }),
  pool: openPoolSheet,
  log: () => toggleLog(),
  keys: () => toggleKeys(),
  back: () => { location.href = '../app.html#/deck/' + encodeURIComponent(DECK.slug || ''); },
  classic: () => { location.href = 'index.html?deck=' + encodeURIComponent(DECK.slug || ''); },
  newgame: () => newGame(true),
  again: () => newGame(false),
  keep: () => { closeWin(); render(); },
  life: a => act(() => G.life(+a)),
  opplife: openOppSheet,
  menu: a => openCardMenu(a),
  playtop: a => playCard(+a),
  emblem: a => { const e = (S().emblems || [])[+a]; if (e) openSheet({ title: esc(e.name || 'Emblem'), body: `<p class="sheet-text">${esc(emblemText(e))}</p>`, buttons: [{ label: 'Close' }] }); },
};
function hand2play(uid) {
  if (ui.busy) return;
  const f = findEntry(uid);
  if (!f || f.zone !== 'hand') return;
  const s = S();
  if (s.owed > 0) { bottomCard(f.entry); return; }
  if (s.phase === 'cleanup' && s.zones.hand.length > 7) { discardCard(f.entry); return; }
  playCard(f.entry.uid);
}
function closeTopLayer() {
  if ($('moreMenu')?.classList.contains('open')) toggleMore(false);
  else if (radialIsOpen()) closeRadial();
  else if (sheetIsOpen()) closeSheet();
  else if (oracleIsOpen()) closeOracle();
  else if (keysIsOpen()) toggleKeys(false);
  else if (libIsOpen()) closeLibrary();
  else if (logIsOpen()) toggleLog(false);
  else if (ui.winOpen) { closeWin(); render(); }
  else if (ui.pick && ui.pick.mode === 'p1p1') { ui.pick = null; render(); }
  else return false;
  return true;
}
function openMenuFor(el) {
  if (!el) return;
  handPeek?.clear?.();
  if (el.dataset.uid) openCardMenu(el.dataset.uid);
}

/* ---------- hand: tap, long-press, drag to the board ---------- */
function wireHand() {
  const wrap = $('hand');
  if (!wrap) return;
  let g = null; // gesture
  const overEl = (el, x, y) => { if (!el) return false; const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || ui.busy) return;
    const card = e.target.closest('.card[data-uid]');
    if (!card) return;
    g = { uid: card.dataset.uid, el: card, x: e.clientX, y: e.clientY, moved: 0, drag: false, ghost: null, ox: 0, oy: 0, lp: 0, fired: false, type: e.pointerType };
    if (e.pointerType !== 'mouse') {
      g.lp = setTimeout(() => { if (g && !g.drag && g.moved < 10) { g.fired = true; openMenuFor(card); } }, 520);
    }
  });
  document.addEventListener('pointermove', e => {
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    g.moved = Math.max(g.moved, Math.hypot(dx, dy));
    if (!g.drag) {
      if (g.moved > 10) clearTimeout(g.lp);
      if (!g.fired && dy < -18 && Math.abs(dy) > Math.abs(dx) * 0.8) startDrag(e);
      return;
    }
    moveGhost(e.clientX, e.clientY);
  });
  function startDrag(e) {
    g.drag = true;
    clearTimeout(g.lp);
    handPeek?.clear?.();
    const img = g.el.querySelector('img, .tokface') || g.el;
    const r = img.getBoundingClientRect();
    const w = g.el.offsetWidth || r.width, h = g.el.offsetHeight || r.height;
    const ghost = makeProxy(g.el);
    if (!ghost) { g.drag = false; return; }
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { width: w + 'px', height: h + 'px' });
    g.ghost = ghost; g.ox = w / 2; g.oy = h * 0.35;
    g.el.classList.add('drag-src');
    document.body.classList.add('dragging');
    moveGhost(e.clientX, e.clientY);
  }
  function moveGhost(x, y) {
    if (!g || !g.ghost) return;
    g.ghost.style.left = (x - g.ox) + 'px';
    g.ghost.style.top = (y - g.oy) + 'px';
    $('board')?.classList.toggle('drop-hot', overEl($('board'), x, y));
    $('pileGy')?.classList.toggle('drop-hot', overEl($('pileGy'), x, y));
  }
  async function end(e) {
    if (!g) return;
    const gg = g; g = null;
    clearTimeout(gg.lp);
    if (!gg.drag) {
      if (e.type === 'pointerup' && !gg.fired && gg.moved < 10 && Date.now() >= ui.suppressUntil) hand2play(gg.uid);
      if (gg.fired) ui.suppressUntil = Date.now() + 500;
      return;
    }
    ui.suppressUntil = Date.now() + 400;
    document.body.classList.remove('dragging');
    $('board')?.classList.remove('drop-hot');
    $('pileGy')?.classList.remove('drop-hot');
    const x = e.clientX, y = e.clientY;
    let used = false;
    const f = findEntry(gg.uid);
    if (e.type === 'pointerup' && f && f.zone === 'hand') {
      const s = S();
      if (overEl($('pileGy'), x, y)) { await discardCard(f.entry, gg.ghost); used = true; }
      else if (overEl($('board'), x, y)) {
        if (s.owed > 0 || (s.phase === 'cleanup' && s.zones.hand.length > 7)) hint(s.owed > 0 ? 'Put cards on the bottom first' : 'Discard down to 7 first');
        else used = await playCard(f.entry.uid, { src: gg.ghost });
      }
    }
    if (!used) {
      const back = elOf('hand', gg.uid);
      if (back && gg.ghost) { await fx.fly(gg.ghost, back, { clone: false, duration: 220 }); }
      gg.ghost?.remove();
      back?.classList.remove('drag-src');
    }
    gg.el.classList.remove('drag-src');
  }
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

function wire() {
  document.addEventListener('click', e => {
    if (!e.target.closest('#moreMenu, #moreBtn')) toggleMore(false);
    if (ui.inter) { skipInterstitial(); return; }
    const a = e.target.closest('[data-act]');
    if (a) {
      if (!ACTS[a.dataset.act]) return;
      e.preventDefault();
      if (a.closest('#moreMenu')) toggleMore(false);
      ACTS[a.dataset.act](a.dataset.arg);
      if (a.tagName === 'BUTTON') a.blur(); // so Space doesn't re-press it
      return;
    }
    if (Date.now() < ui.suppressUntil || ui.busy) return;
    const c = e.target.closest('.card[data-uid][data-z]');
    if (!c || !$('app')?.contains(c)) return;
    const f = findEntry(c.dataset.uid);
    if (!f || f.zone !== c.dataset.z) return;
    if (f.zone === 'bf') bfClick(f.entry);
    else if (f.zone === 'cz') playCard(f.entry.uid);
    // hand taps are handled by the pointer gesture in wireHand()
  });
  // the interstitial skips on any tap (pointerdown so it feels immediate)
  document.addEventListener('pointerdown', e => { if (ui.inter && !e.target.closest('#moreMenu')) skipInterstitial(); }, true);

  // card menu: right-click, or long-press on touch (hand long-press lives in wireHand)
  document.addEventListener('contextmenu', e => {
    const c = e.target.closest('.card[data-uid]');
    if (!c || c.closest('#radial') || ui.busy) return;
    e.preventDefault();
    openMenuFor(c);
  });
  let lp = null;
  const lpCancel = () => { if (lp) { clearTimeout(lp.t); lp = null; } };
  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || ui.busy) return;
    const c = e.target.closest('.card[data-uid]');
    if (!c || c.closest('#hand') || c.closest('#radial')) return;
    lpCancel();
    lp = { x: e.clientX, y: e.clientY, t: setTimeout(() => { lp = null; ui.suppressUntil = Date.now() + 700; openMenuFor(c); }, 500) };
  });
  document.addEventListener('pointermove', e => { if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) lpCancel(); });
  ['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, lpCancel));
  wireHand();

  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      if (e.key === 'Escape') { t.blur(); closeTopLayer(); }
      return;
    }
    if (e.key === 'Escape') { closeTopLayer(); return; }
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      return;
    }
    if (e.altKey) return;
    if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); toggleKeys(); return; }
    if (e.key === ' ' || e.key === 'Enter') {
      if (t && t.tagName === 'BUTTON' && t.id !== 'primary' && e.key === 'Enter') return; // Enter on a focused control activates it
      e.preventDefault();
      if (radialIsOpen() || sheetIsOpen() || libIsOpen() || oracleIsOpen() || keysIsOpen()) return;
      if (ui.winOpen) return;
      runPrimary();
      return;
    }
    if (radialIsOpen() || sheetIsOpen() || libIsOpen() || oracleIsOpen() || ui.winOpen) return;
    const k = e.key.toLowerCase();
    const fn = { a: attackAll, u: undo, k: ACTS.tokens, v: ACTS.lib, l: ACTS.log }[k];
    if (fn) { e.preventDefault(); fn(); }
  });

  // the fan measures card widths: re-lay it once webfonts and the first card image have settled
  const relayout = () => requestAnimationFrame(() => layoutFan($('hand')));
  try { document.fonts?.ready?.then(relayout); } catch (_) { /* no font loading API */ }
  const firstImg = $('hand')?.querySelector('.card img');
  if (firstImg && !firstImg.complete) firstImg.addEventListener('load', relayout, { once: true });
  else if (!firstImg) {
    $('hand')?.addEventListener('load', e => { if (e.target.tagName === 'IMG') relayout(); }, { capture: true, once: true });
  } else relayout();
  let rz = 0;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(relayout, 120); });
}
