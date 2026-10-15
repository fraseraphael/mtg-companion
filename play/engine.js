// Goldfish table engine — pure game logic, no DOM, zero dependencies.
// Contract: prototype/goldfish/SPEC.md ("Engine API"). Every mutating method snapshots the state
// for undo first, appends a log line, and returns { ok: true, ... } or { ok: false, reason, ... }.
// `game.state` is plain JSON; `game.deck` is the deck JSON it was built from.

export const PHASES = ['untap', 'upkeep', 'draw', 'main1', 'combat', 'combat-damage', 'main2', 'end', 'cleanup'];
export const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];
const ZONES = ['lib', 'hand', 'bf', 'gy', 'ex', 'cz'];
const UNDO_MAX = 60;
const LOG_MAX = 500; // keeps localStorage saves small; the UI shows the last 50

/* ---------------- PRNG ---------------- */
// mulberry32, with its 32-bit state kept in game.state.rng so save/load/undo stay deterministic.
function mulberry32Step(s) {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/* ---------------- card helpers (pure) ---------------- */

// "{10}{G}{G}" -> { generic: 10, pips: ['G','G'], x: 0 }
// Hybrid "{G/U}" -> pips [['G','U']]; "{2/W}" -> pips [['2','W']] (pay W, or 2 generic).
// Phyrexian "{G/P}" -> 'G' (paid with the colour; life payment is the judge's call).
// "{C}" -> pip 'C' (must be colourless mana). "{S}" (snow) -> 1 generic: the engine doesn't track snow.
// Split / MDFC costs "A // B": the front face only.
export function parseCost(manaCost) {
  const out = { generic: 0, pips: [], x: 0 };
  if (!manaCost) return out;
  const front = String(manaCost).split('//')[0];
  for (const m of front.matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1].toUpperCase();
    if (/^\d+$/.test(sym)) out.generic += +sym;
    else if (sym === 'X' || sym === 'Y' || sym === 'Z') out.x += 1;
    else if (sym === 'S') out.generic += 1;
    else if (sym.includes('/')) {
      const parts = sym.split('/');
      if (parts.includes('P')) {
        const col = parts.find(p => p !== 'P');
        out.pips.push(col);
      } else out.pips.push(parts);
    } else if (COLORS.includes(sym)) out.pips.push(sym);
    // anything else (e.g. {H}, {Q}) is ignored
  }
  return out;
}

const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Kindred', 'Tribal'];
function tokenCard(perm) {
  const hasPT = perm.tokPower != null || perm.tokToughness != null;
  const prod = /^treasure$/i.test(perm.name) ? ['W', 'U', 'B', 'R', 'G'] : [];
  // tokTypes (from a rules `token` effect) e.g. ['Creature','Elf','Warrior'] -> "Token Creature — Elf Warrior"
  const types = (perm.tokTypes || []).filter(t => CARD_TYPES.includes(t));
  const subs = (perm.tokTypes || []).filter(t => !CARD_TYPES.includes(t));
  if (hasPT && !types.includes('Creature')) types.push('Creature');
  const tl = ['Token', ...types].join(' ') + (subs.length ? ' — ' + subs.join(' ') : '');
  return {
    name: perm.name, mana_cost: '', cmc: 0,
    type_line: tl, oracle_text: '', keywords: [...(perm.tokKw || []), ...extraKw(perm)], produced_mana: prod,
    colors: (perm.tokColors || []).slice(),
    power: hasPT ? String(perm.tokPower ?? 0) : undefined,
    toughness: hasPT ? String(perm.tokToughness ?? 0) : undefined,
    token: true,
  };
}

function findAnywhere(state, uid) {
  for (const z of ZONES) {
    const i = state.zones[z].findIndex(c => c.uid === uid);
    if (i >= 0) return { zone: z, index: i, entry: state.zones[z][i] };
  }
  return null;
}

// Keywords granted to a permanent by statics (perm.mod) and until-end-of-turn effects (perm.eot).
function extraKw(perm) {
  if (!perm) return [];
  const a = (perm.mod && perm.mod.kw) || [], b = (perm.eot && perm.eot.kw) || [];
  return a.length || b.length ? [...a, ...b] : [];
}

// Card data for a uid (any zone) or a card name. A transformed permanent returns its back face's
// characteristics layered over the front. Tokens get a synthesised card. Unknown names get a stub.
export function cardOf(game, uidOrName) {
  const cards = (game.deck && game.deck.cards) || {};
  if (typeof uidOrName === 'object' && uidOrName) uidOrName = uidOrName.uid ?? uidOrName.name;
  if (typeof uidOrName === 'number') {
    const f = findAnywhere(game.state, uidOrName);
    if (!f) return null;
    const e = f.entry;
    if (f.zone === 'bf') return permCard(game, e);
    if (e.tok && !e.copy) return tokenCard(e);
    let base = cards[e.name] || { name: e.name, type_line: '', keywords: [], produced_mana: [] };
    if (e.flip && base.back) base = { ...base, ...base.back, keywords: base.keywords || [], produced_mana: base.produced_mana || [], front: base.name };
    return base;
  }
  return cards[uidOrName] || { name: String(uidOrName), type_line: '', keywords: [], produced_mana: [] };
}

// perm.animated = { p, t, kw } (earthbend): the permanent is also a P/T creature with those keywords.
function animate(base, perm) {
  const a = perm && ((perm.eot && perm.eot.animated) || perm.animated || (perm.mod && perm.mod.animated));
  if (!a) return base;
  let [main, sub] = String(base.type_line || '').split('//')[0].split(/\s+—\s+/);
  for (const t of a.types && a.types.length ? a.types : ['Creature']) if (!new RegExp(`\\b${t}\\b`).test(main)) main = `${main} ${t}`.trim();
  if (a.subtypes && a.subtypes.length) sub = [sub, ...a.subtypes].filter(Boolean).join(' ');
  return { ...base, type_line: main + (sub ? ` — ${sub}` : ''), power: String(a.p | 0), toughness: String(a.t | 0), keywords: [...(base.keywords || []), ...(a.kw || [])] };
}

// Card data for a Perm object (works for a permanent that has already left the battlefield, e.g. in a
// `leaves` payload): tokens get their synthesised card, granted keywords are merged in.
export function permCard(game, perm) {
  if (!perm) return null;
  const cards = (game.deck && game.deck.cards) || {};
  const copyOf = (perm.eot && perm.eot.copyOf) || perm.copyOf;
  let base;
  if (copyOf) base = { ...(cards[copyOf] || { name: copyOf, type_line: '', keywords: [], produced_mana: [] }) };
  else if (perm.tok && !perm.copy) base = tokenCard(perm);
  else {
    base = cards[perm.name] || { name: perm.name, type_line: '', keywords: [], produced_mana: [] };
    if (perm.flip && base.back) base = { ...base, ...base.back, keywords: base.keywords || [], produced_mana: base.produced_mana || [], front: base.name };
  }
  if (perm.stripped || (perm.eot && perm.eot.stripped)) base = { ...base, keywords: [], oracle_text: '' };
  if (perm.addTypes && perm.addTypes.length) {
    let [main, sub] = String(base.type_line || '').split('//')[0].split(/\s+—\s+/);
    const add = perm.addTypes.filter(t => !new RegExp(`\\b${t}\\b`).test(sub || ''));
    if (add.length) base = { ...base, type_line: main + ' — ' + [sub, ...add].filter(Boolean).join(' ') };
  }
  base = animate(base, perm);
  const kw = extraKw(perm);
  return kw.length ? { ...base, keywords: [...(base.keywords || []), ...kw] } : base;
}

const typeOf = card => (card && card.type_line ? String(card.type_line).split('//')[0] : '');
export function isCreature(card) {
  if (!card) return false;
  if (card.tok && !card.copy) return card.tokPower != null || card.tokToughness != null; // a token Perm
  return /\bCreature\b/.test(typeOf(card));
}
export function isLand(card) { return !!card && /\bLand\b/.test(typeOf(card)); }
export function isInstantOrSorcery(card) { return !!card && /\b(Instant|Sorcery)\b/.test(typeOf(card)); }
// The `kind` of a cast payload: creature / instant / sorcery / artifact / enchantment / planeswalker / battle / land.
function spellKind(card) {
  const t = typeOf(card);
  for (const k of ['Creature', 'Instant', 'Sorcery', 'Planeswalker', 'Battle', 'Artifact', 'Enchantment', 'Land']) if (new RegExp(`\\b${k}\\b`).test(t)) return k.toLowerCase();
  return 'other';
}
function isPlaneswalker(card) { return !!card && /\bPlaneswalker\b/.test(typeOf(card)); }

function commanderNames(game) {
  const list = (game.deck && game.deck.list) || [];
  const names = list.filter(l => /^Commander/i.test(l.section)).map(l => l.name);
  if (!names.length && game.deck && game.deck.commander) names.push(game.deck.commander);
  return names;
}
export function isCommander(game, name) { return commanderNames(game).includes(name); }

