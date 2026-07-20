// namespv.ts — trustless .csd name → address verification (XREPO-1 cure, Phase 5).
//
// THE THREAT: the wallet's resolveName() takes the resolver's `addr` verbatim. A hostile/MITM'd
// resolver can answer "alice.csd → 0xATTACKER" and the wallet would send funds there.
//
// THE CURE (reuses audited code, never re-types it): the wallet fetches the resolver's name-history
// HINTS (untrusted txids), then INDEPENDENTLY proves them against a PoW header chain it verified
// itself (the vendored LightClient), and re-runs the AUDITED CairnX resolver over the merkle-verified
// events. The recomputed (owner, addr) must equal what the resolver claimed — a server cannot fabricate
// a mapping it has no signed, mined events for.
//
//   per block touched: fetch it, rebuild EVERY tx, require merkleRoot(txids) == the PoW-verified
//                      header's merkle root (so a lying node can't omit/alter/add a committed tx body),
//                      then authenticate each relevant tx's SIGNER by its signature (the merkle root
//                      does NOT commit the scriptSig) and reconstruct the resolver ChainEvent.
//   then: resolve(events, verifiedTip).names[name] — the audited resolver, byte-for-byte.
//
// HONEST SCOPE (must NOT be overstated in the UI): this proves the mapping is backed by SPV-verified,
// correctly-signed, mined events AS SHOWN by the resolver's hint list. It defeats FABRICATION (the
// dominant hostile-resolver redirect — the attacker has no signed/mined events for 0xATTACKER). It does
// NOT by itself prove COMPLETENESS: the resolver chooses WHICH txids to show, and the wallet cannot prove
// it was shown ALL of a name's events. So a hostile resolver can WITHHOLD events to mislead the replay —
// two cases, both real:
//   (a) stale: hide a later nxfer/nset so an old (real) mapping looks current → routes to a prior owner.
//   (b) **competing-claim**: hide the legitimate owner's WINNING claim (lower effectiveHeight) and show
//       only an attacker's REAL, mined, fee-paid but LOSING `name` registration for the same name → the
//       replay sees only the attacker's claim → resolves to the ATTACKER's address → matches the hostile
//       resolver's claim → verified:true. NOT arbitrary (the attacker must have pre-registered + paid for
//       a losing claim on that exact name AND control/MITM the resolver) but it CAN route to an attacker.
// So "verified" means "chain-backed AS SHOWN", never "provably the current/winning mapping". The send UX
// keeps a loud caution for high-value sends; the COMPLETENESS cure is a second-source / multi-resolver
// cross-check (doc 34 §6 follow-on), still unbuilt. Everything here fails CLOSED: any gap, mismatch, or
// error returns verified:false with a reason — never a false pass against FABRICATION.
import { LightClient, CsdClient, rpcTxToTx, txid as ctxid, sighash, merkleRoot, recoverSigner as recoverSignerFromScriptSig, resolve, paidToFromOutputs, type RpcTxJson, type Tx } from "../vendor/cairnx-spv.js";

// Baked checkpoint: a real finalized CSD header at the NAMES-ACTIVATION floor (V11_HEIGHT). No name can
// have an effectiveHeight below this, so a forward-only verified chain seeded here covers every name.
// Trust is anchored HERE, not at the server's word; the LightClient verifies every header forward (PoW +
// LWMA-bits + prev-link). Bump it (and the snapshot version) periodically to bound forward-sync cost.
export const CP = { height: 29960, hash: "0x00000000000376f1b00dfa976b2314ee3d1cbe25431b008293fa93e28cdce9fb" };

export interface NameVerification {
  verified: boolean;          // true ⇒ the mapping is chain-backed AS SHOWN
  addr?: string;              // the chain-verified send target (use THIS when verified)
  owner?: string;
  via?: "nset" | "owner";
  depth?: number;             // confirmations of the most recent defining record
  reason?: string;            // fail-closed explanation when !verified
  scope: "as-shown";          // honest completeness label (see file header)
  // NSPV-CLAIMCAP-1 (H1): true when the winning record was acquired via an on-chain offer FILL/recapture
  // (cairnx resolver `viaFill`). Such ownership can depend on out-of-name-scope state (the V17 open-lane
  // claim cap is global over ALL offers; a name-for-token fill depends on the buyer's global token balance),
  // so a name-scoped SPV replay cannot soundly prove it. Surfaced so the UI never shows it as plain "verified".
  viaFill?: boolean;
  // Multi-source cross-check (NSPV-COMPLETE-1 cure, doc 36 Part B): how many INDEPENDENT resolvers were
  // unioned, how many AGREED with the chain-recomputed address, and whether any disagreed (a source whose
  // stated claim ≠ the SPV-proven union winner — caught + flagged; the send still goes to the proven winner).
  sources?: number;
  agreed?: number;
  disagree?: boolean;
  // WALLET-LAPSE-TIP-1: a lease-LAPSED verdict is only CONFIDENT (`lapsed:true`) when corroborated — a second
  // independent name source, or the persisted monotonic tip floor (a tip trusted across prior sessions) also
  // past expiry. An UNCORROBORATED single-source lapse degrades to CAUTION: `verified:false` + `lapsed` falsy
  // + a "may have lapsed" reason, so a fresh-install + MITM inflating the node tip cannot assert a false
  // confident lapse that hard-blocks a legit send. Fail-soft (availability valve), never a false green.
  lapsed?: boolean;
}

export interface NameClaim { addr?: string; owner?: string; via?: string; lapsed?: boolean }
export interface NameHint { txid: string; height: number; pos: number; kind?: string }
// The all-zeros coinbase outpoint (consensus): a coinbase tx is never a signed cairnx record, so a hinted
// record whose authenticating input looks like one is rejected (no prevout owner to bind against).
// Mirrors the vendored bundle's own `isCoinbaseInput`/`COINBASE_VOUT(=0xffffffff)` — kept local because
// those are not in the bundle's export surface (the .d.ts types only the members namespv.ts already used).
const COINBASE_TXID = "0x" + "00".repeat(32);
const isCoinbaseInput = (i: { prevTxid: string; vout: number }) =>
  String(i.prevTxid).toLowerCase() === COINBASE_TXID && Number(i.vout) === 0xffffffff;
// An independent name-history source (resolver) to cross-check against. `base` ends at the trade-API root,
// e.g. "https://cairn-substrate.com/trade/api" or "https://clarvis.cairn-substrate.com/trade/api".
export interface ResolverSource { label: string; base: string }
interface SourceResult { label: string; ok: boolean; unregistered?: boolean; claim?: NameClaim; hints: NameHint[]; error?: string; scopedReplaySufficient?: boolean }

