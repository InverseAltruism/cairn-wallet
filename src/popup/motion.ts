// Scripted motion reads the cairn-ui motion tokens from the page, so a tween runs on the same durations and curve
// as the CSS around it. Display only: nothing here touches a value that is signed or sent.

/** A `--ui-dur-*` token in milliseconds, or null when the page does not define it (then: no tween). */
export function tokenMs(name: string): number | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(v);
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : null;
}

/** The progress function of a CSS `cubic-bezier(x1, y1, x2, y2)` with x1 and x2 in [0, 1]. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const coord = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0, hi = 1, s = t;
    for (let i = 0; i < 30; i++) {
      s = (lo + hi) / 2;
      if (coord(x1, x2, s) < t) lo = s; else hi = s;
    }
    return coord(y1, y2, s);
  };
}

/** The `--ui-ease` curve, or null when the token is missing or not a cubic-bezier. */
export function tokenEase(name = "--ui-ease"): ((t: number) => number) | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(v);
  const p = m?.[1]?.split(",").map((x) => Number(x.trim())) ?? [];
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) return null;
  const [x1, y1, x2, y2] = p as [number, number, number, number];
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
  return cubicBezier(x1, y1, x2, y2);
}
