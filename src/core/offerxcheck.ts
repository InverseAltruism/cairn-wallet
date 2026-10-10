// Second-source read of an offer for the fclaim-lane fill. The fill SPV scan (fillspv.ts) covers only a
// tip-anchored window, so a primary resolver can withhold an older cancel or consuming fill. An independent
// resolver's view of the OFFER (by offer id) can show that. Refuse only on positive evidence; absence, lag,
// errors and garbage proceed (test/fill-offer-crosscheck.test.mjs).

const HASH_RE = /^0x[0-9a-f]{64}$/;
const CLOSED = new Set(["cancelled", "filled", "expired"]);

export interface OfferCrossCheckCtx { offerId: string; fclaimTxid: string; ownHoldEnd?: number }

// Absent counts as 0 (a never-filled offer omits paid/delivered); a malformed value is null (no evidence).
function units(v: unknown): bigint | null {
  if (v === undefined || v === null) return 0n;
  const s = String(v);
  return /^\d{1,40}$/.test(s) ? BigInt(s) : null;
}

/**
 * Why the second source contradicts the primary's offer for this fill, or null when it gives no positive
 * evidence. Only states a lagging honest source cannot produce trigger: a closed status, more paid or
 * delivered than the primary served, or a different reservation whose hold ends after ours. A lagging
 * source shows the previous holder, whose hold ended before our grant, so that never refuses.
 */
export function secondSourceOfferConflict(primary: unknown, second: unknown, ctx: OfferCrossCheckCtx): string | null {
  if (!second || typeof second !== "object") return null;
  const s = second as Record<string, unknown>;
  const p = (primary && typeof primary === "object" ? primary : {}) as Record<string, unknown>;
  if (String(s.id ?? "").toLowerCase() !== String(ctx.offerId).toLowerCase()) return null;
  if (typeof s.status === "string" && CLOSED.has(s.status)) return `this offer is ${s.status}`;
  for (const [k, label] of [["paid", "paid"], ["delivered", "delivered"]] as const) {
    if (s[k] === undefined || s[k] === null) continue;
    const sv = units(s[k]), pv = units(p[k]) ?? 0n;
    if (sv !== null && sv > pv) return `more of this offer has already been ${label} (${sv} base units, your resolver shows ${pv})`;
  }
  const holder = String(s.claimTxid ?? "").toLowerCase();
  const until = s.claimUntilHeight;
  if (HASH_RE.test(holder) && holder !== String(ctx.fclaimTxid).toLowerCase()
    && typeof until === "number" && Number.isSafeInteger(until)
    && typeof ctx.ownHoldEnd === "number" && Number.isSafeInteger(ctx.ownHoldEnd) && until > ctx.ownHoldEnd)
    return "a later reservation now holds this offer";
  return null;
}

/** A started second-source read. `answer()` is undefined while pending and null when there is no usable body. */
export interface SecondSourceRead { answer(): unknown; stop(): void }

/** Start GET {base}/cairnx/offer/{offerId} without awaiting it. Errors resolve to null; a malformed id reads nothing. */
export function startSecondSourceOfferRead(base: string, offerId: string, timeoutMs: number): SecondSourceRead {
  let ans: unknown = undefined;
  const id = String(offerId).toLowerCase();
  if (!HASH_RE.test(id)) return { answer: () => null, stop: () => {} };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  (async () => {
    try {
      const r = await fetch(`${base}/cairnx/offer/${encodeURIComponent(id)}`, { signal: ac.signal });
      ans = r.ok ? await r.json().catch(() => null) : null;
    } catch { ans = null; /* network error, timeout or abort: no evidence */ }
    finally { clearTimeout(timer); }
  })();
  return { answer: () => ans, stop: () => { clearTimeout(timer); ac.abort(); } };
}
