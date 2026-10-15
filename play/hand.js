/* The hand as a held fan of cards.
   Layout: cards hang from a common bottom point, rotated and dropped by distance from centre.
   Peek: driven by pointer X over the whole fan strip (not per-card hover), so a popped card
   moving under the cursor cannot cancel its own hover. On touch, dragging a finger across the
   fan raises the card under it; a quick tap is a click; a sweep swallows the following click. */

export function layoutFan(wrap) {
  if (!wrap) return;
  const cards = [...wrap.querySelectorAll('.card')];
  const n = cards.length;
  if (!n) return;
  const W = wrap.clientWidth || window.innerWidth || 600;
  const cw = cards[0].offsetWidth || 110;
  const ch = cards[0].offsetHeight || cw * 1.4;
  const mid = (n - 1) / 2;
  const rotF = Math.min(5, 44 / n);
  // outer cards are rotated: their swung top corners need extra edge room
  const swing = Math.sin(mid * rotF * Math.PI / 180) * ch;
  const spread = Math.max(6, Math.min(cw * 0.82, (W - cw - 16 - 2 * swing) / Math.max(n - 1, 1)));
  cards.forEach((el, i) => {
    const o = i - mid;
    el.style.setProperty('--tx', (o * spread - cw / 2) + 'px');
    el.style.setProperty('--rot', (o * rotF) + 'deg');
    el.style.setProperty('--ty', (Math.pow(Math.abs(o), 1.6) * 2.4) + 'px');
    el.style.zIndex = String(i + 1);
    el.dataset.fanx = String(o * spread);
  });
}

export function initHandPeek(wrap) {
  const st = { drag: false, startX: 0, moved: 0, suppress: false };
  if (!wrap) return st;
  const peekAt = (x) => {
    const cards = [...wrap.querySelectorAll('.card')];
    if (!cards.length) return;
    const r = wrap.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    let best = null, bestD = Infinity;
    cards.forEach(el => {
      const d = Math.abs(x - (mid + (+el.dataset.fanx || 0)));
      if (d < bestD) { bestD = d; best = el; }
    });
    cards.forEach(el => el.classList.toggle('peek', el === best));
  };
  const clear = () => wrap.querySelectorAll('.peek').forEach(el => el.classList.remove('peek'));
  st.clear = clear;

  wrap.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') { peekAt(e.clientX); return; }
    if (!st.drag) return;
    st.moved = Math.max(st.moved, Math.abs(e.clientX - st.startX));
    peekAt(e.clientX);
  });
  wrap.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') clear(); });
  wrap.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || !e.target.closest('.card')) return;
    st.drag = true; st.startX = e.clientX; st.moved = 0;
    try { wrap.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ }
    peekAt(e.clientX);
  });
  ['pointerup', 'pointercancel'].forEach(ev => wrap.addEventListener(ev, e => {
    if (e.pointerType === 'mouse' || !st.drag) return;
    st.drag = false;
    if (st.moved > 12) { st.suppress = true; setTimeout(() => { st.suppress = false; }, 400); }
    clear();
  }));
  return st;
}
