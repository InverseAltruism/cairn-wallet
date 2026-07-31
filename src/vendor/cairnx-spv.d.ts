// Type surface for the vendored SPV bundle (src/vendor/cairnx-spv.js — built by scripts/build-spv-vendor.sh
// from the audited csd-sdk dists). Paired with the adjacent .js; only the members core/namespv.ts uses are typed.
export interface RpcTxJson {
  version: number;
  locktime: number;
  inputs: { prev_txid: string; vout: number; script_sig: string }[];
  outputs: { value: number; script_pubkey: string }[];
  app: { type: "None" } | { type: "Propose"; domain: string; payload_hash: string; uri: string; expires_epoch: number } | { type: "Attest"; proposal_id: string; score: number; confidence: number };
}
export interface Tx {
  version: number; locktime: number;
  inputs: { prevTxid: string; vout: number; scriptSig: string }[];
  outputs: { value: number | bigint; scriptPubkey: string }[];
  app: { type: "None" } | { type: "Propose"; domain: string; payloadHash: string; uri: string; expiresEpoch: number } | { type: "Attest"; proposalId: string; score: number; confidence: number };
}
export interface VerifiedHeader { height: number; hash: string; header: { merkle: string; prev: string; bits: number;[k: string]: unknown }; chainwork: bigint; trusted?: boolean }
export interface RpcBlock { ok: boolean; hash: string; height?: number; header: unknown; txs: (RpcTxJson & { txid: string })[] }

export class CsdClient {
  constructor(opts: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }); // timeoutMs: per-request AbortSignal bound (bundle default 10s)
  tip(): Promise<{ height: number; hash?: string }>;
  blockByHeight(h: number): Promise<RpcBlock>;
  blockByHash(hash: string): Promise<RpcBlock>;
  tx(id: string): Promise<{ ok?: boolean; tx?: RpcTxJson } | null>; // /tx/{id} — used by namespv prevout-ownership bind (H3)
}
export class LightClient {
  readonly chain: VerifiedHeader[];
  baseHeight: number;
  constructor(opts: { client?: CsdClient; baseUrl?: string; headersBatchProvider?: (from: number, count: number) => Promise<{ header: unknown; hash: string }[]>; checkpoints?: Record<number, string> });
  static fromSnapshot(s: unknown, opts?: ConstructorParameters<typeof LightClient>[0]): LightClient;
  syncFromCheckpoint(height: number, hash: string, context?: number): Promise<void>;
  sync(to: number, from?: number): Promise<VerifiedHeader>;
  toSnapshot(): unknown;
}
export function rpcTxToTx(j: RpcTxJson): Tx;
export function txid(tx: Tx): string;
export function sighash(tx: Tx): string;
export function merkleRoot(txids: string[]): string;
export function verifyMerkleProof(txid: string, pos: number, branch: string[], root: string): boolean;
export function addrFromPub(pub: string): string;
export function verifyDigest(sig: string, pub: string, digest: string): boolean;
/** STRICT signer recovery (csd-crypto 0.1.15): exact 198-byte CSD_SIG_V1 frame + verifyDigest
 *  against the given digest; lowercase addr20 or null. The wallet's namespv authenticator. */
export function recoverSigner(scriptSig: string, digest: string): string | null;
// THE audited CairnX resolver, reused (never re-typed). Returns canonical state; we read .names[name].
export function resolve(events: unknown[], tipHeight: number): { names: Record<string, { owner: string; addr?: string; expired?: boolean; viaFill?: boolean; pending?: boolean; finalizeBy?: number; effectiveHeight: number; height: number; claimId: string }>;[k: string]: unknown };

