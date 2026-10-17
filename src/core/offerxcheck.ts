// Second-source reads for the fclaim-lane fill, both from an independent resolver and both fail-soft. The offer by
// id covers a cancel or consuming fill older than the SPV scan window (test/fill-offer-crosscheck.test.mjs). The
// resolver's verdict on the buyer's own fclaim covers a header source that hides a competing hold placed just
// before it (test/fill-reservation-verdict.test.mjs). Refuse only on positive evidence; absence, lag, errors and
// garbage proceed.

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

/** One second-source reply: the HTTP status and the parsed JSON body (null when the body is not JSON). */
export interface SecondSourceReply { ok: boolean; status: number; body: unknown }

/** A started second-source read. `answer()` is undefined while pending and null when nothing usable came back. */
export interface SecondSourceRead { answer(): SecondSourceReply | null | undefined; stop(): void }

/** The body of a 2xx reply, else null. */
export function okBody(reply: SecondSourceReply | null | undefined): unknown {
  return reply && reply.ok ? reply.body : null;
}

/** Start GET {base}/cairnx/{route}/{id} without awaiting it. Errors resolve to null; a malformed id reads nothing. */
export function startSecondSourceRead(base: string, route: "offer" | "record", id: string, timeoutMs: number): SecondSourceRead {
  let ans: SecondSourceReply | null | undefined = undefined;
  const key = String(id).toLowerCase();
  if (!HASH_RE.test(key)) return { answer: () => null, stop: () => {} };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  (async () => {
    try {
      const r = await fetch(`${base}/cairnx/${route}/${encodeURIComponent(key)}`, { signal: ac.signal });
      ans = { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
    } catch { ans = null; /* network error, timeout or abort: no evidence */ }
    finally { clearTimeout(timer); }
  })();
  return { answer: () => ans, stop: () => { clearTimeout(timer); ac.abort(); } };
}

// How far a resolver's tipHeight may lead the events it has applied. The cairnx service publishes tipHeight and
// events from one scan (events <= tipHeight); with its inclusion check on it applies only events confDepth (12,
// cairnx Scanner.FINALITY) below the verified tip. 12 also covers a shallow reorg that re-mines our fclaim higher.
export const RECORD_LAG_MARGIN = 12;

// A note is shown to the user, so only short printable ASCII is kept (every vendored fclaim denial reason is).
const NOTE_RE = /^[\x20-\x7e]{1,160}$/;

export type ReservationVerdict = { kind: "denied"; note: string | null } | { kind: "unknown"; tipHeight: number } | null;

/**
 * The second resolver's verdict on our fclaim from GET /cairnx/record/{fclaimTxid}. "denied": it replayed this
 * fclaim and did not apply it, so the chain it follows would deliver nothing for the fill. "unknown": it has
 * scanned at least RECORD_LAG_MARGIN blocks past our proven fclaim height and has no record of it. Anything else
 * (applied, a lagging 404, a wrong kind or txid, garbage, no reply) is null: no evidence.
 */
export function reservationRecordVerdict(reply: SecondSourceReply | null | undefined, ctx: { fclaimTxid: string; provenHeight?: number }): ReservationVerdict {
  if (!reply || !reply.body || typeof reply.body !== "object") return null;
  const b = reply.body as Record<string, unknown>;
  if (reply.status === 200) {
    if (b.kind !== "fclaim" || b.applied !== false) return null;
    if (typeof b.txid !== "string" || b.txid.toLowerCase() !== String(ctx.fclaimTxid).toLowerCase()) return null;
    return { kind: "denied", note: typeof b.note === "string" && NOTE_RE.test(b.note) ? b.note : null };
  }
  if (reply.status === 404) {
    const tip = b.tipHeight, h = ctx.provenHeight;
    if (typeof tip === "number" && Number.isSafeInteger(tip) && typeof h === "number" && Number.isSafeInteger(h) && tip >= h + RECORD_LAG_MARGIN)
      return { kind: "unknown", tipHeight: tip };
  }
  return null;
}