// The SPV data seam. Production wires the real LightClient (liveSpvSource); tests inject synthetic
// PoW-verified blocks so the merkle-bind + replay + fail-closed logic is exercised without a chain.
export interface SpvSource {
  // Ensure verified headers cover up to `maxEventHeight` (the name's most recent record — no need to
  // sync the whole chain to tip for an old, sparse name). Returns the PoW-VERIFIED tip actually reached
  // AND the (untrusted) node-reported chain tip used ONLY for the lease-lapse epoch (a deflated value is
  // the documented stale residual; an inflated one is fail-closed-safe, since a higher epoch ⇒ "lapsed").
  // `floorTip` (optional, WALLET-LAPSE-TIP-1): the persisted monotonic tip high-water as seeded from PRIOR
  // sessions — a tip we already trusted BEFORE this (possibly-MITM'd) session, EXCLUDING the current read.
  // Used ONLY to CORROBORATE a lease-lapse verdict: a lapse that also holds at floorTip is confident; one
  // that holds only at the current nodeTip degrades to caution. Omitted ⇒ no corroboration available.
  prepare(maxEventHeight: number): Promise<{ verifiedTip: number; nodeTip: number; floorTip?: number }>;
  // The PoW-VERIFIED merkle root for `height` + that block's node-JSON txs. THROWS if it cannot verify.
  blockAt(height: number): Promise<{ merkle: string; txs: RpcTxJson[] }>;
  // NSPV-SIGSUB-1 (H3): resolve the scriptPubkey of a record's spent prevout, BOUND to its txid — the
  // fetched source tx must recompute to `prevTxid` (the consensus txid commits its outputs incl. scriptPubkey),
  // reusing the TXB-1 fetch+recompute pattern. Lets replayName require that the recovered signer actually OWNS
  // the coin it spends (mirroring consensus / BIP-174), so a hostile node can't swap in a foreign valid
  // scriptSig to re-attribute a record. Returns the 0x-prefixed 20-byte scriptPubkey, or null on any
  // mismatch / unavailable / malformed body → the caller fails CLOSED.
  prevoutScriptPubkey(prevTxid: string, vout: number): Promise<string | null>;
}

// Headers to sync past the last record so its inclusion proof has a confirmation cushion. The verifier
// never needs the full chain tip for inclusion — only up to the records it must prove.
const CONF_BUFFER = 12;

const fail = (reason: string): NameVerification => ({ verified: false, reason, scope: "as-shown" });

// outputs → addr→sum(value) map (the resolver's `paidTo`). The AGGREGATION is the vendored
// paidToFromOutputs (the exact sink the cairnx scanner/resolver use — same skip-don't-throw
// semantics for malformed values; a dropped fee output can only make a fee look unpaid → reject,
// never overpay). What stays local is SPV-specific: raw tx outputs carry a scriptPubkey, not an
// addr, so extract + validate the 40-hex address and coerce codec number|bigint values to number
// (a value past 2^53 coerces non-safe and is skipped by the sink, matching the old local copy).
// A hand-rolled twin of the aggregation lived here until 2026-07-06.
function outputsToPaidTo(outputs: Tx["outputs"]): Record<string, string> {
  const decoded: { addr: string; value: number }[] = [];
  for (const o of outputs) {
    const a = String(o.scriptPubkey ?? "").toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(a)) continue;
    decoded.push({ addr: "0x" + a, value: Number(o.value) });
  }
  return paidToFromOutputs(decoded);
}

// Recover + AUTHENTICATE a tx's signer. scriptSig = 0x40‖sig64‖0x21‖pub33 (99 bytes). The signature MUST
// validate against sighash(tx): the merkle root commits the tx BODY but not the scriptSig, so without this
// a lying node could re-attribute (or fabricate) a record's author. null on any malformation / bad sig.
// Since csd-crypto 0.1.15 (Plan 57 B9) the STRICT parser+verifier is the vendored recoverSigner
// (exact 198-byte frame + verifyDigest + lowercase addr — the same contract this file hand-rolled);
// this wrapper only supplies sighash(tx), kept INSIDE the try so a malformed hinted tx null-fails
// instead of throwing (fail-closed, never fail-crashed).
function recoverSigner(tx: Tx): string | null {
  const ss = tx.inputs?.[0]?.scriptSig;
  if (typeof ss !== "string") return null;
  try { return recoverSignerFromScriptSig(ss, sighash(tx)); }
  catch { return null; }
}

// Reconstruct a resolver ChainEvent from a merkle-verified, signer-authenticated, prevout-bound tx. The
// caller has already recovered + ownership-bound `signer` (see replayName); this only decodes the app
// payload. Returns null for a non-cairnx tx (the caller fail-closes — a hinted tx we can't faithfully
// replay is a lying read).
// ★ KEEP-IN-SYNC: the emitted field shapes mirror the cairnx scanner (cairnx repo src/scan.ts
// tx()/propose/attest mapping) so resolve() produces identical state from either feed. The
// aggregation half already IS the shared sink (paidToFromOutputs, above); this event shaping stays
// a marked mirror because the two sides read different wire formats (SPV raw tx vs indexer JSON).
// Any field-shape change lands in BOTH files; test/namespv.test.mjs replays against the audited
// resolver and fails on shape drift.
function toChainEvent(tx: Tx, id: string, height: number, pos: number, signer: string): Record<string, unknown> | null {
  if (!tx.app || tx.app.type === "None") return null;
  const paidTo = outputsToPaidTo(tx.outputs);
  if (tx.app.type === "Propose") {
    return { kind: "propose", id: id.toLowerCase(), proposer: signer, uri: tx.app.uri, payloadHash: String(tx.app.payloadHash).toLowerCase(), expiresEpoch: Number(tx.app.expiresEpoch), height, pos, paidTo };
  }
  const conf = Number(tx.app.confidence);
  return { kind: "attest", txid: id.toLowerCase(), proposalId: String(tx.app.proposalId).toLowerCase(), attester: signer, score: Number(tx.app.score), confidence: Number.isSafeInteger(conf) && conf >= 0 ? conf : 0, height, pos, paidTo };
}

// Core SPV replay (no claim gate): SPV-verify `hints` against the chain and recompute the name's (owner,addr)
// via the AUDITED resolver. Shared by the single-source verifyName and the multi-source verifyNameUnion.
type Replay =
  | { ok: true; owner: string; addr: string; via: "nset" | "owner"; depth: number; viaFill: boolean }
  // WALLET-LAPSE-TIP-1: a lease-lapse failure carries `lapsed` + whether the persisted floor corroborated it,
  // so the caller can present a confident lapse vs a single-source caution. Other failures leave both unset.
  | { ok: false; reason: string; lapsed?: boolean; floorCorroborated?: boolean };