// ── CairnX convention surface (cairnx-core) — imported by core/cairnx.ts instead of a hand-typed copy
// (shared-core de-dup, cairn docs/Plans/46). The bundle already inlines all of cairnx-core to serve
// resolve(); these are the same reviewed bytes, now type-declared for the wallet's build/decode/display.
export const DOMAIN: string;
export const MIN_FEE_PROPOSE: number;
export const TREASURY_ADDR: string;
export const FEE_BPS: number;
export const FEE_BPS_V16: number;
export const REBATE_BPS: number;
export const REBATE_FLAT: bigint;
export const V16_HEIGHT: number;
export const V18_HEIGHT: number;
export const V24_HEIGHT: number;   // v2.4 name-fee gate (imported by core/cairnx.ts buildFeeHeight)
export const V25_HEIGHT: number;   // v2.5 sealed-reservation gate (clearsign fee-warning: name reveal is free at V25)
export const NAME_RE: RegExp;
export const PKEY: RegExp;
export const TICKER_RE: RegExp;
export const ADDR_RE: RegExp;
export const AMOUNT_RE: RegExp;
export const SALT_RE: RegExp;
export const RESERVED_NAMES: ReadonlySet<string>;
export const MAX_AMOUNT: bigint;
export const MAX_RECORD_BYTES: number;
export const PROFILE_MAX_KEYS: number;
export const PROFILE_MAX_VALUE_BYTES: number;
export function canonicalJson(v: unknown, depth?: number): string;
export function payloadHash(record: unknown): string;
export function tradeFee(want: bigint, bps?: number): bigint;
export function makerRebate(value: bigint): bigint;
export function nameRegFee(name: string, height: number): bigint;
export function parseRecord(uri: string, payloadHashHex: string): Record<string, unknown> | null;
/** Canonical amount gate (AMOUNT_RE + MAX_AMOUNT + allowZero); bigint or null. */
export function parseAmount(s: unknown, opts?: { allowZero?: boolean }): bigint | null;
export function nameCommit(name: string, salt: string, owner: string): string;

// ── Tier 1 pre-flight (deep-review 2026-07-03): the shared "before you sign a value tx" surface.
// Minimal structural types (the offer/name records the wallet fetches from /cairnx/offer|name/:id).
export interface CxOfferState {
  id: string; seller: string;
  give: { ticker: string; amount: string } | { name: string };
  want: { value: string; payto: string } | { ticker: string; amount: string; payto: string };
  taker?: string; status: string; height: number; feeBps: number;
  min?: string; paid?: string; delivered?: string; bid?: string;
  claimedBy?: string; claimUntilHeight?: number;
  // v2.8 fclaim: the live routing target (Correction 1) + the D2 alias fields (served on a GET of the fclaim txid).
  claimTxid?: string; fclaimId?: string; fclaimHeight?: number; fclaimExpiresEpoch?: number;
}
export interface CxNameState {
  name: string; owner: string; effectiveHeight: number; pending?: boolean;
  addr?: string; locked?: boolean; viaFill?: boolean;
}
export interface FillPreview { deliverable: boolean; reason?: string; got: bigint; pay: bigint; fee: bigint; rebate: bigint }
export interface FillSafety { safe: boolean; reason: string; preview: FillPreview }
/** Delivered `got` + fee + rebate for a CSD payment against a CSD-priced offer (exact resolver math). */
export function previewFill(offer: CxOfferState, pay: bigint | string | number): FillPreview;
/** The C2/C3/C4 union: status open, deliverability ≥1, live-claim holdership for open-CSD, taker match. */
export function fillIsSafe(offer: CxOfferState, me: string, pay: bigint | string | number, tip: number): FillSafety;
/** The C1 registration-finalize gate — pass the AUTHORITATIVE (freshly re-fetched) name record. */
export function finalizeWinnerCheck(nameState: CxNameState | null | undefined, me: string, commitHeight: number, tip?: number | null): { safe: boolean; reason: string };
export function isOpenClaimLane(offer: CxOfferState, tip: number): boolean;
export function hasLiveClaim(offer: CxOfferState, me: string, tip: number): boolean;
/** The resolver's fill value-gate need-map as a build-ready output list (2026-07-06 promotion —
 *  replaces the wallet's hand-mirrored per-address sums in fillOffer). [] = token-priced (no CSD
 *  outputs); null = undeliverable (gate with fillIsSafe first). Amounts accumulate per address. */
export function requiredFillOutputs(offer: CxOfferState, pay: bigint | string | number): { to: string; value: bigint }[] | null;
/** Approach-the-gate name-fee build heuristic (owns the gate list; replaces the local copy that
 *  lived in core/cairnx.ts until 2026-07-06). Overpay-safe: strict `<` resolver gate. */
export function buildFeeHeight(tip: number): number;
export const FEE_GATE_MARGIN_BLOCKS: number;
/** paidTo map from tx outputs (addr → summed value as decimal string), the scanner/resolver shape —
 *  replaces namespv.ts's hand-mirrored outputsToPaidTo (same reviewed bytes the resolver uses). */
export function paidToFromOutputs(outputs: readonly { addr: string; value: number | bigint }[]): Record<string, string>;
export const REG_COMMIT_MAX_BLOCKS: number;      // sealed-registration displacement freeze (v2.5)
export const REG_FINALIZE_GRACE_BLOCKS: number;  // finalize window past the freeze (v2.5)

