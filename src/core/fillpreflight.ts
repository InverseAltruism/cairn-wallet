// The fill preflight: what the wallet checks before it signs an offer fill (fillOffer, and an attest at the
// token-fill confidence). It reads the offer and the chain through the wallet (FillPreflightIo) and returns a
// refusal, or null to sign. Nothing here signs or records.
import type * as node from "./node.js";
import { cairnxTradeFee, fillIsSafe, isOpenClaimLane, hasLiveClaim, requiredFillOutputs, verifyFillSpv, bindOfferTerms, FEE_BPS, FEE_BPS_V16, V16_HEIGHT, TREASURY_ADDR, V28_HEIGHT, CLAIM_WINDOW_BLOCKS_V20, CLAIM_FILL_GRACE_BLOCKS } from "./cairnx.js";
import { fclaimHoldEnd, offerExpiryHeightOf, FILL_TIP_MARGIN, type CxOfferState, type FillSpvIo, type FillVerdict } from "../vendor/cairnx-spv.js";
import { BodyMismatchError } from "./spvbind.js";
import type { MintedProvenOfferTerms } from "./fillspv.js";
import { refuse } from "./refuse.js";
import { secondSourceOfferConflict, reservationRecordVerdict, secondSourceUnanswered, startSecondSourceRead, okBody, type SecondSourceRead, type ReservationUnconfirmed } from "./offerxcheck.js";
import { CLARVIS_TRADE_API } from "./endpoints.js";

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

// B7e-FIX (W1 token-lane close): this predicate now runs on the TOKEN-priced lane too (tokenLanePreflight), not only
// the CSD lane. On the token lane the give leg is the load-bearing content bind
// and the want-type leg is a real rejecter (on the CSD lane the pre-existing value leg shadows it). The
// want-type leg binds only the want TYPE (token vs CSD), so the token lane binds want.ticker/want.amount
// separately: bindOfferTerms carries no token-want ticker/amount leg (see tokenLanePreflight).
function provenTermsMismatch(offer: unknown, t: MintedProvenOfferTerms): boolean {
  return bindOfferTerms(offer, t, { give: true, wantType: true });
}

// Whether a fill submitted at `tip` would strand: the node refuses an attest after its proposal's expiry, in
// mempool admission and in block apply, so a fill that cannot be mined by the offer's last live block
// (offerExpiryHeightOf - 1) sits unconfirmed and is dropped. FILL_TIP_MARGIN is the bundle's margin for the same
// strand on the fclaim lane's hold deadline, applied the same way (holdEnd < tip + FILL_TIP_MARGIN).
export function offerFillTooLate(expiresAt: number, tip: number): boolean {
  return expiresAt - 1 < tip + FILL_TIP_MARGIN;
}

