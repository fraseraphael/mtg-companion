/* Overlay panels: library browser (search + tutor), token maker with quick picks,
   oracle-text panel, keyboard help and the log drawer. ui.js passes a small context in
   initPanels(); nothing here mutates game state except through ctx.act(). */

import { esc, safe, faceOf, imgOf, manaStringHtml, isCreatureFace, isPlaneswalkerFace } from './util.js';
import { openSheet, closeSheet } from './radial.js';

let ctx = null;
const $ = id => document.getElementById(id);
const G = () => ctx && ctx.game();
const st = () => G() && G().state;

export function initPanels(c) {
  ctx = c;
  initLibrary();
  $('oracle')?.addEventListener('click', e => {
    if (e.target.closest('[data-oclose]') || e.target.id === 'oracle') closeOracle();
  });
  $('keys')?.addEventListener('click', e => { if (e.target.id === 'keys' || e.target.closest('[data-kclose]')) toggleKeys(false); });
  $('log')?.addEventListener('click', e => { if (e.target.closest('[data-lclose]')) toggleLog(false); });
}

/* ================= library browser ================= */
export const libIsOpen = () => !!$('libview')?.classList.contains('open');
export function openLibrary() {
  const el = $('libview'), q = $('libSearch');
  if (!el || !st()) return;
  el.classList.add('open');
  if (q) { q.value = ''; setTimeout(() => q.focus(), 0); }
  renderLib();
}
export function closeLibrary() { $('libview')?.classList.remove('open'); }
export function renderLib() {
  if (!libIsOpen()) return;
  const s = st(), list = $('libList'), cnt = $('libCount');
  if (!s || !list) return;
  const lib = (s.zones && s.zones.lib) || [];
  const q = (($('libSearch') || {}).value || '').trim().toLowerCase();
  const rows = lib.map(c => ({ c, f: faceOf(ctx.deck, c) }))
    .filter(r => !q || r.c.name.toLowerCase().includes(q) || (r.f.type_line || '').toLowerCase().includes(q))
    .sort((a, b) => a.c.name.localeCompare(b.c.name));
  if (cnt) cnt.textContent = `${rows.length} of ${lib.length}` + (s.searched ? ' — shuffle when done' : '');
  list.innerHTML = rows.length ? rows.map(({ c, f }) => `<div class="librow">
      <img loading="lazy" src="${esc(imgOf(f, 'small'))}" alt="" data-oracle="${esc(c.name)}">
      <span class="n" data-oracle="${esc(c.name)}">${esc(c.name)}<small>${esc(f.type_line || '')}</small></span>
      <span class="mv">${manaStringHtml(f.mana_cost)}</span>
      <span class="tut">
        <button class="btn" data-tut="${esc(c.uid)}:hand">Hand</button>
        <button class="btn" data-tut="${esc(c.uid)}:bf">Field</button>
        <button class="btn" data-tut="${esc(c.uid)}:libtop">Top</button>
        <button class="btn" data-tut="${esc(c.uid)}:gy">Yard</button>
        <button class="btn" data-tut="${esc(c.uid)}:ex">Exile</button>
      </span></div>`).join('') : '<div class="empty">Nothing matches.</div>';
}
function initLibrary() {
  const q = $('libSearch');
  if (q) q.addEventListener('input', renderLib);
  $('libDone')?.addEventListener('click', () => { closeLibrary(); ctx.act(() => G().shuffle(), { ok: 'Library shuffled' }); });
  $('libClose')?.addEventListener('click', closeLibrary);
  $('libList')?.addEventListener('click', e => {
    const b = e.target.closest('[data-tut]');
    if (!b) return;
    const [uidStr, to] = b.dataset.tut.split(':');
    const card = ((st() && st().zones.lib) || []).find(c => String(c.uid) === uidStr);
    if (!card) return;
    ctx.act(() => G().tutor(card.uid, to), { ok: `${card.name} → ${({ hand: 'hand', bf: 'battlefield', libtop: 'top of library', gy: 'graveyard', ex: 'exile' })[to] || to}` });
  });
}

