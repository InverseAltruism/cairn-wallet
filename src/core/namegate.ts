// The verdict on a name action (renew, or a name record such as set primary) from the name service's record, and
// the one reader of that record. The approval window shows the verdict before Approve (approve.ts); the wallet
// re-derives it before it signs its own renew and set primary (wallet.ts), so a review primed earlier cannot pay a
// fee the resolver would ignore.

/** The name service's answer: a record, a clean 404 (`record: null`), or no usable answer (`failed`). */
export type NameFetchResult =
  | { failed: true }
  | { failed?: false; record: Record<string, any> | null };

/** Both readers give up after this long and proceed on `failed` (the gate fails open on transport). */
export const NAME_READ_TIMEOUT_MS = 6000;

/** Reads `/cairnx/name/:name` through `get` (a fetch bound to the trade API base and a timeout). Never throws: a
 *  network error, a timeout, a non-404 error status or a body that is not a JSON object is `failed`. */
export async function readNameRecord(get: (path: string) => Promise<Response>, name: string): Promise<NameFetchResult> {
  try {
    const res = await get(`/cairnx/name/${encodeURIComponent(name)}`);
    if (res.status === 404) return { record: null };
    if (res.ok) { const j = await res.json().catch(() => null); if (j && typeof j === "object") return { record: j }; }
  } catch { /* unreachable or timed out: not definitive, so the caller fails open */ }
  return { failed: true };
}

// Both records ride a fee (nrenew the treasury renewal fee, nset the 0.25 CSD anchor) that is spent when the resolver
// ignores the record. Block only on a definitive no-op: a clean 404, and for nset an owner mismatch. A pending
// reservation and a lapsed name only warn here, because the record may be stale (warn over block); the resolver's
// nrenew and nset both reject them, and the service marks a name `expired` only once its grace period is over. A
// transport failure warns and never blocks.
const CATCHING_UP = "If it was registered in the last few minutes, the name service may still be catching up: try again later.";
export function nameActApproveGate(kind: "nrenew" | "nset", fetched: NameFetchResult, me: string): { block: boolean; note: string | null } {
  if (fetched.failed) {
    return { block: false, note: `Could not verify this ${kind === "nrenew" ? "renewal" : "name record"} against the name service (unreachable). A no-op ${kind === "nrenew" ? "renewal burns the renewal fee" : "record burns the anchor fee"}. Approve only if the site shows the action as available.` };
  }
  const rec = fetched.record;
  if (rec == null) {
    return { block: true, note: kind === "nrenew"
      ? `Refusing to sign: this name is not registered, so the renewal would be ignored on-chain and the fee burned. ${CATCHING_UP}`
      : `Refusing to sign: this name is not registered, so the record would be ignored on-chain and the anchor fee spent for nothing. ${CATCHING_UP}` };
  }
  if (kind === "nset" && typeof rec.owner === "string" && rec.owner.toLowerCase() !== me.toLowerCase()) {
    return { block: true, note: "Refusing to sign: this name is owned by a different address, so the resolver would ignore this record and the anchor fee would be spent for nothing. If you just bought it, wait for the purchase to settle and re-open." };
  }
  if (rec.pending === true) {
    return { block: false, note: kind === "nrenew"
      ? "This name is a pending reservation, not a finalized registration: a renewal would be ignored on-chain and the fee burned. Finalize the registration first before renewing."
      : "This name is a pending reservation, not a finalized registration: the record would be ignored on-chain and the anchor fee spent for nothing. Finalize the registration first." };
  }
  if (rec.expired === true) {
    return { block: false, note: kind === "nrenew"
      ? "This name has lapsed: its lease and grace period are over, and a lapsed name is claimed again, not renewed, so the renewal fee would be burned. Verify on the site before approving."
      : "This name has lapsed: its lease and grace period are over, so the record would be ignored on-chain and the anchor fee spent for nothing. Claim the name again on the site first." };
  }
  return { block: false, note: null };
}

/** The wallet's own renew and set primary, at the sign: the refusal text, or null to sign. Nobody reads a warning
 *  here, so an answered read refuses on a block and on a warning (a pending or lapsed name, which the resolver's
 *  nrenew and nset reject); a read with no answer signs, as the approval window lets Approve through. */
export function nameActSignRefusal(kind: "nrenew" | "nset", fetched: NameFetchResult, me: string): string | null {
  if (fetched.failed) return null;
  return nameActApproveGate(kind, fetched, me).note;
}