// ── v2.8 fclaim fill-SPV fund boundary (§31, B4) — the shared client-side surface the open-lane (fclaim)
// fill preflight MUST clear before signing. A resolver-DENIED fclaim is an L0-valid attest target, so this
// re-derives the ENTIRE grant + hold from PoW-buried, MERKLE-PROVEN events (never a served "granted" flag).
// The wallet builds the FillSpvIo from its PoW light client (core/fillspv.ts) and fails CLOSED on safe:false.
export const V28_HEIGHT: number;              // open-lane fclaim gate (planning placeholder until Batch P)
export const FILL_TIP_MARGIN: number;         // refuse a fill within this many blocks of the hold deadline
export const CONF_TOKEN_FILL: number;         // the app-layer confidence SENTINEL for a token-priced fill (= 1_000_000)
export const MAX_ACTIVE_CLAIMS: number;       // cross-offer live-hold cap (the myLiveHoldsAtGrant clause)
export const GAP_NEEDED: number;              // clean-start hold/cooldown scan bound (fund-safety, = 104)
export const MAX_SCAN: number;                // GAP_NEEDED rounded up a full epoch (= 134)
export const EPOCH_LEN: number;               // 30 blocks/epoch (fclaim hold-span math)
export const FCLAIM_MAX_EPOCH_AHEAD: number;  // anti-squat: a hold spans at most (this+1) epochs
export const SCORE_CLAIM: number;             // legacy pre-V28 claim attest score (transition-window cap count)
export const SCORE_FILL: number;              // the required on-chain score for a fill attest (100); any other score is a resolve() no-op
export const CLAIM_WINDOW_BLOCKS_V20: number; // legacy claim window (V20 era)
export const CLAIM_FILL_GRACE_BLOCKS: number; // legacy claim fill grace
/** holdEnd (last L0-minable height for the fill) from an fclaim's confirmed expires_epoch. */
export function fclaimHoldEnd(expiresEpoch: number): number;
// A PoW-verified, MERKLE-PROVEN chain event (resolver ChainEvent + the verified burial `depth`).
export interface ProvenPropose { kind: "propose"; id: string; proposer: string; uri: string; payloadHash: string; expiresEpoch: number; height: number; pos: number; paidTo: Record<string, string>; depth: number }
export interface ProvenAttest { kind: "attest"; txid: string; proposalId: string; attester: string; score: number; confidence: number; height: number; pos: number; paidTo: Record<string, string>; depth: number }
export type ProvenEvent = ProvenPropose | ProvenAttest;
// The injected SPV seam (modeled on namespv.ts SpvSource): all chain access flows through it so the pure
// surface runs identically in the wallet and site bundles and is test-injectable.
export interface FillSpvIo {
  tip(): Promise<number>;
  offerEventIds(offerId: string, fclaimTxid: string): Promise<string[]>;
  provenEvent(id: string): Promise<ProvenEvent | null>;
}
export interface FillVerdict { safe: boolean; reason: string }
/** The fail-closed fund boundary: safe:true only when the offer + fclaim are merkle-proven + bound + buried,
 *  the grant replays to a live hold that is MINE and routes to THIS fclaim, delivery >= 1, and the deadline
 *  (from the fclaim's OWN confirmed expiry) has cushion. Refuses every doomed/forged case.
 *  B6a (REBIND W3) `opts.sums` (OPT-IN, default OFF = byte-identical verdicts): the caller's PLANNED per-address
 *  CSD sums must EXACTLY match requiredFillOutputs re-run over the merkle-proven, replayed offer (the chain's own
 *  paid/delivered, not a served lie), closing the whole->partial overpay. Pass the SAME per-address need-map you
 *  will build (payto + treasury fee + maker rebate, MERGED per address; payto === seller merges the rebate leg). */