// `card` may also be a battlefield Perm: its granted keywords (mod / eot) count.
export function hasKeyword(card, kw) {
  if (!card) return false;
  const k = String(kw).toLowerCase();
  if ((card.keywords || []).some(x => String(x).toLowerCase() === k)) return true;
  if (extraKw(card).some(x => String(x).toLowerCase() === k)) return true;
  // fall back to a keyword line in the oracle text ("Flying", "Vigilance, trample")
  const text = String(card.oracle_text || '');
  return text.split('\n').some(line => !/[:"]/.test(line) && line.toLowerCase().split(/[,(]/).map(s => s.trim()).includes(k));
}

const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }; // '*' -> 0

function permOf(game, perm) {
  if (typeof perm === 'number') return game.state.zones.bf.find(p => p.uid === perm) || null;
  return perm;
}
export function power(game, perm) {
  perm = permOf(game, perm);
  if (!perm) return 0;
  const ov = (perm.eot && perm.eot.base) || perm.base;
  const base = ov ? ov.p : perm.tok && !perm.copy && !perm.copyOf ? (perm.tokPower ?? 0) : num(cardOf(game, perm.uid ?? perm.name)?.power);
  return base + ((perm.counters && perm.counters.p1p1) || 0) + ((perm.mod && perm.mod.p) || 0) + ((perm.eot && perm.eot.p) || 0);
}
export function toughness(game, perm) {
  perm = permOf(game, perm);
  if (!perm) return 0;
  const ov = (perm.eot && perm.eot.base) || perm.base;
  const base = ov ? ov.t : perm.tok && !perm.copy && !perm.copyOf ? (perm.tokToughness ?? 0) : num(cardOf(game, perm.uid ?? perm.name)?.toughness);
  return base + ((perm.counters && perm.counters.p1p1) || 0) + ((perm.mod && perm.mod.t) || 0) + ((perm.eot && perm.eot.t) || 0);
}

// a copy is a token (tok:true) that keeps the copied card's characteristics (copy:true)
function permIsCreature(game, p) { return p.tok && !p.copy ? isCreature(p) : isCreature(cardOf(game, p.uid)); }

// Sum of power of creatures on the battlefield (a token stack counts n times; negatives count as 0).
export function totalPower(game) {
  return game.state.zones.bf.reduce((s, p) => s + (permIsCreature(game, p) ? Math.max(0, power(game, p)) * (p.n || 1) : 0), 0);
}

// Rule 601.2f: cost increases (commander tax) are applied before reductions (Ghalta), and a
// reduction only ever reduces the generic part.
export function castCost(game, cardName) {
  const card = cardOf(game, cardName);
  const cost = parseCost(card.mana_cost);
  if (isCommander(game, cardName)) cost.generic += 2 * ((game.state.cmdTax || {})[cardName] || 0);
  if (/costs \{X\} less to cast, where X is the total power of creatures you control/i.test(card.oracle_text || '')) {
    cost.generic = Math.max(0, cost.generic - totalPower(game));
  }
  // Cost reducers computed by rules.js from statics (state.costLess = { [cardName]: n }).
  const less = (game.state.costLess || {})[card.name ?? cardName] || 0;
  if (less > 0) cost.generic = Math.max(0, cost.generic - less);
  return cost;
}

/* ---------------- mana sources ---------------- */
// A permanent is a tap-for-mana source if it has produced_mana AND is a land or has a
// "{T}: Add ..." ability on its own line (excludes Hulking Raptor's trigger and Rishkar's granted ability).
// fx = state.manaFx written by rules.js statics: { any: bool (Chromatic Lantern), extra: ['B'] (Urborg) }
function manaInfo(card, fx) {
  let produced = (card && card.produced_mana) || [];
  if (fx && isLand(card)) {
    if (fx.any) produced = ['W', 'U', 'B', 'R', 'G'];
    else if (fx.extra && fx.extra.length) produced = [...new Set([...produced, ...fx.extra])];
  }
  if (!produced.length) return null;
  const text = String(card.oracle_text || '');
  const line = text.match(/^\(?\{T\}(?:, [^:\n]*)?: Add ([^\n]*)/m);
  if (!isLand(card) && !line && !card.token) return null;
  let amount = 1;
  const syms = line && line[1].match(/^((?:\{[WUBRGC]\})+)/);
  if (syms) {
    const s = syms[1].match(/\{[WUBRGC]\}/g);
    if (s.every(x => x === s[0])) amount = s.length; // Sol Ring {C}{C} -> 2, Llanowar Tribe -> 3
  }
  return { produced, amount };
}

function canTapForMana(game, p) {
  if (p.tapped) return false;
  const card = cardOf(game, p.uid);
  if (!manaInfo(card, game.state.manaFx)) return false;
  if (permIsCreature(game, p) && game._sickNow(p) && !hasKeyword(card, 'Haste')) return false;
  return true;
}

function defaultColor(game, produced) {
  // Default: the first produced colour that is in the deck's colour identity (so a mono-green deck's
  // Birds / Commander's Sphere default to G), else the first produced colour.
  const ids = (game.deck && game.deck.pips) || [];
  return produced.find(c => ids.includes(c)) || produced[0];
}

/* ---------------- payment ---------------- */
function normCost(cost) {
  if (typeof cost === 'string') return parseCost(cost);
  return { generic: cost.generic || 0, pips: (cost.pips || []).slice(), x: cost.x || 0 };
}

// Take `n` generic out of a pool: colourless first, then the most plentiful colour.
function takeGeneric(pool, n, used) {
  while (n > 0) {
    let c = pool.C > 0 ? 'C' : null;
    if (!c) for (const k of COLORS) if (pool[k] > 0 && (!c || pool[k] > pool[c])) c = k;
    if (!c) break;
    pool[c]--; n--; if (used) used[c] = (used[c] || 0) + 1;
  }
  return n;
}

// Pays `cost` from `pool` in place; returns the shortfall.
function payFrom(pool, cost) {
  let short = 0, generic = cost.generic;
  const pips = cost.pips.slice().sort((a, b) => (Array.isArray(a) ? 1 : 0) - (Array.isArray(b) ? 1 : 0));
  for (const pip of pips) {
    if (!Array.isArray(pip)) { if (pool[pip] > 0) pool[pip]--; else short++; continue; }
    const col = pip.find(c => c !== '2' && pool[c] > 0);
    if (col) pool[col]--;
    else if (pip.includes('2')) generic += 2;
    else short++;
  }
  return short + takeGeneric(pool, generic);
}

// "Drew 1 card." -> "drew 1 card." inside a batch line ("Garruk's Uprising: drew 1 card.")
const LC_VERBS = /^(Drew|Created|Moved|Tapped|Untapped|Scried|Surveilled|Milled|Sacrificed|Searched|Put|Added|Removed|Exiled|Returned|Shuffled|Discarded|Gained|Lost|Paid|Your|Dummy)\b/;
const lcVerb = m => (LC_VERBS.test(m) ? m[0].toLowerCase() + m.slice(1) : m);

/* ---------------- the game ---------------- */
const blankPool = () => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
const blankTurnStats = () => ({ lifeGained: 0, lifeLost: 0, tokensCreated: 0, entered: [], died: [], spellsCast: [], damageToOpp: 0, manaSpent: 0, treasureManaSpent: 0, sacrificed: [] });

export function createGame(deck, opts = {}) {
  const game = new Game(deck);
  game._init(opts, true);
  return game;
}

class Game {
  constructor(deck) {
    this.deck = deck;
    this.state = null;
    this.undoStack = [];
    this._mathRandom = Math.random;
    this._listeners = {};   // event bus (not part of state)
    this.hooks = {};        // rules.js: replace(kind, info), canPlayFromTop(entry), canCastFromGy(entry), hasFlash(entry), noMaxHand()
    this._batchDepth = 0;
    this._batchLog = null;
    this.lastBatch = null;  // { label, lines } of the last finished outermost batch
  }

  /* ---- event bus (RULES.md §1) ---- */
  // on(event, fn): fn(payload). on('*', fn): fn(event, payload) for every event. Listeners run
  // synchronously after the state change; a throwing listener is caught and never breaks the engine.
  on(ev, fn) { (this._listeners[ev] ||= []).push(fn); return () => this.off(ev, fn); }
  off(ev, fn) {
    const l = this._listeners[ev];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  _emit(ev, payload = {}) {
    this._track(ev, payload);
    for (const fn of (this._listeners[ev] || []).slice()) {
      try { fn(payload); } catch (e) { if (typeof console !== 'undefined') console.error(`[engine] ${ev} listener:`, e); }
    }
    for (const fn of (this._listeners['*'] || []).slice()) {
      try { fn(ev, payload); } catch (e) { if (typeof console !== 'undefined') console.error(`[engine] * listener (${ev}):`, e); }
    }
    if (ev === 'enters' && payload.perm && (!payload.perm.tok || payload.perm.copy)) this._lore(payload.perm);
  }

  // "This turn" facts (state.turnStats, reset at untap) and Saga lore, kept in one place.
  _track(ev, payload) {
    const s = this.state;
    if (!s) return;
    const ts = s.turnStats || (s.turnStats = blankTurnStats());
    const snap = p => {
      const o = { uid: p.uid, name: p.name, tok: !!p.tok, n: p.tok ? p.n || 1 : 1, counters: { ...(p.counters || {}) } };
      for (const k of ['tokPower', 'tokToughness', 'tokTypes', 'tokColors']) if (p[k] != null) o[k] = p[k];
      return o;
    };
    if (ev === 'life') {
      if (payload.who === 'you') { if (payload.delta > 0) ts.lifeGained += payload.delta; else ts.lifeLost -= payload.delta; }
      else if (payload.delta < 0) ts.damageToOpp -= payload.delta;
    } else if (ev === 'tokenCreated') ts.tokensCreated += payload.n || 1;
    else if (ev === 'enters' && payload.perm) { ts.entered.push({ ...snap(payload.perm), n: payload.n || 1 }); if (ts.entered.length > 200) ts.entered.shift(); }
    else if (ev === 'dies' && payload.perm) { ts.died.push(snap(payload.perm)); if (ts.died.length > 200) ts.died.shift(); }
    else if (ev === 'sacrificed' && payload.perm) { (ts.sacrificed || (ts.sacrificed = [])).push(snap(payload.perm)); if (ts.sacrificed.length > 200) ts.sacrificed.shift(); }
    else if (ev === 'cast' && payload.card) ts.spellsCast.push({ uid: payload.card.uid, name: payload.card.name });
  }
  // Sagas: a lore counter as one enters and at your precombat main phase; each one fires `chapter`.
  _lore(p) {
    if (!p || !this._perm(p.uid) || !/\bSaga\b/.test(typeOf(cardOf(this, p.uid)))) return;
    p.counters.lore = (p.counters.lore || 0) + 1;
    this._log(`${p.name}: lore counter ${p.counters.lore}.`);
    this._emit('counters', { perm: p, kind: 'lore', delta: 1 });
    this._emit('chapter', { perm: p, n: p.counters.lore });
  }

  // Run fn() as ONE undo step with ONE log line ("label: inner line inner line"). Inner snapshots are
  // suppressed and inner log lines are collected; nested batches collapse into the outermost one.
  batch(label, fn) {
    if (this._batchDepth > 0) return fn();
    this._snap();
    this._batchDepth = 1;
    this._batchLog = [];
    let out;
    try { out = fn(); this._sba(); }
    finally {
      const lines = this._batchLog;
      this._batchDepth = 0;
      this._batchLog = null;
      this.lastBatch = { label, lines };
      if (lines.length) this._log(label ? `${label}: ${[lcVerb(lines[0]), ...lines.slice(1)].join(' ')}` : lines.join(' '));
    }
    return out;
  }
  // A log line with no snapshot (rules.js narrates through this; inside a batch it joins the batch line).
  note(msg) { this._log(String(msg)); return { ok: true }; }

  /* ---- internals ---- */
  _rand() {
    if (this.state.rng == null) return this._mathRandom();
    const [r, s] = mulberry32Step(this.state.rng);
    this.state.rng = s;
    return r;
  }
  _shuffleArr(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this._rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  _uid() { return this.state.uid++; }
  _snap() {
    if (this._batchDepth > 0) return;
    this.undoStack.push(JSON.stringify(this.state));
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
  }
  _log(msg) {
    if (this._batchLog) { this._batchLog.push(msg); return; }
    const s = this.state;
    s.log.push(`T${s.turn} ${s.phase}: ${msg}`);
    if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  }
  _find(uid, zone) {
    const f = findAnywhere(this.state, uid);
    if (!f || (zone && f.zone !== zone)) return null;
    return f;
  }
  _perm(uid) { return this.state.zones.bf.find(p => p.uid === uid) || null; }
  // Summoning sick: the flag, or a non-creature that entered this turn and is a creature now (animated land).
  _sickNow(p) {
    if (p.sick) return true;
    return p.entryCreature === false && p.enteredTurn === this.state.turn && permIsCreature(this, p);
  }
  _maxHand() { return this.hooks.noMaxHand && this.hooks.noMaxHand() ? Infinity : 7; }
  _newPerm(name, extra = {}) {
    const card = cardOf(this, name);
    const p = {
      uid: this._uid(), name, tapped: false, sick: false, counters: { p1p1: 0 }, tok: false, n: 1,
      copy: false, flip: false, attacking: false, blocked: false, damage: 0, ...extra,
    };
    const face = p.flip && card.back ? { ...card, ...card.back } : card;
    p.enteredTurn = this.state.turn;
    p.entryCreature = isCreature(face) || p.tokPower != null;
    if (!p.tok) {
      p.sick = isCreature(face) && !hasKeyword(card, 'Haste');
      if (isPlaneswalker(face) && face.loyalty != null) p.counters.loyalty = num(face.loyalty);
    }
    return p;
  }
  _setPhase(ph, { quiet = false } = {}) {
    const s = this.state;
    const from = s.phase;
    s.phase = ph;
    s.pool = blankPool(); // mana empties between steps and phases
    if (!quiet) this._emit('phase', { from, to: ph, turn: s.turn });
  }
  _checkWin() {
    const s = this.state;
    if (s.won) return;
    if (s.opp.life <= 0 || Object.values(s.opp.cmdDamage).some(v => v >= 21)) {
      s.won = true; s.wonOn = s.turn;
      this._log(`The dummy is dead on turn ${s.turn}.`);
    }
  }
  _emitDrew(cards, reason) {
    const s = this.state;
    cards = cards.map(c => ({ ...c }));
    this._emit('drew', { cards, reason });
    for (const c of cards) { s.drawsThisTurn = (s.drawsThisTurn || 0) + 1; this._emit('nthDraw', { index: s.drawsThisTurn, card: c }); }
  }
  _drawRaw(n) {
    const s = this.state; let drawn = 0;
    for (let i = 0; i < n && s.zones.lib.length; i++) { s.zones.hand.push(s.zones.lib.shift()); drawn++; }
    return drawn;
  }

  _init(opts = {}, first = false) {
    const deck = this.deck;
    const seed = opts.seed;
    const cmd = commanderNames(this);
    const prevRng = this.state ? this.state.rng : null;
    this.state = {
      deck: deck.slug, deckName: deck.name,
      turn: 1,
      // Turn 1 starts in main1: nothing to untap, no upkeep triggers, and no draw on the play.
      phase: 'main1',
      life: 40,
      opp: { life: 40, cmdDamage: {} },
      pool: blankPool(),
      landPlayed: false,
      cmdTax: Object.fromEntries(cmd.map(n => [n, 0])),
      zones: { lib: [], hand: [], bf: [], gy: [], ex: [], cz: [] },
      mulls: 0, owed: Math.max(0, opts.owedBottom | 0),
      searched: false,
      attackers: [],
      won: false, wonOn: null,
      onThePlay: opts.onThePlay !== false,
      rng: seed != null ? (seed >>> 0) : (first ? null : prevRng),
      attackedThisTurn: false,
      landLimit: 1, landsPlayed: 0,   // extra land drops (rules `extraLand`)
      drawsThisTurn: 0,               // for nthDraw
      monarch: false, ringTempted: 0, extraCombats: 0, extraTurns: 0,
      ringBearer: null, emblems: [], foretold: {}, lost: false,
      manaFx: null,      // { any, extra } written by rules.js mana statics
      turnStats: blankTurnStats(),
      playable: {},      // { [uid]: { until: turn|null, exileAfter } } cards castable from exile / graveyard
      counters: {},      // player counters: experience, energy, poison...
      pending: [],      // rules.js Pending[] (RULES.md §3) — persisted with the state
      pendSeq: 1,
      costLess: {},     // { [cardName]: generic reduction } written by rules.js statics
      log: [],
      uid: 1,
    };
    const s = this.state;
    for (const l of deck.list || []) {
      for (let i = 0; i < (l.n || 1); i++) {
        const c = { uid: this._uid(), name: l.name };
        if (cmd.includes(l.name)) s.zones.cz.push(c); else s.zones.lib.push(c);
      }
    }
    if (Array.isArray(opts.hand)) { // explicit hand (may be empty)
      for (const name of opts.hand) {
        const i = s.zones.lib.findIndex(c => c.name === name);
        if (i >= 0) s.zones.hand.push(s.zones.lib.splice(i, 1)[0]);
        else s.zones.hand.push({ uid: this._uid(), name }); // not in the list: the judge asked for it
      }
      this._shuffleArr(s.zones.lib);
    } else {
      this._shuffleArr(s.zones.lib);
      this._drawRaw(7);
    }
    this._log(`New game: ${deck.name}. Opening hand of ${s.zones.hand.length}${s.onThePlay ? ', on the play' : ', on the draw'}.`);
  }

  /* ---- persistence / undo ---- */
  save() { return JSON.stringify(this.state); }
  load(stateJson) {
    try {
      const st = typeof stateJson === 'string' ? JSON.parse(stateJson) : JSON.parse(JSON.stringify(stateJson));
      if (!st || !st.zones || !Array.isArray(st.zones.lib)) return { ok: false, reason: 'invalid' };
      if (!Array.isArray(st.pending)) st.pending = [];
      if (!st.pendSeq) st.pendSeq = 1;
      if (!st.costLess) st.costLess = {};
      if (st.landLimit == null) { st.landLimit = 1; st.landsPlayed = st.landPlayed ? 1 : 0; }
      if (st.drawsThisTurn == null) st.drawsThisTurn = 0;
      if (st.ringTempted == null) st.ringTempted = 0;
      if (!st.turnStats) st.turnStats = blankTurnStats();
      if (!st.playable) st.playable = {};
      if (!st.counters) st.counters = {};
      if (!st.emblems) st.emblems = [];
      if (!st.foretold) st.foretold = {};
      this.state = st;
      this.undoStack = [];
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'invalid' };
    }
  }
  undo() {
    if (!this.undoStack.length) return { ok: false, reason: 'nothing to undo' };
    this.state = JSON.parse(this.undoStack.pop());
    return { ok: true };
  }
  restart(opts = {}) {
    this._snap(); // a mis-clicked "New game" can be undone
    this._init({ onThePlay: this.state.onThePlay, ...opts });
    return { ok: true };
  }

  /* ---- mana ---- */
  tapForMana(uid, color) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    if (p.tapped) return { ok: false, reason: 'tapped' };
    const card = cardOf(this, uid);
    const info = manaInfo(card, this.state.manaFx);
    if (!info) return { ok: false, reason: 'not a mana source' };
    if (!canTapForMana(this, p)) return { ok: false, reason: 'summoning sick' };
    const c = color || defaultColor(this, info.produced);
    if (!info.produced.includes(c)) return { ok: false, reason: 'color', produced: info.produced.slice() };
    this._snap();
    p.tapped = true;
    this.state.pool[c] += info.amount;
    this._log(`Tapped ${p.name} for ${`{${c}}`.repeat(info.amount)}.`);
    this._emit('tapped', { perm: p });
    return { ok: true, color: c, amount: info.amount };
  }

  // Plan how to pay `cost` (string or parsed cost) without mutating.
  autoPay(cost) {
    cost = normCost(cost);
    const s = this.state;
    const orig = { ...s.pool }, fresh = blankPool(), fromPool = {};
    const tap = [];
    const sources = s.zones.bf.filter(p => canTapForMana(this, p)).map(p => {
      const card = cardOf(this, p.uid);
      const info = manaInfo(card, s.manaFx);
      return { p, info, tier: isLand(card) ? 0 : (permIsCreature(this, p) ? 2 : 1) };
    });
    const used = new Set();
    const take = c => {
      if (orig[c] > 0) { orig[c]--; fromPool[c] = (fromPool[c] || 0) + 1; return true; }
      if (fresh[c] > 0) { fresh[c]--; return true; }
      return false;
    };
    const tapSrc = (src, c) => { used.add(src.p.uid); fresh[c] += src.info.amount; tap.push({ uid: src.p.uid, color: c }); };
    // best source for one of `cols`: lands, then non-creatures, then creatures; fewest colours first
    const best = cols => {
      let pick = null, pc = null;
      for (const src of sources) {
        if (used.has(src.p.uid)) continue;
        const c = cols.find(x => src.info.produced.includes(x));
        if (!c) continue;
        const k = [src.tier, src.info.produced.length];
        if (!pick || k[0] < pick.k[0] || (k[0] === pick.k[0] && k[1] < pick.k[1])) { pick = { src, k }; pc = c; }
      }
      return pick ? [pick.src, pc] : null;
    };
    let short = 0, generic = cost.generic;
    const pips = cost.pips.slice().sort((a, b) => (Array.isArray(a) ? 1 : 0) - (Array.isArray(b) ? 1 : 0));
    for (const pip of pips) {
      const cols = Array.isArray(pip) ? pip.filter(c => c !== '2') : [pip];
      if (cols.some(c => take(c))) continue;
      const b = best(cols);
      if (b) { tapSrc(b[0], b[1]); take(b[1]); continue; }
      if (Array.isArray(pip) && pip.includes('2')) generic += 2;
      else short++;
    }
    generic = takeGeneric(orig, generic, fromPool);
    generic = takeGeneric(fresh, generic);
    if (generic > 0) {
      const rest = sources.filter(src => !used.has(src.p.uid)).sort((a, b) =>
        a.tier - b.tier ||
        (a.info.produced.every(c => c === 'C') ? 0 : a.info.produced.length) - (b.info.produced.every(c => c === 'C') ? 0 : b.info.produced.length));
      for (const src of rest) {
        if (generic <= 0) break;
        const c = defaultColor(this, src.info.produced);
        tapSrc(src, c);
        generic = takeGeneric(fresh, generic);
      }
    }
    short += Math.max(0, generic);
    return { ok: short === 0, tap, fromPool, short };
  }

  addMana(color, n = 1) {
    if (!COLORS.includes(color)) return { ok: false, reason: 'color' };
    this._snap();
    this.state.pool[color] = Math.max(0, this.state.pool[color] + (n | 0));
    this._log(`${n >= 0 ? 'Added' : 'Removed'} ${Math.abs(n)} ${color} ${n >= 0 ? 'to' : 'from'} the pool (manual).`);
    return { ok: true };
  }

  /* ---- turn structure ---- */
  draw(n = 1, { reason = 'effect' } = {}) {
    const s = this.state;
    if (!s.zones.lib.length) return { ok: false, reason: 'empty library' };
    this._snap();
    const drawn = this._drawRaw(n);
    this._log(`Drew ${drawn} card${drawn === 1 ? '' : 's'}.`);
    if (drawn) this._emitDrew(s.zones.hand.slice(-drawn), reason);
    return drawn < n ? { ok: true, drawn, reason: 'library ran out' } : { ok: true, drawn };
  }

  // One phase step without snapshotting. Returns a result object.
  _advance() {
    const s = this.state;
    const ph = s.phase;
    if (ph === 'cleanup') {
      if (s.zones.hand.length > this._maxHand()) return { ok: false, reason: 'discard', count: s.zones.hand.length - 7 };
      s.turn++;
      this._setPhase('untap');
      s.landPlayed = false;
      s.landLimit = 1; s.landsPlayed = 0; s.drawsThisTurn = 0;
      s.attackedThisTurn = false;
      s.turnStats = blankTurnStats();
      for (const [u, pl] of Object.entries(s.playable || {})) if (pl.until != null && pl.until < s.turn) delete s.playable[u];
      const stays = p => p.noUntap || (p.mod && p.mod.noUntap) || p.skipUntap > 0;
      const wasTapped = s.zones.bf.filter(p => p.tapped && !stays(p));
      for (const p of s.zones.bf) {
        p.sick = false;
        if (p.tapped && stays(p)) { if (p.skipUntap > 0) p.skipUntap--; continue; }
        p.tapped = false;
      }
      this._log('Untap: untapped everything.');
      for (const p of wasTapped) if (s.zones.bf.includes(p)) this._emit('untapped', { perm: p });
      const extra = s.extraTurns > 0;
      if (extra) { s.extraTurns--; this._log('Extra turn.'); }
      this._emit('turnStart', { turn: s.turn, extra });
      return { ok: true };
    }
    if (ph === 'combat') {
      // Rule 508.8: no attackers declared -> the combat damage step is skipped.
      if (!s.attackers.length) { this._log('No attack.'); this._afterCombat(); return { ok: true }; }
      this._setPhase('combat-damage');
      return { ok: true };
    }
    if (ph === 'combat-damage') return this._resolveCombat();
    const next = PHASES[PHASES.indexOf(ph) + 1];
    this._setPhase(next, { quiet: next === 'draw' });
    if (next === 'draw') {
      let drawn = 0;
      if (s.turn === 1 && s.onThePlay) this._log('No draw on turn 1 (on the play).');
      else if ((drawn = this._drawRaw(1))) this._log('Draw step: drew a card.');
      else this._log('Draw step: library is empty.');
      this._emit('phase', { from: ph, to: 'draw', turn: s.turn });
      if (drawn) this._emitDrew(s.zones.hand.slice(-drawn), 'draw-step');
    }
    if (next === 'main1') for (const p of s.zones.bf.slice()) this._lore(p);
    if (next === 'end' && s.monarch) {
      const d = this._drawRaw(1);
      this._log(d ? 'Monarch: drew a card.' : 'Monarch: library is empty.');
      if (d) this._emitDrew(s.zones.hand.slice(-1), 'monarch');
    }
    if (next === 'cleanup') {
      for (const p of s.zones.bf) p.damage = 0;
      this.cleanupEot();
      if (s.zones.hand.length > this._maxHand()) {
        const count = s.zones.hand.length - 7;
        this._log(`Cleanup: discard ${count} to hand size.`);
        return { ok: false, reason: 'discard', count };
      }
    }
    return { ok: true };
  }

  // A non-empty state.pending (rules.js) blocks phase changes unless { force: true } (judge override).
  nextPhase({ force = false } = {}) {
    const s = this.state;
    if (!force && s.pending && s.pending.length) return { ok: false, reason: 'pending', phase: s.phase };
    if (s.phase === 'cleanup' && s.zones.hand.length > this._maxHand()) return { ok: false, reason: 'discard', count: s.zones.hand.length - 7 };
    this._snap();
    const r = this._advance();
    return { ...r, phase: this.state.phase };
  }

  // Advance until the next turn's main1 (one undo step). Stops early at a cleanup discard.
  // Also stops early (ok:false, reason:'pending') when a trigger on the way needs an answer.
  passTurn({ force = false } = {}) {
    const s = this.state;
    if (!force && s.pending && s.pending.length) return { ok: false, reason: 'pending', phase: s.phase };
    if (s.phase === 'cleanup' && s.zones.hand.length > this._maxHand()) return { ok: false, reason: 'discard', count: s.zones.hand.length - 7 };
    this._snap();
    const startTurn = s.turn;
    // Resuming from untap/upkeep/draw (e.g. after answering an upkeep trigger) stops at THIS turn's main1.
    const beforeMain = ['untap', 'upkeep', 'draw'].includes(s.phase);
    for (let guard = 0; guard < 40; guard++) {
      const r = this._advance();
      if (!r.ok) return { ...r, phase: this.state.phase };
      if (this.state.phase === 'main1' && (this.state.turn > startTurn || beforeMain)) break;
      if (this.state.pending && this.state.pending.length) return { ok: false, reason: 'pending', phase: this.state.phase, turn: this.state.turn };
    }
    return { ok: true, phase: this.state.phase, turn: this.state.turn };
  }

  /* ---- playing cards ---- */
  playLand(uid, { force = false } = {}) {
    const s = this.state;
    const f = this._find(uid, 'hand') || this._playableEntry(uid);
    if (!f) return { ok: false, reason: 'not in hand' };
    const card = cardOf(this, f.entry.name);
    if (!isLand(card)) return { ok: false, reason: 'not a land' };
    if (!force && s.phase !== 'main1' && s.phase !== 'main2') return { ok: false, reason: 'phase' };
    if (!force && (s.landsPlayed ?? (s.landPlayed ? 1 : 0)) >= (s.landLimit || 1)) return { ok: false, reason: 'land already played' };
    this._snap();
    s.zones[f.zone].splice(f.index, 1);
    delete (s.playable || {})[uid];
    const perm = this._newPerm(f.entry.name);
    s.zones.bf.push(perm); // enters untapped; ETB-tapped text is the judge's call
    s.landsPlayed = (s.landsPlayed || 0) + 1;
    s.landPlayed = s.landsPlayed >= (s.landLimit || 1);
    this._log(`Played ${f.entry.name}.`);
    this._emit('enters', { perm, from: f.zone });
    this._emit('landPlayed', { perm });
    return { ok: true, uid: perm.uid };
  }

  // force: judge override — ignores timing and casts even when short (pays what it can).
  // pay:false casts without touching mana. x: value for {X}.
  // Emits: tapped (payment) -> cast {card, kind, x, from} -> enters (permanent) | resolved (instant/sorcery).
  // `x` is passed through in the payload as given (undefined when the caller did not say).
  cast(uid, { force = false, pay = true, x } = {}) {
    const s = this.state;
    let f = this._find(uid, 'hand');
    let fromCz = false;
    if (!f) f = this._playableEntry(uid);
    if (!f) {
      f = this._find(uid, 'cz');
      if (!f) return { ok: false, reason: 'not in hand or command zone' };
      fromCz = true;
    }
    const play = f.zone === 'gy' || f.zone === 'ex' || f.zone === 'lib' ? (s.playable[uid] || { from: f.zone }) : null;
    const name = f.entry.name;
    const card = cardOf(this, name);
    if (isLand(card) && !isCreature(card)) return this.playLand(uid, { force });
    const instantSpeed = /\bInstant\b/.test(typeOf(card)) || hasKeyword(card, 'Flash') || !!(this.hooks.hasFlash && this.hooks.hasFlash(f.entry));
    if (!force && !instantSpeed && s.phase !== 'main1' && s.phase !== 'main2') return { ok: false, reason: 'phase' };
    let cost = castCost(this, name);
    cost.generic += Math.max(0, x | 0) * cost.x;
    if (pay && this.hooks.altCost) {
      const alt = this.hooks.altCost(f.entry);   // { free } or a parsed cost, when an alternative cost applies
      if (alt) {
        const total = c => c.generic + c.pips.length;
        const altCost = alt.free ? { generic: 0, pips: [], x: 0 } : normCost(alt.cost);
        if (total(altCost) <= total(cost)) { cost = altCost; this._altUsed = alt; }
      }
    }
    const paidTaps = [];
    let plan = null;
    if (pay) {
      plan = this.autoPay(cost);
      if (plan.short > 0 && !force) return { ok: false, reason: 'mana', short: plan.short, cost };
    }
    this._snap();
    let short = 0;
    if (pay) {
      for (const t of plan.tap) {
        const p = this._perm(t.uid);
        const info = manaInfo(cardOf(this, t.uid), s.manaFx);
        p.tapped = true;
        s.pool[t.color] += info.amount;
        paidTaps.push(p);
      }
      short = payFrom(s.pool, cost); // leftover mana stays floating until the phase ends
      this._spend(cost.generic + cost.pips.length - short, paidTaps.filter(p => /^treasure$/i.test(p.name)).length);
    }
    const zone = s.zones[f.zone];
    zone.splice(zone.findIndex(c => c.uid === uid), 1);
    if (play) delete s.playable[uid];
    if (fromCz) s.cmdTax[name] = (s.cmdTax[name] || 0) + 1;
    this._log(`Cast ${name}${fromCz ? ' from the command zone' : play ? ` from ${{ gy: 'the graveyard', ex: 'exile', lib: 'the top of the library' }[f.zone]}` : ''}${short ? ` (forced, ${short} short)` : ''}.`);
    for (const p of paidTaps) this._emit('tapped', { perm: p });
    const ref = { uid: f.entry.uid, name };
    const from = f.zone;
    if (this._altUsed) { this._log(`(alternative cost${this._altUsed.free ? ': free' : ''})`); this._altUsed = null; }
    this._emit('cast', { card: ref, kind: spellKind(card), x, from: from === 'ex' ? 'exile' : from });
    let to;
    if (isInstantOrSorcery(card)) {
      if (play && play.exileAfter) { s.zones.ex.push(ref); to = 'ex'; } else { s.zones.gy.push(ref); to = 'gy'; }
      this._emit('resolved', { card: ref, x });
    } else {
      const p = this._newPerm(name); s.zones.bf.push(p); to = 'bf'; uid = p.uid;
      this._emit('enters', { perm: p, from });
    }
    return { ok: true, to, uid, short };
  }

  tap(uid) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    if (p.tapped) return { ok: false, reason: 'already tapped' };
    this._snap(); p.tapped = true; this._log(`Tapped ${p.name}.`);
    this._emit('tapped', { perm: p });
    return { ok: true };
  }
  untap(uid) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    if (!p.tapped) return { ok: false, reason: 'already untapped' };
    this._snap(); p.tapped = false; this._log(`Untapped ${p.name}.`);
    this._emit('untapped', { perm: p });
    return { ok: true };
  }
  toggleTap(uid) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    return p.tapped ? this.untap(uid) : this.tap(uid);
  }

  // to: 'hand'|'bf'|'gy'|'ex'|'cz'|'lib' ('libtop' = lib with top:true). Tokens and copy markers
  // cease to exist when they leave the battlefield (copies of permanents are tokens in real rules).
  move(uid, to, { top = false, flip = false } = {}) {
    if (to === 'libtop') { to = 'lib'; top = true; }
    if (to === 'libbottom') to = 'lib';
    if (!ZONES.includes(to)) return { ok: false, reason: 'bad zone' };
    const s = this.state;
    const f = this._find(uid);
    if (!f) return { ok: false, reason: 'not found' };
    if (f.zone === to && to !== 'lib') return { ok: false, reason: 'already there' };
    this._snap();
    const e = f.entry;
    s.zones[f.zone].splice(f.index, 1);
    s.attackers = s.attackers.filter(u => u !== uid);
    if (f.zone === 'bf' && (e.tok || e.copy)) {
      this._log(`${e.name} ${e.tok ? 'token' : 'copy'} left the battlefield and ceased to exist.`);
      this._emitLeaves(e, to);
      return { ok: true, vanished: true };
    }
    let newUid = e.uid, entered = null;
    if (to === 'bf') { const p = this._newPerm(e.name, { flip: !!flip }); s.zones.bf.push(p); newUid = p.uid; entered = p; }
    else {
      const c = { uid: e.uid, name: e.name };
      if (to === 'lib' && top) s.zones.lib.unshift(c); else s.zones[to].push(c);
    }
    const label = { hand: 'hand', bf: 'the battlefield', gy: 'the graveyard', ex: 'exile', cz: 'the command zone', lib: top ? 'the top of the library' : 'the bottom of the library' }[to];
    this._log(`Moved ${e.name} from ${f.zone} to ${label}.`);
    if (f.zone === 'bf') this._emitLeaves(e, to);
    if (entered) this._emit('enters', { perm: entered, from: f.zone });
    if (f.zone !== 'bf' && to !== 'bf') this._emit('moved', { card: { uid: e.uid, name: e.name }, from: f.zone, to });
    return { ok: true, uid: newUid };
  }

  addCounter(uid, kind = 'p1p1', delta = 1) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    if (delta > 0 && this.hooks.replace) { const r = this.hooks.replace('countersPlaced', { perm: p, kind, n: delta }); if (Number.isFinite(r)) delta = r; }
    this._snap();
    const before = p.counters[kind] || 0;
    p.counters[kind] = Math.max(0, before + delta);
    this._log(`${delta >= 0 ? '+' : ''}${delta} ${kind} counter on ${p.name} (now ${p.counters[kind]}).`);
    if (p.counters[kind] !== before) this._emit('counters', { perm: p, kind, delta: p.counters[kind] - before });
    if (!this._batchDepth) this._sba(); // 0 loyalty / -1/-1 counters
    return { ok: true, value: p.counters[kind] };
  }

  transform(uid) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    const card = (this.deck.cards || {})[p.name];
    if (!card || !card.back) return { ok: false, reason: 'no back face' };
    this._snap();
    p.flip = !p.flip;
    this._log(`Transformed ${p.name} to ${p.flip ? card.back.name : card.name}.`);
    this._emit('transformed', { perm: p });
    return { ok: true, flip: p.flip };
  }

  /* ---- combat ---- */
  declareAttackers(uids = []) {
    const s = this.state;
    if (s.phase !== 'combat') return { ok: false, reason: 'phase' };
    const accepted = [], skipped = [];
    for (const uid of uids) {
      const p = this._perm(uid);
      const card = p && cardOf(this, uid);
      if (!p || !permIsCreature(this, p)) { skipped.push({ uid, reason: 'not a creature' }); continue; }
      if (this.hooks.cantAttack && this.hooks.cantAttack(p)) { skipped.push({ uid, reason: "can't attack" }); continue; }
      if (p.tapped) { skipped.push({ uid, reason: 'tapped' }); continue; }
      if (this._sickNow(p) && !hasKeyword(card, 'Haste')) { skipped.push({ uid, reason: 'summoning sick' }); continue; }
      if (accepted.includes(uid)) continue;
      accepted.push(uid);
    }
    this._snap();
    const tappedNow = [];
    for (const uid of accepted) {
      const p = this._perm(uid);
      p.attacking = true; p.blocked = false;
      if (!hasKeyword(cardOf(this, uid), 'Vigilance')) { p.tapped = true; tappedNow.push(p); }
    }
    s.attackers = accepted;
    if (accepted.length) s.attackedThisTurn = true;
    const dmg = accepted.reduce((t, u) => t + Math.max(0, power(this, u)) * (this._perm(u).n || 1), 0);
    this._log(accepted.length ? `Attacked with ${accepted.map(u => this._perm(u).name).join(', ')} (${dmg} power).` : 'Declared no attackers.');
    this._setPhase('combat-damage');
    for (const p of tappedNow) this._emit('tapped', { perm: p });
    if (accepted.length) {
      const perms = accepted.map(u => this._perm(u)).filter(Boolean);
      this._emit('attacks', { perms });
      this._emit('attackedWith', { count: perms.reduce((t, p) => t + (p.tok ? p.n || 1 : 1), 0), perms });
    }
    return { ok: true, attackers: accepted, skipped };
  }

  markBlocked(uid, blocked = true) {
    const p = this._perm(uid);
    if (!p || !p.attacking) return { ok: false, reason: 'not attacking' };
    this._snap();
    p.blocked = !!blocked;
    this._log(`${p.name} ${blocked ? 'is' : 'is no longer'} blocked.`);
    return { ok: true };
  }

  _resolveCombat() {
    const s = this.state;
    let damage = 0;
    const byPerm = [];
    for (const uid of s.attackers) {
      const p = this._perm(uid);
      if (!p || !p.attacking || p.blocked) continue;
      let dmg = Math.max(0, power(this, p)) * (p.n || 1);
      if (dmg > 0 && this.hooks.replace) { const r = this.hooks.replace('damageToOpp', { source: p, n: dmg }); if (Number.isFinite(r)) dmg = r; }
      damage += dmg;
      if (dmg > 0) byPerm.push({ perm: p, dmg });
      if (!p.tok && !p.copy && isCommander(this, p.name) && dmg > 0) {
        s.opp.cmdDamage[p.name] = (s.opp.cmdDamage[p.name] || 0) + dmg;
      }
    }
    s.opp.life -= damage;
    let link = byPerm.filter(b => hasKeyword(cardOf(this, b.perm.uid), 'Lifelink')).reduce((t, b) => t + b.dmg, 0);
    for (const p of s.zones.bf) { p.attacking = false; p.blocked = false; }
    s.attackers = [];
    this._log(`Combat damage: the dummy takes ${damage} (life ${s.opp.life}).`);
    this._checkWin();
    if (damage > 0) {
      this._emit('combatDamage', { total: damage, byPerm });
      this._emit('life', { who: 'opp', delta: -damage, now: s.opp.life });
    }
    if (link > 0) {
      if (this.hooks.replace) { const r = this.hooks.replace('lifeGained', { n: link }); if (Number.isFinite(r)) link = r; }
      s.life += link;
      this._log(`Lifelink: you gain ${link} (life ${s.life}).`);
      this._emit('life', { who: 'you', delta: link, now: s.life });
    }
    this._afterCombat();
    return { ok: true, damage, won: s.won };
  }

  _afterCombat() {
    const s = this.state;
    if (s.extraCombats > 0) { s.extraCombats--; this._log('Additional combat phase.'); this._setPhase('combat'); }
    else this._setPhase('main2');
  }

  resolveCombat() {
    const s = this.state;
    if (s.phase !== 'combat' && s.phase !== 'combat-damage') return { ok: false, reason: 'phase' };
    this._snap();
    return this._resolveCombat();
  }

  /* ---- life ---- */
  life(delta) {
    if ((delta | 0) > 0 && this.hooks.replace) { const r = this.hooks.replace('lifeGained', { n: delta | 0 }); if (Number.isFinite(r)) delta = r; }
    this._snap();
    this.state.life += delta | 0;
    this._log(`Your life ${delta >= 0 ? '+' : ''}${delta} -> ${this.state.life}.`);
    if (delta | 0) this._emit('life', { who: 'you', delta: delta | 0, now: this.state.life });
    return { ok: true, life: this.state.life };
  }
  oppLife(delta) {
    this._snap();
    this.state.opp.life += delta | 0;
    this._log(`Dummy life ${delta >= 0 ? '+' : ''}${delta} -> ${this.state.opp.life}.`);
    this._checkWin();
    if (delta | 0) this._emit('life', { who: 'opp', delta: delta | 0, now: this.state.opp.life });
    return { ok: true, life: this.state.opp.life, won: this.state.won };
  }

  /* ---- library ---- */
  // London mulligan with the house rule: the first mulligan is free -> owed = max(0, mulls - 1).
  mulligan() {
    const s = this.state;
    if (s.turn !== 1 || s.zones.bf.length) return { ok: false, reason: 'only before the game starts' };
    this._snap();
    s.zones.lib.push(...s.zones.hand.map(c => ({ uid: c.uid, name: c.name })));
    s.zones.hand = [];
    this._shuffleArr(s.zones.lib);
    this._drawRaw(7);
    s.mulls++;
    s.owed = Math.max(0, s.mulls - 1);
    s.searched = false;
    this._log(`Mulligan #${s.mulls}: drew 7${s.owed ? `, put ${s.owed} on the bottom` : ' (free)'}.`);
    return { ok: true, owed: s.owed };
  }

  bottom(uid) {
    const s = this.state;
    const f = this._find(uid, 'hand');
    if (!f) return { ok: false, reason: 'not in hand' };
    this._snap();
    s.zones.hand.splice(f.index, 1);
    s.zones.lib.push(f.entry);
    s.owed = Math.max(0, s.owed - 1);
    this._log(`Put ${f.entry.name} on the bottom${s.owed ? ` (${s.owed} more owed)` : ''}.`);
    return { ok: true, owed: s.owed };
  }

  shuffle() {
    this._snap();
    this._shuffleArr(this.state.zones.lib);
    this.state.searched = false;
    this._log('Shuffled the library.');
    return { ok: true };
  }

  peekTop(n = 1) { return this.state.zones.lib.slice(0, n).map(c => ({ ...c })); }

  tutor(uid, to) {
    const valid = ['hand', 'bf', 'gy', 'ex', 'libtop'];
    if (!valid.includes(to)) return { ok: false, reason: 'bad zone' };
    const f = this._find(uid, 'lib');
    if (!f) return { ok: false, reason: 'not in library' };
    this._snap();
    const s = this.state;
    s.zones.lib.splice(f.index, 1);
    let newUid = f.entry.uid;
    let entered = null;
    if (to === 'bf') { const p = this._newPerm(f.entry.name); s.zones.bf.push(p); newUid = p.uid; entered = p; }
    else if (to === 'libtop') s.zones.lib.unshift(f.entry);
    else s.zones[to].push(f.entry);
    s.searched = true;
    this._log(`Searched for ${f.entry.name} -> ${to}.`);
    if (entered) this._emit('enters', { perm: entered, from: 'lib' });
    return { ok: true, uid: newUid };
  }

  /* ---- tokens ---- */
  // Identical tokens stack: a new token joins an untapped, counter-free, non-attacking stack of the
  // same name, P/T and sickness. P/T default from a "2/2 Zombie" style name.
  // opts.tapped: enters tapped; opts.kw: the token's own keywords; opts.types: ['Creature','Elf'] (type line).
  // Replacement effects (rules.js hook) may multiply the count or swap the tokens (Academy Manufactor).
  createToken(name, n = 1, opts = {}) {
    name = String(name || '').trim().slice(0, 40);
    n = Math.max(1, Math.floor(+n || 1));
    if (!name) return { ok: false, reason: 'name' };
    let specs = [{ name, n, opts }];
    if (this.hooks.replace) { const r = this.hooks.replace('tokenCreated', specs); if (Array.isArray(r) && r.length) specs = r; }
    this._snap();
    let first = null;
    for (const sp of specs) { const r = this._makeToken(String(sp.name).slice(0, 40), Math.max(1, Math.floor(+sp.n || 1)), sp.opts || {}); if (!first) first = r; }
    return first;
  }
  _makeToken(name, n, { power: pw, toughness: tg, tapped = false, kw = [], types = [], colors = [], script = null } = {}) {
    const m = name.match(/^(\d+)\s*\/\s*(\d+)\b/);
    if (pw == null && m) pw = +m[1];
    if (tg == null && m) tg = +m[2];
    const creature = pw != null || tg != null;
    const s = this.state;
    const sick = creature; // creature tokens are summoning sick; Haste is the judge's call
    const counterFree = p => Object.values(p.counters).every(v => !v);
    tapped = !!tapped;
    const kwKey = JSON.stringify(kw || []), tyKey = JSON.stringify(types || []), coKey = JSON.stringify(colors || []);
    const home = s.zones.bf.find(p => p.tok && p.tapped === tapped && !p.attacking && counterFree(p) && p.sick === sick &&
      p.name.toLowerCase() === name.toLowerCase() && (p.tokPower ?? null) === (pw ?? null) && (p.tokToughness ?? null) === (tg ?? null) &&
      JSON.stringify(p.tokKw || []) === kwKey && JSON.stringify(p.tokTypes || []) === tyKey && JSON.stringify(p.tokColors || []) === coKey && !p.eot && !p.copy && !p.attachedTo &&
      (p.tokScript || null) === (script || null));
    let uid, perm;
    if (home) { home.n += n; uid = home.uid; perm = home; }
    else {
      const p = this._newPerm(name, { tok: true, n, sick, tapped });
      if (creature) { p.tokPower = pw ?? 0; p.tokToughness = tg ?? 0; p.entryCreature = true; }
      if (kw && kw.length) p.tokKw = kw.slice();
      if (types && types.length) p.tokTypes = types.slice();
      if (colors && colors.length) p.tokColors = colors.slice();
      if (script) p.tokScript = script;
      s.zones.bf.push(p); uid = p.uid; perm = p;
    }
    this._log(`Created ${n} ${name} token${n === 1 ? '' : 's'}${tapped ? ' (tapped)' : ''}.`);
    this._emit('enters', { perm, from: 'token', n });
    this._emit('tokenCreated', { perm, n });
    return { ok: true, uid };
  }

  splitToken(uid) {
    const p = this._perm(uid);
    if (!p || !p.tok) return { ok: false, reason: 'not a token' };
    if (p.n < 2) return { ok: false, reason: 'single token' };
    this._snap();
    p.n--;
    const q = JSON.parse(JSON.stringify(p));
    q.uid = this._uid(); q.n = 1;
    this.state.zones.bf.splice(this.state.zones.bf.indexOf(p) + 1, 0, q);
    this._log(`Split one ${p.name} token off the stack.`);
    return { ok: true, uid: q.uid };
  }

  setTokenCount(uid, n) {
    const p = this._perm(uid);
    if (!p || !p.tok) return { ok: false, reason: 'not a token' };
    n = Math.floor(+n);
    if (!Number.isFinite(n) || n < 0) return { ok: false, reason: 'count' };
    this._snap();
    if (n === 0) {
      this.state.zones.bf.splice(this.state.zones.bf.indexOf(p), 1);
      this.state.attackers = this.state.attackers.filter(u => u !== uid);
      this._log(`Removed the ${p.name} token stack.`);
      this._emit('leaves', { perm: p, to: 'none' });
    } else { p.n = n; this._log(`${p.name} tokens set to ${n}.`); }
    return { ok: true };
  }

  mergeTokens(uid) {
    const p = this._perm(uid);
    if (!p || !p.tok) return { ok: false, reason: 'not a token' };
    if (p.attachedTo) return { ok: false, reason: 'attached tokens stay separate' };
    const same = q => q !== p && q.tok && !q.attachedTo && q.name.toLowerCase() === p.name.toLowerCase() &&
      q.tapped === p.tapped && q.sick === p.sick && q.attacking === p.attacking &&
      (q.tokPower ?? null) === (p.tokPower ?? null) && (q.tokToughness ?? null) === (p.tokToughness ?? null) &&
      JSON.stringify(q.counters) === JSON.stringify(p.counters);
    const twins = this.state.zones.bf.filter(same);
    if (!twins.length) return { ok: false, reason: 'nothing to merge' };
    this._snap();
    p.n += twins.reduce((t, q) => t + q.n, 0);
    this.state.zones.bf = this.state.zones.bf.filter(q => !twins.includes(q));
    this._log(`Merged ${p.name} tokens into a stack of ${p.n}.`);
    return { ok: true, n: p.n };
  }

  // The old table's "Copy (token)": a copy marker of a permanent (tok:false, copy:true).
  copyPermanent(uid) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    let q;
    if (p.tok) {
      q = { ...JSON.parse(JSON.stringify(p)), uid: this._uid(), n: 1, tapped: false, attacking: false, blocked: false, damage: 0, counters: { p1p1: 0 } };
      q.sick = permIsCreature(this, q);
    } else { q = this._newPerm(p.name, { copy: true, flip: p.flip }); q.tok = true; q.n = 1; } // copies are tokens
    this.state.zones.bf.push(q);
    this._log(`Created a copy of ${p.name}.`);
    this._emit('enters', { perm: q, from: 'copy' });
    return { ok: true, uid: q.uid };
  }

  _emitLeaves(perm, to) {
    const s = this.state;
    this._emit('leaves', { perm, to });
    if (to === 'gy') this._emit('dies', { perm });
    if (!this._perm(perm.uid)) {
      // Auras attached to it go to the graveyard; Equipment (anything else) stays, unattached.
      for (const a of s.zones.bf.filter(q => q.attachedTo === perm.uid)) {
        if (/\bAura\b/.test(typeOf(cardOf(this, a.uid)))) { this._log(`${a.name} falls off and goes to the graveyard.`); this.move(a.uid, 'gy'); }
        else { delete a.attachedTo; this._log(`${a.name} becomes unattached.`); this._emit('attached', { perm: a, host: null }); }
      }
    }
  }

  /* ---- rules primitives (RULES.md §1 "Also needed") ---- */
  // Until-end-of-turn bonuses end at cleanup. Called by the engine; no snapshot of its own.
  cleanupEot() {
    for (const p of this.state.zones.bf) delete p.eot;
    return { ok: true };
  }

  // Look at the top n: uids in `keepTop` go back on top in that order (unlisted ones follow in their
  // original order), uids in `bottom` go to the bottom in that order.
  scry(n, keepTop = [], bottom = []) { return this._lookTop('scry', n, keepTop, bottom); }
  // Same, but the `toGy` cards go to the graveyard.
  surveil(n, keepTop = [], toGy = []) { return this._lookTop('surveil', n, keepTop, toGy); }
  _lookTop(kind, n, keepTop, away) {
    const s = this.state;
    n = Math.min(Math.max(0, n | 0), s.zones.lib.length);
    if (!n) return { ok: false, reason: 'empty library' };
    const top = s.zones.lib.slice(0, n);
    const byUid = new Map(top.map(c => [c.uid, c]));
    keepTop = (keepTop || []).filter((u, i, a) => a.indexOf(u) === i);
    away = (away || []).filter((u, i, a) => a.indexOf(u) === i);
    if ([...keepTop, ...away].some(u => !byUid.has(u))) return { ok: false, reason: 'not in the top cards' };
    this._snap();
    const awaySet = new Set(away);
    const keepIds = keepTop.filter(u => !awaySet.has(u));
    const kept = [...keepIds.map(u => byUid.get(u)), ...top.filter(c => !keepIds.includes(c.uid) && !awaySet.has(c.uid))];
    const gone = away.map(u => byUid.get(u));
    s.zones.lib.splice(0, n, ...kept);
    if (kind === 'scry') s.zones.lib.push(...gone); else s.zones.gy.push(...gone);
    const where = kind === 'scry' ? 'on the bottom' : 'into the graveyard';
    this._log(`${kind === 'scry' ? 'Scried' : 'Surveilled'} ${n}: ${kept.length} on top, ${gone.length} ${where}${gone.length ? ` (${gone.map(c => c.name).join(', ')})` : ''}.`);
    this._emit(kind === 'scry' ? 'scryed' : 'surveiled', { n, top: kept.map(c => c.uid), away: gone.map(c => c.uid) });
    return { ok: true, top: kept.map(c => c.uid), away: gone.map(c => c.uid) };
  }

  mill(n = 1) { return this._topTo(n, 'gy', 'Milled'); }
  exileTop(n = 1) { return this._topTo(n, 'ex', 'Exiled the top'); }
  _topTo(n, zone, verb) {
    const s = this.state;
    n = Math.min(Math.max(0, n | 0), s.zones.lib.length);
    if (!n) return { ok: false, reason: 'empty library' };
    this._snap();
    const cards = s.zones.lib.splice(0, n);
    s.zones[zone].push(...cards);
    this._log(`${verb} ${n}: ${cards.map(c => c.name).join(', ')}.`);
    this._emit('moved', { cards: cards.map(c => ({ ...c })), from: 'lib', to: zone });
    return { ok: true, cards: cards.map(c => ({ ...c })) };
  }

  // Library -> battlefield. `filter`: a library uid, 'basic' (default), 'land', an exact card name, or a
  // predicate (card, entry) => bool. Takes the first match. Sets `searched` (the caller shuffles).
  rampLand(filter = 'basic', tapped = true) {
    const s = this.state;
    const test = typeof filter === 'number' ? (c, e) => e.uid === filter
      : typeof filter === 'function' ? filter
      : filter === 'basic' ? c => isLand(c) && /\bBasic\b/.test(typeOf(c))
      : filter === 'land' ? c => isLand(c)
      : (c, e) => e.name === filter;
    const i = s.zones.lib.findIndex(e => test(cardOf(this, e.name), e));
    if (i < 0) return { ok: false, reason: 'no match in library' };
    this._snap();
    const [e] = s.zones.lib.splice(i, 1);
    const p = this._newPerm(e.name, { tapped: !!tapped });
    s.zones.bf.push(p);
    s.searched = true;
    this._log(`Put ${e.name} from the library onto the battlefield${tapped ? ' tapped' : ''}.`);
    this._emit('enters', { perm: p, from: 'lib' });
    return { ok: true, uid: p.uid, name: e.name };
  }

  // Graveyard -> 'hand' | 'bf' | 'top' (library top) | 'lib' (bottom).
  returnFromGy(uid, to = 'hand') {
    const s = this.state;
    const f = this._find(uid, 'gy');
    if (!f) return { ok: false, reason: 'not in graveyard' };
    if (!['hand', 'bf', 'top', 'libtop', 'lib'].includes(to)) return { ok: false, reason: 'bad zone' };
    this._snap();
    s.zones.gy.splice(f.index, 1);
    let newUid = f.entry.uid, entered = null;
    if (to === 'bf') { entered = this._newPerm(f.entry.name); s.zones.bf.push(entered); newUid = entered.uid; }
    else if (to === 'top' || to === 'libtop') s.zones.lib.unshift(f.entry);
    else s.zones[to].push(f.entry);
    this._log(`Returned ${f.entry.name} from the graveyard to ${{ hand: 'hand', bf: 'the battlefield', top: 'the top of the library', libtop: 'the top of the library', lib: 'the bottom of the library' }[to]}.`);
    if (entered) this._emit('enters', { perm: entered, from: 'gy' });
    return { ok: true, uid: newUid };
  }

  // Battlefield -> graveyard (tokens cease to exist). One token off a stack of n.
  sacrifice(uid) {
    const s = this.state;
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    let gone = p;
    if (p.tok && p.n > 1) {
      p.n--;
      gone = { ...JSON.parse(JSON.stringify(p)), n: 1 };
    } else {
      s.zones.bf.splice(s.zones.bf.indexOf(p), 1);
      s.attackers = s.attackers.filter(u => u !== uid);
      if (!p.tok && !p.copy) s.zones.gy.push({ uid: p.uid, name: p.name });
    }
    this._log(`Sacrificed ${p.name}${p.tok ? ' token' : ''}.`);
    this._emitLeaves(gone, 'gy');
    this._emit('sacrificed', { perm: gone });
    return { ok: true };
  }

  // Untap without failing on an already-untapped permanent (effects "untap target creature").
  untapPerm(uid) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    if (!p.tapped) return { ok: true, changed: false };
    this._snap(); p.tapped = false; this._log(`Untapped ${p.name}.`);
    this._emit('untapped', { perm: p });
    return { ok: true, changed: true };
  }

  // +p/+t and keywords until end of turn (perm.eot, cleared at cleanup).
  grantEot(uid, { p = 0, t = 0, kw = [] } = {}) {
    const perm = this._perm(uid);
    if (!perm) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    const e = perm.eot || (perm.eot = { p: 0, t: 0, kw: [] });
    e.p += p | 0; e.t += t | 0;
    for (const k of kw || []) if (!e.kw.includes(k)) e.kw.push(k);
    const pt = (p | 0) || (t | 0) ? `${p >= 0 ? '+' : ''}${p | 0}/${t >= 0 ? '+' : ''}${t | 0}` : '';
    const kws = (kw || []).length ? `${pt ? ' and ' : ''}${kw.join(', ')}` : '';
    this._log(`${perm.name} gets ${pt}${kws} until end of turn.`);
    return { ok: true, eot: { ...e, kw: e.kw.slice() } };
  }

  // Set the persistent static bonus perm.mod = { p, t, kw, costLess, from? }. rules.js recomputes
  // statics with { quiet: true } (no undo step, no log: it is derived state). An empty mod is removed.
  modify(uid, mod, { quiet = false } = {}) {
    const perm = this._perm(uid);
    if (!perm) return { ok: false, reason: 'not on battlefield' };
    const m = mod || {};
    const next = { p: m.p | 0, t: m.t | 0, kw: (m.kw || []).slice(), costLess: m.costLess | 0 };
    if (m.noUntap) next.noUntap = true;
    if (m.animated) next.animated = { ...m.animated };
    if (m.from && m.from.length) next.from = m.from.slice();
    const empty = !next.p && !next.t && !next.kw.length && !next.costLess && !next.noUntap && !next.animated;
    if (!quiet) this._snap();
    if (empty) delete perm.mod; else perm.mod = next;
    if (!quiet) this._log(empty ? `${perm.name}: static bonus cleared.` : `${perm.name}: static bonus ${next.p >= 0 ? '+' : ''}${next.p}/${next.t >= 0 ? '+' : ''}${next.t}${next.kw.length ? ' ' + next.kw.join(', ') : ''}.`);
    return { ok: true };
  }

  // Pay a mana cost (string or parsed) from the pool + untapped sources (activated abilities).
  payCost(cost, { force = false } = {}) {
    cost = normCost(cost);
    const plan = this.autoPay(cost);
    if (plan.short > 0 && !force) return { ok: false, reason: 'mana', short: plan.short };
    const s = this.state;
    this._snap();
    const tapped = [];
    for (const t of plan.tap) {
      const p = this._perm(t.uid);
      p.tapped = true;
      s.pool[t.color] += manaInfo(cardOf(this, t.uid), s.manaFx).amount;
      tapped.push(p);
    }
    const short = payFrom(s.pool, cost);
    this._spend(cost.generic + cost.pips.length - short, tapped.filter(p => /^treasure$/i.test(p.name)).length);
    this._log(`Paid ${cost.generic ? `{${cost.generic}}` : ''}${cost.pips.map(x => `{${Array.isArray(x) ? x.join('/') : x}}`).join('')}${short ? ` (${short} short)` : ''}.`);
    for (const p of tapped) this._emit('tapped', { perm: p });
    return { ok: true, short };
  }

  _playableEntry(uid) {
    const s = this.state, pl = (s.playable || {})[uid];
    if (pl && (pl.until == null || pl.until >= s.turn)) { const f = this._find(uid, 'gy') || this._find(uid, 'ex'); if (f) return f; }
    const top = s.zones.lib[0];
    if (top && top.uid === uid && this.hooks.canPlayFromTop && this.hooks.canPlayFromTop(top)) return { zone: 'lib', index: 0, entry: top };
    const g = this._find(uid, 'gy');
    if (g && this.hooks.canCastFromGy && this.hooks.canCastFromGy(g.entry)) return g;
    return null;
  }
  // Let a card in exile / the graveyard be cast or played (impulse draw, flashback-like permissions).
  // until: last turn number it is playable (null = while it stays there); exileAfter: an instant/sorcery cast this way is exiled.
  grantPlayable(uid, { until = null, exileAfter = false } = {}) {
    const f = this._find(uid, 'gy') || this._find(uid, 'ex');
    if (!f) return { ok: false, reason: 'not in exile or graveyard' };
    this._snap();
    this.state.playable[uid] = { until, exileAfter: !!exileAfter };
    this._log(`${f.entry.name} may be played from ${f.zone === 'gy' ? 'the graveyard' : 'exile'}${until != null ? ` until turn ${until}` : ''}.`);
    return { ok: true };
  }
  // Everything castable/playable from outside hand: impulse/flashback grants, the top of the library
  // (playFromTop statics) and graveyard cards a static lets you cast.
  playableCards() {
    const s = this.state, out = [], seen = new Set();
    const add = (f, extra) => { if (f && !seen.has(f.entry.uid)) { seen.add(f.entry.uid); out.push({ uid: f.entry.uid, name: f.entry.name, zone: f.zone, ...extra }); } };
    for (const u of Object.keys(s.playable || {}).map(Number)) { const pl = s.playable[u]; if (pl.until == null || pl.until >= s.turn) add(this._find(u, 'gy') || this._find(u, 'ex'), pl); }
    const top = s.zones.lib[0];
    if (top && this.hooks.canPlayFromTop && this.hooks.canPlayFromTop(top)) add({ zone: 'lib', entry: top }, { source: 'static' });
    if (this.hooks.canCastFromGy) for (const c of s.zones.gy) if (this.hooks.canCastFromGy(c)) add({ zone: 'gy', entry: c }, { source: 'static' });
    return out;
  }

  // Base P/T override ("has base power and toughness X/X"): until end of turn (eot) or for good.
  setBase(uid, p, t, { eot = true } = {}) {
    const perm = this._perm(uid);
    if (!perm) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    if (eot) (perm.eot || (perm.eot = { p: 0, t: 0, kw: [] })).base = { p: p | 0, t: t | 0 };
    else perm.base = { p: p | 0, t: t | 0 };
    this._log(`${perm.name} has base power and toughness ${p | 0}/${t | 0}${eot ? ' until end of turn' : ''}.`);
    return { ok: true };
  }

  // "Doesn't untap during your untap step": for good (noUntap) or only the next one (next:true).
  setNoUntap(uid, { next = false, on = true } = {}) {
    const perm = this._perm(uid);
    if (!perm) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    if (next) perm.skipUntap = (perm.skipUntap || 0) + 1; else if (on) perm.noUntap = true; else delete perm.noUntap;
    this._log(`${perm.name} ${next ? "doesn't untap during your next untap step" : on ? "doesn't untap during your untap step" : 'untaps normally again'}.`);
    return { ok: true };
  }

  // Player counters (experience, energy, poison...): state.counters[kind].
  addPlayerCounter(kind = 'experience', delta = 1) {
    const s = this.state;
    this._snap();
    const before = s.counters[kind] || 0;
    s.counters[kind] = Math.max(0, before + (delta | 0));
    this._log(`You ${delta >= 0 ? 'get' : 'lose'} ${Math.abs(s.counters[kind] - before)} ${kind} counter${Math.abs(delta) === 1 ? '' : 's'} (now ${s.counters[kind]}).`);
    if (s.counters[kind] !== before) this._emit('playerCounters', { kind, delta: s.counters[kind] - before, now: s.counters[kind] });
    return { ok: true, value: s.counters[kind] };
  }

  // "You win the game" (Simic Ascendancy, Felidar Sovereign...): the dummy is beaten with a reason.
  win(reason = 'an alternate win condition') {
    const s = this.state;
    if (s.won) return { ok: true, already: true };
    this._snap();
    s.won = true; s.wonOn = s.turn; s.wonReason = String(reason);
    this._log(`You win: ${s.wonReason}.`);
    return { ok: true };
  }

  // State-based check: a creature with lethal damage dies (unless indestructible); a creature whose
  // toughness was pushed to 0 or less dies. Printed 0 or '*' toughness is exempt (hydras get their
  // counters from a trigger that the goldfish resolves a beat later). Runs at the end of every batch.
  _sba() {
    for (let round = 0; round < 10; round++) {
      const dead = this.state.zones.bf.filter(p => {
        const card = cardOf(this, p.uid);
        if (isPlaneswalker(card) && p.counters && p.counters.loyalty != null && p.counters.loyalty <= 0) return true;
        if (!permIsCreature(this, p)) return false;
        const base = p.tok && !p.copy ? (p.tokToughness ?? 0) : String(card.toughness ?? '');
        if (base === 0 || base === '0' || /\*/.test(String(base))) return (p.damage || 0) > 0 && toughness(this, p) - (p.damage || 0) <= 0 && !hasKeyword(card, 'Indestructible');
        const t = toughness(this, p);
        if (t <= 0) return true;
        return (p.damage || 0) > 0 && t - p.damage <= 0 && !hasKeyword(card, 'Indestructible');
      });
      if (!dead.length) return;
      for (const p of dead) { this._log(`${p.name} dies (state-based).`); this.move(p.uid, 'gy'); }
    }
  }

  // Mark damage on a creature (cleared at cleanup). Lethal damage kills at the end of the batch.
  damage(uid, n) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    n = Math.max(0, n | 0);
    if (!n) return { ok: true };
    this._snap();
    p.damage = (p.damage || 0) + n;
    this._log(`${p.name} is dealt ${n} damage.`);
    this._emit('damaged', { perm: p, amount: n });
    if (!this._batchDepth) this._sba();
    return { ok: true, damage: p.damage };
  }

  // Attach an Aura / Equipment `uid` to `hostUid` (null = unattach). Emits `attached`.
  attach(uid, hostUid) {
    let p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    if (hostUid != null && !this._perm(hostUid)) return { ok: false, reason: 'host not on battlefield' };
    if (hostUid === uid) return { ok: false, reason: 'cannot attach to itself' };
    this._snap();
    if (p.tok && (p.n || 1) > 1 && hostUid != null) { // one token comes off the pile and is attached on its own
      p.n--;
      const q = { ...JSON.parse(JSON.stringify(p)), uid: this._uid(), n: 1 };
      this.state.zones.bf.splice(this.state.zones.bf.indexOf(p) + 1, 0, q);
      p = q; uid = q.uid;
    }
    const host = hostUid == null ? null : this._perm(hostUid);
    if (host) p.attachedTo = hostUid; else delete p.attachedTo;
    this._log(host ? `Attached ${p.name} to ${host.name}.` : `Unattached ${p.name}.`);
    this._emit('attached', { perm: p, host });
    return { ok: true, uid };
  }

  // The permanent becomes a P/T creature (types/subtypes/keywords added): for good (perm.animated) or
  // until end of turn (eot). returns:true marks earthbend (rules.js returns it tapped when it dies).
  animate(uid, { p = 0, t = 0, kw = [], types = ['Creature'], subtypes = [], eot = false, returns = true } = {}) {
    const perm = this._perm(uid);
    if (!perm) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    const a = { p: p | 0, t: t | 0, kw: (kw || []).slice(), types: (types || ['Creature']).slice(), subtypes: (subtypes || []).slice() };
    if (eot) (perm.eot || (perm.eot = { p: 0, t: 0, kw: [] })).animated = a; else perm.animated = a;
    if (returns) perm.earthbent = true;
    this._log(`${perm.name} becomes a ${p | 0}/${t | 0} ${[...a.subtypes, 'creature'].join(' ')}${a.kw.length ? ' with ' + a.kw.join(', ').toLowerCase() : ''}${eot ? ' until end of turn' : ''}.`);
    return { ok: true };
  }

  // Mana spent this turn; `expend` fires when the running total reaches 4 and 8.
  _spend(n, treasure = 0) {
    if (!(n > 0)) return;
    const ts = this.state.turnStats || (this.state.turnStats = blankTurnStats());
    const before = ts.manaSpent || 0;
    ts.manaSpent = before + n;
    ts.treasureManaSpent = (ts.treasureManaSpent || 0) + Math.min(n, treasure);
    for (const k of [4, 8]) if (before < k && ts.manaSpent >= k) this._emit('expend', { n: k });
  }

  lose(reason = 'a rules effect') {
    this._snap();
    this.state.lost = true; this.state.lostReason = String(reason);
    this._log(`You lose the game: ${this.state.lostReason}.`);
    return { ok: true };
  }

  setRingBearer(uid) {
    const p = uid == null ? null : this._perm(uid);
    this._snap();
    this.state.ringBearer = p ? p.uid : null;
    this._log(p ? `${p.name} is your Ring-bearer.` : 'You have no Ring-bearer.');
    return { ok: true };
  }

  // Emblems: player-level objects whose statics/triggers rules.js runs (state.emblems).
  addEmblem(name, script) {
    this._snap();
    const e = { id: `em${this.state.uid++}`, name, script: JSON.parse(JSON.stringify(script || {})) };
    this.state.emblems.push(e);
    this._log(`You get an emblem: ${name}.`);
    return { ok: true, id: e.id };
  }

  // Layers set by rules effects. until 'eot' lives in perm.eot (cleared at cleanup).
  setLayer(uid, key, value, { eot = false } = {}) {
    const perm = this._perm(uid);
    if (!perm) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    if (eot) (perm.eot || (perm.eot = { p: 0, t: 0, kw: [] }))[key] = value;
    else if (value == null || value === false) delete perm[key];
    else perm[key] = value;
    const what = { stripped: 'loses all abilities', copyOf: `becomes a copy of ${value}` }[key] || `${key} changed`;
    this._log(`${perm.name} ${what}${eot ? ' until end of turn' : ''}.`);
    return { ok: true };
  }
  addSubtype(uid, subtype) {
    const perm = this._perm(uid);
    if (!perm) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    perm.addTypes = [...new Set([...(perm.addTypes || []), subtype])];
    this._log(`${perm.name} is also a ${subtype}.`);
    return { ok: true };
  }

  // Hideaway: a library card exiled face down under a permanent (perm.hidden = [uids]).
  hideaway(permUid, cardUid) {
    const perm = this._perm(permUid), f = this._find(cardUid, 'lib');
    if (!f) return { ok: false, reason: 'not in library' };
    this._snap();
    this.state.zones.lib.splice(f.index, 1);
    this.state.zones.ex.push(f.entry);
    if (perm) perm.hidden = [...(perm.hidden || []), cardUid];
    this._log(`Exiled a card face down${perm ? ` with ${perm.name}` : ''}.`);
    return { ok: true };
  }

  // Foretell: exile a card from hand face down; it can be cast later for its foretell cost (rules.js).
  foretell(uid) {
    const f = this._find(uid, 'hand');
    if (!f) return { ok: false, reason: 'not in hand' };
    this._snap();
    this.state.zones.hand.splice(f.index, 1);
    this.state.zones.ex.push(f.entry);
    this.state.foretold[uid] = this.state.turn;
    this._log('Foretold a card (exiled face down).');
    return { ok: true };
  }

  addExtraCombat(n = 1) { this._snap(); this.state.extraCombats = (this.state.extraCombats || 0) + n; this._log(`${n} additional combat phase${n === 1 ? '' : 's'} after this one.`); return { ok: true }; }
  addExtraTurn(n = 1) { this._snap(); this.state.extraTurns = (this.state.extraTurns || 0) + n; this._log(`Take ${n} extra turn${n === 1 ? '' : 's'} after this one.`); return { ok: true }; }

  // A token that's a copy of a card by name (a spell on the stack, a card in a graveyard...).
  createCopyToken(name, n = 1) {
    this._snap();
    let first = null;
    for (let i = 0; i < Math.max(1, n | 0); i++) {
      const q = this._newPerm(name, { copy: true });
      q.tok = true; q.n = 1;
      this.state.zones.bf.push(q);
      if (!first) first = q;
      this._log(`Created a token copy of ${name}.`);
      this._emit('enters', { perm: q, from: 'copy' });
    }
    return { ok: true, uid: first && first.uid };
  }

  // Move a library card to position `index` from the top (1 = top).
  libPlace(uid, index = 1) {
    const s = this.state, i = s.zones.lib.findIndex(c => c.uid === uid);
    if (i < 0) return { ok: false, reason: 'not in library' };
    this._snap();
    const [c] = s.zones.lib.splice(i, 1);
    const at = Math.max(0, Math.min(s.zones.lib.length, (index | 0) - 1));
    s.zones.lib.splice(at, 0, c);
    this._log(`Put ${c.name} ${at === 0 ? 'on top of' : `${at + 1}${['', 'st', 'nd', 'rd'][at + 1] || 'th'} from the top of`} the library.`);
    return { ok: true };
  }

  // Put library cards on the bottom in a random order (cascade, "the rest in a random order").
  bottomRandom(uids) {
    const s = this.state;
    const cards = uids.map(u => s.zones.lib.find(c => c.uid === u)).filter(Boolean);
    if (!cards.length) return { ok: true };
    this._snap();
    s.zones.lib = s.zones.lib.filter(c => !cards.includes(c));
    s.zones.lib.push(...this._shuffleArr(cards.slice()));
    this._log(`Put ${cards.length} card${cards.length === 1 ? '' : 's'} on the bottom in a random order.`);
    return { ok: true };
  }

  extraLand(n = 1) {
    const s = this.state;
    this._snap();
    s.landLimit = (s.landLimit || 1) + Math.max(0, n | 0);
    s.landPlayed = (s.landsPlayed || 0) >= s.landLimit;
    this._log(`You may play ${n} additional land${n === 1 ? '' : 's'} this turn.`);
    return { ok: true, landLimit: s.landLimit };
  }

  setMonarch(on = true) {
    this._snap();
    this.state.monarch = !!on;
    this._log(on ? 'You become the monarch.' : 'You are no longer the monarch.');
    return { ok: true };
  }

  ringTempt() {
    this._snap();
    const s = this.state;
    s.ringTempted = (s.ringTempted || 0) + 1;
    this._log(`The Ring tempts you (${s.ringTempted}).`);
    this._emit('tempted', { count: s.ringTempted });
    return { ok: true, count: s.ringTempted };
  }

  // Store a choice made "as ~ enters" on the permanent: perm.choices[key] = value.
  choose(uid, key, value) {
    const p = this._perm(uid);
    if (!p) return { ok: false, reason: 'not on battlefield' };
    this._snap();
    p.choices = { ...(p.choices || {}), [key]: value };
    this._log(`${p.name}: chose ${value}.`);
    return { ok: true };
  }

  discard(uid) {
    const f = this._find(uid, 'hand');
    if (!f) return { ok: false, reason: 'not in hand' };
    this._snap();
    this.state.zones.hand.splice(f.index, 1);
    this.state.zones.gy.push(f.entry);
    this._log(`Discarded ${f.entry.name}.`);
    this._emit('discarded', { card: { ...f.entry } });
    return { ok: true, handSize: this.state.zones.hand.length };
  }
}