// Cap the hinted records a verify will SPV-prove (L8 / HINTDOS): each hint now also costs a prevout fetch
// (H3), so an unbounded attacker-chosen hint list could fan out into many round-trips. A real name has a
// handful of records; 256 is far above any honest history and bounds a hostile source's fetch amplification.
const MAX_HINTS = 256;
async function replayName(name: string, hints: NameHint[], src: SpvSource): Promise<Replay> {
  if (!Array.isArray(hints) || hints.length === 0) return { ok: false, reason: "no on-chain records were offered for this name" };
  if (hints.length > MAX_HINTS) return { ok: false, reason: `too many record hints for one name (>${MAX_HINTS}) — refusing` };
  // group hinted txids by block height — verify each block ONCE against its PoW-committed merkle root
  const byHeight = new Map<number, NameHint[]>();
  let maxHeight = 0;
  for (const h of hints) {
    const height = Number(h.height);
    if (!Number.isInteger(height) || height < 0) return { ok: false, reason: "a record hint has an invalid height" };
    (byHeight.get(height) ?? byHeight.set(height, []).get(height)!).push(h);
    if (height > maxHeight) maxHeight = height;
  }
  const { verifiedTip, nodeTip, floorTip } = await src.prepare(maxHeight);
  if (maxHeight > verifiedTip) return { ok: false, reason: `a record at height ${maxHeight} is above the verified tip (${verifiedTip})` };
  const lapseTip = Math.max(verifiedTip, Number.isFinite(nodeTip) ? nodeTip : 0);

  const events: Record<string, unknown>[] = [];
  for (const [height, hs] of byHeight) {
    const { merkle, txs } = await src.blockAt(height);            // THROWS if the header can't be PoW-verified
    // A plain/coinbase tx may carry no `app`; default it to {None} BEFORE decode so a hostile node can't omit
    // `app` on one filler tx to make rpcTxToTx throw and DoS the whole verify. A None tx still has a real txid.
    const rebuilt = txs.map((t) => rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } }));
    const ids = rebuilt.map(ctxid);
    // M7/F11 (B5e, CVE-2012-2459): reject a duplicated txid BEFORE the root compare - merkleRoot self-pairs
    // an odd final row, so a body whose last tx is duplicated shares the honest root. A real block can never
    // hold a duplicate txid. Same one-line defense as fillspv.ts bindBlock (F11: this is the second site).
    if (new Set(ids.map((x) => x.toLowerCase())).size !== ids.length) return { ok: false, reason: `block ${height} has a duplicate txid (malleated read path, CVE-2012-2459)` };
    // FULL-block bind: the entire tx-set must hash to the verified header's merkle root, so the node cannot
    // have omitted/altered/added any committed body within this block (completeness-in-block).
    if (String(merkleRoot(ids)).toLowerCase() !== String(merkle).toLowerCase()) return { ok: false, reason: `block ${height} doesn't match its verified merkle root (tampered read path)` };
    for (const hint of hs) {
      const pos = ids.findIndex((x) => x.toLowerCase() === String(hint.txid).toLowerCase());
      if (pos < 0) return { ok: false, reason: `record ${hint.txid} is not in verified block ${height}` };
      const tx = rebuilt[pos];
      const signer = recoverSigner(tx);
      if (!signer) return { ok: false, reason: `record ${hint.txid} couldn't be authenticated (not a signed cairnx record)` };
      // NSPV-SIGSUB-1 (H3): the merkle root + txid commit the tx BODY but NOT the scriptSig, and the public
      // sighash is secret-free — so a hostile/MITM block-body provider could substitute a foreign VALID
      // signature over it to re-attribute this record's author (re-pointing a name's owner). Defeat it the
      // way consensus / BIP-174 do: bind the recovered signer to the COIN it spends — the authenticating
      // input's prevout scriptPubkey (a 20-byte hash160) must equal hash160(pub) == this signer's address.
      // SpvSource.prevoutScriptPubkey txid-binds the source body (reuses the TXB-1 cure). Fail CLOSED on any gap.
      const in0 = tx.inputs?.[0];
      if (!in0 || isCoinbaseInput(in0)) return { ok: false, reason: `record ${hint.txid} has no spendable authenticating input` };
      const spk = await src.prevoutScriptPubkey(String(in0.prevTxid), Number(in0.vout));
      if (!spk || spk.toLowerCase() !== signer) return { ok: false, reason: `record ${hint.txid} signer does not own the coin it spends (rejected possible scriptSig substitution)` }; // MUTATE_NSPV_PREVOUT_BIND
      const ev = toChainEvent(tx, ids[pos], height, pos, signer);
      if (!ev) return { ok: false, reason: `record ${hint.txid} is not a cairnx app record` };
      events.push(ev);
    }
  }
  // Replay the AUDITED resolver over ONLY the verified events. `lapseTip` (≥ the node-reported chain tip,
  // monotonic-floored) drives the lease-lapse epoch fail-closed.
  const state = resolve(events, lapseTip);
  const rec = state.names[name];
  if (!rec) return { ok: false, reason: "the verified records don't establish ownership of this name" };
  if (rec.expired) {
    // WALLET-LAPSE-TIP-1: corroborate the lapse against the persisted tip FLOOR (a tip already trusted BEFORE
    // this — possibly MITM'd — session). Re-running the AUDITED resolver at floorTip re-derives "expired"
    // without any consensus math here; if the lease is expired even at that trusted lower-bound tip, the lapse
    // is confident. If it is expired ONLY at the current (claimed) nodeTip, the caller degrades it to caution
    // unless a second source corroborates — so an inflated fresh-install tip can't assert a false lapse.
    const floor = Number.isFinite(floorTip as number) ? Number(floorTip) : 0;
    const floorCorroborated = floor > 0 && resolve(events, floor).names[name]?.expired === true;
    return { ok: false, lapsed: true, floorCorroborated, reason: `${name}.csd lease has lapsed (per the chain) — refusing to send` };
  }
  // v2.5: a `pending` reservation is a payment-free registration/recapture reserve that has NOT been finalized —
  // it confers no address and is not an owned name yet. Fail CLOSED (never resolve it to the owner) so a name
  // that is only reserved, or whose promoting `nfinalize` is being withheld from the hint set, can never be a
  // send target. A finalized name is not pending (nfinalize clears the flag), so this only blocks true reserves.
  if (rec.pending) return { ok: false, reason: `${name}.csd is a reservation that has not been finalized on-chain yet — refusing to send` };
  return { ok: true, owner: String(rec.owner).toLowerCase(), addr: String(rec.addr ?? rec.owner).toLowerCase(), via: rec.addr ? "nset" : "owner", depth: Math.max(0, verifiedTip - maxHeight + 1), viaFill: !!rec.viaFill };
}

