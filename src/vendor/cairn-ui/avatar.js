// The identity avatar: a circle filled with a soft conic gradient that is the same for the same seed wherever it is
// drawn (the site's name pages, the wallet). The look is the approved design's `.avatar`: four stops from blue through
// violet and pink to peach, light and soft, edged by a hairline (avatar.css). Each seed turns the gradient (its start
// angle), picks its stretch of that hue arc and its direction, and keeps the arc's lightness and chroma. The arc
// stays out of green and yellow, which the design keeps for up and caution. The output is built from numbers only, so
// no character of a seed reaches CSS or HTML (test/avatar.test.mjs).

/** The OKLCH hue arc every stop is drawn from, in degrees: from ARC_START, ARC degrees forward (through 0). */
export const ARC_START = 262;
export const ARC = 168;

// FNV-1a over UTF-16 code units, then the MurmurHash3 finaliser so neighbouring seeds land far apart.
function fmix32(x) {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}
// The k-th number in [0, 1) drawn from a seed's hash.
const draw = (h, k) => fmix32(h + Math.imul(k + 1, 0x9e3779b9)) / 4294967296;

// OKLCH to linear sRGB (Ottosson's OKLab matrices).
function linearRgb(L, C, hue) {
  const r = (hue * Math.PI) / 180;
  const a = C * Math.cos(r);
  const b = C * Math.sin(r);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (c) => c.every((v) => v >= 0 && v <= 1);
const encode = (v) => {
  const x = Math.min(1, Math.max(0, v));
  return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
};
// The colour at lightness L and hue `hue`, with the chroma lowered as far as sRGB needs.
function stop(L, C, hue) {
  let lin = linearRgb(L, C, hue);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(linearRgb(L, mid, hue))) lo = mid;
      else hi = mid;
    }
    lin = linearRgb(L, lo, hue);
  }
  return lin.map(encode);
}

/**
 * The avatar of `seed` (a non-string seed counts as ""): the gradient's start angle in whole degrees and its four
 * stops as [r, g, b] in 0..255.
 * @param {unknown} seed
 * @returns {{ from: number, stops: number[][] }}
 */
export function avatarSpec(seed) {
  const h = hash32(typeof seed === "string" ? seed : "");
  const from = Math.floor(draw(h, 0) * 360);
  const span = 110 + draw(h, 1) * (ARC - 110);
  const start = ARC_START + draw(h, 2) * (ARC - span);
  // where the two inner stops fall along the span; the design's are at 0.18 and 0.56
  const at = [0, 0.13 + draw(h, 3) * 0.1, 0.51 + draw(h, 4) * 0.1, 1];
  const stops = at.map((t) => {
    const hue = start + span * t;
    const p = (hue - ARC_START) / ARC;
    // the design's stops: blue is the deepest and most saturated, peach the lightest and softest
    return stop(0.625 + 0.21 * p, 0.2 - 0.075 * p, hue % 360);
  });
  if (draw(h, 5) < 0.5) stops.reverse();
  return { from, stops };
}

/**
 * The CSS background of `seed`'s avatar: a conic-gradient of whole numbers, closed on its first stop.
 * @param {unknown} seed
 * @returns {string}
 */
export function avatarBackground(seed) {
  const { from, stops } = avatarSpec(seed);
  const rgb = ([r, g, b]) => `rgb(${r} ${g} ${b})`;
  return `conic-gradient(from ${from}deg, ${[...stops, stops[0]].map(rgb).join(", ")})`;
}

/**
 * The avatar as markup: a decorative span with the class ui-avatar and any extra classes (letters, digits, "_" and
 * "-" only; anything else throws), its background set inline.
 * @param {unknown} seed
 * @param {string} [extraClass]
 * @returns {string}
 */
export function avatarHtml(seed, extraClass = "") {
  if (typeof extraClass !== "string" || !/^[A-Za-z0-9_ -]*$/.test(extraClass)) throw new TypeError("avatarHtml: a class list of letters, digits, _ and - only");
  const cls = extraClass.trim() ? ` ${extraClass.trim().replace(/\s+/g, " ")}` : "";
  return `<span class="ui-avatar${cls}" style="background:${avatarBackground(seed)}" aria-hidden="true"></span>`;
}

/**
 * The seed of an account's avatar: its primary name when it has one (so the account and that name's page draw the
 * same avatar), else its address in lower case, else "".
 * @param {string | null | undefined} primaryName
 * @param {string | null | undefined} address
 * @returns {string}
 */
export function identitySeed(primaryName, address) {
  const name = typeof primaryName === "string" ? primaryName.trim() : "";
  if (name) return name;
  return typeof address === "string" ? address.toLowerCase() : "";
}