/* ================= token maker ================= */
const TOKEN_DEFAULTS = ['Treasure', 'Food', 'Clue', 'Blood', '1/1 Soldier', '1/1 Spirit', '2/2 Zombie', '3/3 Beast', '4/4 Angel', '5/5 Dragon'];
const TOKEN_THEMES = [
  [/zombie/i, '2/2 Zombie'], [/angel/i, '4/4 Angel'], [/dinosaur/i, '3/3 Dinosaur'], [/elf|elves|elven/i, '1/1 Elf Warrior'],
  [/food|fellowship/i, 'Food'], [/treasure|pirate/i, 'Treasure'], [/spirit/i, '1/1 Spirit'], [/soldier|human/i, '1/1 Soldier'],
  [/goblin/i, '1/1 Goblin'], [/saproling|fungus/i, '1/1 Saproling'], [/insect/i, '1/1 Insect'], [/vampire|blood/i, 'Blood'],
  [/clue|investigate/i, 'Clue'], [/knight/i, '2/2 Knight'], [/\bcat/i, '1/1 Cat'], [/dragon/i, '5/5 Dragon'],
  [/bird/i, '1/1 Bird'], [/thopter|artifact/i, '1/1 Thopter'], [/spider/i, '1/2 Spider'], [/beast/i, '3/3 Beast'],
];
const TOK_KEY = 'mf-gf2-toks';
function tokRecents() { try { return JSON.parse(localStorage.getItem(TOK_KEY) || '{}') || {}; } catch (_) { return {}; } }
function tokRemember(name) {
  try {
    const all = tokRecents(), k = ctx.deck.slug;
    all[k] = [name].concat((all[k] || []).filter(x => x.toLowerCase() !== name.toLowerCase())).slice(0, 8);
    localStorage.setItem(TOK_KEY, JSON.stringify(all));
  } catch (_) { /* storage blocked: quick picks just won't remember */ }
}
function tokPicks() {
  const d = ctx.deck, seen = new Set(), out = [];
  const add = n => { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(n); } };
  (tokRecents()[d.slug] || []).forEach(add);
  // what the deck's own cards say they make: "create ... 3/3 green Beast creature token"
  const hay = `${d.arch || ''} ${d.commander || ''} ${d.name || ''}`;
  TOKEN_THEMES.forEach(([re, n]) => { if (re.test(hay)) add(n); });
  Object.values(d.cards || {}).forEach(c => {
    const m = /create[^.]*?(\d+)\/(\d+)\s+(?:[a-z]+\s+){0,3}?([A-Z][a-z]+)[^.]*?creature tokens?/.exec(c.oracle_text || '');
    if (m) add(`${m[1]}/${m[2]} ${m[3]}`);
  });
  ((st() && st().zones.bf) || []).filter(p => p.tok).forEach(p => add(p.name));
  TOKEN_DEFAULTS.forEach(add);
  return out.slice(0, 14);
}
function parsePT(name) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\b/.exec(name);
  return m ? { power: +m[1], toughness: +m[2] } : {};
}
export function openTokenMaker() {
  if (!st()) return;
  const body = `<div class="tokmk">
    <div class="row">
      <input type="text" id="tokName" placeholder="Token, e.g. 2/2 Zombie, Treasure" autocomplete="off" maxlength="30">
      <button class="btn" data-tokn="-1" title="One fewer">&minus;</button>
      <input type="number" id="tokCount" value="1" min="1" max="99" inputmode="numeric">
      <button class="btn" data-tokn="1" title="One more">+</button>
    </div>
    <div class="row chips">${[1, 2, 3, 4, 5, 8, 10].map(k => `<button class="chip ${k === 1 ? 'on' : ''}" data-tokset="${k}">&times;${k}</button>`).join('')}</div>
    <div class="chips">${tokPicks().map(p => `<button class="chip" data-tokpick="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <div class="tokhint">"2/2 Zombie" style names set power/toughness. Identical tokens stack into one card with a count.</div>
  </div>`;
  const go = () => {
    const nameEl = $('tokName'), cntEl = $('tokCount');
    const name = String(nameEl?.value || '').trim().slice(0, 30);
    const n = Math.max(1, Math.min(99, Math.floor(+(cntEl?.value) || 1)));
    if (!name) { nameEl?.focus(); return; }
    const r = ctx.act(() => G().createToken(name, n, parsePT(name)), { ok: `Created ${n} × ${name}` });
    if (r && r.ok !== false) { tokRemember(name); closeSheet(); }
  };
  openSheet({
    title: 'Create tokens', body, cls: 'wide',
    buttons: [{ label: 'Create', primary: true, keep: true, fn: go }, { label: 'Cancel' }],
    onClick: e => {
      const b = e.target.closest('[data-tokn],[data-tokset],[data-tokpick]');
      if (!b) return false;
      const cntEl = $('tokCount'), nameEl = $('tokName');
      const sync = () => document.querySelectorAll('#sheet [data-tokset]').forEach(x => x.classList.toggle('on', +x.dataset.tokset === +cntEl.value));
      if (b.dataset.tokn && cntEl) { cntEl.value = Math.max(1, Math.min(99, (+cntEl.value || 1) + +b.dataset.tokn)); sync(); }
      else if (b.dataset.tokset && cntEl) { cntEl.value = b.dataset.tokset; sync(); }
      else if (b.dataset.tokpick !== undefined && nameEl) {
        nameEl.value = b.dataset.tokpick;
        document.querySelectorAll('#sheet [data-tokpick]').forEach(x => x.classList.toggle('on', x === b));
      }
      return true;
    },
  });
  const nameEl = $('tokName');
  if (nameEl) {
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    setTimeout(() => nameEl.focus(), 0);
  }
}

/* ================= oracle text ================= */
export const oracleIsOpen = () => !!$('oracle')?.classList.contains('open');
export function closeOracle() { $('oracle')?.classList.remove('open'); }
function oracleHtml(text) {
  return esc(text || '').split('\n').map(line =>
    `<p>${line.replace(/\{([^}]+)\}/g, (m, t) => `<span class="sym">${t}</span>`)}</p>`).join('');
}
/** entry: a zone entry ({uid,name,...}) or a bare card name. */
export function openOracle(entry, zone) {
  const el = $('oracle');
  if (!el) return;
  const f = faceOf(ctx.deck, entry);
  const raw = ctx.deck.cards?.[f.front ? f.front.name : f.name] || null;
  const perm = zone === 'bf' && entry && typeof entry === 'object' ? entry : null;
  let stats = '';
  if (isCreatureFace(f)) {
    const p = perm ? safe(() => ctx.power(perm), f.power) : f.power;
    const t = perm ? safe(() => ctx.toughness(perm), f.toughness) : f.toughness;
    stats = `<span class="ostat">${esc(p ?? '?')}/${esc(t ?? '?')}</span>`;
  } else if (isPlaneswalkerFace(f)) {
    stats = `<span class="ostat">Loyalty ${esc(perm?.counters?.loyalty ?? f.loyalty ?? '?')}</span>`;
  }
  const flags = [];
  if (perm) {
    if (perm.tapped) flags.push('tapped');
    if (perm.sick) flags.push('summoning sick');
    if (perm.attacking) flags.push('attacking');
    if (perm.copy) flags.push('copy');
    const c = perm.counters || {};
    if (c.p1p1) flags.push(`${c.p1p1 > 0 ? '+' : ''}${c.p1p1}/${c.p1p1 > 0 ? '+' : ''}${c.p1p1} counters`);
    if (c.other) flags.push(`${c.other} other counter${c.other > 1 ? 's' : ''}`);
    if (perm.tok && (perm.n || 1) > 1) flags.push(`stack of ${perm.n}`);
  }
  const back = raw && raw.back && !f.front ? raw.back : (f.front || null);
  const img = imgOf(f, 'normal');
  el.innerHTML = `<div class="oracle-card">
    <button class="btn oclose" data-oclose="1" aria-label="Close">&times;</button>
    ${img ? `<img src="${esc(img)}" alt="${esc(f.name)}">` : `<div class="tokface big"><span>${esc(f.name)}</span></div>`}
    <div class="otext">
      <h3>${esc(f.name)} ${manaStringHtml(f.mana_cost)}</h3>
      <div class="otype">${esc(f.type_line || '')} ${stats}</div>
      ${f.oracle_text ? `<div class="obody">${oracleHtml(f.oracle_text)}</div>` : (f.tok ? '<div class="obody"><p><i>Token.</i></p></div>' : '')}
      ${flags.length ? `<div class="oflags">${flags.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
      ${back ? `<div class="oback"><h4>${f.front ? 'Front face' : 'Back face'}: ${esc(back.name || '')}</h4>
        <div class="otype">${esc(back.type_line || '')}</div><div class="obody">${oracleHtml(back.oracle_text)}</div></div>` : ''}
    </div></div>`;
  el.classList.add('open');
}

/* ================= keys help ================= */
export const keysIsOpen = () => !!$('keys')?.classList.contains('open');
export function toggleKeys(force) { $('keys')?.classList.toggle('open', force); }

/* ================= log drawer ================= */
export const logIsOpen = () => !!$('log')?.classList.contains('open');
export function toggleLog(force) {
  const el = $('log');
  if (!el) return;
  el.classList.toggle('open', force);
  if (logIsOpen()) renderLog();
}
export function renderLog() {
  const list = $('logList'), s = st();
  if (!list || !s) return;
  const lines = (Array.isArray(s.log) ? s.log : []).slice(-50);
  list.innerHTML = lines.length ? lines.map(l => `<li>${esc(l)}</li>`).join('') : '<li class="empty">Nothing yet.</li>';
  list.scrollTop = list.scrollHeight;
}
