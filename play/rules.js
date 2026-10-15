// Rules layer — trigger matcher, effect interpreter and pending queue (RULES.md §3).
// The script language is documented exhaustively in scripts/SCHEMA.md; tools/validate_scripts.py checks it.
//
//   const rules = attachRules(game, bundle);   // bundle = { [cardName]: script }
//   rules.resolve(id, answer)  rules.explain(name)  rules.pendingTop()  rules.detach()
//   (extras) rules.activatable(uid)  rules.activate(uid, index, {force})  rules.run(cardName, effects, {src})
//            rules.refresh()  rules.scriptFor(name)
//
// Everything the queue needs lives in game.state.pending (plain JSON), so a reload mid-pending resumes.
// Rules never throws into the engine: a script step that cannot run degrades to a `prompt` pending.

import { cardOf, permCard, power, toughness, isCreature, isLand, hasKeyword, isCommander } from './engine.js';

const MAX_FRAMES = 200;   // triggers auto-run per cascade before the loop guard parks the rest
const MAX_STEPS = 500;    // effect steps per frame
const MAX_REPEAT = 50;
const MAX_PER_OBJECT = 20; // a token stack of n entering fires "whenever a creature enters" up to this many times
const NEED_X = { needX: true };

const STEP_EVENTS = { upkeep: ['upkeep'], drawStep: ['draw'], beginCombat: ['combat'], endStep: ['end'], beginMain: ['main1', 'main2'] };
const PER_OBJECT = new Set(['enters', 'leaves', 'dies', 'attacks', 'combatDamage', 'sacrificed']);
// Tokens with a well-known ability get a built-in script (they have no card in the bundle).
const BUILTIN_TOKENS = {
  clue: { name: 'Clue', status: 'hand', activated: [{ cost: { mana: '{2}', sacSelf: true }, do: [{ draw: 1 }], label: 'Crack', text: '{2}, Sacrifice this token: Draw a card.' }] },
  food: { name: 'Food', status: 'hand', activated: [{ cost: { mana: '{2}', tap: true, sacSelf: true }, do: [{ gainLife: 3 }], label: 'Eat', text: '{2}, {T}, Sacrifice this token: You gain 3 life.' }] },
};
const FILTER_BOOL_KEYS = ['creature', 'noncreature', 'land', 'nonland', 'token', 'nontoken', 'other', 'legendary', 'basic', 'tapped', 'untapped', 'attacking', 'equipped', 'enchanted', 'modified', 'attachedToThis', 'sharesTypeWithThis', 'isRingBearer'];
const CARD_TYPE_WORDS = ['artifact', 'enchantment', 'planeswalker', 'instant', 'sorcery', 'battle', 'kindred'];
// "count:creature,subtype=Elf,other" / "count:Elf" -> a filter object (null when it is not parseable)
export function parseCountFilter(str) {
  const f = {};
  for (const raw of String(str).split(',')) {
    const tok = raw.trim();
    if (!tok) return null;
    const m = tok.match(/^([A-Za-z]+)=(.+)$/);
    if (m) { const v = m[2]; f[m[1]] = /^-?\d+$/.test(v) ? +v : v === 'true' ? true : v === 'false' ? false : v; continue; }
    if (FILTER_BOOL_KEYS.includes(tok)) { f[tok] = true; continue; }
    if (CARD_TYPE_WORDS.includes(tok.toLowerCase())) { f.type = tok[0].toUpperCase() + tok.slice(1).toLowerCase(); continue; }
    if (/^[A-Z][A-Za-z'-]*$/.test(tok)) { f.subtype = tok; continue; }
    return null;
  }
  return f;
}
const OBJECT_EVENTS = new Set(['enters', 'leaves', 'dies', 'attacks', 'combatDamage', 'cast', 'resolved', 'landPlayed',
  'counters', 'tokenCreated', 'tapped', 'untapped']);
const COLOR_WORD = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
const typeLine = c => String((c && c.type_line) || '').split('//')[0];
const mainTypes = c => typeLine(c).split(/\s+[—-]\s+/)[0];
const subTypes = c => { const parts = typeLine(c).split(/\s+[—-]\s+/); return parts[1] || ''; };
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const wordIn = (hay, w) => new RegExp(`(^|[^A-Za-z])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i').test(hay);
const plural = (n, one, many) => (n === 1 ? one : many || one + 's');
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Keyword sugar and split/adventure/aftermath faces become ordinary activated abilities with a `zone`.
const SUGAR_KEYS = ['flashback', 'dredge', 'retrace', 'encore', 'cycling', 'typecycling', 'channel', 'foretell', 'faces'];
export function expandScript(sc) {
  if (!sc || typeof sc !== 'object' || !SUGAR_KEYS.some(k => sc[k] != null)) return sc;
  const out = { ...sc, activated: [...(sc.activated || [])] };
  const A = ab => out.activated.push(ab);
  if (sc.cycling) A({ zone: 'hand', cost: { mana: sc.cycling, discardSelf: true }, do: [{ draw: 1 }], label: 'Cycling', _cycling: true, text: `Cycling ${sc.cycling}` });
  if (sc.typecycling) A({ zone: 'hand', cost: { mana: sc.typecycling.cost, discardSelf: true }, do: [{ tutor: { filter: sc.typecycling.filter || {}, to: 'hand' } }], label: 'Typecycling', _cycling: true, text: `Typecycling ${sc.typecycling.cost}` });
  if (sc.channel) A({ zone: 'hand', cost: { mana: sc.channel.cost, discardSelf: true }, do: sc.channel.do, label: 'Channel', text: `Channel — ${sc.channel.cost}, discard this card` });
  if (sc.flashback) A({ zone: 'gy', cost: { mana: sc.flashback }, do: [{ $castSelf: { exileAfter: true } }], label: 'Flashback', _castTiming: true, text: `Flashback ${sc.flashback}` });
  if (sc.retrace) A({ zone: 'gy', cost: { discard: { filter: { land: true }, n: 1 } }, do: [{ $castSelf: { pay: true } }], label: 'Retrace', _castTiming: true, text: 'Retrace (cast it from your graveyard by discarding a land in addition to its other costs)' });
  if (sc.encore) A({ zone: 'gy', cost: { mana: sc.encore, exileSelf: true }, limit: 'sorcery-speed', do: [{ $encore: {} }], label: 'Encore', text: `Encore ${sc.encore}` });
  if (sc.dredge) A({ zone: 'gy', cost: {}, do: [{ mill: sc.dredge }, { moveSelf: { to: 'hand' } }], label: `Dredge ${sc.dredge}`, text: `Dredge ${sc.dredge} (use it instead of a draw)` });
  if (sc.foretell) {
    A({ zone: 'hand', cost: { mana: '{2}' }, do: [{ $foretellSelf: {} }], label: 'Foretell', text: 'Foretell — {2}: exile this card face down' });
    A({ zone: 'exile', cost: { mana: sc.foretell }, do: [{ $castSelf: {} }], label: 'Cast foretold', _foretold: true, _castTiming: true, text: `Cast it for its foretell cost ${sc.foretell}` });
  }
  for (const [face, f] of Object.entries(sc.faces || {})) {
    const kind = f.kind || 'split';
    A({ zone: kind === 'aftermath' ? 'gy' : 'hand', cost: { mana: f.cost }, do: [{ $castFace: { face } }], label: `Cast ${face}`, _castTiming: f.type || 'Sorcery', _face: face, text: f.text || `${face} ${f.cost}` });
  }
  return out;
}

export function attachRules(game, bundle = {}) {
  const scripts = {};
  for (const [k, v] of Object.entries(bundle || {})) if (!k.startsWith('_') && v && typeof v === 'object') scripts[k] = expandScript(v);
  const tokenScripts = {};
  for (const [k, v] of Object.entries((bundle && bundle._tokens) || {})) if (v && typeof v === 'object') tokenScripts[k] = expandScript(v);
  let processing = false;
  let attached = true;
  let cascade = 0; // trigger frames run since the last player action (loop guard)

  const S = () => game.state;
  const bf = () => S().zones.bf;
  const onBf = uid => bf().find(p => p.uid === uid) || null;
  const scriptFor = name => scripts[name] || null;
  // token scripts: bundle._tokens, then a bundle key, then any script whose name matches
  const tokenScriptCache = {};
  function tokenScript(name) {
    if (!name) return null;
    if (name in tokenScriptCache) return tokenScriptCache[name];
    let sc = tokenScripts[name] || scripts[name] || null;
    if (!sc) for (const v of Object.values(scripts)) if (v && v.name === name) { sc = v; break; }
    return (tokenScriptCache[name] = sc);
  }
  // the script that governs a permanent right now: stripped -> none; becomeCopy -> the copied card's;
  // a scripted token -> its token script; transformed -> the script's `back` (triggers/statics/activated/replace)
  function scriptOfPerm(p) {
    if (!p || p.stripped || (p.eot && p.eot.stripped)) return null;
    const copyOf = (p.eot && p.eot.copyOf) || p.copyOf;
    let sc;
    if (copyOf) sc = scriptFor(copyOf);
    else if (p.tok && !p.copy) sc = (p.tokScript && tokenScript(p.tokScript)) || tokenScript(p.name) || tokenScript(`${p.name} Token`) || BUILTIN_TOKENS[String(p.name).toLowerCase()] || null;
    else sc = scriptFor(p.name);
    if (sc && p.flip && sc.back) sc = { ...sc, statics: [], triggers: [], activated: [], replace: [], ...sc.back };
    return sc;
  }
  const pendingList = () => (Array.isArray(S().pending) ? S().pending : (S().pending = []));

  /* ================= object helpers ================= */
  const zoneTriggerNames = new Set(Object.values(scripts).filter(sc => (sc.triggers || []).some(t => t && t.zone && t.zone !== 'bf')).map(sc => sc.name));
  const cardFor = entry => (entry && (entry.tok || entry.counters) ? permCard(game, entry) : cardOf(game, entry && entry.name));
  const isPerm = entry => !!(entry && entry.counters);
  const creatureP = p => isCreature(permCard(game, p));
  const stackN = p => (p.tok ? p.n || 1 : 1);

  // "$chosen" (any "$key") in a filter value reads the source permanent's choices (chooseOn / choose).
  function resolveRefs(f, ctx) {
    let out = f;
    for (const [k, v] of Object.entries(f)) {
      const vals = list(v);
      if (!vals.some(x => typeof x === 'string' && x.startsWith('$'))) continue;
      const src = ctx && ctx.src != null ? onBf(ctx.src) : null;
      const choices = (src && src.choices) || (ctx && ctx.choices) || {};
      const mapped = vals.map(x => (typeof x === 'string' && x.startsWith('$') ? choices[x.slice(1)] : x));
      if (mapped.some(x => x == null)) return null;
      if (out === f) out = { ...f };
      out[k] = Array.isArray(v) || k === 'colors' ? mapped : mapped[0];
    }
    return out;
  }
  const xv = (v, ctx) => (v === 'X' ? Math.max(0, (ctx && ctx.x) | 0) : v);
  // "$chosen" (any "$key") in a verb argument: the source permanent's stored choice (chooseOn / choose)
  function refStr(v, ctx) {
    if (typeof v !== 'string' || !v.startsWith('$')) return v;
    const src = ctx && ctx.src != null ? onBf(ctx.src) : null;
    const choices = (src && src.choices) || (ctx && ctx.choices) || {};
    return choices[v.slice(1)] ?? null;
  }
  const refList = (l, ctx) => (l || []).map(x => refStr(x, ctx)).filter(x => x != null);
  function matchFilter(entry, f, ctx) {
    if (!f) return true;
    f = resolveRefs(f, ctx);
    if (!f) return false;
    const card = cardFor(entry);
    if (!card) return false;
    const creature = isCreature(card), land = isLand(card), perm = isPerm(entry);
    for (const [k, v] of Object.entries(f)) {
      switch (k) {
        case 'creature': if (creature !== v) return false; break;
        case 'noncreature': if (creature === v) return false; break;
        case 'land': if (land !== v) return false; break;
        case 'nonland': if (land === v) return false; break;
        case 'token': if (!!entry.tok !== v) return false; break;
        case 'nontoken': if (!!entry.tok === v) return false; break;
        case 'other': if (v && ctx && ctx.src != null && entry.uid === ctx.src) return false; break;
        case 'legendary': if (/\bLegendary\b/.test(typeLine(card)) !== v) return false; break;
        case 'basic': if (/\bBasic\b/.test(typeLine(card)) !== v) return false; break;
        case 'tapped': if (!!entry.tapped !== v) return false; break;
        case 'untapped': if (!entry.tapped !== v) return false; break;
        case 'attacking': if (!!entry.attacking !== v) return false; break;
        case 'type': if (!list(v).some(t => wordIn(mainTypes(card), t))) return false; break;
        case 'subtype': if (!list(v).some(t => wordIn(subTypes(card), t) || (entry.tok && wordIn(entry.name, t)))) return false; break;
        case 'name': if (!list(v).includes(entry.name)) return false; break;
        case 'controller': if (v !== 'you') return false; break;
        case 'colors': if (!list(v).some(c => (card.colors || []).includes(c))) return false; break;
        case 'keyword': if (!hasKeyword(card, v)) return false; break;
        case 'powerGe': if ((perm ? power(game, entry) : num(card.power)) < v) return false; break;
        case 'powerLe': if ((perm ? power(game, entry) : num(card.power)) > v) return false; break;
        case 'toughnessGe': if ((perm ? toughness(game, entry) : num(card.toughness)) < v) return false; break;
        case 'cmcGe': case 'mvGe': if ((card.cmc || 0) < xv(v, ctx)) return false; break;
        case 'cmcLe': case 'mvLe': if ((card.cmc || 0) > xv(v, ctx)) return false; break;
        case 'mvLt': if ((card.cmc || 0) >= xv(v, ctx)) return false; break;
        case 'castFrom': if (!list(v).includes(entry.castFrom)) return false; break;
        case 'isRingBearer': if ((S().ringBearer != null && S().ringBearer === entry.uid) !== v) return false; break;
        case 'not': if (matchFilter(entry, v, ctx)) return false; break;
        case 'withoutKw': if (list(v).some(k => hasKeyword(card, k))) return false; break;
        case 'equipped': if (attachmentsOf(entry, 'Equipment').length > 0 !== v) return false; break;
        case 'enchanted': if (attachmentsOf(entry, 'Aura').length > 0 !== v) return false; break;
        case 'modified': {
          const m = Object.values(entry.counters || {}).some(n => n > 0) || attachmentsOf(entry, 'Equipment').length > 0 || attachmentsOf(entry, 'Aura').length > 0;
          if (m !== v) return false; break;
        }
        case 'attachedToThis': {
          const src = ctx && ctx.src != null ? onBf(ctx.src) : null;
          const host = src ? src.attachedTo : ctx && ctx.attachedTo;
          if ((host != null && host === entry.uid) !== v) return false; break;
        }
        case 'sharesTypeWithThis': if (sharesType(entry, ctx) !== v) return false; break;
        case 'counters': { const k = (v && v.kind) || 'p1p1'; if (((entry.counters || {})[k] || 0) < ((v && v.ge) ?? 1)) return false; break; }
        case 'noCounters': {
          const cs = entry.counters || {};
          const has = v && v.kind ? (cs[v.kind] || 0) > 0 : Object.values(cs).some(n => n > 0);
          if (has) return false; break;
        }
        default: break; // event-level keys (kind / who / gain / lose / countGe) are checked by their callers
      }
    }
    return true;
  }
  // creature types shared with the source ("this"); Changeling has every type
  function creatureTypes(entry) {
    const card = cardFor(entry);
    if (!card || !isCreature(card)) return null;
    if (hasKeyword(card, 'Changeling')) return '*';
    return subTypes(card).split(/\s+/).filter(Boolean);
  }
  function sharesType(entry, ctx) {
    const src = ctx && ctx.src != null ? onBf(ctx.src) : null;
    if (!src || src.uid === entry.uid) return false;
    const a = creatureTypes(src), b = creatureTypes(entry);
    if (!a || !b) return false;
    if (a === '*' || b === '*') return a.length !== 0 && b.length !== 0;
    return a.some(t => b.includes(t));
  }
  function attachmentsOf(entry, sub) {
    if (!isPerm(entry)) return [];
    return bf().filter(q => q.attachedTo === entry.uid && wordIn(subTypes(permCard(game, q)), sub));
  }
  // "This turn" facts kept by the engine in state.turnStats
  function thisTurn(fact, filter, ctx) {
    const ts = S().turnStats || {};
    switch (fact) {
      case 'lifeGained': return ts.lifeGained || 0;
      case 'lifeLost': return ts.lifeLost || 0;
      case 'tokensCreated': return ts.tokensCreated || 0;
      case 'damageToOpp': return ts.damageToOpp || 0;
      case 'landsPlayed': return S().landsPlayed || 0;
      case 'manaSpent': return ts.manaSpent || 0;
      case 'treasureManaSpent': return ts.treasureManaSpent || 0;
      case 'entered': return (ts.entered || []).filter(e => matchFilter(e, filter, ctx)).reduce((t, e) => t + (e.n || 1), 0);
      case 'sacrificed': return (ts.sacrificed || []).filter(e => matchFilter(e, filter, ctx)).reduce((t, e) => t + (e.n || 1), 0);
      case 'died': return (ts.died || []).filter(e => matchFilter(e, filter, ctx)).reduce((t, e) => t + (e.n || 1), 0);
      case 'spellsCast': return (ts.spellsCast || []).filter(e => matchFilter({ uid: e.uid, name: e.name }, filter, ctx)).length;
      default: return 0;
    }
  }
  // stats of a card that isn't on the battlefield
  function cardInfo(c) {
    const card = cardOf(game, c.name);
    return { name: c.name, power: num(card.power), toughness: num(card.toughness), mv: card.cmc || 0, counters: {}, n: 1 };
  }
  // last-known information of a permanent, for amounts after it left
  function lki(p) {
    if (!p) return null;
    return { name: p.name, power: Math.max(0, power(game, p)), toughness: Math.max(0, toughness(game, p)), mv: permCard(game, p).cmc || 0, counters: { ...(p.counters || {}) }, n: p.tok ? p.n || 1 : 1 };
  }
  const countPerms = (pred) => bf().reduce((t, p) => t + (pred(p) ? stackN(p) : 0), 0);
  const countFilter = (f, ctx) => countPerms(p => matchFilter(p, f, ctx));

  function namedCount(name, ctx) {
    const s = S(), src = ctx && ctx.src != null ? onBf(ctx.src) : null;
    const creatures = bf().filter(creatureP);
    switch (name) {
      case 'creatures-you-control': return countPerms(creatureP);
      case 'other-creatures-you-control': return countPerms(p => creatureP(p) && p.uid !== (ctx && ctx.src));
      case 'lands-you-control': return countPerms(p => isLand(permCard(game, p)));
      case 'artifacts-you-control': return countPerms(p => /\bArtifact\b/.test(mainTypes(permCard(game, p))));
      case 'enchantments-you-control': return countPerms(p => /\bEnchantment\b/.test(mainTypes(permCard(game, p))));
      case 'permanents-you-control': return countPerms(() => true);
      case 'tokens-you-control': return countPerms(p => p.tok);
      case 'attacking-creatures': return countPerms(p => p.attacking);
      case 'cards-in-hand': return s.zones.hand.length;
      case 'cards-in-graveyard': case 'cards-in-gy': return s.zones.gy.length;
      case 'creature-cards-in-graveyard': return s.zones.gy.filter(c => isCreature(cardOf(game, c.name))).length;
      case 'land-cards-in-graveyard': return s.zones.gy.filter(c => isLand(cardOf(game, c.name))).length;
      case 'counters-on-self': return src ? (src.counters.p1p1 || 0) : 0;
      case 'power-of-self': return src ? Math.max(0, power(game, src)) : 0;
      case 'toughness-of-self': return src ? Math.max(0, toughness(game, src)) : 0;
      case 'counters-on-triggering': {
        const t = ctx && ctx.trig != null ? onBf(ctx.trig) : null;
        return t ? (t.counters.p1p1 || 0) : ((ctx && ctx.trigInfo && ctx.trigInfo.counters.p1p1) || 0);
      }
      case 'power-of-triggering': {
        const t = ctx && ctx.trig != null ? onBf(ctx.trig) : null;
        return t ? Math.max(0, power(game, t)) : Math.max(0, (ctx && ctx.trigPower) || 0);
      }
      case 'greatest-power': return creatures.reduce((m, p) => Math.max(m, power(game, p)), 0);
      case 'total-power': return creatures.reduce((t, p) => t + Math.max(0, power(game, p)) * stackN(p), 0);
      case 'event-amount': return Math.max(0, (ctx && ctx.amount) || 0);
      case 'life': return s.life;
      case 'opponents': return 1;
      case 'creatures-sharing-type-with-this': return countPerms(p => creatureP(p) && p.uid !== (ctx && ctx.src) && sharesType(p, ctx));
      case 'colors-among-permanents-you-control': {
        const cs = new Set();
        for (const p of bf()) for (const c of permCard(game, p).colors || []) cs.add(c);
        return cs.size;
      }
      case 'types-in-gy': {
        const ts = new Set();
        for (const c of s.zones.gy) for (const t of ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery']) if (wordIn(mainTypes(cardOf(game, c.name)), t)) ts.add(t);
        return ts.size;
      }
      default: {
        if (name.startsWith('gy:')) { const f = parseCountFilter(name.slice(3)); return f ? s.zones.gy.filter(c => matchFilter(c, f, ctx)).length : 0; }
        const f = parseCountFilter(name); return f ? countFilter(f, ctx) : 0;
      }
    }
  }

  // {of: triggering|this|target, stat: power|toughness|mv|counters.<kind>}
  function objStat(of, stat, ctx) {
    ctx = ctx || {};
    if (of === 'lastCount') return ctx.lastCount || 0;
    if (of === 'chosen') return Math.max(0, +ctx.chosen || 0);
    if (of === 'you') return String(stat).startsWith('counters.') ? ((S().counters || {})[String(stat).slice(9)] || 0) : stat === 'life' ? S().life : 0;
    const fromInfo = info => {
      if (!info) return 0;
      if (String(stat).startsWith('counters.')) return info.counters[String(stat).slice(9)] || 0;
      return info[stat] || 0;
    };
    if (of === 'lastDied') return fromInfo(ctx.lastDied);
    if (of === 'lastExiled') return fromInfo(ctx.lastExiled);
    if (of === 'hidden') {
      const src = ctx.src != null ? onBf(ctx.src) : null;
      const h = src && (src.hidden || [])[0];
      const c = h != null ? S().zones.ex.find(x => x.uid === h) : null;
      return c ? fromInfo(cardInfo(c)) : 0;
    }
    if (of === 'triggering' && ctx.trig != null && !onBf(ctx.trig) && ctx.trigInfo) return fromInfo(ctx.trigInfo);
    if (of === 'target' && ctx.lastTarget != null && !onBf(ctx.lastTarget) && ctx.lastTargetInfo) return fromInfo(ctx.lastTargetInfo);
    const uid = of === 'triggering' ? ctx.trig : of === 'this' ? ctx.src : ctx.lastTarget;
    const perm = uid != null ? onBf(uid) : null;
    const name = perm ? perm.name : of === 'triggering' ? ctx.trigName : of === 'this' ? ctx.card : null;
    if (stat === 'power') return perm ? Math.max(0, power(game, perm)) : of === 'triggering' ? Math.max(0, ctx.trigPower || 0) : 0;
    if (stat === 'toughness') return perm ? Math.max(0, toughness(game, perm)) : of === 'triggering' ? Math.max(0, ctx.trigToughness || 0) : 0;
    if (stat === 'mv') return name ? (perm ? permCard(game, perm) : cardOf(game, name)).cmc || 0 : 0;
    if (String(stat).startsWith('counters.')) return perm ? (perm.counters[String(stat).slice(9)] || 0) : 0;
    return 0;
  }
  function greatest(stat) {
    const cs = bf().filter(creatureP);
    return cs.reduce((m, p) => Math.max(m, stat === 'power' ? power(game, p) : stat === 'toughness' ? toughness(game, p) : permCard(game, p).cmc || 0), 0);
  }

  // Count -> number. "X" with no known X throws NEED_X (the frame turns it into an `x` pending).
  function evalCount(c, ctx, { xDefault } = {}) {
    if (typeof c === 'number') return c;
    if (c == null) return 0;
    if (typeof c === 'string' && c.startsWith('-')) return -evalCount(c.slice(1), ctx, { xDefault });
    if (typeof c === 'object' && c.neg != null) return -evalCount(c.neg, ctx, { xDefault });
    if (typeof c === 'object' && c.thisTurn) return thisTurn(c.thisTurn, c.filter, ctx);
    if (c === 'X') {
      if (ctx && ctx.x != null) return Math.max(0, ctx.x | 0);
      if (xDefault != null) return xDefault;
      throw NEED_X;
    }
    if (typeof c === 'string' && c.startsWith('count:')) return namedCount(c.slice(6), ctx);
    if (typeof c === 'string' && c.startsWith('greatest:')) return Math.max(0, greatest(c.slice(9).replace(/-you-control$/, '')));
    if (typeof c === 'object' && c.count) return countFilter(c.count, ctx);
    if (typeof c === 'object' && c.of) return objStat(c.of, c.stat, ctx);
    return 0;
  }

  function evalIf(pr, ctx) {
    if (!pr) return true;
    const s = S();
    for (const [k, v] of Object.entries(pr)) {
      switch (k) {
        case 'youControl': {
          const { countGe, ...f } = v || {};
          const need = countGe ?? pr.countGe ?? 1;
          if (countFilter(f, ctx) < need) return false;
          break;
        }
        case 'countGe': break; // read with youControl
        case 'lifeGe': if (s.life < v) return false; break;
        case 'lifeLe': if (s.life > v) return false; break;
        case 'oppLifeLe': if (s.opp.life > v) return false; break;
        case 'handLe': if (s.zones.hand.length > v) return false; break;
        case 'handGe': if (s.zones.hand.length < v) return false; break;
        case 'landsGe': if (namedCount('lands-you-control', ctx) < v) return false; break;
        case 'gyGe': if (s.zones.gy.length < v) return false; break;
        case 'turnGe': if (s.turn < v) return false; break;
        case 'attackedThisTurn': if (!!s.attackedThisTurn !== v) return false; break;
        case 'isYourTurn': if (v !== true) return false; break;
        case 'totalPowerGe': if (namedCount('total-power', ctx) < v) return false; break;
        case 'tokensGe': if (namedCount('tokens-you-control', ctx) < v) return false; break;
        case 'isMonarch': if (!!s.monarch !== v) return false; break;
        case 'counters': case 'noCounters': { // about the source permanent
          const src = ctx && ctx.src != null ? onBf(ctx.src) : null;
          if (!src || !matchFilter(src, { [k]: v }, ctx)) return false; break;
        }
        case 'commanderOnBf': if (bf().some(p => !p.tok && !p.copy && isCommander(game, p.name)) !== v) return false; break;
        case 'youHaveCounters': if (((s.counters || {})[(v && v.kind) || 'experience'] || 0) < ((v && v.ge) ?? 1)) return false; break;
        case 'thisTurn': {
          const n = thisTurn(v.fact, v.filter, ctx);
          if (v.ge != null && n < v.ge) return false;
          if (v.le != null && n > v.le) return false;
          if (v.eq != null && n !== v.eq) return false;
          if (v.ge == null && v.le == null && v.eq == null && n < 1) return false;
          break;
        }
        case 'not': if (evalIf(v, ctx)) return false; break;
        case 'any': if (!list(v).some(x => evalIf(x, ctx))) return false; break;
        case 'all': if (!list(v).every(x => evalIf(x, ctx))) return false; break;
        default: return false; // unknown predicate: be conservative
      }
    }
    return true;
  }

  /* ================= statics ================= */
  const PERM_SCOPES = {
    'self': (p, src) => p.uid === src.uid,
    'creatures-you-control': p => creatureP(p),
    'other-creatures-you-control': (p, src) => creatureP(p) && p.uid !== src.uid,
    'permanents-you-control': () => true,
    'lands-you-control': p => isLand(permCard(game, p)),
    'artifacts-you-control': p => /\bArtifact\b/.test(mainTypes(permCard(game, p))),
    'tokens-you-control': p => !!p.tok,
    'commander': p => !p.tok && !p.copy && isCommander(game, p.name),
    'attached': (p, src) => src.attachedTo === p.uid,
  };

  function recomputeStatics() {
    const s = S();
    if (!s || !s.zones) return;
    for (let pass = 0; pass < 2; pass++) {
      const acc = new Map();
      const costLess = {};
      const add = (p, d, from) => {
        let m = acc.get(p.uid);
        if (!m) acc.set(p.uid, (m = { p: 0, t: 0, kw: [], costLess: 0, from: [] }));
        m.p += d.p || 0; m.t += d.t || 0;
        for (const k of d.kw || []) if (!m.kw.includes(k)) m.kw.push(k);
        if (d.noUntap) m.noUntap = true;
        if (d.animated) m.animated = d.animated;
        if (!m.from.includes(from)) m.from.push(from);
      };
      const manaFx = { any: false, extra: [] };
      const spellCards = [...s.zones.hand, ...s.zones.cz];
      const names = [...new Set(spellCards.map(c => c.name))];
      // static sources: battlefield permanents, graveyard cards with zone:"gy" statics, emblems
      const sources = [];
      for (const p of bf()) { const sc = scriptOfPerm(p); if (sc && Array.isArray(sc.statics)) sources.push([p, sc.statics.filter(st => st && (st.zone || 'bf') === 'bf')]); }
      for (const c of s.zones.gy) { const sc = scriptFor(c.name); if (sc && Array.isArray(sc.statics)) { const z = sc.statics.filter(st => st && st.zone === 'gy'); if (z.length) sources.push([c, z]); } }
      for (const em of s.emblems || []) if (em.script && Array.isArray(em.script.statics)) sources.push([{ uid: -1, name: em.name }, em.script.statics]);
      const bearer = s.ringBearer != null ? onBf(s.ringBearer) : null;
      if (bearer) add(bearer, { kw: ['Ring-bearer'] }, 'The Ring');
      for (const [src, statics] of sources) {
        const ctx = { src: src.uid, card: src.name };
        for (const st of statics) {
          if (st && st.anthemPer && (!st.if || evalIf(st.if, ctx))) {
            // the amount is evaluated per affected creature, with "this" bound to that creature (Coat of Arms)
            const ap = st.anthemPer, inScope = PERM_SCOPES[ap.scope || 'creatures-you-control'];
            try {
              for (const p of bf()) {
                if (!inScope || !inScope(p, src) || !matchFilter(p, ap.filter, ctx)) continue;
                const pctx = { src: p.uid, card: p.name, anthemSrc: src.uid };
                add(p, { p: ap.p != null ? evalCount(ap.p, pctx, { xDefault: 0 }) : 0, t: ap.t != null ? evalCount(ap.t, pctx, { xDefault: 0 }) : 0 }, src.name);
              }
            } catch (e) { /* skip */ }
            continue;
          }
          if (st && (st.landsProduceAny || st.landsAlsoProduce || st.landsAreSwamps) && (!st.if || evalIf(st.if, ctx))) {
            if (st.landsProduceAny) manaFx.any = true;
            for (const c of st.landsAlsoProduce || []) if (!manaFx.extra.includes(c)) manaFx.extra.push(c);
            if (st.landsAreSwamps && !manaFx.extra.includes('B')) manaFx.extra.push('B');
            continue;
          }
          if (!st || st.prompt || !st.scope) continue;
          try {
            if (st.if && !evalIf(st.if, ctx)) continue;
            if (st.scope === 'spells-you-cast') {
              const n = evalCount(st.costLess, ctx, { xDefault: 0 });
              for (const nm of names) if (matchFilter({ name: nm }, st.filter, ctx)) costLess[nm] = (costLess[nm] || 0) + n;
              continue;
            }
            const inScope = PERM_SCOPES[st.scope];
            if (!inScope) continue;
            const d = { p: st.p != null ? evalCount(st.p, ctx, { xDefault: 0 }) : 0, t: st.t != null ? evalCount(st.t, ctx, { xDefault: 0 }) : 0, kw: st.kw || [], noUntap: !!st.noUntap,
              animated: st.animate ? { p: evalCount(st.animate.p ?? 0, ctx, { xDefault: 0 }), t: evalCount(st.animate.t ?? 0, ctx, { xDefault: 0 }), kw: st.animate.kw || [], types: st.animate.types || ['Creature'], subtypes: st.animate.subtypes || [] } : null };
            for (const p of bf()) if (inScope(p, src) && matchFilter(p, st.filter, ctx)) add(p, d, src.name);
          } catch (e) { /* a bad static is skipped, never fatal */ }
        }
      }
      for (const nm of names) {
        const sc = scriptFor(nm);
        if (!sc || !Array.isArray(sc.statics)) continue;
        for (const st of sc.statics) {
          if (!st || st.scope !== 'this-spell') continue;
          try {
            const ctx = { src: null, card: nm };
            if (st.if && !evalIf(st.if, ctx)) continue;
            costLess[nm] = (costLess[nm] || 0) + evalCount(st.costLess, ctx, { xDefault: 0 });
          } catch (e) { /* skip */ }
        }
      }
      let changed = false;
      for (const p of bf()) {
        const m = acc.get(p.uid);
        const before = JSON.stringify(p.mod || null);
        const empty = !m || (!m.p && !m.t && !m.kw.length && !m.noUntap && !m.animated);
        const after = empty ? 'null' : JSON.stringify({ p: m.p, t: m.t, kw: m.kw, costLess: 0, ...(m.noUntap ? { noUntap: true } : {}), ...(m.animated ? { animated: m.animated } : {}), from: m.from });
        if (before !== after) { changed = true; game.modify(p.uid, empty ? null : m, { quiet: true }); }
      }
      const fx = manaFx.any || manaFx.extra.length ? manaFx : null;
      if (JSON.stringify(s.manaFx || null) !== JSON.stringify(fx)) s.manaFx = fx;
      for (const k of Object.keys(costLess)) if (!costLess[k]) delete costLess[k];
      if (JSON.stringify(s.costLess || {}) !== JSON.stringify(costLess)) s.costLess = costLess;
      if (!changed) break; // a second pass only when a bonus may feed another static's filter
    }
  }

  /* ================= describing (explain + pending text) ================= */
  function dFilter(f, { many = false, noun = null } = {}) {
    f = f || {};
    const adj = [];
    if (f.other) adj.push(many ? 'other' : 'another');
    if (f.tapped) adj.push('tapped');
    if (f.untapped) adj.push('untapped');
    if (f.attacking) adj.push('attacking');
    if (f.legendary) adj.push('legendary');
    if (f.basic) adj.push('basic');
    if (f.nontoken) adj.push('nontoken');
    if (f.colors) adj.push(list(f.colors).map(c => COLOR_WORD[c] || c).join(' or '));
    if (f.noncreature) adj.push('noncreature');
    if (f.nonland) adj.push('nonland');
    let n = noun;
    const sub = f.subtype ? list(f.subtype).join(' or ') : '';
    if (!n) {
      if (f.creature || f.subtype) n = f.creature === false ? 'noncreature permanent' : 'creature';
      else if (f.land) n = 'land';
      else if (f.type) n = list(f.type).map(t => t.toLowerCase()).join(' or ');
      else n = 'permanent';
      if (f.creature === false) n = 'noncreature permanent';
      if (f.land === false && !f.creature) n = 'nonland permanent';
    }
    if (sub) n = sub + (n === 'creature' ? '' : ' ' + n);
    n = n.trim();
    if (f.token) n += ' token';
    if (many) n = pluralNoun(n);
    const post = [];
    if (f.name) post.push(`named ${list(f.name).join(' or ')}`);
    if (f.powerGe != null) post.push(`with power ${f.powerGe} or greater`);
    if (f.powerLe != null) post.push(`with power ${f.powerLe} or less`);
    if (f.toughnessGe != null) post.push(`with toughness ${f.toughnessGe} or greater`);
    if (f.cmcGe != null) post.push(`with mana value ${f.cmcGe} or greater`);
    if (f.cmcLe != null) post.push(`with mana value ${f.cmcLe} or less`);
    if (f.keyword) post.push(`with ${String(f.keyword).toLowerCase()}`);
    if (f.controller === 'opp') post.push('an opponent controls');
    if (f.counters) post.push(`with ${f.counters.ge && f.counters.ge > 1 ? f.counters.ge + ' or more' : 'a'} ${f.counters.kind && f.counters.kind !== 'p1p1' ? f.counters.kind : '+1/+1'} counter${f.counters.ge > 1 ? 's' : ''} on it`);
    if (f.noCounters) post.push(`with no ${f.noCounters.kind ? (f.noCounters.kind === 'p1p1' ? '+1/+1 ' : f.noCounters.kind + ' ') : ''}counters on it`);
    if (f.withoutKw) post.push(`without ${list(f.withoutKw).join(' or ').toLowerCase()}`);
    if (f.not) post.push(`that isn't ${article(dFilter(f.not))}`);
    if (f.equipped) adj.unshift('equipped');
    if (f.enchanted) adj.unshift('enchanted');
    if (f.modified) adj.unshift('modified');
    if (f.attachedToThis) return 'the creature it is attached to';
    if (f.sharesTypeWithThis) post.push('that shares a creature type with it');
    return [...adj, n, ...post].filter(Boolean).join(' ');
  }
  const article = w => (/^(another|each|any)\b/.test(w) ? w : (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w);
  const IRREGULAR = { Elf: 'Elves', Dwarf: 'Dwarves', Wolf: 'Wolves', Werewolf: 'Werewolves', Mouse: 'Mice', Fish: 'Fish', Sheep: 'Sheep', Ox: 'Oxen', Thief: 'Thieves' };
  function pluralNoun(n) {
    // pluralise the head noun of "Elf Warrior" / "creature token" / "basic land": the last word that isn't a suffix
    const words = n.split(' ');
    let i = words.length - 1;
    if (words[i] === 'token' && i > 0) { words[i] = 'tokens'; return words.join(' '); }
    const w = words[i];
    words[i] = IRREGULAR[w] || (/s$/.test(w) ? w : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : /(ch|sh|x)$/.test(w) ? w + 'es' : w + 's');
    return words.join(' ');
  }

  const NAMED_COUNT_TEXT = {
    'creatures-you-control': 'the number of creatures you control',
    'other-creatures-you-control': 'the number of other creatures you control',
    'lands-you-control': 'the number of lands you control',
    'artifacts-you-control': 'the number of artifacts you control',
    'enchantments-you-control': 'the number of enchantments you control',
    'permanents-you-control': 'the number of permanents you control',
    'tokens-you-control': 'the number of tokens you control',
    'attacking-creatures': 'the number of attacking creatures',
    'cards-in-hand': 'the number of cards in your hand',
    'cards-in-graveyard': 'the number of cards in your graveyard',
    'creature-cards-in-graveyard': 'the number of creature cards in your graveyard',
    'land-cards-in-graveyard': 'the number of land cards in your graveyard',
    'counters-on-self': 'the number of +1/+1 counters on it',
    'power-of-self': 'its power', 'toughness-of-self': 'its toughness',
    'power-of-triggering': "that creature's power",
    'greatest-power': 'the greatest power among creatures you control',
    'total-power': 'the total power of creatures you control',
    'event-amount': 'that much', 'creatures-sharing-type-with-this': 'the number of other creatures you control that share a creature type with it',
    'colors-among-permanents-you-control': 'the number of colours among permanents you control', 'counters-on-triggering': 'the number of +1/+1 counters on it', 'life': 'your life total', 'opponents': 'the number of opponents',
  };
  const OF_TEXT = { triggering: "that permanent's", this: 'its', target: "the target's" };
  const dCount = c => (typeof c === 'number' ? String(c) : c === 'X' ? 'X'
    : typeof c === 'string' && c.startsWith('count:') ? (NAMED_COUNT_TEXT[c.slice(6)] || (parseCountFilter(c.slice(6)) ? `the number of ${dFilter(parseCountFilter(c.slice(6)), { many: true })} you control` : c))
    : typeof c === 'string' && c.startsWith('greatest:') ? `the greatest ${c.slice(9).replace(/-you-control$/, '').replace('mv', 'mana value')} among creatures you control`
    : c && c.count ? `the number of ${dFilter(c.count, { many: true })} you control`
    : typeof c === 'string' && c.startsWith('-') ? `minus ${dCount(c.slice(1))}`
    : c && c.neg != null ? `minus ${dCount(c.neg)}`
    : c && c.thisTurn ? `the ${{ lifeGained: 'life you gained', lifeLost: 'life you lost', tokensCreated: 'number of tokens you created', damageToOpp: 'damage dealt to the opponent', landsPlayed: 'number of lands you played', entered: `number of ${c.filter ? dFilter(c.filter, { many: true }) : 'permanents'} that entered`, died: `number of ${c.filter ? dFilter(c.filter, { many: true }) : 'creatures'} that died`, spellsCast: 'number of spells you cast' }[c.thisTurn] || c.thisTurn} this turn`
    : c && c.of === 'lastCount' ? 'the number of cards affected this way'
    : c && c.of === 'chosen' ? 'the chosen number'
    : c && c.of === 'lastDied' ? `the ${c.stat === 'mv' ? 'mana value' : String(c.stat).replace('counters.', 'counters (') } of the creature that died`
    : c && c.of === 'you' ? `the number of ${String(c.stat).replace('counters.', '')} counters you have`
    : c && c.of ? `${OF_TEXT[c.of] || c.of} ${String(c.stat).startsWith('counters.') ? `number of ${c.stat.slice(9) === 'p1p1' ? '+1/+1' : c.stat.slice(9)} counters` : c.stat === 'mv' ? 'mana value' : c.stat}`
    : String(c));
  const isNum = c => typeof c === 'number';

  function dTarget(t, name) {
    if (t == null || t === 'self' || t === 'this') return name || 'this permanent';
    if (typeof t === 'string') return ({
      'triggering': 'that permanent', 'creature-you-control': 'target creature you control',
      'land-you-control': 'target land you control', 'any-you-control': 'target permanent you control',
      'each-creature-you-control': 'each creature you control', 'each-other-creature-you-control': 'each other creature you control',
      'each-land-you-control': 'each land you control', 'opponent': 'target permanent an opponent controls', 'commander': 'your commander',
    })[t] || t;
    if (t.$uids) return t.$uids.map(u => (onBf(u) || {}).name || 'it').join(', ') || 'nothing';
    if (t.pick) {
      const n = t.n || 1;
      return `${t.optional ? 'up to ' : ''}${n === 1 ? 'target' : n + ' target'} ${dFilter(t.pick, { many: n > 1 })}${t.pick.controller ? '' : ' you control'}`;
    }
    if (t.each) return `each ${dFilter(t.each)} you control`;
    if (t === 'any') return 'any target';
    if (t === 'you') return 'you';
    return JSON.stringify(t);
  }

  function dIf(pr) {
    const parts = [];
    for (const [k, v] of Object.entries(pr || {})) {
      switch (k) {
        case 'youControl': {
          const { countGe, ...f } = v || {};
          const n = countGe ?? pr.countGe ?? 1;
          parts.push(n <= 1 ? `you control ${article(dFilter(f))}` : `you control ${n} or more ${dFilter(f, { many: true })}`);
          break;
        }
        case 'countGe': break;
        case 'lifeGe': parts.push(`you have ${v} or more life`); break;
        case 'lifeLe': parts.push(`you have ${v} or less life`); break;
        case 'oppLifeLe': parts.push(`the opponent has ${v} or less life`); break;
        case 'handLe': parts.push(v === 0 ? 'you have no cards in hand' : `you have ${v} or fewer cards in hand`); break;
        case 'handGe': parts.push(`you have ${v} or more cards in hand`); break;
        case 'landsGe': parts.push(`you control ${v} or more lands`); break;
        case 'gyGe': parts.push(`there are ${v} or more cards in your graveyard`); break;
        case 'turnGe': parts.push(`it is turn ${v} or later`); break;
        case 'attackedThisTurn': parts.push(v ? 'you attacked this turn' : "you haven't attacked this turn"); break;
        case 'isYourTurn': parts.push(v ? "it's your turn" : "it isn't your turn"); break;
        case 'not': parts.push(`not (${dIf(v)})`); break;
        case 'totalPowerGe': parts.push(`creatures you control have total power ${v} or greater`); break;
        case 'tokensGe': parts.push(`you control ${v} or more tokens`); break;
        case 'isMonarch': parts.push(v ? "you're the monarch" : "you're not the monarch"); break;
        case 'counters': parts.push(`it has ${v.ge && v.ge > 1 ? v.ge + ' or more' : 'a'} ${v.kind && v.kind !== 'p1p1' ? v.kind : '+1/+1'} counter${v.ge > 1 ? 's' : ''} on it`); break;
        case 'noCounters': parts.push(`it has no ${v.kind ? (v.kind === 'p1p1' ? '+1/+1 ' : v.kind + ' ') : ''}counters on it`); break;
        case 'youHaveCounters': parts.push(`you have ${v.ge && v.ge > 1 ? v.ge + ' or more' : 'a'} ${v.kind || 'experience'} counter${v.ge > 1 ? 's' : ''}`); break;
        case 'thisTurn': parts.push(`${dCount({ thisTurn: v.fact, filter: v.filter })} is ${v.eq != null ? 'exactly ' + v.eq : v.ge != null ? v.ge + ' or more' : v.le != null ? v.le + ' or less' : 'at least 1'}`); break;
        case 'any': parts.push(list(v).map(dIf).join(' or ')); break;
        case 'all': parts.push(list(v).map(dIf).join(' and ')); break;
        default: parts.push(k);
      }
    }
    return parts.join(' and ');
  }

  function dMana(m) { return typeof m === 'string' ? m : `${m.mana}${m.n != null && m.n !== 1 ? ` for each of ${dCount(m.n)}` : ''}`; }
  function dCounters(kind, n) {
    const k = kind === 'p1p1' || !kind ? '+1/+1' : kind;
    return isNum(n) ? `${n === 1 ? 'a' : n} ${k} ${plural(n, 'counter')}` : `${dCount(n) === 'X' ? 'X' : `a number of ${k} counters equal to ${dCount(n)}`}${dCount(n) === 'X' ? ` ${k} counters` : ''}`;
  }
  function dEffect(e, name) {
    if (!e || typeof e !== 'object') return String(e);
    const [verb, a] = Object.entries(e)[0] || [];
    const amt = (n, one, many) => (isNum(n) ? (n === 1 ? one : `${n} ${many}`) : `${many.replace(/^\S+ /, '')} equal to ${dCount(n)}`);
    switch (verb) {
      case 'draw': return isNum(a) ? (a === 1 ? 'draw a card' : `draw ${a} cards`) : a === 'X' ? 'draw X cards' : `draw cards equal to ${dCount(a)}`;
      case 'gainLife': return isNum(a) || a === 'X' ? `gain ${a} life` : `gain life equal to ${dCount(a)}`;
      case 'loseLife': return isNum(a) || a === 'X' ? `lose ${a} life` : `lose life equal to ${dCount(a)}`;
      case 'oppLoseLife': return isNum(a) || a === 'X' ? `the opponent loses ${a} life` : `the opponent loses life equal to ${dCount(a)}`;
      case 'damageOpp': return isNum(a) || a === 'X' ? `deal ${a} damage to the opponent` : `deal damage equal to ${dCount(a)} to the opponent`;
      case 'addMana': return `add ${dMana(a)}`;
      case 'counters': return a.target === 'you' ? `you get ${dCounters(a.kind || 'experience', a.n ?? 1)}` : `put ${dCounters(a.kind, a.n ?? 1)} on ${dTarget(a.target, name)}`;
      case 'token': {
        if (a.copyOf != null) return `create ${a.n == null || a.n === 1 ? 'a token' : `${dCount(a.n)} tokens`} that's a copy of ${a.copyOf === 'triggering' ? 'that spell or permanent' : dTarget(a.copyOf === 'this' ? 'self' : a.copyOf, name)}`;
        const n = a.n ?? 1;
        const ptOf = v => (v == null ? 0 : isNum(v) ? v : v === 'X' ? 'X' : `(${dCount(v)})`);
        const pt = a.power != null || a.toughness != null ? `${ptOf(a.power)}/${ptOf(a.toughness)} ` : '';
        const what = `${pt}${a.name}${/token/i.test(a.name) ? '' : ' ' + plural(isNum(n) ? n : 2, 'token')}`;
        return `create ${isNum(n) ? (n === 1 ? article(what) : `${n} ${what}`) : `${dCount(n) === 'X' ? 'X' : 'a number of'} ${what}${dCount(n) === 'X' ? '' : ` equal to ${dCount(n)}`}`}${a.kw && a.kw.length ? ` with ${a.kw.join(', ').toLowerCase()}` : ''}${a.tapped ? ', tapped' : ''}`;
      }
      case 'pump': {
        const pt = a.p != null || a.t != null ? `gets ${fmtSigned(a.p)}/${fmtSigned(a.t)}` : '';
        const kw = a.kw && a.kw.length ? `${pt ? ' and ' : ''}gains ${a.kw.join(', ').toLowerCase()}` : '';
        return `${dTarget(a.target, name)} ${pt}${kw || (pt ? '' : 'gets nothing')} until end of turn`;
      }
      case 'grant': return `${dTarget(a.target, name)} gains ${(a.kw || []).join(', ').toLowerCase()} until end of turn`;
      case 'untap': return `untap ${dTarget(a.target, name)}`;
      case 'tap': return `tap ${dTarget(a.target, name)}`;
      case 'scry': return `scry ${dCount(a)}`;
      case 'surveil': return `surveil ${dCount(a)}`;
      case 'mill': return `mill ${isNum(a) ? amt(a, 'a card', 'cards') : dCount(a)}`;
      case 'discard': {
        if (a && typeof a === 'object' && !a.count && !a.of && !a.thisTurn && !a.neg) return `discard ${dCount(a.n ?? 1) === '1' ? 'a card' : `${dCount(a.n ?? 1)} cards`}${a.random ? ' at random' : ''}`;
        return isNum(a) ? (a === 1 ? 'discard a card' : `discard ${a} cards`) : `discard ${dCount(a)} cards`;
      }
      case 'tutor': {
        const where = { hand: 'put it into your hand', bf: `put it onto the battlefield${a.tapped ? ' tapped' : ''}`, top: 'put it on top of your library', gy: 'put it into your graveyard' }[a.to || 'hand'];
        return `search your library for ${article(dFilter(a.filter || {}, { noun: a.filter && Object.keys(a.filter).length ? null : 'card' }) + (a.filter && Object.keys(a.filter).length ? ' card' : ''))}, ${where}, then shuffle`;
      }
      case 'ramp': {
        const n = a.n ?? 1;
        const what = a.filter === 'land' ? 'land' : !a.filter || a.filter === 'basic' ? 'basic land' : dFilter(a.filter, { noun: 'land' });
        const cnt = isNum(n) ? (n === 1 ? article(what + ' card') : `${n} ${what} cards`) : `${dCount(n)} ${what} cards`;
        return `search your library for ${cnt}, put ${n === 1 ? 'it' : 'them'} ${a.to === 'hand' ? 'into your hand' : `onto the battlefield${a.tapped === false ? '' : ' tapped'}`}, then shuffle`;
      }
      case 'return': {
        const n = a.n ?? 1;
        const what = dFilter(a.filter || {}, { many: n !== 1, noun: a.filter && Object.keys(a.filter).length ? null : (n !== 1 ? 'card' : 'card') });
        const cnt = isNum(n) ? (n === 1 ? article(what) : `${n} ${what}`) : `${dCount(n)} ${what}`;
        return `return ${a.optional ? 'up to ' : ''}${cnt} from your graveyard to ${{ hand: 'your hand', bf: 'the battlefield', top: 'the top of your library' }[a.to || 'hand']}`;
      }
      case 'sacrifice': return `sacrifice ${dTarget(a.target, name)}`;
      case 'destroy': return `destroy ${dTarget(a.target, name)}`;
      case 'exile': return `exile ${dTarget(a.target, name)}`;
      case 'bounce': return `return ${dTarget(a.target, name)} to its owner's hand`;
      case 'fight': return `${dTarget(a.target, name)} fights (resolved by hand — the dummy has no creatures)`;
      case 'createCopy': return `create a token copy of ${dTarget(a.target, name)}`;
      case 'prompt': return `you resolve by hand: “${a}”`;
      case 'choice': return `choose one — ${(a.options || []).map(o => o.label).join('; or ')}`;
      case 'repeat': return `${dCount(a.times)} times: ${dEffects(a.do, name)}`;
      case 'check': return `if ${dIf(a.if)}, ${dEffects(a.do, name)}${a.else && a.else.length ? `; otherwise ${dEffects(a.else, name)}` : ''}`;
      case 'damage': return `${name ? name + ' deals' : 'deal'} ${isNum(a.n ?? 1) || a.n === 'X' ? a.n ?? 1 : `damage equal to ${dCount(a.n)}`}${isNum(a.n ?? 1) || a.n === 'X' ? ' damage' : ''} to ${a.target === 'opponent' ? 'the opponent' : dTarget(a.target ?? 'any', name)}`;
      case 'attach': return `attach ${!a.what || a.what === 'this' ? name || 'it' : a.what === 'target-equipment-you-control' ? 'target Equipment you control' : a.what === 'target-aura-you-control' ? 'target Aura you control' : dTarget(a.what, name)} to ${a.to === 'this' ? name : dTarget(a.to ?? a.target ?? 'creature-you-control', name)}`;
      case 'unattach': return `unattach ${name || 'it'}`;
      case 'investigate': return isNum(a) && a === 1 ? 'investigate' : `investigate ${dCount(a)} times`;
      case 'amass': return `amass ${a.type}${/s$/.test(a.type) ? '' : 's'} ${dCount(a.n ?? 1)}`;
      case 'explore': return `${dTarget(a.target ?? 'self', name)} explores`;
      case 'proliferate': return 'proliferate';
      case 'monarch': return 'you become the monarch';
      case 'ringTempt': return 'the Ring tempts you';
      case 'earthbend': return `earthbend ${dCount(a.n ?? 1)}${a.target && a.target !== 'land-you-control' ? ` (${dTarget(a.target, name)})` : ''}`;
      case 'airbend': return `airbend ${dTarget(a.target, name)}`;
      case 'firebend': return `add ${isNum(a) ? '{R}'.repeat(Math.max(0, a)) || 'no mana' : `{R} for each of ${dCount(a)}`} (firebending)`;
      case 'waterbend': return `waterbend ${a}`;
      case 'lookTop': {
        const pk = a.pick || { to: 'hand', n: 1 };
        const to = { hand: 'into your hand', bf: 'onto the battlefield', gy: 'into your graveyard', top: 'back on top', bottom: 'on the bottom', cast: '(cast without paying its mana cost)' }[pk.to || 'hand'];
        const rest = { bottom: 'on the bottom of your library', top: 'back on top', gy: 'into your graveyard', ex: 'into exile', hand: 'into your hand' }[a.rest || 'bottom'];
        return `look at the top ${dCount(a.n)} cards of your library, put up to ${dCount(pk.n ?? 1)} ${pk.filter ? dFilter(pk.filter, { noun: pk.filter.creature || pk.filter.land || pk.filter.type || pk.filter.subtype ? null : 'card' }) + (pk.filter.creature || pk.filter.land || pk.filter.type || pk.filter.subtype ? ' card' : '') : 'card'}${(pk.n ?? 1) === 1 ? '' : 's'} ${to} and the rest ${rest}`;
      }
      case 'revealTop': return `reveal the top ${dCount(a.n)} cards of your library, put ${a.filter ? 'every ' + dFilter(a.filter, { noun: a.filter.creature || a.filter.land || a.filter.type || a.filter.subtype ? null : 'card' }) + (a.filter.creature || a.filter.land || a.filter.type || a.filter.subtype ? ' card' : '') + ' revealed' : 'them'} ${{ hand: 'into your hand', bf: 'onto the battlefield', gy: 'into your graveyard' }[a.to || 'hand']} and the rest ${{ bottom: 'on the bottom', top: 'back on top', gy: 'into your graveyard', ex: 'into exile', hand: 'into your hand' }[a.rest || 'bottom']}`;
      case 'extraLand': return `you may play ${a === 1 ? 'an additional land' : `${dCount(a)} additional lands`} this turn`;
      case 'castFree': return `you may cast ${article(a.filter ? dFilter(a.filter, { noun: a.filter.creature || a.filter.subtype || a.filter.land || a.filter.type ? null : 'spell' }) : 'spell')} from your hand without paying its mana cost`;
      case 'choose': return `choose a ${a.kind === 'color' ? 'colour' : 'creature type'}`;
      case 'revealUntil': return `reveal cards from the top of your library until you reveal ${article(a.filter ? dFilter(a.filter, { noun: a.filter.creature || a.filter.land || a.filter.type || a.filter.subtype ? null : 'card' }) + (a.filter.creature || a.filter.land || a.filter.type || a.filter.subtype ? ' card' : '') : 'card')}, ${a.to === 'cast' || a.to === 'castFree' ? 'you may cast it without paying its mana cost,' : `put it ${a.to === 'bf' ? `onto the battlefield${a.tapped ? ' tapped' : ''}` : 'into your hand'}`} and the rest ${{ bottom: 'on the bottom of your library', gy: 'into your graveyard', exile: 'into exile' }[a.rest || 'bottom']}`;
      case 'moveSelf': return `put this card ${{ hand: 'into your hand', bf: `onto the battlefield${a.tapped ? ' tapped' : ''}`, gy: 'into your graveyard', exile: 'into exile', top: 'on top of your library', bottom: 'on the bottom of your library' }[a.to || 'hand']}`;
      case 'stripAbilities': return `${dTarget(a.target, name)} loses all abilities${a.until === 'eot' ? ' until end of turn' : ''}`;
      case 'becomeCopy': return `${dTarget(a.target, name)} becomes a copy of ${a.of && a.of.name ? a.of.name : a.of === 'triggering' ? 'that permanent' : dTarget(a.of, name)}${a.until === 'eot' ? ' until end of turn' : ''}`;
      case 'addSubtype': return `${dTarget(a.target, name)} is a ${a.subtype} in addition to its other types`;
      case 'emblem': return `you get an emblem${a.name ? ` (${a.name})` : ''}`;
      case 'lose': return `you lose the game${typeof a === 'string' ? ` (${a})` : ''}`;
      case 'putFromLib': return `put the card ${a.index === 1 ? 'on top' : `${a.index}${['', 'st', 'nd', 'rd'][a.index] || 'th'} from the top`} of your library ${a.to === 'cast' ? 'onto the stack (cast free)' : { hand: 'into your hand', bf: 'onto the battlefield', gy: 'into your graveyard', exile: 'into exile', top: 'on top', bottom: 'on the bottom' }[a.to || 'hand']}`;
      case 'castHidden': return 'you may play the exiled card without paying its mana cost';
      case 'animate': return `${dTarget(a.target ?? 'self', name)} becomes a ${dCount(a.p ?? 0)}/${dCount(a.t ?? 0)} ${[...(a.subtypes || []), ...(a.types || ['Creature']).map(t => t.toLowerCase())].join(' ')}${a.kw && a.kw.length ? ` with ${a.kw.join(', ').toLowerCase()}` : ''}${a.until === 'permanent' ? '' : ' until end of turn'}`;
      case 'cascade': return `cascade (reveal until a nonland card with mana value less than ${dCount(a)}, you may cast it free, the rest go to the bottom in a random order)`;
      case 'extraCombat': return a === true || a === 1 ? 'there is an additional combat phase after this one' : `there are ${dCount(a)} additional combat phases`;
      case 'extraTurn': return a === true || a === 1 ? 'take an extra turn after this one' : `take ${dCount(a)} extra turns after this one`;
      case 'transform': return `transform ${dTarget(a.target === 'this' || a.target == null ? 'self' : a.target, name)}`;
      case 'win': return `you win the game${typeof a === 'string' ? ` (${a})` : ''}`;
      case 'removeCounters': return `remove ${a.n === 'all' ? 'all' : dCount(a.n ?? 1)} ${a.kind && a.kind !== 'p1p1' ? a.kind : '+1/+1'} counter${a.n === 1 || a.n == null ? '' : 's'} from ${dTarget(a.target, name)}`;
      case 'doubleCounters': return `double the number of ${a.kind && a.kind !== 'p1p1' ? a.kind : '+1/+1'} counters on ${a.target === 'you' ? 'you' : dTarget(a.target, name)}`;
      case 'moveCounters': return `move ${a.n == null || a.n === 'all' ? 'all' : dCount(a.n)} ${a.kind && a.kind !== 'p1p1' ? a.kind : '+1/+1'} counters from ${dTarget(a.from ?? 'self', name)} onto ${dTarget(a.to ?? 'creature-you-control', name)}`;
      case 'pay': return `you may pay ${dCostFull(a)}; if you do, continue`;
      case 'delay': return `at ${{ endStep: 'the beginning of the end step', nextEndStep: 'the beginning of the next end step', nextUpkeep: 'the beginning of your next upkeep', cleanup: 'cleanup' }[a.at || 'endStep']}, ${dEffects(a.do, name)}`;
      case 'putFromHand': return `${a.optional ? 'you may ' : ''}put ${dCount(a.n ?? 1)} ${a.filter ? dFilter(a.filter, { noun: 'card' }) : 'card'}${(a.n ?? 1) === 1 ? '' : 's'} from your hand ${{ libtop: 'on top of your library', libbottom: 'on the bottom of your library', bf: `onto the battlefield${a.tapped ? ' tapped' : ''}` }[a.to || 'libtop']}`;
      case 'exileFromGy': return `exile ${dCount(a.n ?? 1)} ${a.filter ? dFilter(a.filter, { noun: 'card' }) : 'card'}${(a.n ?? 1) === 1 ? '' : 's'} from your graveyard`;
      case 'castFromGy': return `${a.all ? 'each' : dCount(a.n ?? 1)} ${a.filter ? dFilter(a.filter, { noun: 'card' }) : 'card'} in your graveyard may be cast from there ${a.until === 'permanent' ? 'while it stays there' : 'this turn'}${a.exileAfter ? ' (then exiled)' : ''}`;
      case 'exileTop': { if (a && a.hideaway) return `hideaway ${dCount(a.n ?? 1)} (look at the top ${dCount(a.n ?? 1)}, exile one face down, the rest on the bottom)`; const n = typeof a === 'object' && a ? a.n ?? 1 : a; const play = typeof a === 'object' && a ? a.play : null; return `exile the top ${dCount(n)} card${n === 1 ? '' : 's'} of your library${play ? `; you may play ${n === 1 ? 'it' : 'them'} ${play === 'nextTurn' ? 'until the end of your next turn' : 'this turn'}` : ''}`; }
      case 'chooseNumber': return `choose a number${a.max != null ? ` from ${a.min ?? 0} to ${a.max}` : ''}`;
      case 'noUntap': return `${dTarget(a.target, name)} doesn't untap during your ${a.next ? 'next ' : ''}untap step`;
      case 'setBase': return `${dTarget(a.target, name)} has base power and toughness ${dCount(a.p ?? 0)}/${dCount(a.t ?? 0)}${a.until === 'permanent' ? '' : ' until end of turn'}`;
      default: return `(unknown step ${JSON.stringify(e)})`;
    }
  }
  function fmtSigned(v) { if (v == null) return '+0'; if (isNum(v)) return (v >= 0 ? '+' : '') + v; return '+' + (v === 'X' ? 'X' : `(${dCount(v)})`); }
  function dEffects(ops, name) { return (ops || []).map(e => dEffect(e, name)).join(', then '); }

  function dTriggerHead(tr, name) {
    const f = tr.filter;
    const a = f ? article(dFilter(f)) : null;
    const self = !!tr.self;
    switch (tr.on) {
      case 'enters': return tr.selfOr ? `Whenever ${name} or ${article(dFilter({ other: true, ...tr.selfOr }))} enters` : self ? `When ${name} enters` : `Whenever ${a || 'a permanent'} enters`;
      case 'leaves': return self ? `When ${name} leaves the battlefield` : `Whenever ${a || 'a permanent'} leaves the battlefield`;
      case 'dies': return self ? `When ${name} dies` : `Whenever ${a ? a.replace(/permanent$/, 'creature') : 'a creature'} dies`;
      case 'attacks': return self ? `Whenever ${name} attacks` : f ? `Whenever ${a} attacks` : 'Whenever you attack';
      case 'combatDamage': return self ? `Whenever ${name} deals combat damage to a player` : f ? `Whenever ${a} deals combat damage to a player` : 'Whenever one or more creatures deal combat damage to a player';
      case 'cast': return self ? `When you cast ${name}` : `Whenever you cast ${f ? article(dFilter(f, { noun: f.creature || f.subtype || f.land || f.type ? null : 'spell' })) + (f.creature || f.subtype || f.land || f.type ? ' spell' : '') : 'a spell'}`;
      case 'resolved': return self ? `When ${name} resolves` : `Whenever ${f ? article(dFilter(f)) + ' spell' : 'a spell'} you cast resolves`;
      case 'landPlayed': return self ? `When you play ${name}` : 'Whenever you play a land';
      case 'counters': return `Whenever ${f && f.kind && f.kind !== 'p1p1' ? f.kind : '+1/+1'} counters are put on ${self ? name : f ? article(dFilter({ ...f, kind: undefined })) : 'a permanent you control'}`;
      case 'tokenCreated': return 'Whenever you create one or more tokens';
      case 'tapped': return self ? `Whenever ${name} becomes tapped` : `Whenever ${a || 'a permanent'} becomes tapped`;
      case 'untapped': return self ? `Whenever ${name} becomes untapped` : `Whenever ${a || 'a permanent'} becomes untapped`;
      case 'life': {
        const who = (f && f.who) || 'you';
        const verb = f && f.gain ? (who === 'you' ? 'gain' : 'gains') : f && f.lose ? (who === 'you' ? 'lose' : 'loses') : (who === 'you' ? 'gain or lose' : 'gains or loses');
        return `Whenever ${who === 'you' ? 'you' : 'the opponent'} ${verb} life`;
      }
      case 'drew': return 'Whenever you draw cards';
      case 'upkeep': return 'At the beginning of your upkeep';
      case 'drawStep': return 'At the beginning of your draw step';
      case 'beginCombat': return 'At the beginning of combat on your turn';
      case 'beginMain': return 'At the beginning of each of your main phases';
      case 'sacrificed': return self ? `When you sacrifice ${name}` : `Whenever you sacrifice ${a || 'a permanent'}`;
      case 'attached': return self ? `Whenever ${name} becomes attached or unattached` : `Whenever ${a || 'an Aura or Equipment'} becomes attached`;
      case 'scryed': return 'Whenever you scry';
      case 'surveiled': return 'Whenever you surveil';
      case 'nthDraw': return f && f.index ? `Whenever you draw your ${['zeroth', 'first', 'second', 'third', 'fourth', 'fifth'][f.index] || f.index + 'th'} card each turn` : 'Whenever you draw a card';
      case 'attackedWith': return f && f.countGe ? `Whenever you attack with ${f.countGe} or more creatures` : 'Whenever you attack';
      case 'tempted': return 'Whenever the Ring tempts you';
      case 'cycled': return self ? `When you cycle ${name}` : 'Whenever you cycle a card';
      case 'targeted': return f ? `Whenever ${a} becomes the target of a spell or ability you control` : 'Whenever a permanent you control becomes the target of a spell or ability you control';
      case 'expend': return tr.n ? `Whenever you expend ${list(tr.n).join(' or ')}` : 'Whenever you expend';
      case 'damaged': return self ? `Whenever ${name} is dealt damage` : `Whenever ${a || 'a permanent'} is dealt damage`;
      case 'explored': return self ? `Whenever ${name} explores` : `Whenever ${a || 'a creature you control'} explores`;
      case 'discarded': return f ? `Whenever you discard ${article(dFilter(f, { noun: 'card' }))}` : 'Whenever you discard a card';
      case 'chapter': return tr.n != null ? `Chapter ${list(tr.n).map(n => ['', 'I', 'II', 'III', 'IV', 'V', 'VI'][n] || n).join(', ')}` : 'Each chapter';
      case 'bent': return `Whenever you ${f && f.kind ? list(f.kind).map(k => k + 'bend').join(' or ') : 'waterbend, earthbend, firebend, or airbend'}`;
      case 'endStep': return 'At the beginning of your end step';
      case 'turnStart': return 'At the start of your turn';
      default: return `On ${tr.on}`;
    }
  }
  function dTrigger(tr, name) {
    let s = dTriggerHead(tr, name);
    if (tr.zone && tr.zone !== 'bf') s += ` (while ${name} is in your ${tr.zone === 'gy' ? 'graveyard' : 'hand'})`;
    if (tr.if) s += `, if ${dIf(tr.if)}`;
    if (tr.cost) s += `, you may pay ${dCostFull(tr.cost)}. If you do`;
    s += `, ${tr.optional && !tr.cost ? 'you may ' : ''}${dEffects(tr.do, name)}`;
    if (tr.limit === 'once-per-turn') s += ' (only once each turn)';
    return cap(s) + '.';
  }
  function dStatic(st, name) {
    if (st.prompt) return `Not automated: “${st.prompt}”`;
    const cond = st.if ? ` as long as ${dIf(st.if)}` : '';
    const fOf = (v, noun) => (v && v.filter ? dFilter(v.filter, { many: true, noun: v.filter.creature || v.filter.land || v.filter.type || v.filter.subtype ? null : noun }) : `${noun}s`);
    if (st.playFromTop) return `You may look at the top card of your library any time, and play ${fOf(st.playFromTop, 'card')} from the top of your library${cond}.`;
    if (st.noMaxHand) return `You have no maximum hand size${cond}.`;
    if (st.cantAttack) return st.cantAttack === true || !st.cantAttack.filter ? `${name} can't attack${cond}.` : `${cap(dFilter(st.cantAttack.filter, { many: true }))} can't attack${cond}.`;
    if (st.entersUntapped) return `${cap(fOf(st.entersUntapped, 'land'))} you control enter untapped${cond}.`;
    if (st.flash) return `You may cast ${fOf(st.flash, 'spell')} as though they had flash${cond}.`;
    if (st.castFromGy) return st.castFromGy.self ? `You may cast ${name} from your graveyard${st.castFromGy.if ? ` as long as ${dIf(st.castFromGy.if)}` : cond}.` : `You may cast ${fOf(st.castFromGy, 'card')} from your graveyard${cond}.`;
    if (st.landsProduceAny) return `Lands you control have "{T}: Add one mana of any color"${cond}.`;
    if (st.landsAlsoProduce) return `Lands you control can also tap for ${st.landsAlsoProduce.map(c => `{${c}}`).join(' or ')}${cond}.`;
    if (st.landsAreSwamps) return `Each land is a Swamp in addition to its other types (it taps for {B})${cond}.`;
    if (st.anthemPer) {
      const ap = st.anthemPer;
      return `${cap(ap.filter ? dFilter(ap.filter, { many: true }) : 'creatures')} you control get ${fmtSigned(ap.p ?? 0)}/${fmtSigned(ap.t ?? 0)}, counted for each creature separately${cond}.`;
    }
    const scopeTxt = {
      'self': name, 'creatures-you-control': 'Creatures you control', 'other-creatures-you-control': `Other creatures you control`,
      'permanents-you-control': 'Permanents you control', 'lands-you-control': 'Lands you control',
      'artifacts-you-control': 'Artifacts you control', 'tokens-you-control': 'Tokens you control', 'commander': 'Your commander',
      'attached': 'The creature it is attached to',
    };
    let s;
    if (st.scope === 'spells-you-cast') s = `${cap(dSpells(st.filter))} you cast cost {${isNum(st.costLess) ? st.costLess : 'X'}} less${isNum(st.costLess) ? '' : `, where X is ${dCount(st.costLess)}`}`;
    else if (st.scope === 'this-spell') s = `This spell costs {${isNum(st.costLess) ? st.costLess : 'X'}} less to cast${isNum(st.costLess) ? '' : `, where X is ${dCount(st.costLess)}`}`;
    else {
      let who = scopeTxt[st.scope] || st.scope;
      if (st.filter && st.scope !== 'self') {
        const f = { ...st.filter };
        if (st.scope === 'other-creatures-you-control') f.other = true;
        if (st.scope.includes('creature') && !f.subtype && !f.type) f.creature = true;
        if (st.scope === 'lands-you-control') f.land = true;
        who = `${cap(dFilter(f, { many: true }))} you control`;
      }
      const single = st.scope === 'self' || st.scope === 'commander' || st.scope === 'attached';
      const bits = [];
      if (st.p != null || st.t != null) bits.push(`${single ? 'gets' : 'get'} ${fmtSigned(st.p ?? 0)}/${fmtSigned(st.t ?? 0)}`);
      if (st.kw && st.kw.length) bits.push(`${single ? 'has' : 'have'} ${st.kw.join(', ').toLowerCase()}`);
      if (st.animate) bits.push(`${single ? 'is' : 'are'} ${dCount(st.animate.p ?? 0)}/${dCount(st.animate.t ?? 0)} ${[...(st.animate.subtypes || []), 'creature'].join(' ')}${single ? '' : 's'}${st.animate.kw && st.animate.kw.length ? ` with ${st.animate.kw.join(', ').toLowerCase()}` : ''}`);
      if (st.noUntap) bits.push(`${single ? "doesn't" : "don't"} untap during your untap step`);
      s = `${who} ${bits.join(' and ')}`;
    }
    if (st.if) s += ` as long as ${dIf(st.if)}`;
    return s + '.';
  }
  function dSpells(f) {
    if (!f || !Object.keys(f).length) return 'spells';
    const typed = f.creature || f.subtype || f.land || f.type;
    return typed ? `${dFilter(f)} spells` : dFilter(f, { many: true, noun: 'spell' });
  }
  function dCost(c) {
    const parts = [];
    if (c.mana) parts.push(c.mana);
    if (c.tap) parts.push('{T}');
    if (c.life) parts.push(`pay ${c.life} life`);
    if (c.waterbend) parts.push(`waterbend ${c.waterbend}`);
    if (c.sacSelf) parts.push('sacrifice it');
    return parts.join(', ') || 'free';
  }
  function dCostFull(c) { return dCostFullImpl(c); }

  function explain(cardName) {
    const sc = scriptFor(cardName);
    if (!sc) return 'Not scripted: the game does not know this card yet — play it by hand.';
    const lines = [];
    for (const r of sc.replace || []) {
      const what = r.event === 'tokenCreated' ? (r.becomeAll ? `If you would create ${(r.namesIn || []).join(', ')} tokens, create one of each instead` : `If you would create ${r.filter ? article(dFilter({ ...r.filter }, { noun: 'token' })) : 'tokens'}, create ${r.multiply ? (r.multiply === 2 ? 'twice that many' : `${r.multiply} times that many`) : ''}${r.add ? `that many plus ${r.add}` : ''} instead`)
        : r.event === 'countersPlaced' ? `If ${r.kind === 'p1p1' ? '+1/+1' : r.kind || 'any'} counters would be put on ${r.filter ? article(dFilter(r.filter)) : 'a permanent you control'}, ${r.multiply ? (r.multiply === 2 ? 'twice that many' : `${r.multiply} times that many`) : ''}${r.add ? `that many plus ${r.add}` : ''} are put on it instead`
        : `If ${r.filter ? article(dFilter(r.filter)) + ' source' : 'a source you control'} would deal damage to the opponent, it deals ${r.add ? `that much plus ${r.add}` : ''}${r.multiply ? `${r.multiply} times that much` : ''} instead`;
      lines.push(what + '.');
    }
    const ch = sc.chooseOn && sc.chooseOn.enters;
    if (ch) lines.push(`As ${cardName} enters, choose a ${ch.kind === 'color' ? 'colour' : 'creature type'}.`);
    for (const st of sc.statics || []) lines.push(dStatic(st, cardName));
    for (const tr of sc.triggers || []) lines.push(dTrigger(tr, cardName));
    if (sc.spell && sc.spell.length) lines.push(cap(`When it resolves: ${dEffects(sc.spell, cardName)}.`));
    for (const a of list(sc.altCost)) if (a) lines.push(`You may ${a.free ? 'cast this spell without paying its mana cost' : `pay ${a.cost} rather than its mana cost`}${a.if ? ` if ${dIf(a.if)}` : ''}.`);
    for (const ab of sc.activated || []) {
      if (ab.zone && ab.zone !== 'bf') {
        const eff = dEffects((ab.do || []).filter(o => !Object.keys(o)[0].startsWith('$')), cardName);
        lines.push(`${ab.text || ab.label || 'Ability'} (from your ${ab.zone === 'gy' ? 'graveyard' : ab.zone})${eff ? `: ${cap(eff)}` : ''}.`);
        continue;
      }
      lines.push(`${dCostFull(ab.cost || {})}: ${cap(dEffects(ab.do, cardName))}.${ab.limit === 'once-per-turn' ? ' Activate only once each turn.' : ab.limit === 'sorcery-speed' ? ' Activate only as a sorcery.' : ''}`);
    }
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/([.!?])”\.$/, '$1”').replace(/”\.$/, '”');
    if (sc.back) lines.push(`Transformed: ${[...(sc.back.statics || []).map(st => dStatic(st, cardName)), ...(sc.back.triggers || []).map(tr => dTrigger(tr, cardName))].join(' ') || 'no scripted abilities'}`);
    for (const [face, f] of Object.entries(sc.faces || {})) if (f.spell && f.spell.length) lines.push(`${face}: ${cap(dEffects(f.spell, cardName))}.`);
    if (!lines.length) {
      return sc.status === 'prompt'
        ? 'Prompt only: the game shows this card\'s text when it matters; you resolve it by hand.'
        : 'Nothing to automate: mana abilities and keywords are handled by the table.';
    }
    return lines.join('\n');
  }

  /* ================= pending queue ================= */
  function newId() { const s = S(); const id = 'pd' + (s.pendSeq || 1); s.pendSeq = (s.pendSeq || 1) + 1; return id; }
  function makePending(frame, spec) {
    const p = { id: newId(), kind: spec.kind, card: frame.card };
    if (frame.src != null) p.perm = frame.src;
    p.text = spec.text || frame.text || frame.card;
    if (frame.text) p.trigger = frame.text;
    for (const k of ['options', 'filter', 'n', 'optional', 'zone', 'auto', 'store']) if (spec[k] !== undefined) p[k] = spec[k];
    p.resumeWith = { frame: clone(frame) };
    return p;
  }
  function enqueueFrame(frame, { optional = false } = {}) {
    const item = makePending(frame, {
      kind: 'trigger',
      text: optional ? `Use ${frame.card}'s ability? ${frame.text || ''}`.trim() : frame.text || frame.card,
      options: [{ id: 'resolve', label: 'Resolve' }, { id: 'skip', label: 'Skip' }],
      optional: optional || undefined,
      auto: !optional && cascade <= MAX_FRAMES,
    });
    pendingList().push(item);
  }
  const removePending = id => { const l = pendingList(); const i = l.findIndex(p => p.id === id); if (i >= 0) l.splice(i, 1); return i; };

  // One trigger = one undo step. lastBatch is reset first so a batch nested inside someone else's batch
  // (which collapses and does not report) never re-announces an older ribbon.
  function doBatch(label, fn) { game.lastBatch = null; return game.batch(label, fn); }
  function finishBatch(card, perm) {
    const lb = game.lastBatch;
    if (lb && lb.lines && lb.lines.length) game._emit('triggerResolved', { card, perm, summary: lb.lines.join(' ') });
  }

  // Auto-run queued triggers until something needs the player.
  function processQueue() {
    if (processing) return;
    processing = true;
    try {
      while (pendingList().length) {
        const top = pendingList()[0];
        if (top.kind !== 'trigger' || !top.auto) break;
        if (++cascade > MAX_FRAMES) {
          for (const p of pendingList()) if (p.kind === 'trigger') p.auto = false;
          game.note(`Loop guard: stopped auto-resolving after ${MAX_FRAMES} triggers — resolve the rest by hand.`);
          break;
        }
        const frame = clone(top.resumeWith.frame);
        doBatch(top.card, () => { removePending(top.id); runFrame(frame, undefined, 0); });
        finishBatch(top.card, top.perm);
      }
    } finally { processing = false; }
    recomputeStatics();
  }

  /* ================= targets ================= */
  // -> { uids } (automatic), { block } (player picks), or { uids: [], none: reason }
  function targets(t, frame, answer, verbText) {
    const ctx = frame.ctx || {};
    if (t == null) t = 'self';
    if (t && t.$uids) return { uids: t.$uids.filter(u => onBf(u)) };
    if (t === 'self' || t === 'this') return { uids: frame.src != null && onBf(frame.src) ? [frame.src] : [], none: 'it has left the battlefield' };
    if (t === 'triggering') return { uids: ctx.trig != null && onBf(ctx.trig) ? [ctx.trig] : [], none: 'that permanent is gone' };
    if (t === 'opponent') return { uids: [], none: 'the dummy controls no permanents' };
    if (t === 'commander') { const c = bf().find(p => !p.tok && !p.copy && isCommander(game, p.name)); return { uids: c ? [c.uid] : [], none: 'your commander is not on the battlefield' }; }
    const each = {
      'each-creature-you-control': p => creatureP(p),
      'each-other-creature-you-control': p => creatureP(p) && p.uid !== frame.src,
      'each-land-you-control': p => isLand(permCard(game, p)),
    }[t];
    if (each) return { uids: bf().filter(each).map(p => p.uid) };
    if (t && t.each) return { uids: bf().filter(p => matchFilter(p, t.each, ctx)).map(p => p.uid) };
    let filter, n = 1, optional = false;
    if (t === 'creature-you-control') filter = { creature: true };
    else if (t === 'land-you-control') filter = { land: true };
    else if (t === 'any-you-control') filter = {};
    else if (t && t.pick) { filter = t.pick; n = t.n || 1; optional = !!t.optional; }
    else throw new Error(`unknown target ${JSON.stringify(t)}`);
    const cands = bf().filter(p => matchFilter(p, filter, ctx));
    if (answer && answer.kind === 'target') {
      const ok = new Set(cands.map(p => p.uid));
      return { uids: (answer.uids || []).filter(u => ok.has(u)).slice(0, n) };
    }
    if (!cands.length) return { uids: [], none: 'no legal target' };
    if (!optional && cands.length <= n) return { uids: cands.map(p => p.uid) }; // the only choice: no question
    return {
      block: {
        kind: 'target', zone: 'bf', filter, n, optional,
        options: cands.map(p => ({ id: p.uid, label: p.tok && p.n > 1 ? `${p.name} (×${p.n})` : p.name })),
        text: `${cap(verbText)}: choose ${optional ? 'up to ' : ''}${n === 1 ? 'one' : n}.`,
      },
    };
  }

  // Run fn on each targeted uid; returns a block when the player must choose.
  const isEachTarget = t => (typeof t === 'string' && t.startsWith('each-')) || !!(t && t.each);
  function onTargets(t, frame, answer, op, fn) {
    const r = targets(t, frame, answer, dEffect(op, frame.card));
    if (r.block) return { block: r.block };
    frame.ctx = frame.ctx || {};
    frame.ctx.lastCount = 0;
    if (!r.uids.length) { game.note(`${dEffect(op, frame.card)} — nothing happens (${r.none || 'no target'}).`); return {}; }
    const args = (op && Object.values(op)[0]) || {};
    const whole = isEachTarget(t) || !!(args && args.all);
    const isTargeting = t === 'creature-you-control' || t === 'any-you-control' || t === 'land-you-control' || !!(t && t.pick);
    if (isTargeting) for (const u of r.uids) if (onBf(u)) game._emit('targeted', { perm: onBf(u), card: frame.card });
    for (const u of r.uids) {
      const p = onBf(u);
      if (!p) continue;
      frame.ctx.lastTarget = u;
      frame.ctx.lastTargetInfo = lki(p);
      frame.ctx.lastCount += whole && p.tok ? p.n || 1 : 1;
      fn(u, whole);
    }
    return {};
  }
  // destroy / exile / bounce: a single target takes one token off a stack; "each" (or all:true) takes the stack
  function removePerm(u, zone, whole) {
    const p = onBf(u);
    if (!p) return;
    if (p.tok && (p.n || 1) > 1 && !whole) { const r = game.splitToken(u); if (r.ok) u = r.uid; }
    game.move(u, zone);
  }
  function sacrificePerm(u, whole) {
    const p = onBf(u);
    if (!p) return;
    const times = whole && p.tok ? Math.min(p.n || 1, 200) : 1;
    for (let i = 0; i < times && onBf(u); i++) game.sacrifice(u);
  }
  // Amount that may depend on the current target ({of:"target"}): evaluated per target, else once.
  const refersTarget = c => !!c && typeof c === 'object' && (c.of === 'target' || (c.neg && refersTarget(c.neg)));
  function amountFn(c, ctx, dflt = 1) {
    if (refersTarget(c)) return () => evalCount(c, ctx);
    const v = evalCount(c ?? dflt, ctx);
    return () => v;
  }
  const bent = (kind, n) => game._emit('bent', { kind, n: n || 0 });

  function deckCreatureTypes() {
    const freq = {};
    for (const c of Object.values((game.deck && game.deck.cards) || {})) {
      if (!isCreature(c)) continue;
      for (const t of subTypes(c).split(/\s+/).filter(Boolean)) freq[t] = (freq[t] || 0) + 1;
    }
    return Object.entries(freq).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map(([t]) => t);
  }

  // Waterbend {N}: pay with mana, then tap untapped artifacts/creatures for the generic still owed.
  function waterbendHelpers(exclude) {
    return bf().filter(p => !p.tapped && p.uid !== exclude && (creatureP(p) || /\bArtifact\b/.test(mainTypes(permCard(game, p)))));
  }
  function canWaterbend(cost, exclude) {
    const plan = game.autoPay(cost);
    if (!plan.short) return true;
    const used = new Set(plan.tap.map(t => t.uid));
    return waterbendHelpers(exclude).filter(p => !used.has(p.uid)).length >= plan.short;
  }
  function payWaterbend(cost, exclude) {
    const plan = game.autoPay(cost);
    let owed = plan.short;
    if (owed) {
      const used = new Set(plan.tap.map(t => t.uid));
      for (const h of waterbendHelpers(exclude).filter(p => !used.has(p.uid))) { if (owed <= 0) break; game.tap(h.uid); owed--; }
      const parsed = (mana => { const m = { generic: 0, pips: [] }; for (const x of String(mana).matchAll(/\{([^}]+)\}/g)) { if (/^\d+$/.test(x[1])) m.generic += +x[1]; else m.pips.push(x[1]); } return m; })(cost);
      parsed.generic = Math.max(0, parsed.generic - (plan.short - owed));
      game.payCost(parsed, { force: true });
    } else game.payCost(cost, { force: true });
    bent('water', 0);
    return owed <= 0;
  }

  // Move a library card somewhere (lookTop / revealTop)
  function libTo(uid, to, tapped = false) {
    if (to === 'top') return;
    if (to === 'bottom') { game.move(uid, 'lib'); return; }
    const r = game.move(uid, to);
    if (to === 'bf' && tapped && r.ok && r.uid != null && onBf(r.uid)) game.tap(r.uid);
  }

  // damage from this ability's source to the dummy, through replacement effects (Torbran)
  function dmgToOpp(n, frame) {
    if (!(n > 0)) return n;
    const source = (frame.src != null && onBf(frame.src)) || { uid: frame.ctx && frame.ctx.trig, name: frame.card };
    return replaceHook('damageToOpp', { source: source.counters ? source : { ...source, tok: false }, n });
  }
  const scriptlessName = p => (p.tok && !p.copy ? p.name : (p.copyOf || p.name));
  // cast a library card without paying (cascade, revealUntil to:"cast", lookTop pick to:"cast")
  function castFreeFromLibrary(uid) {
    const c = S().zones.lib.find(x => x.uid === uid);
    if (!c) return;
    const card = cardOf(game, c.name);
    if (isLand(card) && !isCreature(card)) { game.move(uid, 'bf'); return; }
    game.move(uid, 'ex');
    game.grantPlayable(uid, { until: S().turn });
    const r = game.cast(uid, { pay: false, force: true, x: 0 });
    if (!r.ok) game.note(`Could not cast ${c.name} (${r.reason}).`);
  }

  /* ---- costs (activated abilities, trigger `cost`, the `pay` verb) ---- */
  const PICK_COSTS = ['sac', 'discard', 'tapUntapped', 'exileFromGy'];
  function costPool(kind, spec, srcUid, ctx) {
    const f = (spec && spec.filter) || {};
    if (kind === 'sac') return bf().filter(p => matchFilter(p, f, ctx));
    if (kind === 'tapUntapped') return bf().filter(p => !p.tapped && p.uid !== srcUid && matchFilter(p, f, ctx));
    if (kind === 'discard') return S().zones.hand.filter(c => matchFilter(c, f, ctx));
    if (kind === 'exileFromGy') return S().zones.gy.filter(c => matchFilter(c, f, ctx));
    return [];
  }
  const poolSize = (kind, list) => (kind === 'sac' || kind === 'tapUntapped' ? list.reduce((t, p) => t + (kind === 'sac' && p.tok ? p.n || 1 : 1), 0) : list.length);
  function cannotPay(c, srcUid, ctx = {}) {
    const p = srcUid != null ? onBf(srcUid) : null;
    if (c.tap) {
      if (!p) return 'gone';
      if (p.tapped) return 'tapped';
      if (p.sick && creatureP(p) && !hasKeyword(permCard(game, p), 'Haste')) return 'summoning sick';
    }
    if (c.sacSelf && !p) return 'gone';
    if (c.mana) { const plan = game.autoPay(c.mana); if (plan.short > 0) return 'mana'; }
    if (c.waterbend && !canWaterbend(c.waterbend, c.tap ? srcUid : null)) return 'mana';
    if (c.life && S().life < c.life) return 'life';
    if (c.energy && ((S().counters || {}).energy || 0) < c.energy) return 'energy';
    if (c.removeCounters) {
      const k = c.removeCounters.kind || 'p1p1';
      if (!p || (p.counters[k] || 0) < (c.removeCounters.n ?? 1)) return 'counters';
    }
    for (const k of PICK_COSTS) if (c[k] && poolSize(k, costPool(k, c[k], srcUid, ctx)) < (c[k].n ?? 1)) return k;
    if (c.crew && crewPool(srcUid).reduce((t, q) => t + Math.max(0, power(game, q)) * (q.tok ? q.n || 1 : 1), 0) < c.crew) return 'crew';
    if (c.discardSelf && !(ctx.selfCard != null && S().zones.hand.some(x => x.uid === ctx.selfCard))) return 'not in hand';
    return null;
  }
  const crewPool = srcUid => bf().filter(q => !q.tapped && q.uid !== srcUid && creatureP(q));
  // Pays the parts that need no choice now; returns the ops that ask the player (sac / discard / ...).
  function payNow(c, srcUid) {
    if (c.tap && srcUid != null && onBf(srcUid) && !onBf(srcUid).tapped) game.tap(srcUid);
    if (c.mana) game.payCost(c.mana, { force: true });
    if (c.waterbend) payWaterbend(c.waterbend, srcUid);
    if (c.life) game.life(-c.life);
    if (c.energy) game.addPlayerCounter('energy', -c.energy);
    if (c.removeCounters && srcUid != null && onBf(srcUid)) game.addCounter(srcUid, c.removeCounters.kind || 'p1p1', -(c.removeCounters.n ?? 1));
    const ops = PICK_COSTS.filter(k => c[k]).map(k => ({ $payPick: { kind: k, filter: c[k].filter || {}, n: c[k].n ?? 1 } }));
    if (c.crew) ops.push({ $crew: { n: c.crew } });
    return ops;
  }
  function dCostFullImpl(c) {
    const parts = [];
    if (c.mana) parts.push(c.mana);
    if (c.tap) parts.push('{T}');
    if (c.waterbend) parts.push(`waterbend ${c.waterbend}`);
    if (c.life) parts.push(`pay ${c.life} life`);
    if (c.energy) parts.push(`pay ${'{E}'.repeat(c.energy)}`);
    if (c.removeCounters) parts.push(`remove ${c.removeCounters.n ?? 1} ${c.removeCounters.kind === 'p1p1' || !c.removeCounters.kind ? '+1/+1' : c.removeCounters.kind} counter${(c.removeCounters.n ?? 1) === 1 ? '' : 's'} from it`);
    if (c.sac) parts.push(`sacrifice ${(c.sac.n ?? 1) === 1 ? article(dFilter(c.sac.filter || {})) : `${c.sac.n} ${dFilter(c.sac.filter || {}, { many: true })}`}`);
    if (c.discard) parts.push(`discard ${(c.discard.n ?? 1) === 1 ? 'a card' : `${c.discard.n} cards`}${c.discard.filter && Object.keys(c.discard.filter).length ? ` (${dFilter(c.discard.filter)})` : ''}`);
    if (c.tapUntapped) parts.push(`tap ${(c.tapUntapped.n ?? 1) === 1 ? 'an' : c.tapUntapped.n} untapped ${dFilter(c.tapUntapped.filter || {}, { many: (c.tapUntapped.n ?? 1) !== 1 })} you control`);
    if (c.exileFromGy) parts.push(`exile ${(c.exileFromGy.n ?? 1) === 1 ? 'a card' : `${c.exileFromGy.n} cards`} from your graveyard`);
    if (c.sacSelf) parts.push('sacrifice it');
    if (c.discardSelf) parts.push('discard this card');
    if (c.exileSelf) parts.push('exile this card');
    if (c.crew) parts.push(`crew ${c.crew}`);
    return parts.join(', ') || 'free';
  }

  // delayed triggers: state.delayed = [{ phase, turn, frame }]
  const PHASE_ORDER = ['untap', 'upkeep', 'draw', 'main1', 'combat', 'combat-damage', 'main2', 'end', 'cleanup'];
  function scheduleDelay(at, frame, ops) {
    const s = S(), cur = PHASE_ORDER.indexOf(s.phase);
    const spec = { endStep: ['end', 0], nextEndStep: ['end', 1], nextUpkeep: ['upkeep', 1], cleanup: ['cleanup', 0] }[at] || ['end', 0];
    let turn = s.turn + spec[1];
    if (!spec[1] && cur >= PHASE_ORDER.indexOf(spec[0])) turn += 1;
    (s.delayed ||= []).push({ phase: spec[0], turn, frame: { card: frame.card, src: frame.src, text: `${frame.card} (delayed): ${dEffects(ops, frame.card)}.`, ctx: clone(frame.ctx || {}), ops: clone(ops) } });
    game.note(`${frame.card}: delayed until ${{ end: 'the end step', upkeep: 'the upkeep', cleanup: 'cleanup' }[spec[0]]} of turn ${turn}.`);
  }

  /* ================= effects ================= */
  const pickFromCards = (cards, { zone, n, optional, text, distinct = false }) => {
    let opts = cards;
    if (distinct) { const seen = new Set(); opts = cards.filter(c => (seen.has(c.name) ? false : seen.add(c.name))); }
    return { block: { kind: 'target', zone, n, optional, options: opts.map(c => ({ id: c.uid, label: c.name })), text } };
  };

  function exec(op, frame, answer) {
    if (!op || typeof op !== 'object') return unknownStep(op, frame);
    const keys = Object.keys(op);
    if (keys.length !== 1) return unknownStep(op, frame);
    const verb = keys[0], a = op[verb];
    const ctx = frame.ctx || (frame.ctx = {});
    const N = c => evalCount(c, ctx);
    switch (verb) {
      case 'draw': { const n = N(a); if (n > 0) { const r = game.draw(n); if (!r.ok) game.note(`Could not draw (${r.reason}).`); } return {}; }
      case 'gainLife': { const n = N(a); if (n) game.life(n); return {}; }
      case 'loseLife': { const n = N(a); if (n) game.life(-n); return {}; }
      case 'oppLoseLife': { const n = N(a); if (n) game.oppLife(-n); return {}; }
      case 'damageOpp': { const n = dmgToOpp(N(a), frame); if (n) game.oppLife(-n); return {}; }
      case 'addMana': {
        const mana = typeof a === 'string' ? a : a.mana;
        const times = typeof a === 'string' ? 1 : (a.n == null ? 1 : N(a.n));
        const syms = (mana.match(/\{([^}]+)\}/g) || []).map(x => x.slice(1, -1));
        const anyCount = syms.filter(x => x === 'any').length * times;
        if (anyCount && !(answer && answer.kind === 'choice')) {
          return { block: { kind: 'choice', text: `Add ${anyCount} mana of one colour: choose the colour.`, options: ['W', 'U', 'B', 'R', 'G'].map(c => ({ id: c, label: `{${c}}` })) } };
        }
        for (const sym of syms) {
          const col = sym === 'any' ? answer.option : sym;
          if (['W', 'U', 'B', 'R', 'G', 'C'].includes(col) && times > 0) game.addMana(col, times);
        }
        return {};
      }
      case 'counters': {
        if (a.target === 'you') { const n = N(a.n ?? 1); if (n) game.addPlayerCounter(a.kind || 'experience', n); return {}; }
        const nf = amountFn(a.n, ctx);
        return onTargets(a.target, frame, answer, op, u => { const n = nf(); if (n) game.addCounter(u, a.kind || 'p1p1', n); });
      }
      case 'token': {
        if (a.copyOf != null) {
          const n = Math.min(N(a.n ?? 1), MAX_REPEAT);
          if (n <= 0) return {};
          const c = a.copyOf;
          if (c === 'triggering' && (ctx.trig == null || !onBf(ctx.trig))) {
            if (ctx.trigName) game.createCopyToken(ctx.trigName, n); else game.note('Nothing to copy.');
            ctx.lastCount = n;
            return {};
          }
          return onTargets(c === 'this' ? 'self' : c, frame, answer, op, u => { for (let i = 0; i < n; i++) if (onBf(u)) game.copyPermanent(u); });
        }
        const n = N(a.n ?? 1);
        const tp = a.power == null ? undefined : Math.max(0, N(a.power)), tt = a.toughness == null ? undefined : Math.max(0, N(a.toughness));
        if (n > 0) game.createToken(refStr(a.name, ctx) || a.name, n, { power: tp, toughness: tt, tapped: !!a.tapped, kw: a.kw || [], types: refList(a.types, ctx), colors: refList(a.colors, ctx), script: a.script || null });
        ctx.lastCount = Math.max(0, n);
        return {};
      }
      case 'pump': {
        const pf = amountFn(a.p, ctx, 0), tf = amountFn(a.t, ctx, 0);
        return onTargets(a.target, frame, answer, op, u => game.grantEot(u, { p: pf(), t: tf(), kw: a.kw || [] }));
      }
      case 'grant': return onTargets(a.target, frame, answer, op, u => game.grantEot(u, { kw: a.kw || [] }));
      case 'untap': return onTargets(a.target, frame, answer, op, u => game.untapPerm(u));
      case 'tap': return onTargets(a.target, frame, answer, op, u => {
        // "enters tapped" self-trigger vs an entersUntapped static (Horizon Explorer)
        if (ctx.ev === 'enters' && ctx.trig === u && frame.src === u && permission('entersUntapped', onBf(u))) return;
        if (!onBf(u).tapped) game.tap(u);
      });
      case 'scry':
      case 'surveil': {
        const n = Math.min(N(a), S().zones.lib.length);
        if (n <= 0) return {};
        if (answer && answer.kind === 'target') {
          const top = new Set(S().zones.lib.slice(0, n).map(c => c.uid));
          const away = (answer.uids || []).filter(u => top.has(u));
          if (verb === 'scry') game.scry(n, [], away); else game.surveil(n, [], away);
          return {};
        }
        return pickFromCards(S().zones.lib.slice(0, n), {
          zone: 'lib', n, optional: true,
          text: `${cap(verb)} ${n}: choose the cards to put ${verb === 'scry' ? 'on the bottom' : 'into your graveyard'} (the rest stay on top).`,
        });
      }
      case 'mill': { const n = N(a); if (n > 0) { const r = game.mill(n); ctx.lastCount = r.ok ? r.cards.length : 0; } return {}; }
      case 'tutor': {
        const to = a.to || 'hand';
        if (answer && answer.kind === 'target') {
          const uid = (answer.uids || [])[0];
          const inLib = uid != null && S().zones.lib.some(c => c.uid === uid);
          if (!inLib) { game.note('Searched the library and found nothing.'); game.shuffle(); return {}; }
          if (to === 'top') { game.shuffle(); game.tutor(uid, 'libtop'); return {}; }
          const r = game.tutor(uid, to === 'bf' ? 'bf' : to);
          ctx.lastTarget = r.uid ?? uid; ctx.lastCount = 1;
          if (to === 'bf' && a.tapped && r.ok) game.tap(r.uid);
          game.shuffle();
          return {};
        }
        const cands = S().zones.lib.filter(c => matchFilter(c, a.filter, ctx));
        if (!cands.length) { game.note('Searched the library: no match.'); game.shuffle(); return {}; }
        return pickFromCards(cands, { zone: 'lib', n: 1, optional: true, distinct: true, text: `${cap(dEffect(op, frame.card))}: choose a card.` });
      }
      case 'ramp': {
        const n = N(a.n ?? 1);
        if (n <= 0) return {};
        if (n > 1) return { replace: Array.from({ length: Math.min(n, MAX_REPEAT) }, () => ({ ramp: { ...a, n: 1 } })) };
        const tapped = a.tapped !== false;
        const f = a.filter == null || a.filter === 'basic' ? { land: true, basic: true } : a.filter === 'land' ? { land: true } : { ...a.filter, land: true };
        const cands = S().zones.lib.filter(c => matchFilter(c, f, ctx));
        const put = uid => {
          if (a.to === 'hand') game.tutor(uid, 'hand'); else game.rampLand(uid, tapped);
          game.shuffle();
        };
        if (answer && answer.kind === 'target') {
          const uid = (answer.uids || [])[0];
          if (uid != null && cands.some(c => c.uid === uid)) put(uid); else { game.note('Searched the library and found nothing.'); game.shuffle(); }
          return {};
        }
        if (!cands.length) { game.note('Searched the library: no land left to find.'); game.shuffle(); return {}; }
        if (new Set(cands.map(c => c.name)).size === 1) { put(cands[0].uid); return {}; }
        return pickFromCards(cands, { zone: 'lib', n: 1, optional: false, distinct: true, text: 'Search for a land: choose which.' });
      }
      case 'return': {
        const n = N(a.n ?? 1);
        const cands = S().zones.gy.filter(c => matchFilter(c, a.filter, ctx));
        const doIt = uids => {
          ctx.lastCount = uids.length;
          for (const u of uids) {
            const r = game.returnFromGy(u, a.to || 'hand');
            ctx.lastTarget = r.uid ?? u;
            if ((a.to || 'hand') === 'bf' && a.tapped && r.ok && onBf(r.uid)) game.tap(r.uid);
          }
        };
        if (answer && answer.kind === 'target') {
          const ok = new Set(cands.map(c => c.uid));
          doIt((answer.uids || []).filter(u => ok.has(u)).slice(0, n));
          return {};
        }
        if (!cands.length || n <= 0) { game.note(`${cap(dEffect(op, frame.card))} — nothing to return.`); return {}; }
        if (!a.optional && cands.length <= n) { doIt(cands.map(c => c.uid)); return {}; }
        return pickFromCards(cands, { zone: 'gy', n, optional: !!a.optional, text: `${cap(dEffect(op, frame.card))}: choose ${a.optional ? 'up to ' : ''}${n}.` });
      }
      case 'sacrifice': return onTargets(a.target, frame, answer, op, (u, whole) => sacrificePerm(u, whole));
      case 'destroy': return onTargets(a.target, frame, answer, op, (u, whole) => { if (!hasKeyword(permCard(game, onBf(u)), 'Indestructible')) removePerm(u, 'gy', whole); });
      case 'exile': return onTargets(a.target, frame, answer, op, (u, whole) => { ctx.lastExiled = lki(onBf(u)); removePerm(u, 'ex', whole); });
      case 'bounce': return onTargets(a.target, frame, answer, op, (u, whole) => removePerm(u, 'hand', whole));
      case 'createCopy': return onTargets(a.target, frame, answer, op, u => game.copyPermanent(u));
      case 'fight': {
        frame.ops[0] = { prompt: `${cap(dEffect(op, frame.card))}.` };
        return { block: { kind: 'prompt', text: frame.ops[0].prompt } };
      }
      case 'discard': {
        const spec = a && typeof a === 'object' && !a.count && !a.of && !a.thisTurn && !a.neg ? a : { n: a };
        const hand = S().zones.hand.filter(c => matchFilter(c, spec.filter, ctx));
        const n = Math.min(N(spec.n ?? 1), hand.length);
        if (spec.random && n > 0) {
          const pool = hand.slice(), picked = [];
          for (let i = 0; i < n; i++) picked.push(pool.splice(Math.floor(game._rand() * pool.length), 1)[0]);
          for (const c of picked) game.discard(c.uid);
          ctx.lastCount = picked.length;
          return {};
        }
        if (n <= 0) return {};
        if (answer && answer.kind === 'target') {
          const ok = new Set(hand.map(c => c.uid));
          let uids = (answer.uids || []).filter(u => ok.has(u)).slice(0, n);
          for (const c of hand) { if (uids.length >= n) break; if (!uids.includes(c.uid)) uids.push(c.uid); } // short answer: fill from the left
          for (const u of uids) game.discard(u);
          ctx.lastCount = uids.length;
          return {};
        }
        if (hand.length <= n) { ctx.lastCount = hand.length; for (const c of hand.slice()) game.discard(c.uid); return {}; }
        return pickFromCards(hand, { zone: 'hand', n, optional: false, text: `Discard ${n}: choose ${plural(n, 'the card', 'the cards')}.` });
      }
      case 'prompt': {
        if (answer && answer.kind === 'prompt') { quickAction(answer, frame); return {}; }
        return { block: { kind: 'prompt', text: String(a) } };
      }
      case 'choice': {
        const opts = (a.options || []).map((o, i) => ({ id: String(i), label: o.label }));
        if (answer && answer.kind === 'choice') {
          const o = (a.options || [])[+answer.option];
          if (!o) return { block: { kind: 'choice', text: a.text, options: opts } };
          game.note(`Chose: ${o.label}.`);
          if (o.value != null) ctx.chosen = o.value;
          return { replace: clone(o.do || []) };
        }
        return { block: { kind: 'choice', text: a.text, options: opts } };
      }
      case 'repeat': {
        const n = Math.min(N(a.times), MAX_REPEAT);
        const out = [];
        for (let i = 0; i < n; i++) out.push(...clone(a.do || []));
        return { replace: out };
      }
      case 'check': return { replace: clone(evalIf(a.if, ctx) ? a.do || [] : a.else || []) };

      /* ---- extension verbs ---- */
      case 'damage': {
        const t = a.target ?? 'any';
        if (t === 'any') {
          const n = N(a.n ?? 1);
          if (answer && answer.kind === 'choice') {
            if (answer.option === 'opp') { const d = dmgToOpp(n, frame); if (d) game.oppLife(-d); }
            else if (onBf(+answer.option)) { ctx.lastTarget = +answer.option; game.damage(+answer.option, n); }
            return {};
          }
          const opts = [{ id: 'opp', label: 'The opponent' }, ...bf().filter(creatureP).map(p => ({ id: String(p.uid), label: p.name }))];
          return { block: { kind: 'choice', text: `${cap(dEffect(op, frame.card))}: choose where.`, options: opts } };
        }
        if (t === 'opponent') { const n = dmgToOpp(N(a.n ?? 1), frame); if (n) game.oppLife(-n); return {}; }
        const nf = amountFn(a.n, ctx);
        return onTargets(t, frame, answer, op, u => game.damage(u, nf()));
      }
      case 'attach': {
        const what = a.what ?? 'this';
        let uid;
        if (what === 'this' || what === 'self') uid = frame.src != null && onBf(frame.src) ? frame.src : null;
        else {
          const wt = what === 'target-equipment-you-control' ? { pick: { subtype: 'Equipment' } } : what === 'target-aura-you-control' ? { pick: { subtype: 'Aura' } } : what;
          const r = targets(wt, frame, answer, `choose what to attach`);
          if (r.block) return { block: r.block };
          uid = r.uids[0];
        }
        if (uid == null) { game.note(`${frame.card}: nothing to attach.`); return {}; }
        return { replace: [{ $attachTo: { uid, to: a.to ?? a.target ?? 'creature-you-control' } }] };
      }
      case '$attachTo': {
        const uid = a.uid;
        if (!onBf(uid)) return {};
        let host;
        if (a.to === 'this' || a.to === 'self') host = frame.src;
        else {
          const tt = a.to === 'creature-you-control' ? { pick: { creature: true } } : a.to;
          const f = tt && tt.pick ? { ...tt, pick: { ...tt.pick } } : tt;
          const r = targets(f, { ...frame, ctx: { ...(frame.ctx || {}), src: uid } }, answer, `attach ${onBf(uid).name} to`);
          if (r.block) { r.block.options = r.block.options.filter(o => o.id !== uid); return r.block.options.length ? { block: r.block } : {}; }
          host = r.uids.find(u => u !== uid);
        }
        if (host == null || !onBf(host)) { game.note(`${onBf(uid).name}: no creature to attach to.`); return {}; }
        game.attach(uid, host);
        return {};
      }
      case 'unattach': { if (frame.src != null && onBf(frame.src)) game.attach(frame.src, null); return {}; }
      case 'investigate': { const n = N(a); if (n > 0) game.createToken('Clue', n, { types: ['Artifact', 'Clue'] }); return {}; }
      case 'amass': {
        const n = N(a.n ?? 1);
        let army = bf().find(p => p.tok && (/\bArmy\b/i.test(p.name) || (p.tokTypes || []).includes('Army')));
        if (!army) {
          const ty = refStr(a.type, ctx) || 'Zombie';
          const r = game.createToken(`${ty} Army`, 1, { power: 0, toughness: 0, types: ['Creature', ty, 'Army'] });
          army = onBf(r.uid);
        }
        if (army && n) game.addCounter(army.uid, 'p1p1', n);
        return {};
      }
      case 'explore': {
        const r = targets(a.target ?? 'self', frame, answer, dEffect(op, frame.card));
        if (r.block) return { block: r.block };
        if (!r.uids.length) { game.note(`${frame.card}: nothing explores (${r.none || 'no creature'}).`); return {}; }
        return { replace: r.uids.map(u => ({ $exploreOne: { uid: u } })) };
      }
      case '$exploreOne': {
        const uid = a.uid;
        if (!onBf(uid)) return {};
        game._emit('explored', { perm: onBf(uid) });
        const top = S().zones.lib[0];
        if (!top) { game.addCounter(uid, 'p1p1', 1); return {}; }
        if (isLand(cardOf(game, top.name))) { game.note(`Explored: revealed ${top.name}, a land.`); game.move(top.uid, 'hand'); return {}; }
        game.note(`Explored: revealed ${top.name}.`);
        game.addCounter(uid, 'p1p1', 1);
        return { replace: [{ $exploreKeep: { uid: top.uid, name: top.name } }] };
      }
      case '$exploreKeep': {
        if (answer && answer.kind === 'choice') {
          if (answer.option === 'gy' && S().zones.lib.some(c => c.uid === a.uid)) game.move(a.uid, 'gy');
          return {};
        }
        return { block: { kind: 'choice', text: `Explore revealed ${a.name}: keep it on top, or put it into your graveyard?`, options: [{ id: 'top', label: 'Keep on top' }, { id: 'gy', label: 'Put into graveyard' }] } };
      }
      case 'proliferate': {
        const cands = bf().filter(p => Object.values(p.counters || {}).some(v => v > 0));
        if (answer && answer.kind === 'target') {
          for (const u of answer.uids || []) {
            const p = onBf(u);
            if (p) for (const [k, v] of Object.entries(p.counters)) if (v > 0) game.addCounter(u, k, 1);
          }
          return {};
        }
        if (!cands.length) { game.note('Proliferate: nothing has counters.'); return {}; }
        return pickFromCards(cands, { zone: 'bf', n: cands.length, optional: true, text: 'Proliferate: choose any number of permanents (each gets one more of each counter it has).' });
      }
      case 'monarch': game.setMonarch(true); return {};
      case 'ringTempt': {
        game.ringTempt();
        return { replace: [{ $chooseBearer: {} }] };
      }
      case 'earthbend': {
        const n = N(a.n ?? 1);
        const r = onTargets(a.target ?? 'land-you-control', frame, answer, op, u => { game.animate(u, { p: 0, t: 0, kw: ['Haste'] }); if (n) game.addCounter(u, 'p1p1', n); });
        if (!r.block) bent('earth', n);
        return r;
      }
      case 'airbend': {
        const r = onTargets(a.target, frame, answer, op, u => { const nm = onBf(u).name; game.move(u, 'ex'); game.note(`${nm} may be cast from exile for {2} (by hand).`); });
        if (!r.block) bent('air', 0);
        return r;
      }
      case 'firebend': { const n = N(a); if (n > 0) game.addMana('R', n); bent('fire', n); return {}; }
      case 'waterbend': {
        if (!canWaterbend(a, frame.src)) { game.note(`Could not waterbend ${a}.`); return {}; }
        payWaterbend(a, frame.src);
        return {};
      }
      case 'lookTop': {
        const n = Math.min(N(a.n), S().zones.lib.length);
        if (n <= 0) return {};
        const top = S().zones.lib.slice(0, n);
        const pk = a.pick || { to: 'hand', n: 1 };
        const k = pk.n == null ? 1 : N(pk.n);
        const elig = top.filter(c => matchFilter(c, pk.filter, ctx));
        const finish = chosen => {
          ctx.lastCount = chosen.length;
          for (const u of chosen) { if (pk.to === 'cast') castFreeFromLibrary(u); else libTo(u, pk.to || 'hand', !!pk.tapped); }
          for (const c of top) if (!chosen.includes(c.uid) && S().zones.lib.some(x => x.uid === c.uid)) libTo(c.uid, a.rest || 'bottom');
          return {};
        };
        if (answer && answer.kind === 'target') {
          const ok = new Set(elig.map(c => c.uid));
          return finish((answer.uids || []).filter(u => ok.has(u)).slice(0, k));
        }
        if (!elig.length || k <= 0) { game.note(`Looked at ${top.map(c => c.name).join(', ')}: nothing to take.`); return finish([]); }
        return pickFromCards(elig, { zone: 'lib', n: k, optional: true, text: `Look at the top ${n} (${top.map(c => c.name).join(', ')}): choose up to ${k} to put ${{ hand: 'into your hand', bf: 'onto the battlefield', gy: 'into your graveyard', top: 'back on top', bottom: 'on the bottom' }[pk.to || 'hand'] || pk.to}; the rest go ${{ bottom: 'to the bottom', top: 'back on top', gy: 'to the graveyard', ex: 'to exile', hand: 'to your hand' }[a.rest || 'bottom']}.` });
      }
      case 'revealTop': {
        const n = Math.min(N(a.n), S().zones.lib.length);
        if (n <= 0) return {};
        const top = S().zones.lib.slice(0, n);
        const hit = top.filter(c => matchFilter(c, a.filter, ctx));
        game.note(`Revealed ${top.map(c => c.name).join(', ')}.`);
        ctx.lastCount = hit.length;
        for (const c of hit) libTo(c.uid, a.to || 'hand', !!a.tapped);
        for (const c of top) if (!hit.includes(c)) libTo(c.uid, a.rest || 'bottom');
        return {};
      }
      case 'extraLand': { const n = N(a); if (n > 0) game.extraLand(n); return {}; }
      case 'castFree': {
        const cands = S().zones.hand.filter(c => { const cd = cardOf(game, c.name); return (!isLand(cd) || isCreature(cd)) && matchFilter(c, a.filter, ctx); });
        if (answer && answer.kind === 'target') {
          const uid = (answer.uids || [])[0];
          if (uid != null && cands.some(c => c.uid === uid)) game.cast(uid, { pay: false, force: true });
          return {};
        }
        if (!cands.length) { game.note('No card in hand can be cast this way.'); return {}; }
        return pickFromCards(cands, { zone: 'hand', n: 1, optional: true, text: `${cap(dEffect(op, frame.card))}: choose a card (or none).` });
      }
      case 'choose': {
        const store = a.store || 'chosen';
        if (answer && answer.kind === 'choice') {
          if (frame.src != null && onBf(frame.src)) game.choose(frame.src, store, answer.option);
          else ctx.choices = { ...(ctx.choices || {}), [store]: answer.option };
          return {};
        }
        const opts = a.kind === 'color'
          ? ['W', 'U', 'B', 'R', 'G'].map(c => ({ id: c, label: cap(COLOR_WORD[c]) }))
          : deckCreatureTypes().map(t => ({ id: t, label: t }));
        if (!opts.length) { game.note('No creature types to choose from.'); return {}; }
        return { block: { kind: 'choice', text: `${frame.card}: choose a ${a.kind === 'color' ? 'colour' : 'creature type'}.`, options: opts } };
      }
      case 'removeCounters': {
        const kind = a.kind || 'p1p1';
        return onTargets(a.target, frame, answer, op, u => {
          const p = onBf(u); const have = p.counters[kind] || 0;
          const n = a.n === 'all' ? have : Math.min(have, evalCount(a.n ?? 1, ctx));
          ctx.lastCount = n;
          if (n > 0) game.addCounter(u, kind, -n);
        });
      }
      case 'doubleCounters': {
        const kind = a.kind || 'p1p1';
        if (a.target === 'you') { const have = (S().counters || {})[kind] || 0; if (have) game.addPlayerCounter(kind, have); return {}; }
        return onTargets(a.target, frame, answer, op, u => { const have = onBf(u).counters[kind] || 0; if (have) game.addCounter(u, kind, have); });
      }
      case 'moveCounters': {
        const r = targets(a.from ?? 'self', frame, answer, 'choose where the counters come from');
        if (r.block) return { block: r.block };
        const from = r.uids[0];
        if (from == null) { game.note(`${frame.card}: no counters to move.`); return {}; }
        return { replace: [{ $moveCountersTo: { from, to: a.to ?? 'creature-you-control', kind: a.kind || 'p1p1', n: a.n ?? 'all' } }] };
      }
      case '$moveCountersTo': {
        const r = targets(a.to, { ...frame, ctx: { ...ctx, src: a.from } }, answer, 'choose where the counters go');
        if (r.block) { r.block.options = r.block.options.filter(o => o.id !== a.from); return r.block.options.length ? { block: r.block } : {}; }
        const to = r.uids.find(u => u !== a.from);
        const p = onBf(a.from);
        if (to == null || !p) return {};
        const have = p.counters[a.kind] || 0;
        const n = a.n === 'all' ? have : Math.min(have, evalCount(a.n, ctx));
        if (n > 0) { game.addCounter(a.from, a.kind, -n); game.addCounter(to, a.kind, n); }
        ctx.lastCount = n;
        return {};
      }
      case 'pay': {
        const why = cannotPay(a, frame.src, ctx);
        if (why) { game.note(`${frame.card}: can't pay ${dCostFull(a)} — skipped.`); return { abort: true }; }
        if (answer && answer.kind === 'choice') {
          if (answer.option !== 'pay') { game.note(`${frame.card}: declined to pay.`); return { abort: true }; }
          return { replace: payNow(a, frame.src) };
        }
        return { block: { kind: 'choice', text: `${frame.card}: pay ${dCostFull(a)}?`, options: [{ id: 'pay', label: `Pay ${dCostFull(a)}` }, { id: 'skip', label: "Don't pay" }] } };
      }
      case '$payPick': {
        const pool = costPool(a.kind, a, frame.src, ctx);
        const n = a.n;
        const act = uids => {
          ctx.lastCount = 0;
          for (const u of uids) {
            if (a.kind === 'sac') { const p = onBf(u); if (p) { ctx.lastDied = lki(p); game.sacrifice(u); ctx.lastCount++; } }
            else if (a.kind === 'tapUntapped') { if (onBf(u) && !onBf(u).tapped) { game.tap(u); ctx.lastCount++; } }
            else if (a.kind === 'discard') { game.discard(u); ctx.lastCount++; }
            else if (a.kind === 'exileFromGy') { game.move(u, 'ex'); ctx.lastCount++; }
          }
        };
        if (answer && answer.kind === 'target') { act(answer.uids || []); return {}; }
        if (poolSize(a.kind, pool) <= n && !(a.kind === 'sac' && pool.some(p => p.tok && p.n > 1))) { act(pool.map(p => p.uid)); return {}; }
        const zone = a.kind === 'discard' ? 'hand' : a.kind === 'exileFromGy' ? 'gy' : 'bf';
        const verbTxt = { sac: 'Sacrifice', tapUntapped: 'Tap', discard: 'Discard', exileFromGy: 'Exile from your graveyard' }[a.kind];
        const blk = pickFromCards(pool, { zone, n: Math.min(n, pool.length), optional: false, text: `${frame.card} — cost: ${verbTxt} ${n}.` });
        return blk;
      }
      case 'delay': scheduleDelay(a.at || 'endStep', frame, a.do || []); return {};
      case 'putFromHand': {
        const n = N(a.n ?? 1);
        const cands = S().zones.hand.filter(c => matchFilter(c, a.filter, ctx));
        const put = uids => {
          ctx.lastCount = uids.length;
          for (const u of uids) {
            if (a.to === 'bf') { const r = game.move(u, 'bf'); if (r.ok && a.tapped && onBf(r.uid)) game.tap(r.uid); ctx.lastTarget = r.uid; }
            else game.move(u, 'lib', { top: (a.to || 'libtop') === 'libtop' });
          }
        };
        if (answer && answer.kind === 'target') { const ok = new Set(cands.map(c => c.uid)); put((answer.uids || []).filter(u => ok.has(u)).slice(0, n)); return {}; }
        if (!cands.length || n <= 0) { game.note(`${frame.card}: nothing in hand to put.`); return {}; }
        if (!a.optional && cands.length <= n) { put(cands.map(c => c.uid)); return {}; }
        return pickFromCards(cands, { zone: 'hand', n: Math.min(n, cands.length), optional: !!a.optional, text: `${cap(dEffect(op, frame.card))}: choose.` });
      }
      case 'exileFromGy': {
        const n = N(a.n ?? 1);
        const cands = S().zones.gy.filter(c => matchFilter(c, a.filter, ctx));
        const go = uids => { ctx.lastCount = uids.length; for (const u of uids) game.move(u, 'ex'); };
        if (answer && answer.kind === 'target') { const ok = new Set(cands.map(c => c.uid)); go((answer.uids || []).filter(u => ok.has(u)).slice(0, n)); return {}; }
        if (!cands.length || n <= 0) { game.note(`${frame.card}: nothing to exile from the graveyard.`); return {}; }
        if (cands.length <= n && !a.optional) { go(cands.map(c => c.uid)); return {}; }
        return pickFromCards(cands, { zone: 'gy', n: Math.min(n, cands.length), optional: !!a.optional, text: `${cap(dEffect(op, frame.card))}: choose.` });
      }
      case 'castFromGy': {
        const n = N(a.n ?? 1);
        const until = a.until === 'permanent' ? null : S().turn;
        const cands = S().zones.gy.filter(c => matchFilter(c, a.filter, ctx));
        const grant = uids => { ctx.lastCount = uids.length; for (const u of uids) game.grantPlayable(u, { until, exileAfter: !!a.exileAfter }); };
        if (a.all) { grant(cands.map(c => c.uid)); return {}; }
        if (answer && answer.kind === 'target') { const ok = new Set(cands.map(c => c.uid)); grant((answer.uids || []).filter(u => ok.has(u)).slice(0, n)); return {}; }
        if (!cands.length) { game.note(`${frame.card}: no card in the graveyard qualifies.`); return {}; }
        return pickFromCards(cands, { zone: 'gy', n: Math.min(n, cands.length), optional: true, text: `${cap(dEffect(op, frame.card))}: choose.` });
      }
      case 'exileTop': {
        const n = N(typeof a === 'object' && a ? a.n ?? 1 : a);
        if (n <= 0) return {};
        if (typeof a === 'object' && a && a.hideaway) {
          const top = S().zones.lib.slice(0, n);
          if (!top.length) return {};
          return { replace: [{ $hideaway: { uids: top.map(c => c.uid) } }] };
        }
        const r = game.exileTop(n);
        if (!r.ok) return {};
        ctx.lastCount = r.cards.length;
        if (r.cards.length) ctx.lastExiled = cardInfo(r.cards[r.cards.length - 1]);
        const play = typeof a === 'object' && a ? a.play : null;
        if (play) for (const c of r.cards) game.grantPlayable(c.uid, { until: S().turn + (play === 'nextTurn' ? 1 : 0) });
        return {};
      }
      case 'chooseNumber': {
        if (answer && answer.kind === 'x') { ctx.chosen = Math.max(a.min ?? 0, Math.min(a.max ?? 99, answer.x)); game.note(`Chose ${ctx.chosen}.`); return {}; }
        return { block: { kind: 'x', text: a.text || `${frame.card}: choose a number${a.max != null ? ` (${a.min ?? 0}–${a.max})` : ''}.`, store: 'chosen' } };
      }
      case 'noUntap': return onTargets(a.target, frame, answer, op, u => game.setNoUntap(u, { next: !!a.next }));
      case 'setBase': {
        const pf = amountFn(a.p, ctx, 0), tf = amountFn(a.t, ctx, 0);
        return onTargets(a.target, frame, answer, op, u => game.setBase(u, pf(), tf(), { eot: a.until !== 'permanent' }));
      }
      case 'revealUntil': {
        const lib = S().zones.lib;
        const revealed = [];
        let hit = null;
        for (const c of lib) { revealed.push(c); if (matchFilter(c, a.filter, ctx)) { hit = c; break; } }
        game.note(`Revealed ${revealed.map(c => c.name).join(', ') || 'nothing'}${hit ? '' : ' — no match'}.`);
        const rest = revealed.filter(c => c !== hit);
        const casting = a.to === 'cast' || a.to === 'castFree';
        const restTo = { bottom: 'bottom', gy: 'gy', exile: 'ex' }[a.rest || 'bottom'];
        if (casting && (a.rest || 'bottom') === 'bottom') game.bottomRandom(rest.map(c => c.uid));
        else for (const c of rest) if (S().zones.lib.some(x => x.uid === c.uid)) libTo(c.uid, restTo);
        ctx.lastCount = hit ? 1 : 0;
        if (!hit) return {};
        ctx.lastTarget = hit.uid;
        if (casting) return { replace: [{ $castOrRest: { uid: hit.uid, name: hit.name, rest: a.rest || 'bottom' } }] };
        libTo(hit.uid, a.to || 'hand', !!a.tapped);
        return {};
      }
      case 'moveSelf': {
        const uid = ctx.selfCard ?? frame.src;
        const here = uid != null && ['hand', 'gy', 'ex', 'lib', 'bf'].some(z => S().zones[z].some(c => c.uid === uid));
        if (!here) { game.note(`${frame.card}: it's no longer there.`); return {}; }
        const to = a.to || 'hand';
        if (to === 'top' || to === 'bottom') { const r = game.move(uid, 'lib', { top: to === 'top' }); if (r.ok && to === 'top' && a.toIndex > 1) game.libPlace(r.uid ?? uid, a.toIndex); return {}; }
        const r = game.move(uid, { exile: 'ex' }[to] || to);
        if (r.ok && to === 'bf') { ctx.selfCard = r.uid; if (a.tapped && onBf(r.uid)) game.tap(r.uid); }
        return {};
      }
      case '$castSelf': {
        const uid = ctx.selfCard;
        const where = ['gy', 'ex', 'hand'].find(z => S().zones[z].some(c => c.uid === uid));
        if (!where) return {};
        if (where !== 'hand') game.grantPlayable(uid, { until: S().turn, exileAfter: !!a.exileAfter });
        const r = game.cast(uid, { pay: !!a.pay, force: true });
        if (!r.ok) game.note(`Could not cast ${frame.card} (${r.reason}).`);
        if (S().foretold) delete S().foretold[uid];
        return {};
      }
      case '$foretellSelf': { if (ctx.selfCard != null) game.foretell(ctx.selfCard); return {}; }
      case '$encore': {
        const r = game.createCopyToken(frame.card, 1);
        if (r.ok && onBf(r.uid)) {
          game.grantEot(r.uid, { kw: ['Haste'] });
          scheduleDelay('endStep', { ...frame, src: r.uid, ctx: { ...ctx, src: r.uid } }, [{ sacrifice: { target: 'self' } }]);
        }
        return {};
      }
      case '$castFace': {
        const sc = scriptFor(frame.card) || {};
        const f = (sc.faces || {})[a.face];
        const uid = ctx.selfCard;
        if (!f) return {};
        game.note(`Cast ${a.face}.`);
        game._emit('cast', { card: { uid, name: frame.card, face: a.face }, kind: String(f.type || 'Sorcery').toLowerCase(), from: S().zones.gy.some(c => c.uid === uid) ? 'gy' : 'hand' });
        return { replace: [...clone(f.spell || []), { $faceDone: { kind: f.kind || 'split' } }] };
      }
      case '$faceDone': {
        const uid = ctx.selfCard;
        if (a.kind === 'adventure') {
          if (S().zones.hand.some(c => c.uid === uid)) { game.move(uid, 'ex'); game.grantPlayable(uid, { until: null }); game.note(`${frame.card} goes on an adventure (castable from exile).`); }
        } else if (a.kind === 'aftermath') { if (S().zones.gy.some(c => c.uid === uid)) game.move(uid, 'ex'); }
        else if (S().zones.hand.some(c => c.uid === uid)) game.move(uid, 'gy');
        return {};
      }
      case 'stripAbilities': return onTargets(a.target, frame, answer, op, u => game.setLayer(u, 'stripped', true, { eot: a.until === 'eot' }));
      case 'becomeCopy': {
        let nm = null;
        if (a.of && typeof a.of === 'object' && a.of.name) nm = a.of.name;
        else if (a.of === 'triggering') nm = ctx.trigName || (ctx.trig != null && onBf(ctx.trig) ? onBf(ctx.trig).name : null);
        else if (a.of === 'this' || a.of === 'self') nm = frame.card;
        else {
          const r = targets(a.of, frame, answer, 'choose what to copy');
          if (r.block) return { block: r.block };
          nm = r.uids[0] != null && onBf(r.uids[0]) ? scriptlessName(onBf(r.uids[0])) : null;
        }
        if (!nm) { game.note(`${frame.card}: nothing to copy.`); return {}; }
        return { replace: [{ $becomeCopy: { name: nm, target: a.target, until: a.until } }] };
      }
      case '$becomeCopy': return onTargets(a.target, frame, answer, op, u => game.setLayer(u, 'copyOf', a.name, { eot: a.until === 'eot' }));
      case 'addSubtype': {
        const sub = refStr(a.subtype, ctx);
        if (sub == null) { game.note(`${frame.card}: no ${a.subtype} chosen yet.`); return {}; }
        return onTargets(a.target, frame, answer, op, u => game.addSubtype(u, sub));
      }
      case 'emblem': game.addEmblem(a.name || `${frame.card} emblem`, { statics: a.statics || [], triggers: a.triggers || [] }); return {};
      case 'lose': game.lose(typeof a === 'string' ? a : frame.card); return {};
      case 'putFromLib': {
        const idx = Math.max(1, N(a.index ?? 1));
        const c = S().zones.lib[idx - 1];
        if (!c) { game.note('The library is too small.'); return {}; }
        ctx.lastTarget = c.uid;
        if (a.to === 'cast') castFreeFromLibrary(c.uid);
        else if (a.toIndex != null || a.to === 'top') game.libPlace(c.uid, a.toIndex ?? 1);
        else libTo(c.uid, { exile: 'ex' }[a.to] || a.to || 'hand', !!a.tapped);
        return {};
      }
      case '$hideaway': {
        const inLib = a.uids.filter(u => S().zones.lib.some(c => c.uid === u));
        if (!inLib.length) return {};
        if (answer && answer.kind === 'target') {
          const pick = (answer.uids || []).find(u => inLib.includes(u)) ?? inLib[0];
          const c = S().zones.lib.find(x => x.uid === pick);
          game.hideaway(frame.src, pick);
          ctx.lastExiled = cardInfo(c);
          game.bottomRandom(inLib.filter(u => u !== pick));
          return {};
        }
        return pickFromCards(inLib.map(u => S().zones.lib.find(c => c.uid === u)), { zone: 'lib', n: 1, optional: false, text: `Hideaway: choose a card to exile face down with ${frame.card} (the rest go to the bottom).` });
      }
      case 'castHidden': {
        const src = frame.src != null ? onBf(frame.src) : null;
        const uid = src && (src.hidden || []).find(u => S().zones.ex.some(c => c.uid === u));
        if (uid == null) { game.note(`${frame.card}: nothing hidden to cast.`); return {}; }
        src.hidden = src.hidden.filter(u => u !== uid);
        const card = cardOf(game, S().zones.ex.find(c => c.uid === uid).name);
        game.grantPlayable(uid, { until: S().turn });
        if (isLand(card) && !isCreature(card)) game.move(uid, 'bf');
        else game.cast(uid, { pay: false, force: true, x: 0 });
        return {};
      }
      case '$chooseBearer': {
        const r = targets({ pick: { creature: true } }, frame, answer, 'choose your Ring-bearer');
        if (r.block) return { block: r.block };
        if (!r.uids.length) { game.note('No creature to be your Ring-bearer.'); return {}; }
        game.setRingBearer(r.uids[0]);
        return {};
      }
      case '$crew': {
        const pool = crewPool(frame.src);
        const pw = q => Math.max(0, power(game, q)) * (q.tok ? q.n || 1 : 1);
        const finish = uids => {
          const chosen = pool.filter(q => uids.includes(q.uid));
          let total = chosen.reduce((t, q) => t + pw(q), 0);
          for (const q of pool.slice().sort((x, y) => pw(y) - pw(x))) { if (total >= a.n) break; if (!chosen.includes(q)) { chosen.push(q); total += pw(q); } }
          for (const q of chosen) if (onBf(q.uid) && !onBf(q.uid).tapped) game.tap(q.uid);
          ctx.lastCount = chosen.length;
          return {};
        };
        if (answer && answer.kind === 'target') return finish(answer.uids || []);
        if (pool.length <= 1) return finish(pool.map(q => q.uid));
        return { block: { kind: 'target', zone: 'bf', n: pool.length, optional: true, options: pool.map(q => ({ id: q.uid, label: `${q.name} (${pw(q)})` })), text: `Crew ${a.n}: tap creatures with total power ${a.n} or more (short picks are topped up).` } };
      }
      case 'animate': {
        const pf = amountFn(a.p, ctx, 0), tf = amountFn(a.t, ctx, 0);
        return onTargets(a.target ?? 'self', frame, answer, op, u => game.animate(u, { p: pf(), t: tf(), kw: a.kw || [], types: a.types || ['Creature'], subtypes: refList(a.subtypes, ctx), eot: a.until !== 'permanent', returns: false }));
      }
      case 'cascade': {
        const n = N(a);
        return { replace: [{ revealUntil: { filter: { nonland: true, mvLe: Math.max(0, n - 1) }, to: 'cast', rest: 'bottom' } }] };
      }
      case 'extraCombat': { const n = a === true ? 1 : N(a); if (n > 0) game.addExtraCombat(n); return {}; }
      case 'extraTurn': { const n = a === true ? 1 : N(a); if (n > 0) game.addExtraTurn(n); return {}; }
      case '$castOrRest': {
        const inLib = () => S().zones.lib.some(c => c.uid === a.uid);
        if (answer && answer.kind === 'choice') {
          if (answer.option === 'cast' && inLib()) castFreeFromLibrary(a.uid);
          else if (inLib()) { if (a.rest === 'bottom') game.bottomRandom([a.uid]); else libTo(a.uid, { gy: 'gy', exile: 'ex' }[a.rest] || 'bottom'); }
          return {};
        }
        if (!inLib()) return {};
        return { block: { kind: 'choice', text: `Cast ${a.name} without paying its mana cost?`, options: [{ id: 'cast', label: `Cast ${a.name}` }, { id: 'no', label: "Don't cast" }] } };
      }
      case 'transform': {
        const t = a.target ?? 'this';
        return onTargets(t === 'this' ? 'self' : t, frame, answer, op, u => { const r = game.transform(u); if (!r.ok) game.note(`${onBf(u).name} can't transform (${r.reason}).`); });
      }
      case 'win': game.win(typeof a === 'string' ? a : `${frame.card}`); return {};
      case '$returnTapped': {
        let r;
        if (a.zone === 'gy') r = game.returnFromGy(a.uid, 'bf');
        else if (S().zones.ex.some(c => c.uid === a.uid)) r = game.move(a.uid, 'bf');
        if (r && r.ok) game.tap(r.uid);
        return {};
      }
      default: return unknownStep(op, frame);
    }
  }

  function unknownStep(op, frame) {
    const text = `${frame.text || frame.card} — resolve by hand (this step is not automated: ${JSON.stringify(op)}).`;
    frame.ops[0] = { prompt: text };
    return { block: { kind: 'prompt', text } };
  }

  function quickAction(answer, frame) {
    switch (answer.quick) {
      case 'draw': game.draw(answer.n || 1); break;
      case 'p1p1': {
        const uid = answer.uid ?? (frame.src != null && onBf(frame.src) ? frame.src : (bf().find(creatureP) || {}).uid);
        if (uid != null) game.addCounter(uid, 'p1p1', answer.n || 1);
        break;
      }
      case 'token': game.createToken(answer.name || '1/1 Soldier', answer.n || 1, { power: answer.power, toughness: answer.toughness }); break;
      case 'life': game.life(answer.delta ?? 1); break;
      default: break;
    }
  }

  // Run a frame's ops until done or blocked. A block inserts a Pending at index `at`.
  let runningFrame = null;
  function runFrame(frame, answer, at = 0) {
    const prevRunning = runningFrame;
    runningFrame = frame;
    try { return runFrameInner(frame, answer, at); } finally { runningFrame = prevRunning; }
  }
  function runFrameInner(frame, answer, at) {
    let steps = 0;
    frame.ctx = frame.ctx || {};
    if (frame.ctx.src === undefined && frame.src != null) frame.ctx.src = frame.src;
    if (frame.ctx.card === undefined) frame.ctx.card = frame.card;
    while (frame.ops && frame.ops.length) {
      if (++steps > MAX_STEPS) { game.note(`${frame.card}: stopped after ${MAX_STEPS} steps.`); frame.ops = []; break; }
      const op = frame.ops[0];
      let r;
      try { r = exec(op, frame, answer) || {}; }
      catch (e) {
        if (e === NEED_X) r = { block: { kind: 'x', text: `Choose the value of X for ${frame.card}.` } };
        else {
          const text = `${frame.text || frame.card} — resolve by hand (the rules engine could not run ${JSON.stringify(op)}: ${e && e.message}).`;
          frame.ops[0] = { prompt: text };
          r = { block: { kind: 'prompt', text } };
        }
      }
      answer = undefined;
      if (r.block) {
        const l = pendingList();
        l.splice(Math.min(at, l.length), 0, makePending(frame, r.block));
        return 'blocked';
      }
      frame.ops.shift();
      if (r.abort) { frame.ops = []; break; }
      if (r.replace && r.replace.length) frame.ops.unshift(...r.replace);
    }
    return 'done';
  }

  /* ================= trigger matching ================= */
  function eventObjects(ev, payload) {
    switch (ev) {
      case 'enters': return payload.perm ? [{ e: payload.perm, times: payload.from === 'token' ? Math.min(payload.n || 1, MAX_PER_OBJECT) : 1, amount: 1 }] : [];
      case 'leaves': case 'dies':
        return payload.perm ? [{ e: payload.perm, times: payload.perm.tok ? Math.min(payload.perm.n || 1, MAX_PER_OBJECT) : 1, amount: 1 }] : [];
      case 'landPlayed': case 'tapped': case 'untapped': case 'sacrificed': case 'attached': case 'explored':
        return payload.perm ? [{ e: payload.perm, times: 1, amount: 1 }] : [];
      case 'damaged': return payload.perm ? [{ e: payload.perm, times: 1, amount: payload.amount || 0 }] : [];
      case 'discarded': return payload.card ? [{ e: payload.card, times: 1, amount: 1 }] : [];
      case 'counters': return payload.perm ? [{ e: payload.perm, times: 1, amount: payload.delta }] : [];
      case 'tokenCreated': return payload.perm ? [{ e: payload.perm, times: 1, amount: payload.n || 1 }] : [];
      case 'attacks': return (payload.perms || []).map(p => ({ e: p, times: 1, amount: 1 }));
      case 'combatDamage': return (payload.byPerm || []).map(b => ({ e: b.perm, times: 1, amount: b.dmg }));
      case 'cast': return payload.card ? [{ e: { ...payload.card, castFrom: payload.from }, times: 1, amount: 1 }] : [];
      case 'resolved': case 'cycled': return payload.card ? [{ e: payload.card, times: 1, amount: 1 }] : [];
      case 'targeted': return payload.perm ? [{ e: payload.perm, times: 1, amount: 1 }] : [];
      default: return [];
    }
  }

  function limitKey(srcKey, kind, idx) { return `${srcKey}:${kind}${idx}`; }
  function limitOk(key) { const l = S().ruleLimits || {}; return l[key] !== S().turn; }
  function markLimit(key) { (S().ruleLimits ||= {})[key] = S().turn; }

  // Which triggers of one source match this event? Pushes frames into `out`.
  function matchSource(ev, payload, srcEntry, srcUid, sc, out, zone = 'bf') {
    const triggers = sc.triggers || [];
    triggers.forEach((tr, idx) => {
      if (!tr || !Array.isArray(tr.do)) return;
      if (zone !== 'any' && (tr.zone || 'bf') !== zone) return;
      let on = tr.on;
      // step triggers ride on the phase event
      if (STEP_EVENTS[on]) { if (ev !== 'phase' || !STEP_EVENTS[on].includes(payload.to)) return; }
      else if (on !== ev) return;
      const baseCtx = { src: srcUid, card: srcEntry.name, ev };
      if (zone !== 'bf' && zone !== 'any') baseCtx.selfCard = srcEntry.uid;
      if (srcEntry.attachedTo != null) baseCtx.attachedTo = srcEntry.attachedTo; // look-back for "enchanted creature dies"
      const fire = (extra, times = 1) => {
        const ctx = { ...baseCtx, ...extra };
        if (tr.if && !evalIf(tr.if, ctx)) return;
        for (let i = 0; i < times; i++) {
          const key = limitKey(srcUid ?? srcEntry.name, 't', idx);
          if (tr.limit === 'once-per-turn') { if (!limitOk(key)) return; markLimit(key); }
          const ops = tr.cost ? [{ pay: clone(tr.cost) }, ...clone(tr.do)] : clone(tr.do);
          out.push({ frame: { card: srcEntry.name, src: srcUid, text: tr.text || dTrigger(tr, srcEntry.name), ctx, ops }, optional: !!tr.optional && !tr.cost });
        }
      };
      if (on === 'expend') {
        if (tr.n != null && !list(tr.n).includes(payload.n)) return;
        return fire({ amount: payload.n });
      }
      if (on === 'chapter') {
        if (!payload.perm || payload.perm.uid !== srcUid) return;
        if (tr.n != null && !list(tr.n).includes(payload.n)) return;
        return fire({ amount: payload.n, trig: srcUid, trigName: srcEntry.name });
      }
      if (STEP_EVENTS[on] || on === 'turnStart') return fire({});
      if (on === 'drew') return fire({ amount: (payload.cards || []).length });
      if (on === 'scryed' || on === 'surveiled') return fire({ amount: payload.n || 0 });
      if (on === 'tempted') return fire({ amount: payload.count || 0 });
      if (on === 'nthDraw') {
        if (tr.filter && tr.filter.index != null && tr.filter.index !== payload.index) return;
        return fire({ amount: payload.index });
      }
      if (on === 'attackedWith') {
        if (tr.filter && tr.filter.countGe != null && !(payload.count >= tr.filter.countGe)) return;
        return fire({ amount: payload.count });
      }
      if (on === 'bent') {
        if (tr.filter && tr.filter.kind != null && !list(tr.filter.kind).includes(payload.kind)) return;
        return fire({ amount: payload.n || 0 });
      }
      if (on === 'life') {
        const f = tr.filter || {};
        const who = f.who || 'you';
        if (payload.who !== who) return;
        if (f.gain && !(payload.delta > 0)) return;
        if (f.lose && !(payload.delta < 0)) return;
        return fire({ amount: Math.abs(payload.delta || 0) });
      }
      const objs = eventObjects(ev, payload);
      if (on === 'counters') {
        if (!(payload.delta > 0)) return;
        if (tr.filter && tr.filter.kind && tr.filter.kind !== payload.kind) return;
      }
      const filt = tr.filter ? Object.fromEntries(Object.entries(tr.filter).filter(([k]) => k !== 'kind')) : null;
      const trigInfo = o => {
        const info = { trig: o.e.uid, trigName: o.e.name, trigPower: isPerm(o.e) ? power(game, o.e) : num(cardFor(o.e).power),
          trigToughness: isPerm(o.e) ? toughness(game, o.e) : num(cardFor(o.e).toughness), amount: o.amount };
        if (isPerm(o.e)) {
          info.trigInfo = lki(o.e); // counters / mod / eot as it last existed (Chasm Skulker, The Ozolith)
          if (ev === 'dies' || ev === 'leaves' || ev === 'sacrificed') info.lastDied = info.trigInfo;
        }
        return info;
      };
      const isSelf = x => (srcUid != null ? x.e.uid === srcUid : x.e.name === srcEntry.name && x.e.uid === srcEntry.uid);
      if (tr.selfOr) { // "Whenever ~ or another Elf enters"
        const m = objs.filter(o => isSelf(o) || matchFilter(o.e, tr.selfOr, baseCtx));
        if (PER_OBJECT.has(on)) for (const o of m) fire(trigInfo(o), o.times);
        else if (m.length) fire(trigInfo(m[0]));
        return;
      }
      if (tr.self) {
        const o = objs.find(isSelf);
        if (o) fire(trigInfo(o));
        return;
      }
      const matching = objs.filter(o => matchFilter(o.e, filt, baseCtx));
      if (!matching.length) return;
      if (PER_OBJECT.has(on) && !((on === 'attacks' || on === 'combatDamage') && !tr.filter)) {
        for (const o of matching) fire(trigInfo(o), o.times);
      } else {
        const o = matching[0];
        const amount = on === 'combatDamage' ? payload.total : o.amount;
        fire({ ...trigInfo(o), amount });
      }
    });
  }

  function collect(ev, payload) {
    const out = [];
    const safe = (fn) => { try { fn(); } catch (e) { if (typeof console !== 'undefined') console.error('[rules] trigger match:', e); } };
    // the spell itself: "when you cast this" + its resolution
    if ((ev === 'cast' || ev === 'resolved') && payload.card) {
      const sc = scriptFor(payload.card.name);
      if (sc) {
        const entry = { uid: payload.card.uid, name: payload.card.name };
        if (ev === 'resolved' && Array.isArray(sc.spell) && sc.spell.length) {
          out.push({ frame: { card: entry.name, src: null, text: `${entry.name}: ${dEffects(sc.spell, entry.name)}.`, ctx: { trig: entry.uid, trigName: entry.name, x: payload.x == null ? undefined : payload.x }, ops: clone(sc.spell) } });
        }
        safe(() => matchSource(ev, payload, entry, null, { triggers: (sc.triggers || []).map(t => (t && t.self && !t.zone ? t : null)) }, out, 'any'));
        for (const it of out) if (it.frame.ctx && payload.x != null) it.frame.ctx.x = payload.x;
      }
    }
    // leaves-the-battlefield abilities look back: the leaving permanent's own triggers
    if ((ev === 'leaves' || ev === 'dies' || ev === 'sacrificed') && payload.perm) {
      const sc = scriptOfPerm(payload.perm);
      if (sc) safe(() => matchSource(ev, payload, payload.perm, payload.perm.uid, sc, out));
    }
    for (const p of bf().slice()) {
      if ((ev === 'leaves' || ev === 'dies' || ev === 'sacrificed') && payload.perm && p.uid === payload.perm.uid) continue;
      const sc = scriptOfPerm(p);
      if (!sc || !sc.triggers || !sc.triggers.length) continue;
      // a copy doesn't run its own "when this enters" abilities unless the script opts in
      if (ev === 'enters' && p.copy && payload.perm && payload.perm.uid === p.uid && !sc.copiesTrigger) continue;
      safe(() => matchSource(ev, payload, p, p.uid, sc, out));
    }
    // cards in hand / graveyard with zone triggers ("when you cycle or discard this card")
    if (zoneTriggerNames.size) {
      for (const [zone, list2] of [['hand', S().zones.hand], ['gy', S().zones.gy]]) {
        for (const c of list2.slice()) {
          if (!zoneTriggerNames.has(c.name)) continue;
          safe(() => matchSource(ev, payload, c, null, scriptFor(c.name), out, zone));
        }
      }
    }
    // emblems
    for (const em of S().emblems || []) safe(() => matchSource(ev, payload, { uid: null, name: em.name }, null, em.script || {}, out));
    // the Ring: tier abilities of the Ring-bearer
    const bearer = S().ringBearer != null ? onBf(S().ringBearer) : null;
    if (bearer) safe(() => matchSource(ev, payload, { uid: bearer.uid, name: 'The Ring' }, bearer.uid, ringScript(), out));
    // delayed triggers whose moment has come
    if (ev === 'phase' && Array.isArray(S().delayed) && S().delayed.length) {
      const due = S().delayed.filter(d => d.phase === payload.to && S().turn >= d.turn);
      if (due.length) {
        S().delayed = S().delayed.filter(d => !due.includes(d));
        for (const d of due) out.push({ frame: d.frame });
      }
    }
    // a Saga's final chapter: it is sacrificed after that chapter resolves
    if (ev === 'chapter' && payload.perm) {
      const sc = scriptFor(payload.perm.name);
      const chapters = ((sc && sc.triggers) || []).filter(t => t && t.on === 'chapter').flatMap(t => list(t.n));
      if (chapters.length && payload.n >= Math.max(...chapters)) {
        out.push({ frame: { card: payload.perm.name, src: payload.perm.uid, text: `${payload.perm.name}: final chapter — sacrifice it.`, ctx: { src: payload.perm.uid }, ops: [{ sacrifice: { target: 'self' } }] } });
      }
    }
    // "As ~ enters, choose a creature type / colour" runs before its other enters triggers
    if (ev === 'enters' && payload.perm && (!payload.perm.tok || payload.perm.copy)) {
      const sc = scriptOfPerm(payload.perm);
      const ch = sc && sc.chooseOn && sc.chooseOn.enters;
      if (ch) out.unshift({ frame: { card: payload.perm.name, src: payload.perm.uid, text: `As ${payload.perm.name} enters, choose a ${ch.kind === 'color' ? 'colour' : 'creature type'}.`, ctx: { src: payload.perm.uid }, ops: [{ choose: { kind: ch.kind, store: ch.store || 'chosen' } }] } });
    }
    // earthbent lands come back tapped when they die or are exiled
    if (ev === 'leaves' && payload.perm && payload.perm.earthbent && !payload.perm.tok && (payload.to === 'gy' || payload.to === 'ex')) {
      out.push({ frame: { card: payload.perm.name, src: null, text: `${payload.perm.name} returns to the battlefield tapped (earthbend).`, ctx: {}, ops: [{ $returnTapped: { uid: payload.perm.uid, zone: payload.to } }] } });
    }
    return out;
  }

  function onEvent(ev, payload) {
    if (!attached || ev === 'triggerResolved') return;
    if (ev === 'enters' && payload && payload.perm && payload.perm.tapped && onBf(payload.perm.uid)) {
      try { if (permission('entersUntapped', payload.perm)) game.untapPerm(payload.perm.uid); } catch (e) { /* ignore */ }
    }
    if (!processing) cascade = 0; // an engine action the player took, not a rules effect
    if ((ev === 'dies') && payload && payload.perm && runningFrame) {
      runningFrame.ctx = runningFrame.ctx || {};
      try { runningFrame.ctx.lastDied = lki(payload.perm); } catch (e) { /* ignore */ }
    }
    try {
      recomputeStatics();
      const items = collect(ev, payload || {});
      for (const it of items) enqueueFrame(it.frame, { optional: it.optional });
      if (items.length) processQueue();
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[rules] event', ev, e);
    }
  }

  /* ================= public API ================= */
  function validateAnswer(p, answer) {
    if (!answer || typeof answer !== 'object') return 'answer must be an object';
    if (answer.skip) return null;
    switch (p.kind) {
      case 'trigger': return answer.done || ['resolve', 'skip'].includes(answer.option) ? null : 'trigger: {option:"resolve"|"skip"}';
      case 'target': {
        if (!Array.isArray(answer.uids)) return 'target: {uids:[...]}';
        const ok = new Set((p.options || []).map(o => o.id));
        if (answer.uids.some(u => !ok.has(u))) return 'not a legal choice';
        if (answer.uids.length > (p.n || 1)) return `choose at most ${p.n || 1}`;
        const need = p.optional ? 0 : Math.min(p.n || 1, (p.options || []).length);
        if (answer.uids.length < need) return `choose ${need}`;
        return null;
      }
      case 'choice': return (p.options || []).some(o => o.id === String(answer.option)) ? null : 'choice: {option:<id>}';
      case 'prompt': return answer.done || answer.quick ? null : 'prompt: {done:true} or {quick}';
      case 'x': return Number.isFinite(+answer.x) && +answer.x >= 0 ? null : 'x: {x:<number >= 0>}';
      default: return 'unknown pending kind';
    }
  }

  function resolve(id, answer) {
    try {
      if (processing) return { ok: false, reason: 'busy' };
      const l = pendingList();
      const i = l.findIndex(p => p.id === id);
      if (i < 0) return { ok: false, reason: 'no such pending' };
      const p = l[i];
      const bad = validateAnswer(p, answer);
      if (bad) return { ok: false, reason: bad };
      processing = true;
      try {
        doBatch(p.card, () => {
          removePending(p.id);
          if (answer.skip || (p.kind === 'trigger' && answer.option === 'skip')) { game.note('skipped.'); return; }
          const frame = clone(p.resumeWith && p.resumeWith.frame);
          if (!frame) return;
          let ans;
          if (p.kind === 'x' && p.store) ans = { kind: 'x', x: Math.floor(+answer.x) };
          else if (p.kind === 'x') { frame.ctx = frame.ctx || {}; frame.ctx.x = Math.floor(+answer.x); }
          else if (p.kind === 'target') ans = { kind: 'target', uids: answer.uids.slice() };
          else if (p.kind === 'choice') ans = { kind: 'choice', option: String(answer.option) };
          else if (p.kind === 'prompt') ans = { kind: 'prompt', ...answer };
          runFrame(frame, ans, i);
        });
      } finally { processing = false; }
      finishBatch(p.card, p.perm);
      processQueue();
      return { ok: true };
    } catch (e) {
      processing = false;
      if (typeof console !== 'undefined') console.error('[rules] resolve', e);
      return { ok: false, reason: 'error: ' + (e && e.message) };
    }
  }

  // Run an effect list as if `cardName` (optionally permanent `src`) did it — one undo step.
  function run(cardName, ops, { src = null, ctx = {}, text } = {}) {
    if (processing) return { ok: false, reason: 'busy' };
    processing = true;
    let status;
    try {
      doBatch(cardName, () => { status = runFrame({ card: cardName, src, text: text || `${cardName}: ${dEffects(ops, cardName)}.`, ctx: { ...ctx }, ops: clone(ops) }, undefined, 0); });
    } finally { processing = false; }
    finishBatch(cardName, src);
    processQueue();
    return { ok: true, status };
  }

  // An ability's home: a battlefield permanent, or a card in hand / graveyard / exile (zone abilities).
  const ZONE_NAME = { hand: 'hand', gy: 'gy', ex: 'exile' };
  function abilityHome(uid) {
    const p = onBf(uid);
    if (p) return { zone: 'bf', entry: p, sc: scriptOfPerm(p) };
    for (const z of ['hand', 'gy', 'ex']) {
      const c = S().zones[z].find(x => x.uid === uid);
      if (c) return { zone: ZONE_NAME[z], entry: c, sc: scriptFor(c.name) };
    }
    return null;
  }
  function activatable(uid) {
    const h = abilityHome(uid);
    if (!h) return [];
    const out = [];
    ((h.sc && h.sc.activated) || []).forEach((ab, index) => {
      if ((ab.zone || 'bf') !== h.zone) return;
      const why = cannotActivate(h, ab, index);
      out.push({ index, zone: h.zone, label: ab.label || dCostFull(ab.cost || {}), text: ab.text || `${dCostFull(ab.cost || {})}: ${cap(dEffects(ab.do, h.entry.name))}.`, ok: !why, reason: why || undefined });
    });
    return out;
  }
  function cannotActivate(h, ab, index, { force = false } = {}) {
    if (h && h.counters) h = { zone: 'bf', entry: h }; // old call shape: a Perm
    const c = ab.cost || {};
    const uid = h.entry.uid;
    if (ab.limit === 'once-per-turn' && !limitOk(limitKey(uid, 'a', index))) return 'once per turn';
    if (ab._foretold) { const t = (S().foretold || {})[uid]; if (t == null) return 'not foretold'; if (t >= S().turn && !force) return 'foretold this turn'; }
    if (force) return null;
    const mainPhase = ['main1', 'main2'].includes(S().phase);
    if (ab.limit === 'sorcery-speed' && !mainPhase) return 'sorcery speed';
    if (ab._castTiming && !mainPhase) {
      const type = typeof ab._castTiming === 'string' ? ab._castTiming : typeLine(cardOf(game, h.entry.name));
      if (!/\bInstant\b/.test(type) && !hasKeyword(cardOf(game, h.entry.name), 'Flash')) return 'sorcery speed';
    }
    if (h.zone !== 'bf' && (c.tap || c.sacSelf || c.removeCounters || c.crew)) return 'not on the battlefield';
    return cannotPay(c, h.zone === 'bf' ? uid : null, { src: h.zone === 'bf' ? uid : null, card: h.entry.name, selfCard: uid });
  }
  function activate(uid, index, { force = false } = {}) {
    try {
      if (processing) return { ok: false, reason: 'busy' };
      const h = abilityHome(uid);
      if (!h) return { ok: false, reason: 'not found' };
      const ab = h.sc && h.sc.activated && h.sc.activated[index];
      if (!ab || (ab.zone || 'bf') !== h.zone) return { ok: false, reason: 'no such ability' };
      const why = cannotActivate(h, ab, index, { force });
      if (why) return { ok: false, reason: why };
      const c = ab.cost || {};
      const name = h.zone === 'bf' ? h.entry.name : h.entry.name;
      processing = true;
      try {
        doBatch(name, () => {
          const onBattlefield = h.zone === 'bf';
          const picks = payNow(c, onBattlefield ? uid : null);
          if (ab.limit === 'once-per-turn') markLimit(limitKey(uid, 'a', index));
          const frame = { card: name, src: onBattlefield ? uid : null, text: ab.text || `${dCostFull(c)}: ${dEffects(ab.do, name)}.`, ctx: onBattlefield ? {} : { selfCard: uid }, ops: [...picks, ...clone(ab.do)] };
          if (c.sacSelf && onBattlefield) { frame.ctx.lastDied = lki(h.entry); game.sacrifice(uid); }
          if (c.discardSelf && h.zone === 'hand') game.discard(uid);
          if (c.exileSelf && h.zone !== 'exile') game.move(uid, 'ex');
          if (ab._cycling) game._emit('cycled', { card: { uid, name } });
          runFrame(frame, undefined, 0);
        });
      } finally { processing = false; }
      finishBatch(name, h.zone === 'bf' ? uid : null);
      processQueue();
      return { ok: true };
    } catch (e) {
      processing = false;
      if (typeof console !== 'undefined') console.error('[rules] activate', e);
      return { ok: false, reason: 'error: ' + (e && e.message) };
    }
  }

  /* ================= replacement effects + static permissions (engine hooks) ================= */
  const synthTok = p => p.tok && !p.copy && !scriptOfPerm(p);
  function ringScript() {
    const t = S().ringTempted || 0, tr = [];
    if (t >= 2) tr.push({ on: 'attacks', self: true, do: [{ draw: 1 }, { discard: 1 }], text: 'Whenever your Ring-bearer attacks, draw a card, then discard a card.' });
    if (t >= 4) tr.push({ on: 'combatDamage', self: true, do: [{ oppLoseLife: 3 }], text: 'Whenever your Ring-bearer deals combat damage to a player, each opponent loses 3 life.' });
    return { triggers: tr };
  }
  function activeReplacements(event) {
    const out = [];
    for (const p of bf()) {
      const sc = scriptOfPerm(p);
      for (const r of (sc && sc.replace) || []) if (r && r.event === event && (!r.if || evalIf(r.if, { src: p.uid, card: p.name }))) out.push({ src: p, r });
    }
    return out;
  }
  const KNOWN_TOKEN_TYPES = { clue: ['Artifact', 'Clue'], food: ['Artifact', 'Food'], treasure: ['Artifact', 'Treasure'], blood: ['Artifact', 'Blood'], map: ['Artifact', 'Map'] };
  function replaceHook(kind, info) {
    try {
      if (kind === 'tokenCreated') {
        let specs = info.map(sp => ({ ...sp, opts: { ...(sp.opts || {}) } }));
        const reps = activeReplacements('tokenCreated');
        for (const { r } of reps.filter(x => x.r.becomeAll)) {
          const names = (r.namesIn || []).map(String);
          const lower = names.map(n => n.toLowerCase());
          const next = [];
          for (const sp of specs) {
            if (!sp._all && lower.includes(String(sp.name).toLowerCase())) {
              for (const nm of names) next.push({ name: nm, n: sp.n, opts: { types: KNOWN_TOKEN_TYPES[nm.toLowerCase()] || ['Artifact', nm] }, _all: true });
            } else next.push(sp);
          }
          specs = next;
        }
        for (const sp of specs) {
          const o = sp.opts || {};
          const pseudo = { uid: -1, name: sp.name, tok: true, n: sp.n, counters: {}, tokPower: o.power, tokToughness: o.toughness, tokTypes: o.types, tokColors: o.colors, tokKw: o.kw };
          let n = sp.n;
          for (const { src, r } of reps) if (!r.becomeAll && r.add && matchFilter(pseudo, r.filter, { src: src.uid })) n += r.add;
          for (const { src, r } of reps) if (!r.becomeAll && r.multiply && matchFilter(pseudo, r.filter, { src: src.uid })) n *= r.multiply;
          sp.n = Math.max(0, n);
        }
        return specs.filter(sp => sp.n > 0).map(({ _all, ...sp }) => sp);
      }
      if (kind === 'countersPlaced') {
        let n = info.n;
        const reps = activeReplacements('countersPlaced').filter(({ src, r }) => (!r.kind || r.kind === info.kind) && matchFilter(info.perm, r.filter, { src: src.uid }));
        for (const { r } of reps) if (r.add) n += r.add;
        for (const { r } of reps) if (r.multiply) n *= r.multiply;
        return Math.max(0, n);
      }
      if (kind === 'lifeGained') {
        let n = info.n;
        const reps = activeReplacements('lifeGained');
        for (const { r } of reps) if (r.add) n += r.add;
        for (const { r } of reps) if (r.multiply) n *= r.multiply;
        return Math.max(0, n);
      }
      if (kind === 'damageToOpp') {
        let n = info.n;
        const per = info.source && info.source.tok ? info.source.n || 1 : 1;
        const reps = activeReplacements('damageToOpp').filter(({ src, r }) => !info.source || matchFilter(info.source, r.filter, { src: src.uid }));
        for (const { r } of reps) if (r.add) n += r.add * per;
        for (const { r } of reps) if (r.multiply) n *= r.multiply;
        return Math.max(0, n);
      }
    } catch (e) { if (typeof console !== 'undefined') console.error('[rules] replacement', e); }
    return kind === 'tokenCreated' ? info : info.n;
  }
  // statics of the form { <key>: {filter?, if?}, if? } on battlefield permanents
  function permission(key, entry) {
    for (const p of bf()) {
      const sc = scriptOfPerm(p);
      for (const st of (sc && sc.statics) || []) {
        if (st && st.zone && st.zone !== 'bf') continue;
        const v = st && st[key];
        if (!v) continue;
        const ctx = { src: p.uid, card: p.name };
        if (st.if && !evalIf(st.if, ctx)) continue;
        if (v === true) return true;
        if (v.if && !evalIf(v.if, ctx)) continue;
        if (v.self) continue; // self permissions are read from the card itself (below)
        if (!entry || matchFilter(entry, v.filter, ctx)) return true;
      }
    }
    return false;
  }
  // "You may cast this card from your graveyard as long as …" lives on the card in the graveyard
  function selfGyPermission(entry) {
    const sc = scriptFor(entry.name);
    for (const st of (sc && sc.statics) || []) {
      const v = st && st.castFromGy;
      if (!v || !v.self) continue;
      const ctx = { src: null, card: entry.name };
      if ((st.if && !evalIf(st.if, ctx)) || (v.if && !evalIf(v.if, ctx))) continue;
      return true;
    }
    return false;
  }
  const hooks = {
    replace: replaceHook,
    canPlayFromTop: entry => attached && permission('playFromTop', entry),
    canCastFromGy: entry => attached && (permission('castFromGy', entry) || selfGyPermission(entry)),
    hasFlash: entry => attached && permission('flash', entry),
    noMaxHand: () => attached && permission('noMaxHand', null),
    cantAttack: p => attached && cantAttack(p),
    altCost: entry => (attached ? altCostFor(entry) : null),
  };
  game.hooks = hooks;
  game.activatable = activatable;          // UI: abilities of a permanent or of a card in hand / graveyard / exile
  game.activateAbility = (uid, index, opts) => activate(uid, index, opts);
  function cantAttack(p) {
    const own = scriptOfPerm(p);
    for (const st of (own && own.statics) || []) {
      const v = st && st.cantAttack;
      if (!v || (v !== true && v.filter)) continue;
      const ctx = { src: p.uid, card: p.name };
      if ((st.if && !evalIf(st.if, ctx)) || (v.if && !evalIf(v.if, ctx))) continue;
      return true;
    }
    for (const q of bf()) {
      if (q === p) continue;
      const sc = scriptOfPerm(q);
      for (const st of (sc && sc.statics) || []) {
        const v = st && st.cantAttack;
        if (!v || v === true || !v.filter) continue;
        const ctx = { src: q.uid, card: q.name };
        if ((st.if && !evalIf(st.if, ctx)) || (v.if && !evalIf(v.if, ctx))) continue;
        if (matchFilter(p, v.filter, ctx)) return true;
      }
    }
    return false;
  }
  function altCostFor(entry) {
    const sc = scriptFor(entry.name);
    for (const a of list(sc && sc.altCost)) {
      if (!a) continue;
      if (a.if && !evalIf(a.if, { src: null, card: entry.name })) continue;
      if (a.free) return { free: true };
      if (a.cost) return { cost: a.cost };
    }
    return null;
  }

  game.on('*', onEvent);
  recomputeStatics();

  return {
    resolve,
    explain,
    detach() {
      attached = false; game.off('*', onEvent);
      if (game.hooks === hooks) game.hooks = {};
      if (game.activatable === activatable) { delete game.activatable; delete game.activateAbility; }
    },
    pendingTop() { const l = S().pending; return (l && l[0]) || null; },
    // extras (additive to RULES.md §3)
    activatable,
    activate,
    run,
    refresh() { recomputeStatics(); processQueue(); },
    scriptFor,
    bundle: scripts,
  };
}
