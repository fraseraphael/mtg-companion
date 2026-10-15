// fx.js — animation layer for the play surface.
// DOM only, zero dependencies, no knowledge of the game or the engine.
// Every method returns a Promise that resolves when its animation is done, never throws,
// resolves immediately for missing elements, and is instant under prefers-reduced-motion
// (final classes / values are still applied).

// Must match style.css `.card.tapped { transform: ... }` exactly, so there is no jump at the end.
export const TAPPED_TRANSFORM = 'rotate(90deg) translateY(-10%)';
const UNTAPPED_TRANSFORM = 'rotate(0deg) translateY(0%)';
const TAP_MS = 200;

const done = () => Promise.resolve();
const ok = (el) => !!(el && el.nodeType === 1 && el.isConnected);
const reduced = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
const canAnimate = () => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
const instant = () => reduced() || !canAnimate();
let hasTranslateProp = null;
const translateProp = () => {
  if (hasTranslateProp === null) {
    try { hasTranslateProp = !!(window.CSS && CSS.supports('translate', '1px 1px')); } catch { hasTranslateProp = false; }
  }
  return hasTranslateProp;
};
// Keyframe for a screen-space offset. The individual `translate` property composes outside
// `transform`, so a tapped (rotated) card still moves in screen space.
const off = (x, y, extra = {}) => translateProp()
  ? { translate: `${x}px ${y}px`, ...extra }
  : { transform: `translate(${x}px, ${y}px)`, ...extra };

// Resolve when an Animation finishes OR is cancelled (anim.finished rejects on cancel).
// Also resolve on a timer: a hidden tab never delivers finish events (Chrome stops updating
// animations without rendering opportunities), which would leave the game stuck "busy".
const settle = (anim) => new Promise((res) => {
  if (!anim) return res();
  let t = 0;
  const fin = () => { clearTimeout(t); res(); };
  anim.addEventListener('finish', fin, { once: true });
  anim.addEventListener('cancel', fin, { once: true });
  try {
    const tm = anim.effect && anim.effect.getTiming ? anim.effect.getTiming() : {};
    const total = (Number(tm.delay) || 0) + (Number(tm.duration) || 0) * (tm.iterations === Infinity ? 1 : (Number(tm.iterations) || 1));
    t = setTimeout(() => { try { anim.finish(); } catch {} res(); }, total + 300);
  } catch { t = setTimeout(res, 1500); }
});
const wait = (ms) => new Promise((res) => setTimeout(res, Math.max(0, ms || 0)));

function layer() {
  let l = document.getElementById('fx-layer');
  if (!l) {
    l = document.createElement('div');
    l.id = 'fx-layer';
    l.setAttribute('aria-hidden', 'true');
    // inline so it works even if fx.css is not linked
    l.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9000;overflow:hidden;';
    document.body.appendChild(l);
  }
  return l;
}

const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
// Untransformed box size (a fanned hand card has a bigger bounding rect than its real size).
const boxSize = (el, r) => ({
  w: el.offsetWidth || r.width,
  h: el.offsetHeight || r.height,
});

function cloneFor(el, r) {
  const { w, h } = boxSize(el, r);
  const c = el.cloneNode(true);
  c.removeAttribute('id');
  c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  c.classList.remove('tapped', 'glow', 'fx-lunging');
  c.classList.add('fx-clone');
  const cc = center(r);
  Object.assign(c.style, {
    position: 'absolute', left: `${cc.x - w / 2}px`, top: `${cc.y - h / 2}px`,
    width: `${w}px`, height: `${h}px`, margin: '0', transform: 'none', translate: 'none',
    rotate: 'none', scale: 'none', transition: 'none', willChange: 'transform',
    pointerEvents: 'none', visibility: 'visible', opacity: '1',
  });
  return { c, w, h };
}

