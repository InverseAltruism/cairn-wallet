// The fill preflight: what the wallet checks before it signs an offer fill (fillOffer, and an attest at the
// token-fill confidence). It reads the offer and the chain through the wallet (FillPreflightIo) and returns a
// refusal, or null to sign. Nothing here signs or records.
import { attestRefusal, fillTxRefusal, type SubmitResult } from "./node.js";
import { cairnxTradeFee, fillIsSafe, hasLiveClaim, requiredFillOutputs, verifyFillSpv, bindOfferTerms, fmtCsd, FEE_BPS, FEE_BPS_V16, V16_HEIGHT, TREASURY_ADDR } from "./cairnx.js";
import { fclaimHoldEnd, offerExpiryHeightOf, offerFillTooLate, LEGACY_HOLD_SUNSET_HEIGHT, type OfferState, type FillSpvIo, type FillVerdict } from "../vendor/cairnx-spv.js";
import { BodyMismatchError } from "./spvbind.js";
import type { MintedProvenOfferTerms, OfferProgress } from "./fillspv.js";
import { refuse } from "./refuse.js";
import { fillOf, type AttestFields } from "./signfields.js";
import { secondSourceOfferConflict, reservationRecordVerdict, secondSourceUnanswered, startSecondSourceRead, okBody, type SecondSourceRead, type ReservationUnconfirmed } from "./offerxcheck.js";
import { CLARVIS_TRADE_API } from "./endpoints.js";
import { OWN_FILL_INDEX_WAIT_MS } from "./history.js";
import { lowestChainHeight } from "./namespv.js";

// F2 (amount leg): does the resolver-served offer's fee/rebate-relevant fields match the MERKLE-PROVEN offer?
// requiredFillOutputs sizes the treasury fee from feeBps (= feeBpsAt(creation height)), the maker rebate from
// height/taker/bid, and the payment from want.value; a lying resolver deflating any of them makes the wallet
// build an under-sized fill that resolve() (using the proven values) rejects AFTER the payment leg moved =
// pay-without-delivery burn (theft if the attacker is the seller). Bind the served fields to the proven ones.
// Plan 70 R2 Option B: delegate to the SINGLE vendored bindOfferTerms verdict (cairnx-core), retiring this
// repo's hand-copy. It binds height/feeBps/value/taker/bid AND the R1.1 `min` presence+value leg exactly as
// before (byte-identical behaviour, differential-locked by the WA-PARITY corpus across all three seams).
// B7e (REBIND W7 + W1 wallet half): the give legs (give.ticker/amount/name, explicit-presence + verbatim
// string equality, closing the W7 give-inflation shortchange) AND the symmetric want-type refusal are ON,
// passed explicitly so the verdict does not depend on the bundle's default (on since cairnx-core 0.2.0;
// test/vendor-bind-legs.test.mjs pins both). `t` MUST be a MintedProvenOfferTerms (produced only by the
// vendored provenOfferTerms via fillspv.ts), so a hand-built terms object is a compile error exactly where it
// would false-refuse every honest fill (the W2 trap the brand exists to make unrepresentable).
// The vendored verifyFillSpv reasons whose verdict is evaluated at the tip (hold liveness, grant routing,
// the deadline margin, burial depth). Matched on the bundle's wording; test/fillspv-tip-floor.test.mjs runs
// the real verifier for both sides, so a reword in the bundle turns that file red.
export function tipDependentFillReason(reason: string): boolean {
  return /^(no live claim by you|this fclaim is not the live granted hold|too close to the hold deadline)|not buried deep enough yet/.test(String(reason));
}

// Runs on the CSD lanes and the token lane (tokenLanePreflight). On the token lane the give leg and the want leg
// are the content bind: the want leg refuses a proven CSD offer served as a token offer and, for a proven token
// want, a served want.ticker or want.amount that differs from the record (on the CSD lane the value leg shadows it).
function provenTermsMismatch(offer: unknown, t: MintedProvenOfferTerms): boolean {
  return bindOfferTerms(offer, t, { give: true, wantType: true });
}

/** The height the offer-id checks (the sunset and expiry refusals) compare: the served tip or namespv.ts
 *  lowestChainHeight (the stored floor and the release's newest anchor), whichever is higher. A non-finite tip
 *  counts as 0. */
export function offerIdChainBound(tip: number, floor: number): number {
  return Math.max(Number.isFinite(tip) ? tip : 0, lowestChainHeight(floor));
}

/** The sunset refusal for an offer-id fill; `height` gives the chain height (offerIdChainBound in production) and is
 *  asked only for an open CSD offer, so the exempt lanes read nothing more. From the bundle's LEGACY_HOLD_SUNSET_HEIGHT
 *  no legacy hold is live (hasLiveClaim of the last legacy grant, at V28 - 1, is false there), and the resolver
 *  rejects every offer-id fill of an open CSD offer. It reads no served claim field, so a resolver that omits
 *  `claimTxid` or forges `claimedBy` cannot steer past it. Taker-bound and token-priced offers are exempt: neither is
 *  an open-lane claim fill. */
export async function legacySunsetRefusal(offer: OfferState, isCsdWant: boolean, height: () => Promise<number>): Promise<FillRefusal | null> {
  if (offer.taker !== undefined || !isCsdWant || (await height()) < LEGACY_HOLD_SUNSET_HEIGHT) return null;
  return { ok: false, error: "past the V28 sunset an open offer can only be filled through its reservation (fclaim) target: ask the marketplace for the reservation id; paying the offer id now would be rejected on-chain and the funds lost", sighashMatch: false, code: "FILL_LEGACY_SUNSET" };
}

// The offer-id lanes' expiry check, on the merkle-proven expiry and anchor height, at offerIdChainBound: a fill whose
// offer's last live block is below that bound plus FILL_TIP_MARGIN is refused. For an offer anchored at or above V22
// that expiry is the proposal's own, and the node drops the late fill (no payment moves). Below V22 the bundle caps
// the offer's life (offerExpiryHeightOf) and the proposal can carry a later expiry, so the node admits a fill that the
// resolver refuses as expired: the payment moves. The bound is a lower bound on the chain's height, so the copy says
// "at or past".
async function offerExpiryRefusal(wallet: FillPreflightIo, proven: ProvenOfferPayto, tip: number): Promise<FillRefusal | null> {
  if (!Number.isFinite(proven.expiresEpoch) || !Number.isInteger(proven.height)) return null;
  const at = offerIdChainBound(tip, await wallet.tipFloor());
  const expiresAt = offerExpiryHeightOf(proven.expiresEpoch, proven.height);
  if (offerFillTooLate(expiresAt, at))
    return { ok: false, error: `refusing to sign: this offer expires at block ${expiresAt.toLocaleString("en-US")} and the chain is at or past block ${at.toLocaleString("en-US")}, so the fill cannot be mined in time; it would sit unconfirmed and be dropped. Ask the seller to relist.`, sighashMatch: false, code: "FILL_UNSAFE" };
  return null;
}

