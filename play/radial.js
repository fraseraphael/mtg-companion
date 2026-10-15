/* Radial action wheel (card enlarged in the centre, actions on a ring) and the bottom sheet
   used for dialogs: cast shortfall, colour choice, mana pool, token maker, confirmations.
   Both take plain {label, fn} options; the caller wraps fn so it re-renders. */

import { esc } from './util.js';

const PAGE = 10; // more than this and the ring pages, so labels never overlap on a phone

/* ---------- radial ---------- */
let radialOpts = null;

export function openRadial(centerHtml, opts, page = 0) {
  const el = document.getElementById('radial');
  const wrap = document.getElementById('radialWrap');
  if (!el || !wrap) return;
  let shown = opts;
  if (opts.length > PAGE) {
    const per = PAGE - 1;
    const pages = Math.ceil(opts.length / per);
    const p = Math.min(page, pages - 1);
    shown = opts.slice(p * per, p * per + per);
    shown.push(p < pages - 1
      ? { label: 'More &rsaquo;', keep: true, fn: () => openRadial(centerHtml, opts, p + 1), cls: 'more' }
      : { label: '&lsaquo; Back', keep: true, fn: () => openRadial(centerHtml, opts, 0), cls: 'more' });
  }
  // an ellipse: on a tall phone the wheel is taller than wide, so labels stay off each other
  const tall = window.innerHeight > window.innerWidth * 1.3;
  const RX = tall ? 36 : 44, RY = tall ? 46 : 44; // percent radii
  const btns = shown.map((o, i) => {
    const a = (-90 + i * (360 / shown.length)) * Math.PI / 180;
    const x = 50 + RX * Math.cos(a), y = 50 + RY * Math.sin(a);
    return `<button class="rbtn ${o.cls || ''}" data-ract="${i}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%">${o.label}</button>`;
  }).join('');
  wrap.innerHTML = centerHtml + btns + '<div class="rhint">tap outside to cancel</div>';
  radialOpts = shown;
  el.classList.add('open');
  // keep every label on screen: nudge any button that pokes past the viewport edge
  const vw = document.documentElement.clientWidth;
  wrap.querySelectorAll('.rbtn').forEach(b => {
    const r = b.getBoundingClientRect();
    const dx = r.left < 6 ? 6 - r.left : r.right > vw - 6 ? vw - 6 - r.right : 0;
    if (dx) b.style.marginLeft = dx + 'px';
  });
}
export function closeRadial() {
  document.getElementById('radial')?.classList.remove('open');
  radialOpts = null;
}
export const radialIsOpen = () => !!document.getElementById('radial')?.classList.contains('open');

export function initRadial() {
  const el = document.getElementById('radial');
  if (!el) return;
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-ract]');
    if (b && radialOpts) {
      const o = radialOpts[+b.dataset.ract];
      if (!o) return;
      if (!o.keep) closeRadial();
      o.fn && o.fn();
      return;
    }
    if (!e.target.closest('.rcenter')) closeRadial();
  });
}

/* ---------- sheet ---------- */
let sheetBtns = null, sheetClick = null;

/** buttons: [{label, fn, primary, keep}] ; onClick(e) gets first look at clicks (return true = handled) */
export function openSheet({ title = '', body = '', buttons = [], onClick = null, cls = '' } = {}) {
  const el = document.getElementById('sheet');
  if (!el) return null;
  el.className = 'open ' + cls;
  el.innerHTML = `<div class="sheet-in">
    ${title ? `<h4>${title}</h4>` : ''}
    <div class="sheet-body">${body}</div>
    ${buttons.length ? `<div class="sheet-btns">${buttons.map((b, i) =>
      `<button class="btn ${b.primary ? 'primary' : ''}" data-sbtn="${i}">${b.label}</button>`).join('')}</div>` : ''}
  </div>`;
  sheetBtns = buttons; sheetClick = onClick;
  return el;
}
export function closeSheet() {
  const el = document.getElementById('sheet');
  if (el) { el.className = ''; el.innerHTML = ''; }
  sheetBtns = null; sheetClick = null;
}
export const sheetIsOpen = () => !!document.getElementById('sheet')?.classList.contains('open');

export function initSheet() {
  const el = document.getElementById('sheet');
  if (!el) return;
  el.addEventListener('click', e => {
    if (sheetClick && sheetClick(e)) return;
    const b = e.target.closest('[data-sbtn]');
    if (!b || !sheetBtns) return;
    const o = sheetBtns[+b.dataset.sbtn];
    if (!o) return;
    if (!o.keep) closeSheet();
    o.fn && o.fn();
  });
}

/** Promise-free confirm built on the sheet. */
export function confirmSheet(title, text, yesLabel, onYes) {
  openSheet({
    title: esc(title), body: `<p class="sheet-text">${esc(text)}</p>`,
    buttons: [{ label: esc(yesLabel), primary: true, fn: onYes }, { label: 'Cancel', fn: null }],
  });
}
