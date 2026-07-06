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
  prepare(maxEventHeight: number): Promise<{ verifiedTip: number; nodeTip: number }>;
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
// replay is a lying read). Field shapes match the scanner exactly so resolve() produces identical state.
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
type Replay = { ok: true; owner: string; addr: string; via: "nset" | "owner"; depth: number; viaFill: boolean } | { ok: false; reason: string };
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
  const { verifiedTip, nodeTip } = await src.prepare(maxHeight);
  if (maxHeight > verifiedTip) return { ok: false, reason: `a record at height ${maxHeight} is above the verified tip (${verifiedTip})` };
  const lapseTip = Math.max(verifiedTip, Number.isFinite(nodeTip) ? nodeTip : 0);

  const events: Record<string, unknown>[] = [];
  for (const [height, hs] of byHeight) {
    const { merkle, txs } = await src.blockAt(height);            // THROWS if the header can't be PoW-verified
    // A plain/coinbase tx may carry no `app`; default it to {None} BEFORE decode so a hostile node can't omit
    // `app` on one filler tx to make rpcTxToTx throw and DoS the whole verify. A None tx still has a real txid.
    const rebuilt = txs.map((t) => rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } }));
    const ids = rebuilt.map(ctxid);
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
      if (!spk || spk.toLowerCase() !== signer) return { ok: false, reason: `record ${hint.txid} signer does not own the coin it spends (rejected possible scriptSig substitution)` };
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
  if (rec.expired) return { ok: false, reason: `${name}.csd lease has lapsed (per the chain) — refusing to send` };
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
    if (!r.ok) return fail(r.reason);
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
    if (!rep.ok) return { ...fail(rep.reason), sources: usable.length, agreed: 0, disagree: false };
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

/** Build the live SPV source. The LightClient seeds at the baked checkpoint and verifies forward to tip. */
export async function liveSpvSource(opts: LiveSpvOpts): Promise<SpvSource> {
  const boundFetch = (...a: Parameters<typeof fetch>) => fetch(...a);
  const client = new CsdClient({ baseUrl: opts.rpcBase.replace(/\/$/, ""), fetch: boundFetch });
  const headersBase = opts.headersBase.replace(/\/$/, "");
  // The /api/headers endpoint is budget-limited (DOS-HDR-1). A legit cold sync paces itself: on a 429 we
  // back off and retry a few times rather than fail the whole verify — an attacker is still bounded.
  const headersBatch = async (from: number, count: number) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${headersBase}/api/headers/${from}/${count}`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 429 && attempt < 6) { await sleep(1200 * (attempt + 1)); continue; }
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
  const LC = lc;
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

  return {
    async prepare(maxEventHeight: number) {
      let nodeTip = 0;
      try { nodeTip = Number((await client.tip())?.height); } catch { /* node tip unknown → lapse uses the floor / verified tip */ }
      if (Number.isFinite(nodeTip) && nodeTip > seenFloor) { seenFloor = nodeTip; if (opts.floor) { try { await opts.floor.set(seenFloor); } catch { /* persist best-effort */ } } } // monotonic — never regress; persist the high-water across SW restarts
      // Inclusion only needs headers up to the record + cushion (kept cheap; an old, sparse name does not
      // pay a full chain sync). LC.sync re-derives PoW+LWMA per header, so a lying-high cushion fails closed.
      const want = Math.min(Number.isFinite(nodeTip) && nodeTip > 0 ? nodeTip : maxEventHeight + CONF_BUFFER, maxEventHeight + CONF_BUFFER);
      const cur = LC.baseHeight + LC.chain.length - 1;
      if (want > cur) {
        await LC.sync(want);                           // a lying-high header THROWS here (fail-closed)
        if (opts.cache) { try { await opts.cache.set(LC.toSnapshot()); } catch { /* cache best-effort */ } }
      }
      // Report the floored tip so verifyName's lapse epoch (max(verifiedTip, nodeTip)) can only move FORWARD.
      return { verifiedTip: LC.baseHeight + LC.chain.length - 1, nodeTip: Math.max(seenFloor, Number.isFinite(nodeTip) ? nodeTip : 0) };
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