/** Thrown by the fclaim-lane source (fillspv.ts) when the merkle-proven offer Propose is not an offer the resolver admits (cairnx-core
 *  provenOfferRefusal: its domain, payee and creation rules), so a fill would pay and deliver nothing. */
export class OfferNotAdmittedError extends Error {
  constructor(readonly reason: string) {
    super(`fill-SPV: the proven offer is not an offer the resolver admits (${reason})`);
    this.name = "OfferNotAdmittedError";
  }
}

// A merkle-proven offer the resolver does not admit as an offer (provenOfferRefusal: a foreign settlement domain, the
// treasury as payee, a record rule at its creation): the resolver ignores a fill of it, so the payment would be lost.
function offerNotAdmitted(reason: string): FillRefusal {
  return refuse("FILL_UNSAFE", `refusing to sign: this offer's on-chain record is not an offer the marketplace accepts (${reason}), so the chain would take your payment and deliver nothing`);
}

// Abort bound for the fclaim-lane second-source reads (offer and reservation record). The fill does not wait on
// them: an answer is used only if it arrived before the SPV scan finished (fclaimLanePreflight; timed in
// test/fill-offer-crosscheck and test/fill-reservation-verdict).
const SECOND_SOURCE_TIMEOUT_MS = 12000;

// A fill refusal; RESERVATION_UNCONFIRMED also carries the facts the approval window shows.
export type FillRefusal = SubmitResult & { unconfirmed?: ReservationUnconfirmed };
// The shape of a fill target (an offer id or a reservation txid); the preflight refuses anything else before any read.
const FILL_TARGET_RE = /^0x[0-9a-fA-F]{64}$/;
const isTarget = (v: unknown): v is string => typeof v === "string" && FILL_TARGET_RE.test(v);
const badTarget = (): FillRefusal => ({ ok: false, error: "proposalId must be a 0x… 32-byte txid", sighashMatch: false, code: "BAD_REQUEST" });
// The preflight sums a fill's outputs in bigint and takes each value only as a positive safe integer number; a
// decimal-digit string, which the engine would parse, is refused here first.
function outputValueRefusal(outputs: readonly unknown[]): FillRefusal | null {
  const bad = outputs.some((o) => { const v = (o as { value?: unknown } | null)?.value; return typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0; });
  return bad ? { ok: false, error: "each output value must be a positive integer amount in base units: refusing to sign", sighashMatch: false, code: "BAD_OUTPUTS" } : null;
}
/** Why the signer refuses a page's fill on its parameters alone (`f` is signfields.ts fillFields), or null: a score or
 *  confidence that is not a scalar (wallet.ts fillOffer), the preflight's checks that read nothing, then the engine's
 *  (node.ts fillTxRefusal). background.ts asks it before it queues a fillOffer or an attest signed as a fill, so the
 *  window does not open for a fill the signer refuses on its parameters alone (test/send-fill-prequeue.test.mjs). */
export function fillRefusal(f: { proposalId: unknown; outputs: readonly unknown[]; fee: unknown; shape?: string }): { code: string; error: string } | null {
  if (f.shape) return { code: "BAD_REQUEST", error: f.shape };
  const pre = !isTarget(f.proposalId) ? badTarget() : outputValueRefusal(f.outputs);
  return pre ? { code: String(pre.code), error: String(pre.error) } : fillTxRefusal(f);
}
/** Why the signer refuses a page's attest on its parameters alone, or null: as a fill (fillRefusal) at the token-fill
 *  confidence, else a score or confidence that is not a scalar (wallet.ts attest), then the engine's checks
 *  (node.ts attestRefusal). background.ts asks it before it queues an attest. */
export function attestRequestRefusal(a: AttestFields): { code: string; error: string } | null {
  if (a.route === "fill") return fillRefusal(a.fill);
  return a.shape ? { code: "BAD_REQUEST", error: a.shape } : attestRefusal(a);
}
/** The target a dApp request would fill, lowercased as the preflight compares it, or null when the request is not a
 *  fill or names a malformed target (which the preflight refuses with BAD_REQUEST before any read). */
export function fillTargetOf(method: string, params: unknown): string | null {
  const f = fillOf(method, params);
  if (!f) return null;
  return isTarget(f.proposalId) ? f.proposalId.toLowerCase() : null;
}

// What a passing preflight hands the signer. `secondSource`: set by the fclaim lane when clarvis's record read had not
// answered (or failed) at its verdict; a signed fill carries it to the approval window (background.ts keeps it off the
// page's result). `repeat`: this account's recent fills of the target that the lane has not seen applied, one of them
// with its submit answer lost, which the signer checks the assembled transaction against (repeatedFillRefusal).
export type RecentFill = { txid: string; maybe: boolean };
export type RepeatedFills = { unseen: RecentFill[]; copy: "unlisted-partial" | "confirming" };
export type FillNotes = { secondSource?: "pending" | "failed"; repeat?: RepeatedFills };

// What the SPV seams return to the fill preflight: the fclaim lane's proof source with the computed cap
// over-count, the proven terms and whether the tip was floor-clamped; the legacy lane's proven offer author.
export type FillSpvIoExt = FillSpvIo & { myLiveHoldsAtGrant?: number; provenTerms?: MintedProvenOfferTerms; tipFloored?: boolean };
export type ProvenOfferPayto = { payto: string; seller: string; terms: MintedProvenOfferTerms; expiresEpoch: number; height: number; progress?: OfferProgress };
// The proven offer Propose is not an offer the resolver admits; `refused` is cairnx-core provenOfferRefusal's reason.
export type ProvenOfferRefused = { refused: string };
// The reads the fill preflight makes through the wallet: the CairnX read API, the node tip and its PoW-backed
// floor, and the two merkle-proving SPV seams.
export interface FillPreflightIo {
  tradeGet(path: string): Promise<Response>;
  tip(): Promise<number | null>;
  tipFloor(): Promise<number>;
  /** With `fills`, also the running state those listed fills prove (`progress`). */
  makeProvenOfferPayto(offerId: string, offerHeight: number, fills?: readonly { txid: string; height: number }[]): Promise<ProvenOfferPayto | ProvenOfferRefused | null>;
  /** `me`'s own fills of `offerId` recorded in the last OWN_FILL_INDEX_WAIT_MS (local history, no read). */
  recentOwnFills(offerId: string, me: string): Promise<RecentFill[]>;
  makeFillSpvIo(offerId: string, fclaimTxid: string, me: string, offerHeight: number): Promise<FillSpvIoExt>;
}

