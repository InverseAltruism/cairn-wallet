// The CSD/USD rate behind the balance's USD line, read from the Cairn API's /api/market/csd. Display only: nothing that
// is signed, and no send amount, fee or check, reads it. The route answers 503 while the site's market data is off;
// then, and on any other failure or an answer without a usable price, there is no rate and the line is absent.

/** A rate as the line shows it: USD per CSD, the venue it came from and the notes the API attaches. */
export interface CsdUsdRate { ok: true; rate: number; source: "SafeTrade" | "CoinPaprika"; stale: boolean; ageSecs: number; disagree: boolean }
export type CsdMarket = CsdUsdRate | { ok: false };

const SOURCES: Readonly<Record<string, CsdUsdRate["source"]>> = Object.freeze({ safetrade: "SafeTrade", coinpaprika: "CoinPaprika" });

/** The rate in an /api/market/csd body, or { ok: false } when it holds no positive finite price from a named venue. */
export function parseCsdMarket(body: unknown): CsdMarket {
  const b = body as { ok?: unknown; price?: { last?: unknown; source?: unknown }; stale?: unknown; ageSecs?: unknown; disagree?: unknown } | null;
  if (!b || typeof b !== "object" || b.ok !== true || !b.price || typeof b.price !== "object") return { ok: false };
  const rate = b.price.last;
  const src = typeof b.price.source === "string" && Object.prototype.hasOwnProperty.call(SOURCES, b.price.source) ? SOURCES[b.price.source] : undefined;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || !src) return { ok: false };
  const age = Number(b.ageSecs);
  return { ok: true, rate, source: src, stale: b.stale === true, ageSecs: Number.isFinite(age) && age > 0 ? age : 0, disagree: b.disagree === true };
}

/** Reads the rate from the Cairn API at `apiBase`; never throws. */
export async function csdMarket(apiBase: string, timeoutMs = 8000): Promise<CsdMarket> {
  try {
    const r = await fetch(`${apiBase.replace(/\/+$/, "")}/api/market/csd`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false };
    return parseCsdMarket(await r.json());
  } catch { return { ok: false }; }
}

/** The USD line for a balance of `base` base units (1 CSD = 1e8): "≈ $77.08 · USD via SafeTrade", with the API's
 *  stale and disagreement notes; null without a rate or a balance. The product is a display figure in floating
 *  point, rounded to cents; it never feeds back into anything the wallet computes. */
export function usdLine(base: number | null, m: CsdMarket | null): string | null {
  if (base === null || !Number.isSafeInteger(base) || base < 0 || !m || !m.ok) return null;
  const usd = (base / 1e8) * m.rate;
  if (!Number.isFinite(usd)) return null;
  const figure = usd > 0 && usd < 0.005 ? "< $0.01" : `≈ $${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const notes = [m.stale ? `stale, ${Math.max(1, Math.round(m.ageSecs / 60))} min ago` : "", m.disagree ? "sources differ" : ""].filter(Boolean);
  return [figure, `USD via ${m.source}`, ...notes].join(" · ");
}