export function verifyFillSpv(offerId: string, fclaimTxid: string, me: string, io: FillSpvIo, opts: { myLiveHoldsAtGrant: number; pay?: bigint | string | number; sums?: Record<string, bigint | string | number> }): Promise<FillVerdict>;
// Plan 70 R2 Option B: the SINGLE fill-boundary TERM-mismatch verdict (retiring the R1 wallet/site hand-copies).
// The fee/rebate-sizing fields of an offer, derived from the MERKLE-PROVEN offer (never a served object). `min`
// is the ONLY on-chain partial-fill field; paid/delivered are resolver running state, deliberately absent.
// B6a (REBIND W2/W7): the give legs (giveTicker/giveAmount/giveName, verbatim strings) + wantType ("token" iff
// the proven want is token-priced, else "csd"). Emitted bit-identically for the legacy fields, so a 2-arg
// bindOfferTerms over a produced terms object returns the SAME verdict it always did; they participate ONLY
// under the opt-in legs of the 3-arg overload below.
export interface ProvenOfferTerms { height: number; feeBps: number; value?: string; taker?: string; bid?: string; min?: string; giveTicker?: string; giveAmount?: string; giveName?: string; wantType?: "csd" | "token" }
// ── the ProvenOfferTerms BRAND (B6a rider, LTS G6 cure): a nominal brand minted ONLY by provenOfferTerms, so
// the opt-in 3-arg bindOfferTerms cannot be fed a hand-built terms object that leaves the new give/wantType
// fields undefined (that shape would false-refuse every honest fill, the W2 trap). Type-level only; no byte of
// output changes and every STRUCTURAL use of ProvenOfferTerms still compiles (the 2-arg overload keeps taking it).
declare const PROVEN_TERMS_MINT: unique symbol;
export type MintedProvenOfferTerms = ProvenOfferTerms & { readonly [PROVEN_TERMS_MINT]: "cairnx-core/provenOfferTerms" };
/** UNSAFE escape hatch, TESTS ONLY: brand a hand-built terms object. Production must never call it. */
export function unsafeMintProvenOfferTerms(t: ProvenOfferTerms): MintedProvenOfferTerms;
/** The treasury fee rate stamped on an offer at its creation height (feeBpsAt): v11 ? (v16 ? 150 : 100) : 0. */
export function feeBpsAt(height: number): number;
/** Build the normalized (BRANDED) ProvenOfferTerms from a merkle-proven offer record + its proven creation
 *  height. The sole minter of MintedProvenOfferTerms. Legacy fields emitted bit-identically to pre-B6. */
export function provenOfferTerms(offerRec: unknown, provenHeight: number): MintedProvenOfferTerms;
/** OPT-IN legs for the 3-arg bindOfferTerms (default OFF: a 2-arg call is byte-identical to the pre-B6 predicate).
 *  give: bind give.ticker/give.amount/give.name (explicit-presence + verbatim string equality; closes the W7
 *  give-inflation shortchange). wantType: the SYMMETRIC want-type refusal (served want type must equal the proven
 *  type; closes proven-token-served-as-CSD, which the value leg only catches one-sidedly). */
export interface BindTermsOpts { give?: boolean; wantType?: boolean }
/** true iff any fee/rebate/partial-sizing field of the SERVED offer diverges from the merkle-proven terms `t`
 *  (fail-closed: any divergence => the caller refuses). Binds height/feeBps/value/taker/bid + min presence AND
 *  value. The 2-arg overload is byte-identical to the wallet's old provenTermsMismatch + the site's old inline
 *  amount-leg bind. The 3-arg overload adds the opt-in give/wantType legs and requires MINTED terms (the brand). */
export function bindOfferTerms(servedOffer: unknown, t: ProvenOfferTerms): boolean;
export function bindOfferTerms(servedOffer: unknown, t: MintedProvenOfferTerms, opts: BindTermsOpts): boolean;
/** Derive {payto (want.payto or, absent, the author), seller (= the event's prevout-bound proposer), terms}
 *  from a merkle-proven offer Propose event; null if the event does not bind to an offer record. */
export function bindProvenOffer(offerEv: ProvenPropose): { payto: string; seller: string; terms: MintedProvenOfferTerms } | null;
// v2.8 give-backing synthesis (core/fillspv.ts, the accepted N1 residual): the record builders + constants used
// to synthesize an offer's resolver-trusted give-backing (token deploy+mint, or a name registration) so resolve()
// materializes the offer without an unbounded lifecycle scan. The grant/denial VERDICT never rides the backing.
export const DEPLOY_FEE: number;
export const V11_HEIGHT: number;
export const ACTIVATION_HEIGHT: number;   // tokens went live here; resolve() ignores every event below it
export function deploy(p: { ticker: string; decimals: number; supply: string; mint: string; mintLimit?: string; name?: string }): { uri: string; payloadHash: string };
export function mint(p: { ticker: string; amount?: string }): { uri: string; payloadHash: string };
export function nameClaim(p: { name: string; salt?: string }): { uri: string; payloadHash: string };
export function isNameGive(give: unknown): give is { name: string };