// Per-element bookkeeping so a new animation of the same kind replaces the old one.
const running = new WeakMap(); // el -> { tap?: Animation, count?: token }
const slot = (el) => { let s = running.get(el); if (!s) running.set(el, (s = {})); return s; };

function setTapped(el, on) {
  const s = slot(el);
  if (s.tap) { try { s.tap.cancel(); } catch {} s.tap = null; }
  const already = el.classList.contains('tapped');
  if (already === on) return done();
  if (instant()) { el.classList.toggle('tapped', on); return done(); }
  // Swap the class first with transform transitions suppressed (margin still transitions),
  // then let WAAPI drive the transform from the old value to the new one. When the animation
  // is removed the underlying class value is already the final one: no jump, no CSS re-transition.
  const prevTransition = el.style.transition;
  el.style.transition = 'margin 0.15s';
  el.classList.toggle('tapped', on);
  const anim = el.animate(
    [{ transform: on ? UNTAPPED_TRANSFORM : TAPPED_TRANSFORM },
     { transform: on ? TAPPED_TRANSFORM : UNTAPPED_TRANSFORM }],
    { duration: TAP_MS, easing: on ? 'cubic-bezier(.3,.7,.4,1)' : 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
  s.tap = anim;
  return settle(anim).then(() => {
    if (s.tap === anim) s.tap = null;
    try { anim.cancel(); } catch {}
    // restore after the style without the animation has been committed
    requestAnimationFrame(() => { el.style.transition = prevTransition; });
  });
}

function staggered(els, gap, fn) {
  const list = Array.from(els || []).filter(ok);
  if (!list.length) return done();
  if (instant()) { list.forEach((el) => fn(el)); return done(); }
  return Promise.all(list.map((el, i) => wait(i * gap).then(() => fn(el)))).then(() => {});
}

export const fx = {
  fly(fromEl, toEl, { clone = true, duration = 420, arc = 0.25 } = {}) {
    try {
      if (!ok(fromEl) || !ok(toEl) || instant()) return done();
      const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
      if (!a.width || !b.width) return done();
      const { c, w, h } = cloneFor(fromEl, a);
      const tw = toEl.offsetWidth || b.width, th = toEl.offsetHeight || b.height;
      let s = Math.min(tw / w, th / h);
      // target is a container (row, zone), not a card-shaped slot: don't blow the card up
      if (Math.abs(Math.log((tw / th) / (w / h))) > 0.35) s = Math.min(s, 1);
      const ca = center(a), cb = center(b);
      const dx = cb.x - ca.x, dy = cb.y - ca.y;
      const lift = Math.hypot(dx, dy) * arc;
      const prevVis = fromEl.style.visibility;
      if (!clone) fromEl.style.visibility = 'hidden';
      layer().appendChild(c);
      const opts = { duration, fill: 'forwards' };
      const path = c.animate([off(0, 0), off(dx, dy)], { ...opts, easing: 'cubic-bezier(.45,0,.25,1)' });
      const bump = c.animate([
        { transform: 'translateY(0px) scale(1)', easing: 'cubic-bezier(.2,.6,.4,1)' },
        { transform: `translateY(${-lift}px) scale(${((1 + s) / 2) * 1.06})`, offset: 0.5, easing: 'cubic-bezier(.6,0,.8,.4)' },
        { transform: `translateY(0px) scale(${s})` },
      ], opts);
      return Promise.all([settle(path), settle(bump)]).then(() => {
        c.remove();
        if (!clone) fromEl.style.visibility = prevVis;
      });
    } catch { return done(); }
  },

  draw(libPileEl, handEl, cardBackUrl, frontUrl) {
    try {
      if (!ok(libPileEl) || !ok(handEl) || instant()) return done();
      const src = libPileEl.querySelector('img') || libPileEl;
      const a = src.getBoundingClientRect(), hr = handEl.getBoundingClientRect();
      if (!a.width || !hr.width) return done();
      const w = src.offsetWidth || a.width, h = w * 680 / 488;
      // landing spot: just right of the last card in the hand, kept inside the hand box
      const last = handEl.lastElementChild;
      const lr = last ? last.getBoundingClientRect() : null;
      const tw = (last && last.offsetWidth) || Math.min(w * 1.3, hr.width);
      const s = tw / w;
      const th = h * s;
      let tx = lr && lr.width ? lr.right + tw * 0.15 : hr.right - tw / 2 - 8;
      tx = Math.min(tx, hr.right - tw / 2);
      const ty = lr && lr.height ? lr.top + lr.height / 2 : hr.top + Math.min(hr.height, th) / 2;
      const ca = center(a);
      const dx = tx - ca.x, dy = ty - ca.y, lift = Math.hypot(dx, dy) * 0.18;

      if (frontUrl) { const pre = new Image(); pre.src = frontUrl; }
      const c = document.createElement('div');
      c.className = 'fx-clone fx-drawcard';
      Object.assign(c.style, {
        position: 'absolute', left: `${ca.x - w / 2}px`, top: `${ca.y - h / 2}px`,
        width: `${w}px`, height: `${h}px`, willChange: 'transform',
      });
      const img = document.createElement('img');
      img.alt = ''; img.draggable = false;
      if (cardBackUrl) img.src = cardBackUrl;
      c.appendChild(img);
      layer().appendChild(c);

      const D = 560, half = D / 2;
      const path = c.animate([off(0, 0), off(dx, dy)], { duration: D, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
      const ms = (1 + s) / 2 * 1.08;
      const p = 'perspective(900px)';
      const up = c.animate([
        { transform: `${p} translateY(0px) rotateY(0deg) scale(1)` },
        { transform: `${p} translateY(${-lift}px) rotateY(90deg) scale(${ms})` },
      ], { duration: half, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' });
      return settle(up).then(() => {
        if (frontUrl) img.src = frontUrl;
        const downA = c.animate([
          { transform: `${p} translateY(${-lift}px) rotateY(-90deg) scale(${ms})` },
          { transform: `${p} translateY(0px) rotateY(0deg) scale(${s})` },
        ], { duration: half, easing: 'cubic-bezier(.6,0,.8,.4)', fill: 'forwards' });
        try { up.cancel(); } catch {}
        return Promise.all([settle(path), settle(downA)]);
      }).then(() => { c.remove(); });
    } catch { return done(); }
  },

  tap(el) { try { return ok(el) ? setTapped(el, true) : done(); } catch { return done(); } },
  untap(el) { try { return ok(el) ? setTapped(el, false) : done(); } catch { return done(); } },

  tapSequence(els, gap = 90) {
    try { return staggered(els, gap, (el) => setTapped(el, true)); } catch { return done(); }
  },

  untapAll(els) {
    try {
      const list = Array.from(els || []).filter((el) => ok(el) && el.classList.contains('tapped'));
      return staggered(list, 40, (el) => setTapped(el, false));
    } catch { return done(); }
  },

  lunge(el, targetEl) {
    try {
      if (!ok(el) || !ok(targetEl) || instant()) return done();
      const a = center(el.getBoundingClientRect()), b = center(targetEl.getBoundingClientRect());
      const dx = (b.x - a.x) * 0.4, dy = (b.y - a.y) * 0.4;
      el.classList.add('fx-lunging');
      const anim = el.animate([
        off(0, 0, { easing: 'cubic-bezier(.55,0,1,.45)' }),   // ease-in toward the target
        off(dx, dy, { offset: 0.45, easing: 'cubic-bezier(0,.55,.45,1)' }), // ease-out back
        off(0, 0),
      ], { duration: 360 });
      return settle(anim).then(() => el.classList.remove('fx-lunging'));
    } catch { return done(); }
  },

  shake(el, strength = 1) {
    try {
      if (!ok(el) || instant()) return done();
      const k = 7 * (Number(strength) || 1);
      const xs = [0, -k, k, -0.75 * k, 0.75 * k, -0.4 * k, 0.4 * k, 0];
      const anim = el.animate(xs.map((x) => off(x, 0)), { duration: 380, easing: 'ease-out' });
      return settle(anim);
    } catch { return done(); }
  },

  damage(targetEl, n) {
    try {
      if (!ok(targetEl) || instant()) return done();
      const r = targetEl.getBoundingClientRect();
      const c = center(r);
      const d = document.createElement('div');
      d.className = 'fx-damage';
      d.textContent = `−${Math.abs(Number(n) || 0)}`;
      Object.assign(d.style, { left: `${c.x}px`, top: `${c.y}px` });
      layer().appendChild(d);
      const anim = d.animate([
        { transform: 'translate(-50%, -50%) translateY(0px) scale(0.6)', opacity: 0 },
        { transform: 'translate(-50%, -50%) translateY(-12px) scale(1.15)', opacity: 1, offset: 0.15 },
        { transform: 'translate(-50%, -50%) translateY(-30px) scale(1)', opacity: 1, offset: 0.5 },
        { transform: 'translate(-50%, -50%) translateY(-60px) scale(1)', opacity: 0 },
      ], { duration: 800, easing: 'ease-out', fill: 'forwards' });
      return settle(anim).then(() => d.remove());
    } catch { return done(); }
  },

  countTo(el, from, to, duration = 500) {
    try {
      if (!ok(el)) return done();
      const s = slot(el);
      const token = {};
      s.count = token;
      const f = Number(from) || 0, t = Number(to) || 0;
      if (instant() || duration <= 0 || f === t) { el.textContent = String(t); return done(); }
      return new Promise((res) => {
        const t0 = performance.now();
        const step = (now) => {
          if (s.count !== token) return res(); // superseded by a newer countTo
          const p = Math.min(1, (now - t0) / duration);
          const e = 1 - Math.pow(1 - p, 3);
          el.textContent = String(Math.round(f + (t - f) * e));
          if (p < 1 && el.isConnected) requestAnimationFrame(step);
          else { el.textContent = String(t); res(); }
        };
        requestAnimationFrame(step);
      });
    } catch { return done(); }
  },

  banner(text, { sub = '', hold = 900 } = {}) {
    try {
      if (typeof document === 'undefined' || !document.body) return done();
      const host = document.getElementById('board') || document.body;
      const r = host.getBoundingClientRect();
      const prev = layer().querySelectorAll('.fx-banner');
      prev.forEach((p) => p.remove());
      const b = document.createElement('div');
      b.className = 'fx-banner';
      const t = document.createElement('div');
      t.className = 'fx-banner-text';
      t.textContent = text == null ? '' : String(text);
      b.appendChild(t);
      if (sub) {
        const s = document.createElement('div');
        s.className = 'fx-banner-sub';
        s.textContent = String(sub);
        b.appendChild(s);
      }
      const top = host === document.body ? 0 : Math.max(0, r.top);
      const left = host === document.body ? 0 : Math.max(0, r.left);
      const width = host === document.body ? window.innerWidth : Math.min(r.width, window.innerWidth - left);
      Object.assign(b.style, { top: `${top}px`, left: `${left}px`, width: `${width}px` });
      layer().appendChild(b);
      if (instant()) {
        // completes instantly, but the text stays readable (statically) for the hold time
        setTimeout(() => b.remove(), Math.max(hold, 600));
        return done();
      }
      const IN = 240, OUT = 300, total = IN + hold + OUT;
      const anim = b.animate([
        { transform: 'translateY(-100%)', opacity: 0, easing: 'cubic-bezier(.2,.8,.3,1)' },
        { transform: 'translateY(0)', opacity: 1, offset: IN / total },
        { transform: 'translateY(0)', opacity: 1, offset: (IN + hold) / total, easing: 'cubic-bezier(.5,0,.8,.4)' },
        { transform: 'translateY(-60%)', opacity: 0 },
      ], { duration: total, fill: 'forwards' });
      return settle(anim).then(() => b.remove());
    } catch { return done(); }
  },

  glow(el, on) {
    try {
      if (!ok(el)) return done();
      const want = !!on;
      if (el.classList.contains('glow') === want) return done();
      el.classList.toggle('glow', want);
      return instant() ? done() : wait(200); // matches the .glow transition in fx.css
    } catch { return done(); }
  },

  dimBoard(on) {
    try {
      if (typeof document === 'undefined' || !document.body) return done();
      let d = document.getElementById('fx-dim');
      if (on) {
        if (!d) {
          d = document.createElement('div');
          d.id = 'fx-dim';
          d.setAttribute('aria-hidden', 'true');
          d.style.opacity = '0';
          document.body.appendChild(d);
        }
        d.dataset.on = '1';
        if (instant()) { d.style.opacity = '1'; return done(); }
        const from = getComputedStyle(d).opacity;
        d.style.opacity = '1';
        return settle(d.animate([{ opacity: from }, { opacity: 1 }], { duration: 280, easing: 'ease-out' }));
      }
      if (!d) return done();
      d.dataset.on = '';
      const kill = () => { if (!d.dataset.on) d.remove(); };
      if (instant()) { kill(); return done(); }
      const from = getComputedStyle(d).opacity;
      d.style.opacity = '0';
      return settle(d.animate([{ opacity: from }, { opacity: 0 }], { duration: 240, easing: 'ease-in' })).then(kill);
    } catch { return done(); }
  },

  // ---- added for the rules layer (pending panel, trigger ribbon). Same curves as the win card. ----
  rise(el) { // a card-shaped panel enters: up, scale, slight tilt (win card's winIn)
    try {
      if (!ok(el) || instant()) return done();
      return settle(el.animate([
        { transform: 'translateY(30px) scale(0.85) rotate(-3deg)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], { duration: 500, easing: 'cubic-bezier(.2,1.3,.4,1)' }));
    } catch { return done(); }
  },
  sink(el) { // the reverse, quicker; leaves the element at opacity 0 (caller removes it)
    try {
      if (!ok(el) || instant()) { if (ok(el)) el.style.opacity = '0'; return done(); }
      const a = el.animate([
        { transform: 'none', opacity: 1 },
        { transform: 'translateY(24px) scale(0.9)', opacity: 0 },
      ], { duration: 240, easing: 'ease-in', fill: 'forwards' });
      return settle(a);
    } catch { return done(); }
  },
  slideIn(el) { // a ribbon line slides down from under the opponent strip
    try {
      if (!ok(el) || instant()) return done();
      return settle(el.animate([
        { transform: 'translateY(-110%)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], { duration: 320, easing: 'cubic-bezier(.2,.9,.3,1.1)' }));
    } catch { return done(); }
  },
  fadeOut(el, duration = 450) {
    try {
      if (!ok(el)) return done();
      if (instant()) { el.style.opacity = '0'; return done(); }
      return settle(el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { duration, easing: 'ease-in', fill: 'forwards' }));
    } catch { return done(); }
  },
  pulse(el) { // the permanent whose trigger just fired: one accent ring flash
    try {
      if (!ok(el) || instant()) return done();
      const target = el.querySelector(':scope > img, :scope > .tokface') || el;
      return settle(target.animate([
        { boxShadow: '0 0 0 0 transparent' },
        { boxShadow: '0 0 0 3px var(--acc, #d9b45c), 0 0 26px var(--acc, #d9b45c)' },
        { boxShadow: '0 0 0 0 transparent' },
      ], { duration: 700, easing: 'ease-out' }));
    } catch { return done(); }
  },

  sleep(ms) { return wait(ms); },
};

export default fx;