export type TokenFillQuote = {
  ticker?: string; amount?: string; fee?: string; total?: string;
  giveTicker?: string; giveAmount?: string; giveName?: string;
  // 0.2.71, display only (never bound): decimals and deploy ids for human units and the ticker warning
  wantDecimals?: number; giveDecimals?: number; wantDeployId?: string; giveDeployId?: string;
};

// ── fund-safety pre-flight (deep-review 2026-07-03 C2/C3/C4): the wallet's own fillOffer must NEVER sign a
// payment tx the resolver will reject AFTER the CSD moves (no escrow → the payment is lost). Re-fetch the
// CURRENT offer record and run the shared cairnx-core pre-flight over it. The check is computed from the
// offer's OWN give/want/min/claim fields (not a resolver boolean), so even a hostile resolver cannot induce
// a loss by lying about status. Returns a refusal SubmitResult, or null to PROCEED. Posture (since B1,
// Plans/68): fail CLOSED unless the resolver POSITIVELY answers with a parseable open offer.
//   • a clean 404 OR a status-less/garbled 200 → OFFER_UNKNOWN (retryable): filling a proposal the
//     resolver will not settle burns the whole payment, so "no data" is never treated as "safe".
//   • a 5xx / timeout → VERIFY_UNAVAILABLE (retryable).
//   • a parsed open offer runs the shared cairnx-core preflight (fillIsSafe + the requiredFillOutputs
//     need-map) and proceeds only if every leg holds. Honest cost: one retry on a brand-new offer
//     inside the resolver's ~15s scan window. A coherently-lying resolver is the B3 fill-SPV item.
// `me` is the CAPTURED signer address from fillOffer's SignerCtx (A1); never read live here, so the
// account this preflight validates is by construction the account whose key signs.
// RT-W2: `reviewedQuote` is the token debit quote the approve window DISPLAYED (threaded from
// approve.ts via background.ts). On the token lane it is bound against the chain-proven want.
// `reservationAck` is the fclaim txid the user confirmed in the approval window after an "unknown" reservation
// verdict; the background sets it only from that window's own resolve call (background.ts reservationAckFor).
export async function fillOfferPreflight(wallet: FillPreflightIo, proposalId: string, outputs: { to: string; value: number }[], me: string, reviewedQuote: TokenFillQuote | undefined, reservationAck: string | undefined, notes: FillNotes): Promise<FillRefusal | null> {
  if (!isTarget(proposalId)) return badTarget();
  let offer: OfferState | null = null;
  let fetchFailed = false;
  try {
    const r0 = await wallet.tradeGet(`/cairnx/offer/${encodeURIComponent(proposalId)}`); // 12s (tradeGet default): recipient path fails clean
    if (r0.ok) offer = (await r0.json().catch(() => null)) as OfferState | null;   // shape checked next: a string status
    else if (r0.status !== 404) fetchFailed = true;   // 5xx/garbled ≠ a definitive "gone"
  } catch { fetchFailed = true; }
  if (offer && typeof offer.status === "string") {
    if (offer.status !== "open") return { ok: false, error: `offer is ${offer.status}: refusing to pay into a no-op fill (review again)`, sighashMatch: false, code: "FILL_UNSAFE" };
    // Exact per-recipient output sums, BigInt end-to-end (money never rides Number arithmetic here).
    // A non-integer or ≤0 value can never build a valid tx, so refuse with the structured error shape
    // instead of letting BigInt() throw raw out of the preflight.
    const badValue = outputValueRefusal(outputs ?? []);
    if (badValue) return badValue;
    const sums = new Map<string, bigint>();
    for (const o of outputs ?? []) {
      const k = String(o.to).toLowerCase();
      sums.set(k, (sums.get(k) ?? 0n) + BigInt(o.value));
    }
    // the seller payment is the output sum going to want.payto (what previewFill/fillIsSafe price against)
    const payto = String(offer.want?.payto || "").toLowerCase();
    const pay = sums.get(payto) ?? 0n;
    const isCsdWant = !("ticker" in (offer.want ?? {}));
    // ── V28 open-lane (fclaim) STRUCTURAL routing to the grant-replay SPV boundary ─────────────────────
    // The fill ATTESTS the fclaim txid, NEVER the offer id, so `proposalId !== offer.id` STRUCTURALLY IS a
    // fclaim-lane fill and MUST clear the SPV boundary (verifyFillSpv). Crucially this does NOT trust the
    // resolver-echoed `fclaimId`: a hostile primary that WITHHOLDS or alters fclaimId (while still echoing the
    // linked offer id) would otherwise steer the fill into the resolver-trusted LEGACY lane and burn a denied
    // fclaim. It is also tip-INDEPENDENT so a deflated node tip cannot steer the lane: below V28 every legit
    // fill targets `offer.id` (this never mis-fires on an honest fill), and a below-V28 fill mis-served with
    // `proposalId !== offer.id` fails CLOSED in verifyFillSpv (no fclaim exists below the gate).
    // fclaimLanePreflight already fails closed on any unprovable/fabricated fclaim (it must be merkle-proven in
    // the scan AND reference this offer). This makes the mandatory grant replay actually mandatory at V28.
    if (String(proposalId).toLowerCase() !== String(offer.id ?? "").toLowerCase()) {
      const second = {
        offer: startSecondSourceRead(CLARVIS_TRADE_API, "offer", String(offer.id ?? ""), SECOND_SOURCE_TIMEOUT_MS),
        record: startSecondSourceRead(CLARVIS_TRADE_API, "record", proposalId, SECOND_SOURCE_TIMEOUT_MS),
      };
      try { return await fclaimLanePreflight(wallet, offer, proposalId, me, sums, payto, pay, second, reservationAck, notes); } finally { second.offer.stop(); second.record.stop(); }
    }
    // The served tip; an RPC failure reads as 0. It feeds the FILL_WRONG_TARGET mirror and fillIsSafe, and through
    // offerIdChainBound the sunset and expiry checks.
    const tip = (await wallet.tip()) ?? 0;
    // Correction 1 (RT3) mirror: reaching here means `proposalId === offer.id` (the fclaim lane already
    // returned above). An offer-id fill DURING a live fclaim hold burns; the V28 resolver routes fills to the
    // fclaim, so an offer-id attest mines with NO delivery, and fillIsSafe/hasLiveClaim PASS for the holder.
    // `claimTxid` is set only at V28, so this is V28-scoped WITHOUT a deflatable tip gate; a deflated tip only
    // makes hasLiveClaim MORE likely true (fires -> refuse), so it fails safe. A pre-V28 hold honored in the
    // sunset has claimTxid undefined -> legacy path (correct, no false-refuse).
    if (offer.claimTxid !== undefined && hasLiveClaim(offer, me, tip))
      return { ok: false, error: "this offer has a live reservation: fill its reservation (fclaim) target, not the offer id; paying the offer id now would be rejected on-chain and the funds lost", sighashMatch: false, code: "FILL_WRONG_TARGET" };
    // After the mirror, so a served live hold gets the actionable FILL_WRONG_TARGET; a served offer with `claimTxid`
    // omitted skips the mirror and is refused here. The height is offerIdChainBound, so neither a served tip below
    // the sunset nor a fresh install's floor of 0 disarms it. The taker-bound lane binds its taker
    // (provenTermsMismatch in csdLanePreflight) and the token lane its give and want (tokenLanePreflight).
    const sunset = await legacySunsetRefusal(offer, isCsdWant, async () => offerIdChainBound(tip, await wallet.tipFloor()));
    if (sunset) return sunset;
    const verdict = fillIsSafe(offer, me, pay, tip);
    if (!verdict.safe) return { ok: false, error: `refusing to sign: ${verdict.reason}`, sighashMatch: false, code: "FILL_UNSAFE" };
    return isCsdWant ? await csdLanePreflight(wallet, offer, sums, payto, pay, tip, me, notes) : await tokenLanePreflight(wallet, offer, sums, tip, reviewedQuote);
  } else if (fetchFailed) {
    // GENUINE unreachability (5xx / timeout; NOT a 404). We cannot tell the lane without the offer, and
    // an open-CSD claim-lane fill by a non-claimant loses the WHOLE payment (C2/C4), so fail closed here.
    return { ok: false, error: "couldn't confirm this offer is still fillable by you (resolver unreachable): try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  } else {
    // B1 (Plans/68 M-MKT-5 + N-1; the Plan 63 B2 flip, operator-approved): fail CLOSED unless the
    // resolver POSITIVELY answered with a parseable CairnX offer. A clean 404 (a valid, unexpired L1
    // proposal that is NOT an open CairnX offer; a board post, or a record resolve() rejected) and a
    // 200 whose body lacks a parseable status (MITM / garbling proxy) both used to PROCEED here; the
    // wallet signed Attest+payment, L1 moved the CSD, and resolve() ignored the attest; the whole
    // payment burned to attacker-directed outputs. Honest cost: a brand-new offer inside the
    // resolver's ~15s scan poll refuses ONCE with retryable copy. This closes the honest-resolver and
    // MITM hole; a coherently LYING resolver is the B3 proof-bound fill-SPV item, not this guard.
    return { ok: false, error: "this offer is not known to your resolver yet. A new offer appears once it is mined and the resolver has read that block; try again then", sighashMatch: false, code: "OFFER_UNKNOWN" };
  }
}

/** The repeated-fill rule, the one place it is decided (a warning in the approval window could replace the refusal
 *  here). `unseen` are this account's fills of the target from its history within OWN_FILL_INDEX_WAIT_MS, not marked
 *  gone (FillPreflightIo recentOwnFills) and not seen applied by the lane (listed by the offer service on the offer-id
 *  lane, proven in the block scan on the reservation lane); `txid` is the transaction about to be signed (node.ts
 *  codecTxid, which the signature does not change), or null before one is assembled. An unseen fill may still land,
 *  and another payment before it does pays twice: a whole offer delivers once and keeps the second, and a partial one
 *  is sized on what was left before the first. That is refused FILL_ALREADY_SENT, until the fill is seen, is marked gone,
 *  or leaves the window. One exception: the very transaction of an unseen fill whose submit answer was lost (`maybe`),
 *  which a retry builds again from the same coins while they are unspent; sending the same bytes again cannot pay
 *  twice. A fill the node accepted needs no re-send, so it allows nothing. `copy` names the partial offer-id case,
 *  whose risk is the amount served as left. */
export function repeatedFillRefusal(unseen: readonly RecentFill[], copy: RepeatedFills["copy"], txid: string | null): FillRefusal | null {
  const first = unseen[0];
  if (first === undefined) return null;
  const key = (x: string): string => String(x).toLowerCase().replace(/^0x/, "");
  if (txid !== null && unseen.some((f) => f.maybe && key(f.txid) === key(txid))) return null;
  const t = first.txid.slice(0, 12), waitMin = OWN_FILL_INDEX_WAIT_MS / 60_000;
  return refuse("FILL_ALREADY_SENT", copy === "unlisted-partial"
    ? `refusing to sign for now: your earlier fill of this offer (${t}…) was sent and is not listed as applied by the offer service yet, so the amount it lists as left may be too high and the surplus would go to the seller; try again in a few minutes (if the service rejected that fill, this lasts up to ${waitMin} minutes)`
    : `refusing to sign for now: your earlier fill of this offer (${t}…) was sent and is not confirmed yet, and another payment for it before then could lose some or all of what it pays. Try again once the earlier fill confirms. If it does not go through, this lasts up to ${waitMin} minutes after it was sent.`);
}
// The preflight runs before the transaction is assembled. When the rule could still allow it (an unseen fill whose
// submit answer was lost) the unseen fills go to the signer in `notes`; otherwise it decides now, as it would for any
// transaction, so the refusal comes before the offer-id lane's proof read and the reservation lane's second-source
// checks and confirm step.
function handRepeat(recent: readonly RecentFill[], seen: ReadonlySet<string>, copy: RepeatedFills["copy"], notes: FillNotes): FillRefusal | null {
  const unseen = recent.filter((f) => !seen.has(f.txid.toLowerCase()));
  if (!unseen.some((f) => f.maybe)) return repeatedFillRefusal(unseen, copy, null);
  notes.repeat = { unseen, copy };
  return null;
}

// The offer-id CSD lane (the legacy and dApp fill, no SPV scan): the served payto, seller and fee terms are bound
// to the merkle-proven offer, then every leg of the resolver's need-map must be paid. A partial offer is sized against
// the running state its listed fills prove, and its legs must be paid exactly.
// The resolver's value gate is a per-address SUM need-map (whole fill: payto ≥ want, TREASURY ≥
// fee, seller ≥ rebate, SUMMED when recipients coincide; partial: clamped pay + fee). A fill that
// underpays any leg is rejected on-chain AFTER the payment moved (the pay-without-delivery burn
// class). The map itself is the VENDORED requiredFillOutputs (cairnx-core 0.1.35); the same
// resolver-locked function the cairnx service and the trade UI size fills with; until 2026-07-06
// this block hand-mirrored it. Pure local math over data already in hand; no added I/O.
async function csdLanePreflight(wallet: FillPreflightIo, offer: OfferState, sums: Map<string, bigint>, payto: string, pay: bigint, tip: number, me: string, notes: FillNotes): Promise<FillRefusal | null> {
  // F2-legacy: this SPV-less LEGACY / dApp lane (window.cairn.fillOffer, no swapguard in the loop) sizes the
  // payment against the resolver-served want.payto and the rebate against the served seller, so a lying read-
  // path redirects the payment (theft) or mis-sizes the rebate so resolve() rejects the fill (burn). Bind both
  // to the MERKLE-PROVEN offer author (prevout-owner, txid-committed). Fail CLOSED-RETRYABLE on an unprovable /
  // transient read (never a hard decline on an honest fill), FILL_UNSAFE on a proven mismatch. Honest offers
  // default payto/seller to the author, so no honest fill declines.
  const partial = offer.min != null;   // an absent or null min: a whole offer
  const listed = partial ? (Array.isArray(offer.fills) ? offer.fills : []).map((f) => ({ txid: String(f?.txid ?? ""), height: Number(f?.height) })) : undefined;
  // Only the taker fills a taker-bound offer, so a fill the service has not listed yet is this account's own: the
  // repeated-fill rule reads it from local history, before the listed fills are proven (no block read for a fill that
  // refuses anyway, handRepeat). A partial offer's listed fills are proven below, so a listed own fill counts as seen. A
  // whole offer that applied a fill is no longer open (refused above), so for it nothing served counts as seen.
  const seen = new Set((listed ?? []).map((f) => f.txid.toLowerCase()));
  const repeated = handRepeat(await wallet.recentOwnFills(String(offer.id), me), seen, partial ? "unlisted-partial" : "confirming", notes);
  if (repeated) return repeated;
  const proven = await wallet.makeProvenOfferPayto(String(offer.id).toLowerCase(), Number(offer.height), listed);
  if (proven && "refused" in proven) return offerNotAdmitted(proven.refused);
  if (!proven || !/^0x[0-9a-f]{40}$/.test(proven.payto) || !/^0x[0-9a-f]{40}$/.test(proven.seller))
    return { ok: false, error: "couldn't prove this offer's on-chain payment recipient yet; try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  const expiry = await offerExpiryRefusal(wallet, proven, tip);
  if (expiry) return expiry;
  // WANT-TYPE bind (mirrors the fclaim lane's isTokenWant rejection in verifyFillSpv): the MERKLE-PROVEN
  // offer must actually be CSD-priced to take this CSD-fill lane. A token-priced offer carries no
  // want.value, so provenOfferPayto leaves terms.value undefined and bindOfferTerms skips the value leg;
  // without this a lying resolver could serve a token-priced offer as CSD-priced (drop want.ticker, add a
  // fake want.value) and the wallet would sign a CSD payment that resolve() rejects (no delivery) =
  // pay-without-delivery burn/theft. A genuine CSD offer always carries want.value, so no honest fill declines.
  if (proven.terms.value === undefined)
    return { ok: false, error: "refusing to sign: the on-chain offer is not CSD-priced (a lying resolver may be presenting a token-priced offer as a CSD sale)", sighashMatch: false, code: "FILL_UNSAFE" };
  if (payto !== proven.payto || String((offer as { seller?: string }).seller ?? "").toLowerCase() !== proven.seller) return { ok: false, error: "refusing to sign: the seller payment recipient does not match the offer's on-chain author (a lying resolver may be redirecting your payment)", sighashMatch: false, code: "FILL_UNSAFE" }; // MUTATE_LEGACY_PAYTO_GUARD
  // F2 (amount leg): bind the fee/rebate/value fields to the merkle-proven offer (same as the fclaim lane).
  if (provenTermsMismatch(offer, proven.terms))
    return { ok: false, error: "refusing to sign: the offer's fee/rebate terms do not match its on-chain record (a lying resolver could under-size the fee, and the chain would reject the fill after your payment moved)", sighashMatch: false, code: "FILL_UNSAFE" };
  // The listed fills are proven (makeProvenOfferPayto's progress) and the fill is sized against what they give.
  let sized: OfferState = offer;
  if (partial) {
    const progress = proven.progress;
    if (!progress) return refuse("VERIFY_UNAVAILABLE", "couldn't prove this offer's earlier fills yet; try again in a moment");
    // A listed fill missing from its block can be an honest reorg the service has not re-read yet, and one whose spent
    // coin could not be read is unproven, not disproven: both retryable. A fill that is another offer's, or whose
    // signature is not its coin owner's, is a list the chain contradicts.
    if ("unproven" in progress && progress.kind === "missing")
      return refuse("VERIFY_UNAVAILABLE", `couldn't find this offer's earlier fill where the offer service lists it (${progress.unproven}); the chain may have changed since the service read it, so try again in a moment`);
    if ("unproven" in progress && progress.kind === "unavailable")
      return refuse("VERIFY_UNAVAILABLE", `couldn't check this offer's earlier fill yet (${progress.unproven}); try again in a moment`);
    if ("unproven" in progress)
      return refuse("FILL_UNSAFE", `refusing to sign: the offer service's fill list for this offer does not match the chain (${progress.unproven}), so the amount left cannot be trusted`);
    if (progress.paid !== String(offer.paid ?? "0") || progress.delivered !== String(offer.delivered ?? "0"))
      return refuse("FILL_UNSAFE", "refusing to sign: the amount this offer has left, as the offer service lists it, does not match its proven fills; the resolver would clamp the payment and keep the surplus");
    sized = { ...offer, paid: progress.paid, delivered: progress.delivered };
  }
  const need = requiredFillOutputs(sized, pay);
  if (need === null)
    return { ok: false, error: "refusing to sign: this payment would not be accepted by the resolver (undeliverable fill)", sighashMatch: false, code: "FILL_UNSAFE" };
  for (const { to, value } of need) {
    const got = sums.get(to) ?? 0n;
    const what = to === TREASURY_ADDR.toLowerCase() ? "protocol fee output" : to === payto ? "seller payment" : "maker rebate output";
    if (got < value)
      return { ok: false, error: `refusing to sign: the ${what} is missing or underpaid; the chain would take your payment and reject the fill. Rebuild the fill with the quoted fee/rebate outputs.`, sighashMatch: false, code: "FILL_UNSAFE" };
    if (partial && got > value)
      return refuse("FILL_UNSAFE", `refusing to sign: the ${what} is more than this offer has left (the resolver takes ${fmtCsd(value)}) and the resolver would keep the surplus. Rebuild the fill for the amount left.`);
  }
  // a positively-parsed OPEN offer that cleared every check above → proceed to sign
  return null;
}

// The offer-id token lane: the fill pays in tokens (an Attest with no CSD outputs). The give and want content are
// bound to the merkle-proven offer and the reviewed quote to the proven want, fee and total.
async function tokenLanePreflight(wallet: FillPreflightIo, offer: OfferState, sums: Map<string, bigint>, tip: number, reviewedQuote?: TokenFillQuote): Promise<FillRefusal | null> {
  // XR-1 (N26): a token-priced fill routes NO CSD - its on-chain tx is the Attest with outputs:[].
  // The attest->fillOffer reroute hardcodes outputs:[] (in attest()), but a DIRECT dApp fillOffer
  // on a token-priced served offer can still carry CSD outputs, which this lane never checks. `sums`
  // holds only positive, validated outputs (BAD_OUTPUTS ran above), so a non-empty map is real CSD.
  if (sums.size > 0) return { ok: false, error: "refusing to sign: a token purchase is paid in tokens, not CSD, so it must move no CSD. This fill tried to send CSD (a lying resolver or dApp may be trying to move CSD through a token fill). Retry the purchase from the site's Buy button.", sighashMatch: false, code: "FILL_UNSAFE" }; // MUTATE_TOKEN_OUTPUTS_GUARD
  // B7e-FIX (REBIND W1 token-lane close): a TOKEN-want fill (attest CONF_TOKEN_FILL -> fillOffer,
  // outputs:[]) never routes to the fclaim SPV boundary (verifyFillSpv rejects a token want as "CSD-priced
  // offers only"), and until now this lane skipped every content bind, so a hostile resolver could serve a
  // bait-and-switch give/want the user clear-signs and the wallet would proceed (both proof seams never
  // consulted). Merkle-prove the offer RECORD and bind its give/want CONTENT before signing, mirroring the
  // site swapguard verifyOfferContent (which binds want.ticker/want.amount + give from the proven record for
  // a token want). Fail CLOSED-RETRYABLE on an unprovable/transient read (same posture as the CSD lane,
  // never a hard decline on an honest fill); FILL_UNSAFE on a proven content mismatch. An honest token
  // offer's served give/want equal the proven ones (resolve() materializes both from the same on-chain
  // record), so no honest token fill declines. No CSD payto/need-map bind here: a token fill routes no CSD
  // (outputs:[], N26), so the payment legs do not apply.
  const proven = await wallet.makeProvenOfferPayto(String(offer.id).toLowerCase(), Number(offer.height));
  if (proven && "refused" in proven) return offerNotAdmitted(proven.refused);
  if (!proven)
    return { ok: false, error: "couldn't prove this token offer's on-chain terms yet; try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  const expiry = await offerExpiryRefusal(wallet, proven, tip);
  if (expiry) return expiry;
  // The give legs and the want leg (type, and for a token want its ticker and amount) through the vendored
  // bindOfferTerms; once this passes the proven offer is token-priced and the served want is the proven one.
  if (provenTermsMismatch(offer, proven.terms))
    return { ok: false, error: "refusing to sign: what you would receive or what you would pay does not match the offer's on-chain record (a lying resolver may be misrepresenting the trade)", sighashMatch: false, code: "FILL_UNSAFE" };
  // RT-W2: bind the number the user SAW at review to the chain-proven want. The review card's
  // quote was a live resolver read; a resolver answering low on that read and honest at click
  // used to debit the larger proven amount behind the low card. The displayed quote must equal
  // the proven want or the fill refuses. (Absent quote → the review already showed the loud
  // do-NOT-approve caution; the served↔proven binds above still hold.)
  // 0.2.71 (CX-15): a token-debiting fill signs only what the user reviewed. No reviewed quote
  // (the preview failed, was slow, or a caller skipped the approval window) is REVIEW_REQUIRED,
  // retryable; the review must also carry the fee and total, which are bound below.
  if (!reviewedQuote || reviewedQuote.ticker === undefined || reviewedQuote.fee === undefined || reviewedQuote.total === undefined)
    return refuse("REVIEW_REQUIRED", "the wallet could not show you the exact token amount this fill debits, so it will not sign it. Reopen the purchase and approve once the amount is shown.");
  if (reviewedQuote && reviewedQuote.ticker !== undefined) {
    const qT = String(reviewedQuote.ticker ?? ""), qA = String(reviewedQuote.amount ?? "");
    if (qT !== String(proven.terms.wantTicker ?? "") || qA !== String(proven.terms.wantAmount ?? ""))
      return refuse("FILL_UNSAFE", `refusing to sign: the amount changed between review and signing. The card showed ${qA} ${qT}, but the offer's on-chain record requires ${proven.terms.wantAmount ?? "?"} ${proven.terms.wantTicker ?? "?"}. The site's quote did not match its on-chain record; retry from the site's Buy button.`);
  }
  // 0.2.71 (CX-15): bind the reviewed fee and total. The fee follows from the proven amount and the
  // offer's proven inclusion height (1.5% from V16, 1% before), not from the served feeBps, so a
  // quote that understated the fee (e.g. a served feeBps of 0) cannot sign a larger debit.
  {
    let provenAmt: bigint;
    try { provenAmt = BigInt(String(proven.terms.wantAmount ?? "")); } catch { return refuse("FILL_UNSAFE", "refusing to sign: the offer's on-chain amount could not be read"); }
    const provenBps = Number((proven.terms as { feeBps?: unknown }).feeBps);
    const bps = Number.isFinite(provenBps) ? provenBps : (Number(offer.height) >= V16_HEIGHT ? FEE_BPS_V16 : FEE_BPS);
    const fee = cairnxTradeFee(provenAmt, bps);
    if (String(reviewedQuote.fee) !== fee.toString() || String(reviewedQuote.total) !== (provenAmt + fee).toString())
      return refuse("FILL_UNSAFE", `refusing to sign: the card showed a fee of ${reviewedQuote.fee} and a total of ${reviewedQuote.total}, but this offer's on-chain terms debit ${fee.toString()} + ${provenAmt.toString()} = ${(provenAmt + fee).toString()}. Retry from the site's Buy button.`);
  }
  // 0.2.70: bind the resolver-served give the card showed to the merkle-proven give.
  if (reviewedQuote && (reviewedQuote.giveTicker !== undefined || reviewedQuote.giveAmount !== undefined || reviewedQuote.giveName !== undefined)) {
    if (String(reviewedQuote.giveTicker ?? "") !== String(proven.terms.giveTicker ?? "")
      || String(reviewedQuote.giveAmount ?? "") !== String(proven.terms.giveAmount ?? "")
      || String(reviewedQuote.giveName ?? "") !== String(proven.terms.giveName ?? ""))
      return refuse("FILL_UNSAFE", "refusing to sign: the asset you would receive changed between review and signing. The card showed a different give than the offer's on-chain record. Retry from the site's Buy button.");
  }
  // a positively-parsed OPEN offer that cleared every check above → proceed to sign
  return null;
}

// ── V28 open-lane (fclaim) fill fund boundary ───────────────────────────────────────────────────────
// A resolver-DENIED fclaim is an L0-valid but delivery-less attest target, so a fill built on it BURNS the
// whole payment. This is a faithful resolve() mirror the STRONG way: it re-derives the ENTIRE grant + hold
// from PoW-buried, merkle-proven events (the vendored verifyFillSpv) and fails CLOSED on anything unproven:
// it only ever REJECTS MORE than resolve(), never accepts something resolve() would reject.
// `second` holds the clarvis reads of the offer and of this fclaim's record, started by the caller before the
// scan so they run alongside it.
async function fclaimLanePreflight(wallet: FillPreflightIo, offer: any, fclaimTxid: string, me: string, sums: Map<string, bigint>, payto: string, pay: bigint, second: { offer: SecondSourceRead; record: SecondSourceRead }, reservationAck: string | undefined, notes: FillNotes): Promise<FillRefusal | null> {
  const offerId = String(offer?.id ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(offerId))
    return { ok: false, error: "refusing to sign: the resolver did not link this reservation to a well-formed offer", sighashMatch: false, code: "FILL_UNSAFE" };
  // Build the fail-closed SPV seam (PoW-verified tip + merkle-proven offer/fclaim/hold events + the computed
  // cross-offer hold count). Any unverifiable read throws → refuse retryably (never proceed on an unproven grant).
  let io: FillSpvIo & { myLiveHoldsAtGrant?: number; provenTerms?: MintedProvenOfferTerms };
  try {
    io = await wallet.makeFillSpvIo(offerId, fclaimTxid, me, Number(offer?.height));
  } catch (e) {
    // A body that contradicts its verified header means the configured RPC (for example a local node on another
    // chain) or the header source (a false header with valid PoW) is wrong; the refusal names both and blames
    // neither. Every other failure here is a read that could not complete (no tip, a missing chunk, a timeout)
    // and is retryable.
    if (e instanceof OfferNotAdmittedError) return offerNotAdmitted(e.reason);
    if (e instanceof BodyMismatchError && e.bodySource)
      return { ok: false, error: `refusing to sign: block ${e.height} from ${e.bodySource} does not match the block header the wallet verified${e.headerSource ? ` from ${e.headerSource}` : ""}. One of them is wrong: the RPC may follow another chain, or the header source may have served a false header. If that RPC is your own node and it follows the main chain, the header source may be at fault; otherwise try again in a moment.`, sighashMatch: false, code: "RPC_BLOCK_MISMATCH" };
    return { ok: false, error: "couldn't verify this reservation against the chain yet (SPV source unavailable): try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  }
  // myLiveHoldsAtGrant is COMPUTED by the SPV source: a CONSERVATIVE OVER-count of my OTHER-offer fclaim holds
  // live at this fclaim's grant height, from the same PoW-verified [fclaimHeight - MAX_SCAN, tip] scan. It is
  // the cap defense: the lane-scoped replay cannot see other-offer holds, so an under-count would fail-OPEN the
  // cross-offer MAX_ACTIVE_CLAIMS cap and BURN (a resolver that D2-aliases a cap-denied fclaim as "granted"
  // would pass). Over-count only false-refuses (retryable). There is NO wallet create-side cap guard, and 0 is
  // NEVER assumed; if the source could not compute the count, fail CLOSED here. The DEADLINE guard likewise
  // rides INSIDE verifyFillSpv from the fclaim's OWN confirmed expiry epoch (fclaimHoldEnd), never epochOf(tip+45).
  if (!Number.isInteger(io.myLiveHoldsAtGrant))
    return { ok: false, error: "couldn't count your other open reservations to verify this one against the claim cap: try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  // W3 (B7e): the OPT-IN payment bind. verifyFillSpv re-runs requiredFillOutputs over the merkle-proven,
  // REPLAYED offer (the chain's OWN paid/delivered, never a served lie) and requires our PLANNED per-address
  // CSD sums to match it EXACTLY, closing the whole->partial overpay (a resolver serving paid:"0" for a
  // 90%-filled partial made us size the FULL want; the surplus past the real remainder is unrecoverable). We
  // pass the SAME per-address `sums` map the outputs were summed into (payto + treasury fee + maker rebate,
  // MERGED per address); previewFill CLAMPS p.pay to want for a whole fill, so payto === seller (pay carrying
  // the merged rebate) matches the proven need-map exactly and never false-refuses that real honest shape.
  let verdict: FillVerdict;
  try {
    verdict = await verifyFillSpv(offerId, fclaimTxid, me, io, {
      myLiveHoldsAtGrant: io.myLiveHoldsAtGrant as number, pay,
      // The per-address sums bind: planned payment legs must equal the proven offer's need-map exactly, so a
      // served payto, fee or remainder that differs from the chain refuses here (FILL_UNSAFE below), and so does a
      // served seller when the offer has a rebate leg; an offer with `min` has none (previewFill), so a served
      // seller swap on it changes no leg and signs the honest outputs (payto and the treasury fee).
      sums: Object.fromEntries(sums), // MUTATE_FCLAIM_SUMS_BIND
    });
  } catch {
    return { ok: false, error: "couldn't verify this reservation against the chain yet: try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  }
  // FILLSPV-01: when the reported tip had to be floor-clamped UP (a deep reorg OR an active served-tip
  // deflation), the wallet genuinely could not confirm burial-to-true-tip this call, so the vendor's
  // factually-wrong "would strand"/lapsed-shaped reason is replaced with honest, retryable copy. Both
  // branches REFUSE (fail-closed either way); this only fixes which reason the user sees. `tipFloored` is
  // undefined/falsy under the fillSpvIoForTest synthetic io, so every existing denial keeps FILL_UNSAFE.
  // Only a reason the tip decides is remapped; a permanent denial keeps FILL_UNSAFE under a floored tip.
  if (!verdict.safe) return (io as { tipFloored?: boolean }).tipFloored && tipDependentFillReason(verdict.reason) ? { ok: false, error: "we could not confirm this reservation against the current chain tip (the chain may be reorganizing). Wait a moment and try again.", sighashMatch: false, code: "VERIFY_UNAVAILABLE" } : { ok: false, error: `refusing to sign: ${verdict.reason}`, sighashMatch: false, code: "FILL_UNSAFE" }; // MUTATE_FCLAIM_GUARD
  // F2 (amount leg): bind the fee/rebate/value fields to the merkle-proven offer so a deflated feeBps/height/
  // value/taker cannot under-size a leg (which resolve() would reject AFTER payment = pay-without-delivery burn).
  const terms = (io as { provenTerms?: MintedProvenOfferTerms }).provenTerms;
  if (!terms)
    return { ok: false, error: "couldn't prove this offer's on-chain fee terms yet; try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  if (provenTermsMismatch(offer, terms))
    return { ok: false, error: "refusing to sign: the offer's fee/rebate terms do not match its on-chain record (a lying resolver could under-size the fee, and the chain would reject the fill after your payment moved)", sighashMatch: false, code: "FILL_UNSAFE" };
  // verifyFillSpv proves delivery >= 1 on the offer terms; the wallet ALSO pins its OWN outputs to the exact
  // resolver need-map (payto >= want, treasury >= fee, seller >= rebate), identical to the legacy lane.
  const need = requiredFillOutputs(offer, pay);
  if (need === null)
    return { ok: false, error: "refusing to sign: this payment would not be accepted by the resolver (undeliverable fill)", sighashMatch: false, code: "FILL_UNSAFE" };
  for (const { to, value } of need) if ((sums.get(to) ?? 0n) < value) {
    const what = to === TREASURY_ADDR.toLowerCase() ? "protocol fee output" : to === payto ? "seller payment" : "maker rebate output";
    return { ok: false, error: `refusing to sign: the ${what} is missing or underpaid; the chain would take your payment and reject the fill. Rebuild the fill with the quoted fee/rebate outputs.`, sighashMatch: false, code: "FILL_UNSAFE" };
  }
  // The repeated-fill rule: an own fill of this reservation counts as seen once the scan proved it (mined), and the
  // replay above then sized this fill with it applied. The history read is local, and provenEvent answers from what the
  // scan already proved. Each txid is a fill this account signed of this target (history.ts recentFillsOf), so the
  // event proven under it is that attest. Before the second-source checks, so a fill still confirming is not reported
  // as a conflict or sent to the confirm step.
  const recent = await wallet.recentOwnFills(fclaimTxid, me);
  const seen = new Set<string>();
  for (const f of recent) if (await io.provenEvent(f.txid).catch(() => null)) seen.add(f.txid.toLowerCase());
  const repeated = handRepeat(recent, seen, "confirming", notes);
  if (repeated) return repeated;
  // Pre-window withholding: the scan cannot see a cancel or fill older than its window, so ask the second
  // source about the offer. Its answer counts only if it has already arrived; pending or unusable proceeds.
  const fcEv = await io.provenEvent(fclaimTxid).catch(() => null);
  const ownHoldEnd = fcEv && fcEv.kind === "propose" ? fclaimHoldEnd(fcEv.expiresEpoch) : undefined;
  const conflict = secondSourceOfferConflict(offer, okBody(second.offer.answer()), { offerId, fclaimTxid, ownHoldEnd }); // MUTATE_OFFER_XCHECK
  if (conflict) return refuse("OFFER_SOURCE_CONFLICT", `refusing to sign: the second source (clarvis) reports that ${conflict}, while your resolver shows it open. Paying now would likely be lost. Reload the offer and check it on the explorer before trying again.`);
  // A header source that hides a competing hold placed just before our fclaim makes the scan grant it while the
  // chain denies it. The second resolver's replay of the real chain shows the denial.
  const recordReply = second.record.answer();
  const rv = reservationRecordVerdict(recordReply, { fclaimTxid, provenHeight: fcEv?.height });
  if (rv?.kind === "denied") return refuse("RESERVATION_DENIED", `refusing to sign: the second source (clarvis) reports that the chain did not grant your reservation for this offer${rv.note ? ` (${rv.note})` : ""}. The chain would take your payment and deliver nothing. Your resolver may be hiding a competing reservation; check the offer on the explorer before trying again.`); // MUTATE_RESERVATION_VERDICT
  // "unknown" goes back to the approval window as a confirm step; the user's acknowledgement for this fclaim signs.
  if (rv?.kind === "unknown" && typeof fcEv?.height === "number" && String(reservationAck ?? "").toLowerCase() !== fclaimTxid.toLowerCase()) // MUTATE_RESERVATION_CONFIRM
    return { ...refuse("RESERVATION_UNCONFIRMED", `the second source has read the chain to block ${rv.tipHeight} and has no record of your reservation (block ${fcEv.height}); confirm in the approval window to sign anyway`), unconfirmed: { fclaimTxid: fclaimTxid.toLowerCase(), fclaimHeight: fcEv.height, tipHeight: rv.tipHeight } };
  const unanswered = secondSourceUnanswered(recordReply);
  if (unanswered && notes) notes.secondSource = unanswered; // MUTATE_SECOND_SOURCE_NOTE
  return null;
}