/**
 * Verify `name → claim.addr` against the chain via SPV + an audited replay (SINGLE source). The
 * chain-recomputed address must equal what the resolver claimed — a fabricated redirect cannot pass (the
 * attacker has no signed, mined events for 0xATTACKER). Pure over `src` so it is fully Node-testable.
 * NOTE: single-source verify cannot defeat a WITHHOLDING resolver — use verifyNameUnion for that.
 */
export async function verifyName(name: string, claim: NameClaim, hints: NameHint[], src: SpvSource): Promise<NameVerification> {
  try {
    if (!claim?.addr || !/^0x[0-9a-f]{40}$/.test(String(claim.addr).toLowerCase())) return fail("the resolver returned no usable address for this name");
    if (claim.lapsed) return fail(`${name}.csd lease has lapsed — refusing to send`);
    const r = await replayName(name, hints, src);
    if (!r.ok) {
      // WALLET-LAPSE-TIP-1: a SINGLE-source lapse is confident ONLY if the persisted floor corroborates it;
      // otherwise degrade to CAUTION (verified:false, lapsed falsy, "may have lapsed") so a MITM-inflated tip
      // on a fresh install cannot assert a false confident lapse and hard-block a legit send. Fail-soft.
      if (r.lapsed) {
        return r.floorCorroborated
          ? { ...fail(r.reason), sources: 1, agreed: 0, disagree: false, lapsed: true }
          : { ...fail(`${name}.csd may have lapsed, but only one name source is available to confirm the chain tip — confirm out-of-band before sending`), sources: 1, agreed: 0, disagree: false, lapsed: false };
      }
      return fail(r.reason);
    }
    if (r.addr !== String(claim.addr).toLowerCase())
      return fail("the resolver's address does NOT match what the chain proves — refusing (possible hostile resolver)");
    // NSPV-CLAIMCAP-1 (H1): a fill-acquired name can't be soundly proven from a name-scoped replay, and the
    // single-source path has no scopedReplaySufficient signal to consult — fail CLOSED rather than show green.
    if (r.viaFill)
      return { ...fail(`${name}.csd ownership was decided by an on-chain offer fill that a name-scoped replay cannot prove — refusing to show as verified (confirm out-of-band)`), sources: 1, agreed: 0, disagree: false, viaFill: true };
    return { verified: true, addr: r.addr, owner: r.owner, via: r.via, depth: r.depth, scope: "as-shown", sources: 1, agreed: 1, disagree: false, viaFill: false };
  } catch (e) {
    return fail(`couldn't verify on-chain (fail-closed): ${(e as Error)?.message ?? e}`);
  }
}

