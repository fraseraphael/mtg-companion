/* Deck JSON -> CSS custom properties on :root.
   The commander's art crop becomes the table backdrop, the colour pips drive the palette,
   and the dummy opponent gets the complementary tint so the two sides read as two players. */

const PIP_HEX = { W: '#f3e9c6', U: '#3b7dd8', B: '#5d4b7a', R: '#d65a3b', G: '#3e9a5a' };
const INK = '#0b0a10';
const FALLBACK_ACC = '#d9b45c';

/* ---------- colour maths ---------- */
function hexToRgb(h) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
}
const toHex = rgb => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const rgba = (rgb, a) => `rgba(${rgb.map(Math.round).join(', ')}, ${a})`;
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
function luminance(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Dark or light text, whichever reads better on rgb. */
const inkOn = rgb => (contrast(rgb, [16, 16, 16]) >= contrast(rgb, [245, 242, 236]) ? '#101010' : '#f5f2ec');
/** Lift a colour's lightness until it reads as text on the dark ink (>= 4.5:1). */
function liftForInk(rgb) {
  const ink = hexToRgb(INK);
  let [h, s, l] = rgbToHsl(rgb), out = rgb;
  for (let i = 0; i < 20 && contrast(out, ink) < 4.5; i++) { l = Math.min(0.92, l + 0.04); out = hslToRgb([h, s, l]); }
  return out;
}
/** Complementary hue, kept in a band that stays visible on dark ink. */
function complement(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h + 180, clamp(s < 0.12 ? 0.45 : s, 0.35, 0.7), clamp(l, 0.45, 0.6)]);
}

/* ---------- the theme ---------- */
export function applyTheme(deck) {
  const root = document.documentElement;
  const set = (k, v) => root.style.setProperty(k, v);
  const d = deck || {};

  const pips = [...new Set((Array.isArray(d.pips) ? d.pips : []).map(p => String(p).toUpperCase()).filter(p => PIP_HEX[p]))];
  const accRgb = hexToRgb(d.accent) || (pips.length ? hexToRgb(PIP_HEX[pips[0]]) : hexToRgb(FALLBACK_ACC));
  const cols = pips.length ? pips.map(p => hexToRgb(PIP_HEX[p])) : [accRgb];
  const tint = [0, 1, 2].map(i => cols.reduce((s, c) => s + c[i], 0) / cols.length);

  // accent: the deck's own colour, lifted only if it would vanish on the ink
  const accText = liftForInk(accRgb);
  set('--acc', toHex(accText));
  set('--acc-raw', toHex(accRgb));
  set('--acc-ink', inkOn(accText));

  // tint: one pip tints everything; two+ blend for flat uses and run as a gradient elsewhere
  set('--tint', toHex(tint));
  set('--tint-text', toHex(liftForInk(tint)));
  set('--tint-ink', inkOn(tint));
  const stops = cols.length > 1 ? cols.map(toHex).join(', ') : `${toHex(cols[0])}, ${toHex(cols[0])}`;
  set('--tint-grad', `linear-gradient(90deg, ${stops})`);
  set('--tint-glow', cols.length > 1
    ? `linear-gradient(90deg, ${cols.map(c => rgba(c, 0.55)).join(', ')})`
    : `linear-gradient(90deg, transparent, ${rgba(cols[0], 0.6)}, transparent)`);
  // the felt: one soft pool of colour per pip, spread across the width
  set('--felt', cols.map((c, i) => {
    const x = cols.length > 1 ? Math.round(10 + (80 * i) / (cols.length - 1)) : 50;
    return `radial-gradient(ellipse 75% 65% at ${x}% 55%, ${rgba(c, 0.2)} 0%, transparent 70%)`;
  }).join(', '));

  // the dummy: complementary tint, per pip when multicolour
  const opp = complement(tint);
  const oppCols = cols.map(complement);
  set('--opp', toHex(opp));
  set('--opp-text', toHex(liftForInk(opp)));
  set('--opp-ink', inkOn(opp));
  set('--opp-grad', oppCols.length > 1
    ? `linear-gradient(90deg, ${oppCols.map(toHex).join(', ')})`
    : `linear-gradient(90deg, ${toHex(opp)}, ${toHex(opp)})`);

  // commander art as the table backdrop (blur/darken/vignette happen in style.css)
  const art = typeof d.art === 'string' && /^https:\/\//i.test(d.art) ? d.art : '';
  set('--table-art', art ? `url("${art.replace(/["\\\n\r]/g, c => encodeURIComponent(c))}")` : 'none');

  root.dataset.pips = pips.join('') || 'C';
  root.dataset.multi = pips.length > 1 ? '1' : '0';
  if (d.name) document.title = `${d.name} · Goldfish`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', INK);
}
