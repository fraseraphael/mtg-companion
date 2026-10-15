/* Shared helpers for the goldfish UI: escaping, card faces, mana symbols, phase names.
   Pure functions only — no engine calls, no DOM state. */

export const PHASES = [
  ['untap', 'Untap', 'Unt'], ['upkeep', 'Upkeep', 'Upk'], ['draw', 'Draw', 'Drw'],
  ['main1', 'Main 1', 'M1'], ['combat', 'Combat', 'Atk'], ['combat-damage', 'Damage', 'Dmg'],
  ['main2', 'Main 2', 'M2'], ['end', 'End', 'End'], ['cleanup', 'Cleanup', 'Cln'],
];
export const PHASE_INDEX = Object.fromEntries(PHASES.map(([k], i) => [k, i]));
export const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];
export const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colourless' };

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ESC[c]); }

/** Run fn, return fallback if it throws or yields undefined (engine helpers may be in flux). */
export function safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; }
}

/* ---------- card faces ---------- */

/** The face a zone entry currently shows: card data, the back face when transformed,
    or a synthetic face for tokens. Never returns null. */
export function faceOf(deck, entry) {
  const name = entry && typeof entry === 'object' ? entry.name : entry;
  const c = deck && deck.cards ? deck.cards[name] : null;
  if (entry && entry.tok) {
    const m = /^\s*(\d+|\*)\s*\/\s*(\d+|\*)/.exec(name || '');
    const pw = entry.tokPower ?? (m ? m[1] : undefined);
    const th = entry.tokToughness ?? (m ? m[2] : undefined);
    return {
      name, tok: true, img: null, oracle_text: '', keywords: [], produced_mana: [],
      type_line: pw != null ? 'Token Creature' : 'Token', power: pw, toughness: th,
    };
  }
  if (!c) return { name: name || '?', type_line: '', oracle_text: '', keywords: [], produced_mana: [], img: null };
  if (entry && entry.flip && c.back) return { ...c, ...c.back, img: c.back.img || c.img, front: c };
  return c;
}
export const typeIs = (f, re) => re.test((f && f.type_line) || '');
export const isCreatureFace = f => typeIs(f, /Creature/);
export const isLandFace = f => typeIs(f, /\bLand\b/);
export const isPlaneswalkerFace = f => typeIs(f, /Planeswalker/);
export const isSpellFace = f => typeIs(f, /Instant|Sorcery/);
export function hasKw(f, kw) {
  if (!f) return false;
  if (Array.isArray(f.keywords) && f.keywords.some(k => String(k).toLowerCase() === kw.toLowerCase())) return true;
  return new RegExp('\\b' + kw + '\\b', 'i').test(f.oracle_text || '');
}
export function imgOf(f, size) {
  const im = (f && f.img) || {};
  return size === 'small' ? (im.small || im.normal || '') : (im.normal || im.small || '');
}

/* ---------- mana symbols ---------- */

export function pipHtml(sym) {
  if (Array.isArray(sym)) {
    const [a, b] = sym;
    return `<span class="pip hyb" style="--p1:var(--pip-${esc(a)},#888);--p2:var(--pip-${esc(b)},#888)" title="${esc(a)}/${esc(b)}"></span>`;
  }
  const s = String(sym);
  if (/^[WUBRGC]$/.test(s)) return `<span class="pip pip-${s}" title="${COLOR_NAMES[s]}">${s === 'C' ? '◇' : ''}</span>`;
  return `<span class="pip gen">${esc(s)}</span>`;
}
/** cost = { generic, pips, x } from the engine's parseCost/castCost */
export function costHtml(cost) {
  if (!cost) return '';
  let h = '';
  if (cost.x) h += pipHtml('X'.repeat(cost.x));
  if (cost.generic > 0 || (!cost.pips?.length && !cost.x)) h += pipHtml(Math.max(0, cost.generic || 0));
  (cost.pips || []).forEach(p => { h += pipHtml(p); });
  return `<span class="cost">${h}</span>`;
}
/** "{2}{G}{G/U}" -> pip html, for display only */
export function manaStringHtml(str) {
  if (!str) return '';
  const out = [];
  String(str).replace(/\{([^}]+)\}/g, (_, t) => {
    out.push(t.includes('/') && !/^\d/.test(t) ? pipHtml(t.split('/').filter(x => x !== 'P')) : pipHtml(t));
    return '';
  });
  return `<span class="cost">${out.join('')}</span>`;
}
export function poolTotal(pool) { return pool ? COLORS.reduce((s, c) => s + (pool[c] || 0), 0) : 0; }