// Fetch one resolver's /cairnx/name-history. Fail-soft: any error → ok:false (the union tolerates a down source).
async function fetchNameHistory(s: ResolverSource, name: string, fetchImpl: typeof fetch): Promise<SourceResult> {
  try {
    const r = await fetchImpl(`${s.base.replace(/\/$/, "")}/cairnx/name-history/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return { label: s.label, ok: false, unregistered: true, hints: [] };
    if (!r.ok) return { label: s.label, ok: false, hints: [], error: `${r.status}` };
    const j: any = await r.json();
    if (!j?.ok) return { label: s.label, ok: false, hints: [], error: j?.error ?? "name-history unavailable" };
    // Capture the resolver's scopedReplaySufficient flag (cairnx `service.ts`): true = "a name-scoped replay
    // reproduces the same owner/addr as the full chain"; false = "ownership depends on out-of-name-scope state
    // (V17 open-lane claim cap / name-for-token balance) — the wallet MUST fail closed". We HONOR a served
    // false but never TRUST a served true (the self-computed viaFill gate in verifyNameUnion is the real check).
    return { label: s.label, ok: true, hints: Array.isArray(j.events) ? j.events : [], claim: { addr: j.resolve?.addr, owner: j.resolve?.owner, via: j.resolve?.via, lapsed: j.resolve?.lapsed }, scopedReplaySufficient: typeof j.scopedReplaySufficient === "boolean" ? j.scopedReplaySufficient : undefined };
  } catch (e) { return { label: s.label, ok: false, hints: [], error: (e as Error)?.message ?? String(e) }; }
}

/**
 * NSPV-COMPLETE-1 cure (doc 36 Part B): verify `name → addr` against ≥2 INDEPENDENT name-history sources
 * (e.g. cairn-substrate.com + clarvis.cairn-substrate.com). Each source's hints are fetched, UNIONed by
 * lowercase txid, SPV-verified together against the wallet's own PoW header chain, and replayed by the
 * audited resolver to the true winner. Because every unioned event is SPV-authenticated, a source can only
 * ADD real events (filling another's omission) — never fabricate — so the union defeats a WITHHOLDING
 * resolver as long as ONE source is honest (an attacker must make BOTH independent hosts withhold the SAME
 * event). The send target is the SPV-PROVEN union winner, and any source whose stated claim disagrees with
 * it is flagged. Fail-soft: 1 usable source → single-source (caution); ≥2 agree → strong; a disagreement is
 * flagged but the send still goes to the proven winner (the disagreeing source was lying/stale, not trusted).
 */
export async function verifyNameUnion(name: string, sources: ResolverSource[], src: SpvSource, fetchImpl: typeof fetch = fetch): Promise<NameVerification> {
  try {
    // de-dup sources by base so [primary, clarvis] with an identical custom tradeApi doesn't double-count
    const seen = new Set<string>();
    const uniq = sources.filter((s) => s.base && !seen.has(s.base.replace(/\/$/, "")) && seen.add(s.base.replace(/\/$/, "")));
    const results = await Promise.all(uniq.map((s) => fetchNameHistory(s, name, fetchImpl)));
    const usable = results.filter((r) => r.ok && r.hints.length > 0);
    if (usable.length === 0) {
      if (results.some((r) => r.unregistered)) return { ...fail(`${name}.csd is not registered`), sources: 0, agreed: 0, disagree: false };
      return { ...fail("no on-chain records could be fetched for this name (name service unavailable)"), sources: 0, agreed: 0, disagree: false };
    }
    // H1 (deep-review 2026-07-03): a REGISTERED-vs-UNREGISTERED disagreement is fail-closed. When one source
    // serves history (usable) but ANOTHER independent source AFFIRMATIVELY reports the name unregistered (a
    // clean 404, `unregistered:true` — NOT mere unavailability), do NOT silently honor only the hint-serving
    // source: the honest source may have fully replayed and seen an out-of-name-scope rejection (the V25
    // MAX_PENDING_REG forged-green class) that the hint-serving source cannot represent. Fail closed to the
    // untrusted-resolver caution. This is deliberately NOT a blanket ≥2-source rule — a lone honest source
    // with NO disagreeing source still verifies, so the common clarvis-DOWN case keeps its single-source
    // posture (down ≠ a 404). The cost is confined to a genuine primary-vs-second-source existence conflict.
    if (results.some((r) => r.unregistered)) {
      return { ...fail(`one name source reports ${name}.csd is unregistered while another served history — the sources disagree on whether it exists; confirm the address out-of-band before sending`), sources: usable.length, agreed: 0, disagree: true };
    }
    // UNION the hints by lowercase txid; a same-txid-different-height across sources is a tamper → conflict.
    const byTxid = new Map<string, NameHint>();
    let conflict = false;
    for (const r of usable) for (const h of r.hints) {
      const k = String(h.txid).toLowerCase();
      const prev = byTxid.get(k);
      if (prev) { if (Number(prev.height) !== Number(h.height) || Number(prev.pos) !== Number(h.pos)) conflict = true; }
      else byTxid.set(k, h);
    }
    const rep = await replayName(name, [...byTxid.values()], src);
    if (!rep.ok) {
      // WALLET-LAPSE-TIP-1: a lapse is CONFIDENT when corroborated — ≥2 independent name sources served the
      // events establishing the lease, OR the persisted tip floor is also past expiry. A lone usable source
      // with an uncorroborated (current-tip-only) lapse degrades to CAUTION, never a false confident lapse
      // from a fresh-install + MITM-inflated tip. Fail-soft (availability valve), never a false green.
      if (rep.lapsed) {
        const confident = usable.length >= 2 || rep.floorCorroborated === true;
        return confident
          ? { ...fail(rep.reason), sources: usable.length, agreed: 0, disagree: false, lapsed: true }
          : { ...fail(`${name}.csd may have lapsed, but only one name source is available to confirm the chain tip — confirm out-of-band before sending`), sources: usable.length, agreed: 0, disagree: false, lapsed: false };
      }
      // M12 (B5e): the UNIONED replay failed. A single hostile source can poison the combined hint set
      // with ONE junk hint (a txid not in its claimed block, an unauthenticated record), aborting the whole
      // replay — after which resolveName drops to the served address with only a caution badge, and that
      // address can come from the very source that poisoned it. Retry EACH source's hints ALONE (this runs
      // ONLY on the already-failed path, so it slows nothing that was working): a poisoned source still
      // fails on its own junk and drops out, while an honest source's own complete history replays to the
      // true winner. Honor it ONLY if every recovered source AGREES on the address (a genuine two-source
      // disagreement stays fail-closed) and none is a lapse/viaFill/scope-insufficient result (those keep
      // their own fail-closed handling). This cannot re-open the withholding gap: a source serving a
      // stale-but-clean subset that replays to a WRONG winner produces a disagreement and is refused.
      if (usable.length > 1) {
        type OkReplay = Extract<Replay, { ok: true }>;
        const recovered: { label: string; rep: OkReplay; claim?: NameClaim }[] = [];
        for (const r of usable) {
          const solo = await replayName(name, r.hints, src).catch(() => ({ ok: false as const, reason: "solo replay threw" }));
          if (solo.ok && !solo.viaFill && r.scopedReplaySufficient !== false) recovered.push({ label: r.label, rep: solo, claim: r.claim });
        }
        const addrs = new Set(recovered.map((p) => p.rep.addr));
        if (recovered.length >= 1 && addrs.size === 1) {
          const win = recovered[0].rep;
          let agreed = 0; for (const r of usable) { const c = r.claim?.addr ? String(r.claim.addr).toLowerCase() : null; if (c === win.addr) agreed++; }
          // A recovery ALWAYS flags disagree: a source that failed to replay cleanly (the poisoner) or whose
          // stated claim differs from the proven winner is misbehaving, and the badge must stay cautious even
          // though the name is provably resolved. Never a hard veto (the M12 fix), never a silent green.
          return { verified: true, addr: win.addr, owner: win.owner, via: win.via, depth: win.depth, scope: "as-shown", sources: usable.length, agreed, disagree: recovered.length < usable.length || agreed < usable.length, viaFill: false };
        }
      }
      return { ...fail(rep.reason), sources: usable.length, agreed: 0, disagree: false };
    }
    // NSPV-CLAIMCAP-1 (H1): never present a fill-acquired ("viaFill") name — or a name any usable source
    // flagged scopedReplaySufficient:false — as plain verified. Its ownership can hinge on out-of-name-scope
    // state (the V17 open-lane claim cap is global over ALL offers; a name-for-token fill depends on the
    // buyer's global token balance) that this name-scoped replay provably cannot reconstruct, and a second
    // honest source runs the IDENTICAL scoped selector, so the union cannot fill the gap. `viaFill` is
    // COMPUTED from our own SPV-verified events (we honor a served false but never TRUST a served true).
    // Fail CLOSED to caution. (B3 will re-green legitimately taker-bound purchases via self-derived binding.)
    const servedInsufficient = usable.some((r) => r.scopedReplaySufficient === false);
    if (rep.viaFill || servedInsufficient) {
      // Distinct, accurate reasons for the two triggers (QA-3): a self-computed viaFill winner vs a source
      // that explicitly reported its answer is not name-scope-provable. Both are fail-closed to caution.
      const reason = rep.viaFill
        ? `${name}.csd ownership was decided by an on-chain offer fill that a name-scoped replay cannot prove (open-lane / token sale) — confirm the address out-of-band before sending`
        : `a name source reported that ${name}.csd cannot be name-scope-proven (its replay may disagree with the full chain) — confirm the address out-of-band before sending`;
      return { ...fail(reason), sources: usable.length, agreed: 0, disagree: false, viaFill: !!rep.viaFill };
    }
    // Cross-check: each usable source's STATED claim.addr against the SPV-proven union winner.
    let agreed = 0; const disagreeing: string[] = [];
    for (const r of usable) {
      const c = r.claim?.addr ? String(r.claim.addr).toLowerCase() : null;
      if (c === rep.addr) agreed++; else disagreeing.push(r.label);
    }
    const disagree = disagreeing.length > 0 || conflict;
    return { verified: true, addr: rep.addr, owner: rep.owner, via: rep.via, depth: rep.depth, scope: "as-shown", sources: usable.length, agreed, disagree, viaFill: false };
  } catch (e) {
    return { ...fail(`couldn't verify on-chain (fail-closed): ${(e as Error)?.message ?? e}`), sources: 0, agreed: 0, disagree: false };
  }
}

// ── production SPV source: the real PoW-verified light client over the cairn server ──────────────────
export interface LiveSpvOpts {
  rpcBase: string;       // e.g. https://cairn-substrate.com/api/rpc  (CsdClient block/tx reads)
  headersBase: string;   // e.g. https://cairn-substrate.com          (/api/headers batch header source)
  // optional header-chain snapshot cache (the wallet store) so we don't re-sync every verify; re-verified on load
  cache?: { get(): Promise<unknown | null>; set(s: unknown): Promise<void> };
  // optional persisted node-tip high-water (NSPV-STALE-LAPSE / NAME-4). The monotonic floor below only
  // protects WITHIN a session; persisting it lets the floor survive MV3 service-worker restarts so a deflated
  // tip served on the first verify of a fresh session cannot roll lease-state back below a height we have
  // already trusted. A single integer, written (awaited) only when the observed tip ADVANCES, on the .csd
  // name-resolve path — off the send hot path; a write failure is swallowed (the floor just degrades to
  // within-session, the prior behaviour).
  floor?: { get(): Promise<number | null>; set(v: number): Promise<void> };
}

// M9 (B5a): the lapse-floor advance rule, ONE pure function so the clamp and its use-site cannot drift.
// The floor is a cross-session HIGH-WATER of the node tip whose job is to stop lapse-state ROLLBACK (a
// deflated tip on a fresh session). Persisting the RAW served tip made it hostile-INFLATABLE: one lying
// read became an unbounded monotonic lie, persisted forever, driving every later lease-expiry epoch and
// every guard the wallet clamps with the floor. The candidate is therefore clamped to
// verifiedTip + FLOOR_SLACK: the floor may never exceed PoW-verified evidence by more than the sync
// cushion the client already targets. Callers advance the floor only AFTER a successful LC.sync (a
// failed or lying sync advances nothing — a lying-high header chain throws in LC.sync, fail-closed).
// Coverage limit, stated not assumed away: the floor advances only inside prepare(), so a fresh install
// has floor 0 and any guard clamped by it is disarmed until the first successful verify — fail-open in
// the SAFE direction (no false refusal), same posture as WALLET-LAPSE-TIP-1.
export const FLOOR_SLACK = CONF_BUFFER;
export function floorAdvance(seenFloor: number, nodeTip: number, verifiedTip: number): number {
  const raw = Number.isFinite(nodeTip) ? nodeTip : 0;
  const cand = Math.min(raw, (Number.isFinite(verifiedTip) ? verifiedTip : 0) + FLOOR_SLACK);
  return cand > seenFloor ? cand : seenFloor;
}

/** Build the live SPV source. The LightClient seeds at the baked checkpoint and verifies forward to tip. */
export async function liveSpvSource(opts: LiveSpvOpts): Promise<SpvSource> {
  const boundFetch = (...a: Parameters<typeof fetch>) => fetch(...a);
  // timeoutMs 12s (> the /api/rpc proxy's 4s+6s failover worst case): the vendored client's 10s
  // default TIED the inner chain exactly — an abort could fire the instant the proxy's fallback
  // would have answered (timeout-inversion class, docs/Plans/66 B2).
  const client = new CsdClient({ baseUrl: opts.rpcBase.replace(/\/$/, ""), fetch: boundFetch, timeoutMs: 12_000 });
  const headersBase = opts.headersBase.replace(/\/$/, "");
  // The /api/headers endpoint is budget-limited (DOS-HDR-1) and deadline-bounded (it answers a clean
  // 502 at ~10s instead of grinding on a slow indexer). A legit cold sync paces itself:
  //  - 429 (budget) → sleep the server's own Retry-After hint (capped 15s; it says when the window
  //    resets — the old fixed 1.2s×n ladder maxed ~25s and could NOT span a 60s budget window);
  //  - 502/503 (deadline/data-availability hiccup) → short ladder retry: our aborted request left
  //    stragglers warming the server's header cache, so the retry is cheap and usually instant.
  // Every retried header is still fully re-verified (PoW/prev-link/LWMA) downstream — retrying
  // transport carries zero trust. After bounded retries we still THROW → verify fails closed.
  // Client timeout 15s sits ABOVE the server's 10s deadline (the server answers first by design).
  const headersBatch = async (from: number, count: number) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${headersBase}/api/headers/${from}/${count}`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429 && attempt < 6) {
        const ra = Number(r.headers.get("retry-after")) || 0;
        await sleep(Math.min(ra > 0 ? ra * 1000 : 1200 * (attempt + 1), 15_000));
        continue;
      }
      if ((r.status === 502 || r.status === 503) && attempt < 6) { await sleep(1200 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`/api/headers ${r.status}`);
      const rows = (await r.json())?.headers;
      if (!Array.isArray(rows) || rows.length !== count) throw new Error("/api/headers: non-dense range");
      return rows.map((row: { header: unknown; hash: string }) => ({ header: row.header, hash: row.hash }));
    }
  };
  const checkpoints = { [CP.height]: CP.hash };

  let lc: LightClient | null = null;
  // try a re-verified snapshot first (fromSnapshot recomputes PoW + links + LWMA bits, honours the checkpoint)
  if (opts.cache) {
    try { const snap = await opts.cache.get(); if (snap) lc = LightClient.fromSnapshot(snap, { client, headersBatchProvider: headersBatch, checkpoints }); }
    catch { lc = null; }
  }
  if (!lc) {
    lc = new LightClient({ client, headersBatchProvider: headersBatch, checkpoints });
    await lc.syncFromCheckpoint(CP.height, CP.hash);
  }
  // M8 (B5e): `let`, not `const`, so a STRUCTURAL sync break (a reorg orphaned our tip) can drop the
  // wedged snapshot and reseed this client from the baked checkpoint in place (below).
  let LC = lc;
  // Monotonic tip floor (audit NSPV-STALE-LAPSE): a hostile/MITM resolver can DEFLATE the reported tip so a
  // genuinely-lapsed lease's expiry epoch is under-computed and an old-but-real mapping looks current. We
  // never let the tip used for the lapse epoch REGRESS below the highest value this source has already
  // reported in the session, so a mid-flow deflation can't roll the lease-state back. Cheap (an integer) —
  // crucially NO extra header sync, so the first name-verify stays fast (syncing the whole chain to tip would
  // add ~tens of seconds to the cold path and STILL not defeat a consistent MITM, which serves a short chain
  // anyway). The residual — a wallet that has only ever seen a consistently-deflated source — is the same
  // single-source-trust limit as NSPV-COMPLETE-1, closed only by a second source.
  // Seed from the persisted high-water (NAME-4) so the floor survives an MV3 service-worker restart, not just
  // the current session. Best-effort: a missing/garbage value just starts at 0 (the prior behaviour).
  let seenFloor = 0;
  if (opts.floor) { try { const f = Number(await opts.floor.get()); if (Number.isFinite(f) && f > 0) seenFloor = f; } catch { /* no persisted floor → start at 0 */ } }
  // WALLET-LAPSE-TIP-1: freeze the floor as seeded from PRIOR sessions, BEFORE any current-session read
  // advances seenFloor. This is the trusted-across-sessions tip used ONLY to corroborate a lease-lapse
  // verdict (replayName re-runs the audited resolver at it). On a fresh install it is 0 → a lapse rests on
  // the current node tip alone → caution; on an established install it is high → a genuine lapse is confident.
  const persistedFloor = seenFloor;
  // BP4/N11: serialize LC.sync so concurrent consumers of this SHARED source never interleave ingests.
  const serializeSync = makeSerializer();
  // BP8b (N10 wallet-half / N14): the partial-progress persist hook for LONG syncs. Invoked ONLY from
  // inside the serialized critical section below (so no torn snapshot: nothing mutates LC while it
  // serializes), and best-effort by contract (syncWithPartialPersist and the catch below swallow its
  // failures): losing a checkpoint write degrades to a re-sync, never a refusal.
  const persistSnap = opts.cache ? (s: unknown) => opts.cache!.set(s) : null;

  return {
    async prepare(maxEventHeight: number) {
      let nodeTip = 0;
      try { nodeTip = Number((await client.tip())?.height); } catch { /* node tip unknown → lapse uses the floor / verified tip */ }
      // M9 (B5a): the floor advance moved BELOW the sync — it is PoW-clamped and sync-gated now (see
      // floorAdvance). Persisting the raw served tip here made the floor hostile-INFLATABLE: an unbounded
      // lie, persisted forever (monotonic), driving every later lease-expiry epoch and every guard the
      // wallet clamps with the floor (W5 legacy-sunset, M11 fee tier). Deflation was always floored;
      // inflation is now bounded by PoW evidence + FLOOR_SLACK.
      // Inclusion only needs headers up to the record + cushion (kept cheap; an old, sparse name does not
      // pay a full chain sync). LC.sync re-derives PoW+LWMA per header, so a lying-high cushion fails closed.
      const want = Math.min(Number.isFinite(nodeTip) && nodeTip > 0 ? nodeTip : maxEventHeight + CONF_BUFFER, maxEventHeight + CONF_BUFFER);
      // Run the sync inside the serializer, and re-read the tip INSIDE the critical section so a redundant sync
      // (another consumer already advanced the chain) is a cheap no-op. A sync throw still propagates to THIS
      // caller (fail-closed); a prior consumer's failure never wedges the chain (makeSerializer swallows it for
      // chaining only). blockAt (below) never syncs, so block reads stay fully parallel.
      await serializeSync(async () => {
        const cur = LC.baseHeight + LC.chain.length - 1;
        if (want <= cur) return;
        try {
          // BP8b: a long sync checkpoints verified progress every SYNC_PERSIST_WINDOW headers
          // (see syncWithPartialPersist below); the final leg to `want` then lands here.
          await syncWithPartialPersist(LC, want, persistSnap);
          await LC.sync(want);                         // a lying-high header THROWS here (fail-closed)
        } catch (e) {
          // BP8b (N10 wallet-half / N14 "hard wall, not a slow retry"): BEFORE classifying the failure,
          // persist whatever this attempt already ingested, so a 429'd cold bootstrap RESUMES from here
          // on the next attempt instead of restarting at zero forever. Safe by construction: every
          // header in LC.chain was PoW/LWMA-verified at ingest, and a restored snapshot is RE-VERIFIED
          // on load (LightClient.fromSnapshot recomputes hashes, prev links, PoW and LWMA bits,
          // checkpoint-anchored), so this changes WHEN the wallet writes, never what a restore trusts
          // (the storage-poisoning defense is untouched). INVARIANT (composes with B5a floorAdvance):
          // a partial persist NEVER advances the lapse floor. The floor advances only after a FULLY
          // successful sync, because floorAdvance runs after this serialized block completes and the
          // rethrow / a failed reseed below skips it, so the floor can never exceed what was actually
          // verified. Fail-soft: a persist failure only means the next attempt re-syncs.
          if (opts.cache && LC.baseHeight + LC.chain.length - 1 > cur) {
            try { await opts.cache.set(LC.toSnapshot()); } catch { /* fail-soft: next attempt re-syncs */ }
          }
          // M8 (B5e): port swapguard's transient-vs-STRUCTURAL split (ensureSyncedTo, DOS-HDR-3). The
          // wallet only ever appended headers and NEVER cleared the cached snapshot on a prev-link break,
          // so a header later orphaned by a reorg wedged the chain PERMANENTLY: every future session
          // restored the orphaned tip via fromSnapshot and this sync threw forever. Distinguish a
          // TRANSIENT transport failure (rate limit / gateway / timeout / non-dense range / a 200 with a
          // non-JSON body - a CF interstitial served 200 - i.e. data availability, NOT a chain fault) from a
          // STRUCTURAL break (broken prev-link / bad PoW / hash mismatch). On transient: KEEP the cache and
          // rethrow fail-closed (the caller retries) - wiping here would turn one /api/headers 429 or a CF
          // 200-HTML blip into a cache-nuking cold-resync STORM. Only a structural break reseeds from the
          // baked checkpoint. The JSON-parse markers matter: headersBatch does `(await r.json()).headers`, so
          // a 200 with a bad body throws "Unexpected end of JSON input"/"Unexpected token" - a transport
          // fault, never a chain one (structural errors say prev/PoW/bits/hash, never json). (G8 review.)
          const msg = String((e as Error)?.message || e);
          if (/\b(429|50[0-9]|timeout|timed out|abort|aborted|headers|non-dense|failed to fetch|networkerror|load failed)\b/i.test(msg) || /unexpected (token|end)|json/i.test(msg)) throw e;
          // Do NOT drop the snapshot before the reseed: a structurally-lying feed would nuke an HONEST
          // snapshot and, if the reseed then fails, force a full cold sync every session (N10 budget
          // pressure). On reseed SUCCESS the post-catch snapshot write below replaces it with the fresh
          // chain (clearing any real wedge); on reseed FAILURE we keep the old snapshot and heal on the next
          // healthy prepare(). (G8 review: the set(null)-before-reseed hazard.)
          const fresh = new LightClient({ client, headersBatchProvider: headersBatch, checkpoints });
          await fresh.syncFromCheckpoint(CP.height, CP.hash);
          await fresh.sync(want);                       // a genuinely lying-high header still THROWS here (fail-closed)
          LC = fresh;                                   // adopt the reseeded chain (blockAt reads LC at call time)
        }
        // Snapshot write is best-effort (a failure only means the NEXT verify cold-syncs again),
        // but never silent: the snapshot is multi-MB and shares chrome.storage.local's quota with
        // the vault/history — a persistent write failure here is the early smoke of quota
        // exhaustion (the manifest carries unlimitedStorage precisely to keep this from failing;
        // if this warning ever fires, investigate storage pressure, don't ignore it).
        if (opts.cache) { try { await opts.cache.set(LC.toSnapshot()); } catch (e) { console.warn("[namespv] header-snapshot write failed (will cold-sync next verify):", e); } }
      });
      // M9 (B5a): advance + persist the floor ONLY after the sync above succeeded (a throw skips this),
      // and never above verifiedTip + FLOOR_SLACK (floorAdvance). The RETURNED nodeTip still carries the
      // raw served tip for THIS session's lapse epoch (pre-existing design: a lying-high tip only makes
      // leases look expired sooner, over-caution; deflation is floored) — only what the wallet TRUSTS
      // ACROSS SESSIONS is clamped to PoW evidence.
      const verifiedTip = LC.baseHeight + LC.chain.length - 1;
      const cand = floorAdvance(seenFloor, nodeTip, verifiedTip);
      if (cand > seenFloor) { seenFloor = cand; if (opts.floor) { try { await opts.floor.set(seenFloor); } catch { /* persist best-effort */ } } }
      // Report the floored tip so verifyName's lapse epoch (max(verifiedTip, nodeTip)) can only move FORWARD.
      // floorTip is the PRIOR-session high-water (WALLET-LAPSE-TIP-1), for lapse corroboration only.
      return { verifiedTip, nodeTip: Math.max(seenFloor, Number.isFinite(nodeTip) ? nodeTip : 0), floorTip: persistedFloor };
    },
    async blockAt(height: number) {
      const vh = LC.chain[height - LC.baseHeight];
      if (!vh) throw new Error(`no PoW-verified header at ${height}`);
      const b = await client.blockByHeight(height);
      return { merkle: String(vh.header.merkle), txs: b.txs };
    },
    // NSPV-SIGSUB-1 (H3): fetch a record's spent prevout and bind it to its txid exactly as verifyInputValues
    // (TXB-1) does — fetch the source tx, recompute its consensus txid, and require it == prevTxid (the txid
    // commits every output incl. its 20-byte scriptPubkey). A hostile node cannot serve a fake body whose
    // recomputed txid still matches the outpoint. Returns the 0x scriptPubkey, or null (→ fail-closed) on any
    // missing / not-yet-mined / mismatched / malformed body. Same untrusted-node read path as blockAt.
    async prevoutScriptPubkey(prevTxid: string, vout: number) {
      try {
        const body = (await client.tx(prevTxid))?.tx;
        if (!body) return null;
        const tx = rpcTxToTx(body);
        if (String(ctxid(tx)).toLowerCase() !== String(prevTxid).toLowerCase()) return null; // forged source body
        const out = tx.outputs?.[vout];
        if (!out) return null;
        const a = String(out.scriptPubkey ?? "").toLowerCase().replace(/^0x/, "");
        return /^[0-9a-f]{40}$/.test(a) ? "0x" + a : null;
      } catch { return null; }
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Serialize async operations so they never OVERLAP, while each caller still awaits its own operation and sees
// its own result/error. A prior rejection is swallowed for chaining ONLY (the rejecting caller still gets its
// error); it never wedges the chain. BP4/N11: the wallet shares ONE light client across name-verify AND the
// fill lanes, so two consumers can call prepare() -> LC.sync() concurrently; LightClient.ingest asserts strict
// height order and THROWS "out-of-order ingest" on an interleave -> a spurious fail-closed decline on a
// legitimate action. Serializing the SYNC (not the whole consumer) removes the interleave while keeping the
// block reads (blockAt, which never syncs) fully parallel. EXPORTED for a direct unit test.
export function makeSerializer(): <T>(op: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op, op);   // run AFTER the prior settles, regardless of its outcome
    tail = run.catch(() => {});      // the chain never rejects, so a failed op cannot block later ops
    return run;                      // the caller sees THIS op's own result/error
  };
}

// BP8b (N10 wallet-half / N14): partial-progress snapshot persistence for LONG header syncs. namespv
// used to persist its snapshot only after a FULLY successful LC.sync, so a rate-limited (429'd) cold
// bootstrap persisted nothing and every retry restarted from the baked checkpoint: the exact N10
// "hard wall, not a slow retry" shape (and the same defect B0b fixed in the test cache). This helper
// syncs toward `want` in bounded windows, persisting the verified chain after each fully synced
// window, so the next attempt (even in a fresh MV3 service worker killed mid-backoff) restores the
// partial chain and bills only the REMAINING span. The final leg (the last partial window up to
// `want`) stays at the call site, whose catch persists a mid-window tail before failing closed.
// Trust posture (ZERO verification change): every persisted header was already PoW/LWMA-verified by
// LC.sync's ingest, and a restored snapshot is re-verified by LightClient.fromSnapshot exactly as
// before; only the persistence TIMING changes, never what a restore trusts (storage-poisoning
// defense intact). This function never touches the lapse floor: floorAdvance runs in prepare() only
// after a fully successful sync, and a throw here propagates past it (see the invariant comment
// there). Persist failures are swallowed: fail-soft, the worst case is the pre-BP8b behavior (a
// re-sync from the last good snapshot), never a refusal.
// Window sizing: a fresh-install cold span (~28k headers today) checkpoints a handful of times
// (each persist rewrites the multi-MB snapshot, so per-batch persistence would be pure overhead),
// while an incremental daily sync (~720 headers) never enters the loop: the warm hot path pays
// ZERO extra writes. EXPORTED (with a structural lc type) for a direct behavioral unit test; the
// vendored LightClient satisfies the type, and its sync() ingests header-by-header, so on a throw
// the already-verified prefix is retained in memory (vendor bundle LightClient.sync/ingest).
export const SYNC_PERSIST_WINDOW = 8192;
export async function syncWithPartialPersist(
  lc: { baseHeight: number; chain: { length: number }; sync(to: number): Promise<unknown>; toSnapshot(): unknown },
  want: number,
  persist: ((snapshot: unknown) => Promise<void>) | null,
): Promise<void> {
  for (let next = lc.baseHeight + lc.chain.length - 1 + SYNC_PERSIST_WINDOW; next < want; next += SYNC_PERSIST_WINDOW) {
    await lc.sync(next);              // throws on any verify/transport failure (fail-closed, caller classifies)
    if (persist) { try { await persist(lc.toSnapshot()); } catch { /* fail-soft: keep syncing */ } }
  }
}