// The offer-id lanes' expiry check, on the merkle-proven expiry and anchor height. The tip is clamped up by the
// PoW-backed floor, as the sunset check is, so a deflating RPC cannot hide that the offer is about to expire.
async function offerExpiryRefusal(wallet: FillPreflightIo, proven: ProvenOfferPayto, tip: number): Promise<FillRefusal | null> {
  const at = Math.max(tip, await wallet.tipFloor());
  if (!(at > 0) || !Number.isFinite(proven.expiresEpoch) || !Number.isInteger(proven.height))
    return { ok: false, error: "couldn't check this offer's expiry against the chain tip yet; try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  const expiresAt = offerExpiryHeightOf(proven.expiresEpoch, proven.height);
  if (offerFillTooLate(expiresAt, at))
    return { ok: false, error: `refusing to sign: this offer expires at block ${expiresAt.toLocaleString("en-US")} and the chain is at ${at.toLocaleString("en-US")}, so the fill cannot be mined in time; it would sit unconfirmed and be dropped. Ask the seller to relist.`, sighashMatch: false, code: "FILL_UNSAFE" };
  return null;
}

// Abort bound for the fclaim-lane second-source reads (offer and reservation record). The fill does not wait on
// them: an answer is used only if it arrived before the SPV scan finished (fclaimLanePreflight; timed in
// test/fill-offer-crosscheck and test/fill-reservation-verdict).
const SECOND_SOURCE_TIMEOUT_MS = 12000;

// A fill refusal; RESERVATION_UNCONFIRMED also carries the facts the approval window shows.
export type FillRefusal = node.SubmitResult & { unconfirmed?: ReservationUnconfirmed };
// Set by a passing fclaim-lane preflight when clarvis's record read had not answered (or failed) at its verdict; a
// signed fill carries it to the approval window as `secondSource` (background.ts keeps it off the page's result).
export type FillNotes = { secondSource?: "pending" | "failed" };

// What the SPV seams return to the fill preflight: the fclaim lane's proof source with the computed cap
// over-count, the proven terms and whether the tip was floor-clamped; the legacy lane's proven offer author.
export type FillSpvIoExt = FillSpvIo & { myLiveHoldsAtGrant?: number; provenTerms?: MintedProvenOfferTerms; tipFloored?: boolean };
export type ProvenOfferPayto = { payto: string; seller: string; terms: MintedProvenOfferTerms; expiresEpoch: number; height: number; wantTicker?: string; wantAmount?: string };
// The reads the fill preflight makes through the wallet: the CairnX read API, the node tip and its PoW-backed
// floor, and the two merkle-proving SPV seams.
export interface FillPreflightIo {
  tradeGet(path: string): Promise<Response>;
  tip(): Promise<number | null>;
  tipFloor(): Promise<number>;
  makeProvenOfferPayto(offerId: string, offerHeight: number): Promise<ProvenOfferPayto | null>;
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
export async function fillOfferPreflight(wallet: FillPreflightIo, proposalId: string, outputs: { to: string; value: number }[], me: string, reviewedQuote?: TokenFillQuote, reservationAck?: string, notes?: FillNotes): Promise<FillRefusal | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(proposalId))) return { ok: false, error: "proposalId must be a 0x… 32-byte txid", sighashMatch: false, code: "BAD_REQUEST" };
  let offer: CxOfferState | null = null;
  let fetchFailed = false;
  try {
    const r0 = await wallet.tradeGet(`/cairnx/offer/${encodeURIComponent(proposalId)}`); // 12s (tradeGet default): recipient path fails clean
    if (r0.ok) offer = (await r0.json().catch(() => null)) as CxOfferState | null;   // shape checked next: a string status
    else if (r0.status !== 404) fetchFailed = true;   // 5xx/garbled ≠ a definitive "gone"
  } catch { fetchFailed = true; }
  if (offer && typeof offer.status === "string") {
    if (offer.status !== "open") return { ok: false, error: `offer is ${offer.status} — refusing to pay into a no-op fill (review again)`, sighashMatch: false, code: "FILL_UNSAFE" };
    // Exact per-recipient output sums, BigInt end-to-end (money never rides Number arithmetic here).
    // A non-integer or ≤0 value can never build a valid tx, so refuse with the structured error shape
    // instead of letting BigInt() throw raw out of the preflight.
    const sums = new Map<string, bigint>();
    for (const o of outputs ?? []) {
      if (typeof o.value !== "number" || !Number.isSafeInteger(o.value) || o.value <= 0)
        return { ok: false, error: "each output value must be a positive integer amount in base units — refusing to sign", sighashMatch: false, code: "BAD_OUTPUTS" };
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
    // The open-CSD lane (untaken + CSD-priced) is the whole-payment-loss lane, and its claim gate NEEDS
    // a live tip. wallet.tip() yields null on RPC failure (→ 0) and a degenerate 200-without-height reads
    // as 0. But the disarm is NOT just tip==0: fillIsSafe only runs the claim check when
    // isOpenClaimLane(offer, tip) is true, which requires tip >= V13_HEIGHT; so ANY reported tip in
    // (0, V13_HEIGHT) (a grossly-stale or hostile RPC) silently SKIPS the claim gate and would let a
    // non-claimant's open-CSD fill through, while the real chain (tip ~47k) no-ops it and the whole
    // payment is lost (C2/C4). So: for this lane, if the claim gate is NOT active at the reported tip
    // (isOpenClaimLane false; which, given taker===undefined && CSD want, can only be a too-low tip),
    // fail CLOSED with the retryable posture. Red-team 2026-07-06 hardened the guard from `!(tip > 0)`
    // to cover the full (0, V13) band. Taker-bound / token lanes never consult the tip (unaffected).
    const tip = (await wallet.tip()) ?? 0;
    // Correction 1 (RT3) mirror: reaching here means `proposalId === offer.id` (the fclaim lane already
    // returned above). An offer-id fill DURING a live fclaim hold burns; the V28 resolver routes fills to the
    // fclaim, so an offer-id attest mines with NO delivery, and fillIsSafe/hasLiveClaim PASS for the holder.
    // `claimTxid` is set only at V28, so this is V28-scoped WITHOUT a deflatable tip gate; a deflated tip only
    // makes hasLiveClaim MORE likely true (fires -> refuse), so it fails safe. A pre-V28 hold honored in the
    // sunset has claimTxid undefined -> legacy path (correct, no false-refuse).
    if (offer.claimTxid !== undefined && hasLiveClaim(offer, me, tip))
      return { ok: false, error: "this offer has a live reservation — fill its reservation (fclaim) target, not the offer id; paying the offer id now would be rejected on-chain and the funds lost", sighashMatch: false, code: "FILL_WRONG_TARGET" };
    // W5 (B5b): LEGACY-SUNSET arithmetic refuse. Placed AFTER the Correction-1 mirror deliberately: a
    // served live-hold offer gets the more SPECIFIC actionable refusal (FILL_WRONG_TARGET) first, and the
    // W5 forgery (claimTxid OMITTED) never fires the mirror, so this guard still closes it.
    // The last possible legacy grant is at V28-1 and its hold
    // (window + fill grace) ends at V28 + CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS - 1 = 60,044,
    // so AT or ABOVE 60,045 every offer-id fill of an open CSD offer is rejected on-chain AFTER the
    // payment moved (pay-without-delivery). The W5 attack forges/omits the SERVED claim fields to steer a
    // genuine fclaim holder into this lane; so the refuse keys on NOTHING served: pure gate arithmetic
    // over the tip, clamped UP with the PoW-backed floor (M9/B5a) so a deflating RPC cannot disarm it
    // once the wallet has PoW-seen the band. Below 60,045 the honored pre-V28 sunset (resolve.ts:182-183)
    // still admits legacy fills; a flat V28 cut was DECLINED as over-refusal (strategy decline 1); the
    // headline test pins ACCEPTS at 60,010. Taker-bound and token lanes are exempt (neither routes through
    // the open-lane claim machinery): the CSD lane's taker IS bound (provenTermsMismatch in csdLanePreflight), and the
    // token lane now binds its give/want CONTENT (B7e-FIX, tokenLanePreflight), so the token exemption
    // is not claiming an unbound residual - a token-priced offer simply is not an open-CSD claim-lane fill.
    if (offer.taker === undefined && isCsdWant && Math.max(tip, await wallet.tipFloor()) >= V28_HEIGHT + CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS)
      return { ok: false, error: "past the V28 sunset an open offer can only be filled through its reservation (fclaim) target — ask the marketplace for the reservation id; paying the offer id now would be rejected on-chain and the funds lost", sighashMatch: false, code: "FILL_LEGACY_SUNSET" };
    if (offer.taker === undefined && isCsdWant && !isOpenClaimLane(offer, tip))
      return { ok: false, error: "couldn't fetch the chain tip to verify your claim on this open offer — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
    const verdict = fillIsSafe(offer, me, pay, tip);
    if (!verdict.safe) return { ok: false, error: `refusing to sign — ${verdict.reason}`, sighashMatch: false, code: "FILL_UNSAFE" };
    return isCsdWant ? await csdLanePreflight(wallet, offer, sums, payto, pay, tip) : await tokenLanePreflight(wallet, offer, sums, tip, reviewedQuote);
  } else if (fetchFailed) {
    // GENUINE unreachability (5xx / timeout; NOT a 404). We cannot tell the lane without the offer, and
    // an open-CSD claim-lane fill by a non-claimant loses the WHOLE payment (C2/C4), so fail closed here.
    return { ok: false, error: "couldn't confirm this offer is still fillable by you (resolver unreachable) — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
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

// The offer-id CSD lane (the legacy and dApp fill, no SPV scan): the served payto, seller and fee terms are bound
// to the merkle-proven offer, then every leg of the resolver's need-map must be paid.
// The resolver's value gate is a per-address SUM need-map (whole fill: payto ≥ want, TREASURY ≥
// fee, seller ≥ rebate, SUMMED when recipients coincide; partial: clamped pay + fee). A fill that
// underpays any leg is rejected on-chain AFTER the payment moved (the pay-without-delivery burn
// class). The map itself is the VENDORED requiredFillOutputs (cairnx-core 0.1.35); the same
// resolver-locked function the cairnx service and the trade UI size fills with; until 2026-07-06
// this block hand-mirrored it. Pure local math over data already in hand; no added I/O.
async function csdLanePreflight(wallet: FillPreflightIo, offer: CxOfferState, sums: Map<string, bigint>, payto: string, pay: bigint, tip: number): Promise<FillRefusal | null> {
  // F2-legacy: this SPV-less LEGACY / dApp lane (window.cairn.fillOffer, no swapguard in the loop) sizes the
  // payment against the resolver-served want.payto and the rebate against the served seller, so a lying read-
  // path redirects the payment (theft) or mis-sizes the rebate so resolve() rejects the fill (burn). Bind both
  // to the MERKLE-PROVEN offer author (prevout-owner, txid-committed). Fail CLOSED-RETRYABLE on an unprovable /
  // transient read (never a hard decline on an honest fill), FILL_UNSAFE on a proven mismatch. Honest offers
  // default payto/seller to the author, so no honest fill declines.
  const proven = await wallet.makeProvenOfferPayto(String(offer.id).toLowerCase(), Number(offer.height));
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
  const need = requiredFillOutputs(offer, pay);
  if (need === null)
    return { ok: false, error: "refusing to sign — this payment would not be accepted by the resolver (undeliverable fill)", sighashMatch: false, code: "FILL_UNSAFE" };
  for (const { to, value } of need) if ((sums.get(to) ?? 0n) < value) {
    const what = to === TREASURY_ADDR.toLowerCase() ? "protocol fee output" : to === payto ? "seller payment" : "maker rebate output";
    return { ok: false, error: `refusing to sign — the ${what} is missing or underpaid; the chain would take your payment and reject the fill. Rebuild the fill with the quoted fee/rebate outputs.`, sighashMatch: false, code: "FILL_UNSAFE" };
  }
  // a positively-parsed OPEN offer that cleared every check above → proceed to sign
  return null;
}

// The offer-id token lane: the fill pays in tokens (an Attest with no CSD outputs). The give and want content are
// bound to the merkle-proven offer and the reviewed quote to the proven want, fee and total.
async function tokenLanePreflight(wallet: FillPreflightIo, offer: CxOfferState, sums: Map<string, bigint>, tip: number, reviewedQuote?: TokenFillQuote): Promise<FillRefusal | null> {
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
  if (!proven)
    return { ok: false, error: "couldn't prove this token offer's on-chain terms yet; try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  const expiry = await offerExpiryRefusal(wallet, proven, tip);
  if (expiry) return expiry;
  // give legs (give.ticker/amount/name) + the symmetric want-TYPE refusal, via the SAME vendored predicate
  // the CSD lane uses. The want-type leg also refuses a proven CSD offer served as a token offer, so once
  // this passes the proven offer is genuinely token-priced (proven.wantTicker is defined).
  if (provenTermsMismatch(offer, proven.terms))
    return { ok: false, error: "refusing to sign: the offer's asset (give) or want-type does not match its on-chain record (a lying resolver may be misrepresenting what you receive)", sighashMatch: false, code: "FILL_UNSAFE" };
  // The token ticker/amount you PAY is bound explicitly: bindOfferTerms binds the want TYPE but carries no
  // token want ticker/amount leg. A deflated want.amount or a swapped want.ticker would otherwise let the
  // resolver understate your cost for what you receive. Mirrors swapguard verifyOfferContent's want leg.
  const w = (offer.want as { ticker?: string; amount?: string }) ?? {};
  if (String(w.ticker) !== String(proven.wantTicker ?? "") || String(w.amount) !== String(proven.wantAmount ?? ""))
    return { ok: false, error: "refusing to sign: the token or amount you would pay does not match the offer's on-chain record (a lying resolver may be understating your cost)", sighashMatch: false, code: "FILL_UNSAFE" };
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
    if (qT !== String(proven.wantTicker ?? "") || qA !== String(proven.wantAmount ?? ""))
      return refuse("FILL_UNSAFE", `refusing to sign: the amount changed between review and signing — the card showed ${qA} ${qT}, but the offer's on-chain record requires ${proven.wantAmount ?? "?"} ${proven.wantTicker ?? "?"}. The site's quote did not match its on-chain record; retry from the site's Buy button.`);
  }
  // 0.2.71 (CX-15): bind the reviewed fee and total. The fee follows from the proven amount and the
  // offer's proven inclusion height (1.5% from V16, 1% before), not from the served feeBps, so a
  // quote that understated the fee (e.g. a served feeBps of 0) cannot sign a larger debit.
  {
    let provenAmt: bigint;
    try { provenAmt = BigInt(String(proven.wantAmount ?? "")); } catch { return refuse("FILL_UNSAFE", "refusing to sign: the offer's on-chain amount could not be read"); }
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
      return refuse("FILL_UNSAFE", "refusing to sign: the asset you would receive changed between review and signing — the card showed a different give than the offer's on-chain record. Retry from the site's Buy button.");
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
async function fclaimLanePreflight(wallet: FillPreflightIo, offer: any, fclaimTxid: string, me: string, sums: Map<string, bigint>, payto: string, pay: bigint, second: { offer: SecondSourceRead; record: SecondSourceRead }, reservationAck?: string, notes?: FillNotes): Promise<FillRefusal | null> {
  const offerId = String(offer?.id ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(offerId))
    return { ok: false, error: "refusing to sign — the resolver did not link this reservation to a well-formed offer", sighashMatch: false, code: "FILL_UNSAFE" };
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
    if (e instanceof BodyMismatchError && e.bodySource)
      return { ok: false, error: `refusing to sign: block ${e.height} from ${e.bodySource} does not match the block header the wallet verified${e.headerSource ? ` from ${e.headerSource}` : ""}. One of them is wrong: the RPC may follow another chain, or the header source may have served a false header. If that RPC is your own node and it follows the main chain, the header source may be at fault; otherwise try again in a moment.`, sighashMatch: false, code: "RPC_BLOCK_MISMATCH" };
    return { ok: false, error: "couldn't verify this reservation against the chain yet (SPV source unavailable) — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  }
  // myLiveHoldsAtGrant is COMPUTED by the SPV source: a CONSERVATIVE OVER-count of my OTHER-offer fclaim holds
  // live at this fclaim's grant height, from the same PoW-verified [fclaimHeight - MAX_SCAN, tip] scan. It is
  // the cap defense: the lane-scoped replay cannot see other-offer holds, so an under-count would fail-OPEN the
  // cross-offer MAX_ACTIVE_CLAIMS cap and BURN (a resolver that D2-aliases a cap-denied fclaim as "granted"
  // would pass). Over-count only false-refuses (retryable). There is NO wallet create-side cap guard, and 0 is
  // NEVER assumed; if the source could not compute the count, fail CLOSED here. The DEADLINE guard likewise
  // rides INSIDE verifyFillSpv from the fclaim's OWN confirmed expiry epoch (fclaimHoldEnd), never epochOf(tip+45).
  if (!Number.isInteger(io.myLiveHoldsAtGrant))
    return { ok: false, error: "couldn't count your other open reservations to verify this one against the claim cap — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
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
    return { ok: false, error: "couldn't verify this reservation against the chain yet — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
  }
  // FILLSPV-01: when the reported tip had to be floor-clamped UP (a deep reorg OR an active served-tip
  // deflation), the wallet genuinely could not confirm burial-to-true-tip this call, so the vendor's
  // factually-wrong "would strand"/lapsed-shaped reason is replaced with honest, retryable copy. Both
  // branches REFUSE (fail-closed either way); this only fixes which reason the user sees. `tipFloored` is
  // undefined/falsy under the fillSpvIoForTest synthetic io, so every existing denial keeps FILL_UNSAFE.
  // Only a reason the tip decides is remapped; a permanent denial keeps FILL_UNSAFE under a floored tip.
  if (!verdict.safe) return (io as { tipFloored?: boolean }).tipFloored && tipDependentFillReason(verdict.reason) ? { ok: false, error: "we could not confirm this reservation against the current chain tip (the chain may be reorganizing). Wait a moment and try again.", sighashMatch: false, code: "VERIFY_UNAVAILABLE" } : { ok: false, error: `refusing to sign — ${verdict.reason}`, sighashMatch: false, code: "FILL_UNSAFE" }; // MUTATE_FCLAIM_GUARD
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
    return { ok: false, error: "refusing to sign — this payment would not be accepted by the resolver (undeliverable fill)", sighashMatch: false, code: "FILL_UNSAFE" };
  for (const { to, value } of need) if ((sums.get(to) ?? 0n) < value) {
    const what = to === TREASURY_ADDR.toLowerCase() ? "protocol fee output" : to === payto ? "seller payment" : "maker rebate output";
    return { ok: false, error: `refusing to sign — the ${what} is missing or underpaid; the chain would take your payment and reject the fill. Rebuild the fill with the quoted fee/rebate outputs.`, sighashMatch: false, code: "FILL_UNSAFE" };
  }
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
