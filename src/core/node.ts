// Talks to a CSD node (reads + non-custodial submit) and the Cairn API (sign-in). Browser fetch.
// The build is FULLY LOCAL and never trusts a server-supplied hash: coin-select from CHAIN-VERIFIED
// utxos, assemble the whole tx and compute OUR OWN codec sighash locally, sign it, then POST /tx/submit.
// We never sign a signing_hash the node handed us, so a malicious/MITM'd RPC cannot steer a signature
// onto a different transaction. The private key only ever lives in the wallet; nothing here sends it away.
import { signSighash, buildScriptSig, addrFromPriv, sighash as codecSighash, txid as codecTxid, loginDigest, bytesArr, type App, type Tx } from "./csdtx.js";

// Bounded waits (2026-07-09): a node that ACCEPTS the connection but never answers used to hang
// these fetches forever — the popup's "sending…" spinner never settled and there was no in-popup
// recovery. A timeout converts the stall into the existing fail-closed error paths (get() throws →
// caller catch; post() returns the maybeInflight-flagged failure below). Reads are short; submit is
// generous (the node can be busy validating a 512-input tx).
// 12s, not 8s: the cairn proxy's failover chain worst-cases at 4s (routed backend) + 6s (fallback)
// = 10s of legitimate inner wait — an 8s outer abort raced that chain and turned a survivable
// one-backend outage into spurious VERIFY_UNAVAILABLE on every read (timeout-inversion class,
// docs/Plans/66 B1). The outer timeout must sit ABOVE the inner worst case.
const GET_TIMEOUT_MS = 12_000;
const POST_TIMEOUT_MS = 20_000;
async function get(rpc: string, path: string): Promise<any> {
  const r = await fetch(`${rpc}${path}`, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`); return r.json();
}
// Symmetric with get(): a POST must NEVER throw out of the caller after a tx is already signed —
// otherwise a non-JSON 4xx/5xx (e.g. an HTML error page from a proxy) on /tx/submit would surface as an
// uncaught rejection AFTER signing, leaving send/sendMany/fillOffer/propose with an ambiguous outcome
// (audit VAL-2). Read the body as text, parse if we can, and return a structured {ok:false,err} on any
// non-2xx / network error / unparseable body. Every caller already reads {ok,txid,err}, so a 2xx JSON
// body is returned unchanged — this only converts the failure path from "throw" to "fail-closed value".
async function post(rpc: string, path: string, body: unknown): Promise<any> {
  let r: Response;
  try { r = await fetch(`${rpc}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(POST_TIMEOUT_MS) }); }
  // `maybeInflight` classifies the AMBIGUITY of a failure, not its severity: a thrown fetch
  // (network error / timeout) means the request may or may not have reached the server — a
  // /tx/submit could already be in the mempool. signAndSubmit maps this flag to SUBMIT_MAYBE_INFLIGHT
  // vs SUBMIT_REJECTED so the popup only shows the scary "may already be in flight" copy when it is
  // actually true (the old copy claimed it for EVERY failure).
  catch { return { ok: false, err: `${path} -> network error`, maybeInflight: true }; }
  // Symmetric with get(): never let a non-JSON 4xx/5xx (e.g. an HTML proxy error page) throw out of a
  // caller AFTER a tx is already signed — parse defensively and return a structured {ok:false,err} on any
  // non-2xx or unparseable body (audit VAL-2). A 2xx JSON body is returned unchanged; every caller reads
  // {ok,txid,err}, so this only converts the failure path from "throw" to a fail-closed value.
  let j: any;
  try { j = await r.json(); } catch { j = undefined; }
  if (!r.ok) {
    // A non-2xx is NOT automatically "definitively rejected". A 4xx IS definitive: a node rejection
    // (feerate/duplicate/etc.), a pre-forward proxy 400/413 body cap, or a 429 rate limit — the tx never
    // reached the mempool, so "nothing was sent" is truthful. But a 5xx / gateway failure is AMBIGUOUS:
    // the cairn proxy gives the node only ~4s (fallback ~6s) and returns a 502 "node unreachable" if both
    // time out, yet a busy node can INGEST the POST and then be too slow to answer within that window, so
    // the tx MAY be in the mempool. An unparseable error body (a Cloudflare/nginx HTML 5xx page) is the
    // same class. Flag those maybeInflight so the popup shows the cautious "may already be in flight, check
    // before resending" copy instead of a false "nothing was sent" that could drive a double-pay on resend
    // (a resend re-reads /utxos, and if the ingested tx's inputs are now excluded it signs a DIFFERENT tx).
    // Fable-5 money-path audit, 2026-07-09 (this was a 0.2.55 regression: 0.2.54 cautioned on every failure).
    const ambiguous = r.status >= 500 || j === undefined;
    return { ok: false, err: (j && (j.err ?? j.error)) || `${path} -> ${r.status}`, ...(ambiguous ? { maybeInflight: true } : {}) };
  }
  // a 2xx we couldn't parse: the server DID process the request — a submit may have been ingested
  // even though we can't read the answer, so this is ambiguous too.
  if (j === undefined) return { ok: false, err: `${path} -> non-JSON response`, maybeInflight: true };
  // W6 (B5c): `maybeInflight` is THIS function's transport-ambiguity classification, set only on the
  // branches above. Never accept it off a parsed 2xx body — a hostile proxy answering HTTP 200 with
  // {ok:false, maybeInflight:true} could otherwise steer the caller's SUBMIT_MAYBE_INFLIGHT copy and
  // history dedupe. Body fields stay body fields; the flag stays ours.
  if (j && typeof j === "object" && "maybeInflight" in j) delete j.maybeInflight;
  return j;
}

export async function tip(rpc: string): Promise<number> { return Number((await get(rpc, "/tip")).height ?? 0); }
export async function getProposal(rpc: string, txid: string): Promise<any | null> {
  try { const j = await get(rpc, `/proposal/${txid}`); return j?.proposal ?? (j?.payload_hash ? j : null); } catch { return null; }
}
export async function balance(rpc: string, addr: string): Promise<{ confirmed: number; utxos: any[] }> {
  const j = await get(rpc, `/utxos/${addr}?available=true`);
  return { confirmed: Number(j.confirmed_balance ?? 0), utxos: j.utxos ?? [] };
}

function appToJson(app: App): unknown {
  if (app.type === "None") return "None";
  if (app.type === "Propose") return { Propose: { domain: app.domain, payload_hash: bytesArr(app.payloadHash), uri: app.uri, expires_epoch: Number(app.expiresEpoch) } };
  return { Attest: { proposal_id: bytesArr(app.proposalId), score: app.score, confidence: app.confidence } };
}
function txToNodeJson(tx: Tx): any {
  return {
    version: tx.version, locktime: tx.locktime, app: appToJson(tx.app),
    inputs: tx.inputs.map((i) => ({ prevout: { txid: bytesArr(i.prevTxid), vout: i.vout }, script_sig: bytesArr(i.scriptSig) })),
    outputs: tx.outputs.map((o) => ({ value: Number(o.value), script_pubkey: bytesArr(o.scriptPubkey) })),
  };
}

// Map a node-JSON tx body (from /tx or /block) back into our codec Tx so we can recompute its txid.
function nodeTxToTx(j: any): Tx {
  const a = j.app || {};
  const app: App = a.type === "Propose"
    ? { type: "Propose", domain: a.domain, payloadHash: a.payload_hash, uri: a.uri, expiresEpoch: a.expires_epoch }
    : a.type === "Attest"
      ? { type: "Attest", proposalId: a.proposal_id, score: a.score, confidence: a.confidence }
      : { type: "None" };
  return {
    version: j.version, locktime: j.locktime, app,
    inputs: (j.inputs || []).map((i: any) => ({ prevTxid: i.prev_txid, vout: i.vout, scriptSig: i.script_sig })),
    outputs: (j.outputs || []).map((o: any) => ({ value: o.value, scriptPubkey: o.script_pubkey })),
  };
}

// Confirm the REAL on-chain value of each selected input by fetching its source tx and
// RECOMPUTING its txid with our consensus-exact codec. A CSD fee is implicit (Σin − Σout,
// uncapped by consensus), so if the wallet trusted a hostile /utxos `value` it could compute
// too-small a change and silently burn the difference as fee (audit TXB-1). The source tx's
// txid commits to its output values, so a hostile RPC cannot serve a fake body whose recomputed
// txid still matches the prevout — any tamper is detected and the send is refused (fail-closed).
//
// Per-input verdicts are CLASSIFIED (Plan 65, ghost-coin incident): a node can hold UTXO-index
// entries whose source tx is in NO block of its own chain (a failed reorg-undo leaves them behind).
// Under the old any-null-kills-all fold, ONE such coin bricked every spend from the wallet forever.
// The classes and their handling (in selectVerified):
//   number       verified value — the only thing that can ever be spent
//   "notfound"   the node answered authoritatively that it has no such tx (404, or its canonical
//                2xx {ok:false,err:"not found"} miss with no tx body) → a ghost coin; the CALLER may
//                re-select around it. The coin itself is NEVER spent.
//   "transient"  network error / non-2xx-non-404 / unparseable body → the node is unhealthy, refuse
//                retryably and exclude NOTHING (a blip must not change which coins get spent).
//   "tamper"     a body was served but fails decode / txid recompute / output sanity → possible
//                hostile RPC; the whole spend is refused with no retry, exactly as before.
// Caveat: a node answering 2xx {ok:false,err:"db busy"} with no tx body is indistinguishable from a
// miss and classifies "notfound"; the failure mode is an honest "couldn't cover after skipping" error
// (bounded by the caller's short ghost-cache TTL), never an unverified spend.
// Bounded-concurrency map preserving input order. A tiny shared-index worker pool: N workers each
// pull the next unclaimed index until the list is exhausted. fn's rejections propagate (verifyOne
// never rejects — every failure is a verdict value — so verifyInputValues' semantics are unchanged
// from the Promise.all it replaces, minus the unbounded burst).
// `decisive` (optional) short-circuits: once ANY completed result satisfies it, workers stop pulling
// NEW items (in-flight ones finish, leaving later slots undefined). Used so a single tamper/transient
// verdict doesn't force a black-holing node to grind through all 512 inputs 8-at-a-time (≈8.5 min of
// timeouts) before refusing — the caller only needs to KNOW one exists (both are fail-closed refusals
// that no later verdict can override into a success), so the undefined tail is never folded.
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>, decisive?: (r: R) => boolean): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0, stop = false;
  const worker = async () => {
    for (;;) {
      if (stop) return;
      const k = next++;
      if (k >= items.length) return;
      const r = await fn(items[k]!);
      out[k] = r;
      if (decisive && decisive(r)) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
const VERIFY_CONCURRENCY = 8;
type InputVerdict = number | "notfound" | "transient" | "tamper";
type VerifyResult =
  | { ok: true; total: number }
  | { ok: false; kind: "tamper" }
  | { ok: false; kind: "transient" }
  | { ok: false; kind: "notfound"; ghosts: { txid: string; vout: number }[] };
const opKey = (txid: unknown, vout: unknown) => `${String(txid).toLowerCase()}:${Number(vout)}`;
async function verifyInputValues(
  rpc: string,
  inputs: { txid: string; vout: number }[],
  // per-CALL cache: a coin verified in an earlier selection round is never refetched in a later one.
  // Deliberately not cross-call (a txid does commit to its outputs immutably, but re-verifying every
  // spend keeps the "always verify before signing" property trivially auditable).
  verified: Map<string, number> = new Map(),
): Promise<VerifyResult> {
  // Each input is verified INDEPENDENTLY, so the per-input `/tx` fetches overlap — an N-input send
  // is a few round-trips' latency, not N sequential ones. Concurrency is EXPLICITLY bounded by the
  // mapLimit pool below (2026-07-09): the old unbounded Promise.all leaned on the browser's per-host
  // connection cap, which fetch() queueing makes unreliable as a limiter and which hammers the shared
  // /api/rpc proxy with a 100+-request burst on a large send. 8 workers keeps a 512-input verify at
  // ~64 short rounds (~10s) without storming the proxy. The input set is capped at MAX_TX_INPUTS.
  const verifyOne = async (i: { txid: string; vout: number }): Promise<InputVerdict> => {
    const hit = verified.get(opKey(i.txid, i.vout));
    if (hit !== undefined) return hit;
    let body: any;
    try {
      const r = await fetch(`${rpc}/tx/${i.txid}`, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
      if (r.status === 404) return "notfound";
      if (!r.ok) return "transient";
      let j: any; try { j = await r.json(); } catch { return "transient"; }
      body = j?.tx;
    } catch { return "transient"; }
    if (!body) return "notfound"; // the node's canonical 2xx miss: {ok:false,err:"not found"}, no tx
    let tx: Tx, recomputed: string;
    // robustness nit (audit D): codecTxid itself can throw on a malformed body, so decode AND
    // recompute inside one try — any failure is a fail-closed reject, never an uncaught throw.
    try { tx = nodeTxToTx(body); recomputed = codecTxid(tx); } catch { return "tamper"; }
    if (recomputed.toLowerCase() !== String(i.txid).toLowerCase()) return "tamper"; // forged source body
    const out = tx.outputs[i.vout];
    if (!out) return "tamper";
    const v = Number(out.value);
    if (!Number.isFinite(v) || v <= 0 || !Number.isSafeInteger(v)) return "tamper";
    verified.set(opKey(i.txid, i.vout), v);
    return v;
  };
  // Short-circuit on the two DECISIVE refusal verdicts: tamper and transient both refuse the whole
  // spend and neither can be overridden by a later verdict into a success, so once one appears there
  // is no reason to keep verifying (a black-holing node otherwise makes a 512-input send time out
  // 8-at-a-time for minutes). notfound must NOT short-circuit — every ghost has to be collected to
  // exclude it. When we stop early, later slots are undefined, but the tamper/transient checks below
  // fire before the fold, so the undefined tail is never summed.
  const verdicts = await mapLimit(inputs, VERIFY_CONCURRENCY, verifyOne, (v) => v === "tamper" || v === "transient");
  // Severity order: any tamper refuses the whole spend immediately (never route around a forging RPC);
  // any transient refuses retryably without excluding anything; only pure not-founds are skippable.
  if (verdicts.includes("tamper")) return { ok: false, kind: "tamper" };
  if (verdicts.includes("transient")) return { ok: false, kind: "transient" };
  const ghosts = inputs.filter((_, k) => verdicts[k] === "notfound");
  if (ghosts.length) return { ok: false, kind: "notfound", ghosts };
  // Fold the verified values in input order; the running sum must stay in the safe-integer range so a
  // hostile RPC can't push it past 2^53 (addition is commutative, the parallel fetch changes nothing).
  let total = 0;
  for (const v of verdicts as number[]) {
    total += v;
    if (!Number.isSafeInteger(total)) return { ok: false, kind: "tamper" };
  }
  return { ok: true, total };
}

// Coin selection (REPORTED values, to pick which outpoints) THEN chain-verified totals (REAL
// values, to compute change). Returns the verified input set + real total, or an error string.
//
// Fail-closed PER COIN, not per wallet: when the verify round reports ghosts (see verifyInputValues),
// re-select EXCLUDING those outpoints and try again — bounded rounds, and no coin is ever spent
// unverified. A hostile RPC gains nothing it didn't have (it already controls the /utxos enumeration
// entirely); tamper still kills the whole spend with no retry. Session ghost cache: outpoints that
// answered not-found are pre-excluded for a short TTL so an immediate user retry doesn't burn a round;
// module state dies with the MV3 service worker (~30s idle), which is desirable — after a node repair
// or endpoint switch the coins are re-checked from scratch.
const MAX_SELECT_ROUNDS = 3;      // bounds /tx traffic: at most 3 selections per spend attempt
const GHOST_TTL_MS = 120_000;
const ghostSeen = new Map<string, number>(); // outpoint -> expiry
const fmtCsd = (v: number) => (v / 1e8).toLocaleString("en-US", { maximumFractionDigits: 8 });
async function selectVerified(rpc: string, addr: string, need: number): Promise<{ inputs: SelectedInput[]; total: number } | { error: string; code: string }> {
  // The utxo read itself can fail (node down / timeout). Catch it HERE so the failure surfaces as
  // the retryable structured VERIFY_UNAVAILABLE every caller already handles, instead of throwing
  // out of assembleValueTx and landing in the popup's ambiguous "may be in flight" catch branch —
  // nothing has been signed at this point, so the outcome is definitively clean.
  let utxos: any[];
  try { ({ utxos } = await balance(rpc, addr)); }
  catch { return { error: "couldn't fetch your coins (node unreachable or erroring); nothing was signed, try again in a moment", code: "VERIFY_UNAVAILABLE" }; }
  const now = Date.now();
  for (const [k, exp] of ghostSeen) if (exp <= now) ghostSeen.delete(k);
  const exclude = new Set<string>(ghostSeen.keys());
  const verified = new Map<string, number>();
  const reportedVal = new Map<string, number>(utxos.map((u: any) => [opKey(u.txid, u.vout), Number(u.value) || 0]));
  // ghosts already known from the session cache that are present in THIS utxo set count toward the
  // honest error (they are why the reported balance overstates what is spendable)
  let ghostCount = 0, ghostValue = 0;
  for (const k of exclude) if (reportedVal.has(k)) { ghostCount++; ghostValue += reportedVal.get(k)!; }
  let selExhausted = false;                 // loop left because selection failed (vs ghost-round budget spent)
  for (let round = 0; round < MAX_SELECT_ROUNDS; round++) {
    const sel = selectInputs(utxos, need, exclude);
    if (!sel) { selExhausted = true; break; } // remaining verifiable coins can't cover `need` — or can't within the input cap (diagnosed below)
    const ver = await verifyInputValues(rpc, sel.inputs, verified);
    if (ver.ok) {
      if (ver.total < need || !Number.isSafeInteger(ver.total) || !Number.isSafeInteger(ver.total - need)) return { error: "insufficient confirmed balance", code: "INSUFFICIENT" };
      return { inputs: sel.inputs, total: ver.total };
    }
    if (ver.kind === "tamper")
      return { error: "could not verify selected inputs against the chain (refusing to risk a burned fee)", code: "VERIFY_TAMPER" };
    if (ver.kind === "transient")
      return { error: "couldn't fetch source transactions to verify input values (node unreachable or erroring); nothing was signed, try again in a moment", code: "VERIFY_UNAVAILABLE" };
    for (const g of ver.ghosts) {           // ghosts: exclude and re-select; an unverified coin is NEVER spent
      const k = opKey(g.txid, g.vout);
      if (!exclude.has(k)) { ghostCount++; ghostValue += reportedVal.get(k) ?? 0; }
      exclude.add(k); ghostSeen.set(k, now + GHOST_TTL_MS);
    }
    if (ghostSeen.size > 2048) ghostSeen.clear(); // hard cap: a hostile RPC can't grow this unboundedly
  }
  // TOO_MANY_INPUTS vs INSUFFICIENT (2026-07-09): selectInputs returns null BOTH when the balance
  // genuinely can't cover `need` AND when it could but not within the MAX_TX_INPUTS cap — a
  // pure-50-CSD-coinbase holder tops out at 512×50 = 25,600 CSD per tx, and telling them
  // "insufficient confirmed balance" is false and alarming. Diagnose which it was: if the full
  // spendable set (same predicate, ghosts excluded) covers `need`, the cap was the blocker.
  if (selExhausted) {
    let spendable = 0;
    for (const c of spendableCoins(utxos, exclude)) {
      spendable += c.value;
      if (!Number.isSafeInteger(spendable)) { spendable = 0; break; } // beyond-supply garbage: fall through to INSUFFICIENT
    }
    if (spendable >= need)
      return { error: `this spend needs more coins than the ${MAX_TX_INPUTS}-input per-transaction limit allows — send a smaller amount, or consolidate your coins first (settings ▸ coins)`, code: "TOO_MANY_INPUTS" };
  }
  if (!ghostCount) return { error: "insufficient confirmed balance", code: "INSUFFICIENT" };
  console.warn(`cairn-wallet: skipped ${ghostCount} coin(s) the node could not prove (source tx not found); reported balance may be overstated by ~${fmtCsd(ghostValue)} CSD`);
  // Non-retryable: the skipped coins stay excluded until the node can PROVE them, so an immediate retry
  // changes nothing (distinct from the retryable VERIFY_UNAVAILABLE transient class above).
  return { error: `${ghostCount} coin(s) totalling ${fmtCsd(ghostValue)} CSD could not be verified on the chain and were skipped; the remaining verifiable coins couldn't cover this ${fmtCsd(need)} CSD spend (amount plus fee)`, code: "GHOST_INPUTS_SKIPPED" };
}

// `code` (WS5, additive since 0.2.54): a stable UPPER_SNAKE machine tag on every {ok:false} so dApp
// consumers switch on the code instead of the human `error` string (which is UX copy and may change).
// `sighashMatch` is DEPRECATED and vestigial — it is constant-equal to `ok` (true only when WE computed
// and matched the sighash, which is the entire local-build flow) and no reader was found — but it is KEPT
// on every result (incl. preflight errors) because dropping it is a dApp-visible shape change for zero gain.
// spentTxids: the source txids of the inputs this spend consumed (successful submits only) —
// lets the wallet latch a pending-merge history entry the moment its output is SPENT (a spend
// proves the merge confirmed even if no balance refresh ever saw the output; Plans/66 review
// finding: the final combining pass spends earlier rounds' outputs directly, which otherwise
// left their entries deriving a false "merging" line for up to an hour). Additive, internal.
export interface SubmitResult { ok: boolean; txid?: string; error?: string; sighashMatch: boolean; code?: string; spentTxids?: string[] }

interface SelectedInput { txid: string; vout: number; value: number }
interface Selection { inputs: SelectedInput[]; total: number }

// Greedy multi-input coin selection covering `need` (= amount + fee). Largest-first
// so we reach the target with the fewest inputs; prefers spending mature non-coinbase
// coins, only dipping into coinbase outputs if the spendable set can't cover `need`.
// Returns null if even the whole confirmed balance is short. The CSD sighash blanks
// ALL inputs (see csdtx.ts `stripped`), so one signature covers every input — and
// since all of a wallet's inputs are from one address/key, we sign once and apply the
// same scriptSig to each. `total` is summed in the safe-integer range (guarded below).
const MAX_TX_INPUTS = 512; // consensus cap (params/mod.rs) — refuse locally with a clear error
// Defense-in-depth absolute fee cap (NETNEW-NO-MAX-FEE-CAP-1). A legitimate CSD miner fee is well under 1 CSD;
// the clear-sign window already WARNs above 5 CSD. Hard-refuse an absurd caller/dApp-supplied fee at the single
// chokepoint every value tx routes through, so a compromised UI can't steer a user PAST the visible warning
// into burning a huge fee. 100 CSD is ~100× any real fee — no legitimate flow approaches it.
const MAX_FEE = 100 * 1e8; // base units (100 CSD)
// ★ KEEP-IN-SYNC: DELIBERATE supply-chain-isolated fork of csd-tx selectInputs
// (csd-sdk/packages/tx/src/index.ts — which upstreamed this fork's `exclude` param as 0.1.16 on
// 2026-07-06, so the two bodies are line-for-line equivalent again). The fork exists so the wallet's
// coin selection never depends on npm-installed code (MV3 posture); it must NOT be "deduped" into an
// import. Any semantic change lands in BOTH files; test/selectinputs-parity.ts pins them to identical
// selections over shared fixtures.
export function selectInputs(utxos: any[], need: number, exclude?: ReadonlySet<string>): Selection | null {
  // Default a missing `confirmations` to 0 (UNCONFIRMED), never 1 — a hostile/buggy RPC
  // must not be able to make an immature/absent coin look spendable by omitting the field.
  // Dedupe by outpoint (txid:vout) and drop non-positive values so a malicious RPC can't
  // inflate the input count with duplicates/dust or feed a negative value into selection.
  const seen = new Set<string>();
  const confirmed = utxos.filter((x: any) => {
    // Number.isFinite so confirmations:"abc"→NaN / "1e9999"→Infinity (NaN<1 and Infinity<1 are both
    // false) can't slip an unconfirmed/immature coin past the maturity gate — lockstep with csd-tx (audit L4).
    const c = Number(x.confirmations ?? 0);
    if (!Number.isFinite(c) || c < 1) return false;
    const v = Number(x.value);
    if (!Number.isFinite(v) || v <= 0 || !Number.isSafeInteger(v)) return false;
    const key = `${String(x.txid).toLowerCase()}:${Number(x.vout)}`; // case-normalize hex so a hostile RPC can't bypass dedupe with mixed case
    if (exclude?.has(key)) return false;    // outpoints a prior verify round proved unfetchable (ghosts)
    if (seen.has(key)) return false; seen.add(key);
    return true;
  });
  const byValDesc = (a: any, b: any) => Number(b.value) - Number(a.value);
  const take = (pool: any[]): Selection | null => {
    const inputs: SelectedInput[] = [];
    let total = 0;
    for (const x of [...pool].sort(byValDesc)) {
      const v = Number(x.value);
      total += v;
      // Refuse magnitudes that lose precision (a hostile RPC can't push the running
      // sum past 2^53 and slip a mis-signed value through) — bail before it matters.
      if (!Number.isSafeInteger(total)) return null;
      inputs.push({ txid: x.txid, vout: Number(x.vout), value: v });
      // Refuse a tx that would exceed the consensus input cap (e.g. a dust-flood RPC)
      // rather than building one the node will reject — surfaces as "insufficient" upstream.
      if (inputs.length > MAX_TX_INPUTS) return null;
      if (total >= need) return { inputs, total };
    }
    return null;
  };
  // try non-coinbase only first; fall back to the full confirmed set if needed
  return take(confirmed.filter((x: any) => !x.coinbase)) ?? take(confirmed);
}

// The spendability predicate, standalone: MIRRORS selectInputs' filter exactly (≥1 confirmation
// with hostile-value coercion guards, positive safe-integer value, outpoint-deduped, ghost-
// excluded) — ★KEEP-IN-SYNC with the filter inside selectInputs above; it exists so selectVerified
// can DIAGNOSE a null selection (input-cap vs genuine shortfall) and consolidate() can pick
// smallest-first, WITHOUT changing selectInputs' csd-tx-mirrored body (see the KEEP-IN-SYNC note
// there — its signature/body must stay line-for-line equivalent to csd-tx's fork).
// (exported for test/selectinputs-parity.ts, which pins the KEEP-IN-SYNC contract below — same
// precedent as selectInputs itself; nothing outside tests imports it.)
export function spendableCoins(utxos: any[], exclude?: ReadonlySet<string>): SelectedInput[] {
  const seen = new Set<string>();
  const out: SelectedInput[] = [];
  for (const x of utxos ?? []) {
    const c = Number(x?.confirmations ?? 0);
    if (!Number.isFinite(c) || c < 1) continue;
    const v = Number(x?.value);
    if (!Number.isFinite(v) || v <= 0 || !Number.isSafeInteger(v)) continue;
    const key = opKey(x.txid, x.vout);
    if (exclude?.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ txid: x.txid, vout: Number(x.vout), value: v });
  }
  return out;
}

// Build the FULL tx locally (we set the app ourselves), sign OUR OWN codec sighash,
// and submit. We never sign a hash a server handed us — so a malicious or MITM'd RPC
// cannot trick the wallet into signing a different transaction; the node re-derives
// the same sighash and would reject any tampering anyway.
// Sign every input with the one whole-tx sighash and submit. All inputs are blanked
// in the sighash and all belong to this account's single key, so one signature is
// reused across them. Returns sighashMatch:true because WE computed the sighash.
async function signAndSubmit(rpc: string, tx: Tx, priv: string): Promise<SubmitResult> {
  const { sig64, pub33 } = signSighash(codecSighash(tx), priv);
  const scriptSig = buildScriptSig(sig64, pub33);
  for (const i of tx.inputs) i.scriptSig = scriptSig;
  // The consensus txid is known LOCALLY before submit (txid = sha256d over the scriptSig-stripped
  // tx). On an ambiguous outcome the server's answer was lost, so this local txid is the only
  // handle the caller has to later check whether the tx landed (the popup's pending-merge line
  // depends on it; Plans/66 B4).
  const localTxid = codecTxid(tx);
  const sub = await post(rpc, "/tx/submit", { tx: txToNodeJson(tx) });
  // Two distinct failure codes (2026-07-09): SUBMIT_REJECTED = a DEFINITIVE 4xx rejection (node said no,
  // or a pre-forward proxy 400/413/429), so the tx is not in the mempool (safe to say "nothing was sent");
  // SUBMIT_MAYBE_INFLIGHT = the request threw / timed out / hit a 5xx gateway failure / had an unreadable
  // body AFTER signing, so the tx MAY have been ingested — the only case where the popup's "may already be
  // in flight" caution is truthful. post() sets maybeInflight on exactly those ambiguous branches (a 5xx is
  // ambiguous because the cairn proxy 502s the node after only 4s, which can outrace a slow-but-successful
  // mempool ingest).
  // "already present or mempool conflict" is NOT a plain rejection: the node's answer string
  // conflates "this exact tx is already in the mempool" (a resubmit after an ambiguous failure —
  // deterministic signing makes the retry byte-identical, so this is the COMMON resubmit outcome)
  // with "a different tx spends these coins". Either way "nothing was sent" would be FALSE — a tx
  // spending these coins IS pending. Own code (additive, per the error-contract rule) + hedged
  // copy that is true in both cases; txid = the local txid (in the duplicate case that is exactly
  // the pending tx).
  const dup = !sub.ok && !sub.maybeInflight && /already present/i.test(String(sub.err ?? ""));
  // W6 (B5c): signing is deterministic and the txid does not even depend on the signature (sha256d over
  // the scriptSig-stripped serialization), so localTxid is not a fallback — it IS the answer, and the
  // server echo carries no information the wallet does not already hold with certainty. Preferring the
  // echo let a hostile/buggy proxy answering a constant txid dedupe every later send out of history,
  // file sealed-claim reveal preimages under the wrong key, poison flushPending/pendingMerge, and point
  // the explorer link (the user's one independent check) at an attacker-chosen transaction. The echo is
  // kept only as a FREE CROSS-CHECK on the deliberately forked codec: a mismatch logs loudly, is never
  // trusted.
  if (sub.txid && String(sub.txid).toLowerCase() !== localTxid.toLowerCase())
    console.warn(`[node] submit echoed txid ${sub.txid} != locally computed ${localTxid} — using local (codec cross-check)`);
  return {
    ok: !!sub.ok,
    // LOCAL txid whenever a tx may exist on the network (ok / ambiguous / duplicate). Definitive
    // rejections keep txid undefined: providing one would read as "it went through".
    txid: sub.ok || sub.maybeInflight || dup ? localTxid : undefined,
    error: dup
      ? "this transaction, or one spending the same coins, is already pending; it should settle within a block or two"
      : (sub.err ?? (sub.ok ? undefined : "submit rejected")),
    sighashMatch: true,
    code: sub.ok ? undefined : (dup ? "SUBMIT_DUPLICATE" : (sub.maybeInflight ? "SUBMIT_MAYBE_INFLIGHT" : "SUBMIT_REJECTED")),
  };
}

// Shared assembly tail for every value-moving tx (send / sendMany / fillOffer / buildSignSubmit).
// The CALLER validates its own payment outputs + fee (caps, address shape, safe-integer sums); this
// selects inputs from CHAIN-VERIFIED utxos, returns change ONLY to the wallet's own address (never a
// caller-chosen one), refuses an empty output set, then signs + submits. Single-sourcing it keeps
// that security posture — "inputs internal, change to self" — in ONE audited place. `outputs` are the
// payment outputs BEFORE change; `emptyError` is the message if nothing (incl. change) would be paid.
async function assembleValueTx(
  rpc: string,
  outputs: { value: number; scriptPubkey: string }[],
  fee: number,
  app: App,
  priv: string,
  emptyError = "tx would have no outputs",
): Promise<SubmitResult> {
  // Reject a zero (or negative) fee at the SINGLE place every value tx is assembled — send, sendMany,
  // propose, attest and fillOffer all route through here. The node enforces a minimum feerate, so a
  // zero-fee tx is built and signed but then silently dropped by the mempool; surface it as a clear
  // error up front instead (audit FEE-FLOOR). Non-negative integer / safe-integer checks stay with the
  // callers that own the fee value.
  if (!(fee > 0)) return { ok: false, error: "fee must be positive (the node enforces a minimum fee)", sighashMatch: false, code: "FEE_TOO_LOW" };
  if (fee > MAX_FEE) return { ok: false, error: `fee exceeds the ${MAX_FEE / 1e8} CSD safety cap — refusing (a legitimate fee is well under 1 CSD)`, sighashMatch: false, code: "FEE_CAP" };
  // Refuse the zero address at the SINGLE place every value tx is assembled — send, sendMany,
  // propose, attest, fillOffer and buildSignSubmit all route through here. A payment to 0x000…0 is an
  // irrecoverable burn; the popup send form already blocks it, but the dApp send/sendMany/fillOffer paths
  // bypass that form, so the universal backstop lives here (audit M1 / V23 nset-clear burn class). The
  // node accepts a zero-address output, so this MUST be caught client-side. Change is always to self.
  for (const o of outputs) {
    if (/^(0x)?0{40}$/i.test(o.scriptPubkey)) return { ok: false, error: "refusing to send to the zero address (0x000…0) — these funds would be unrecoverable", sighashMatch: false, code: "ZERO_ADDR_REFUSED" };   // (0x)? so the guard matches whether or not the caller carries the codec prefix (QA #3)
  }
  const addr = addrFromPriv(priv);
  const need = outputs.reduce((s, o) => s + o.value, 0) + fee;
  const sv = await selectVerified(rpc, addr, need);
  if ("error" in sv) return { ok: false, error: sv.error, sighashMatch: false, code: sv.code };
  // Proportional fee bound on the CHAIN-VERIFIED selected total, KEEP-IN-SYNC with csd-tx feeCap
  // (packages/tx/src/index.ts: max(1 CSD, 10% of inputs)). Combined with the flat MAX_FEE pre-check
  // above, the effective cap is min(100 CSD, max(1 CSD, 10% of verified inputs)) — strictly TIGHTER
  // than either alone: the flat cap alone let a hostile dApp fee of e.g. 400 CSD through on whale
  // coins (>1000 CSD selected). Every legitimate flow's explicit fee is ≤ 0.25 CSD (name fees are
  // OUTPUTS, never this fee param), 4x under the 1 CSD floor — no honest tx can trip this.
  const propCap = Math.max(100_000_000, Math.floor(sv.total * 0.10));
  if (fee > propCap)
    return { ok: false, error: `fee exceeds ${propCap / 1e8} CSD (10% of the coins this spend uses) — refusing (a legitimate fee is well under 1 CSD)`, sighashMatch: false, code: "FEE_CAP" };
  const outs = [...outputs];
  const change = sv.total - need; // CHAIN-VERIFIED input total, not the RPC's report
  if (change > 0) outs.push({ value: change, scriptPubkey: addr }); // change back to self
  if (outs.length === 0) return { ok: false, error: emptyError, sighashMatch: false, code: "NO_OUTPUTS" };
  const tx: Tx = { version: 1, locktime: 0, app, inputs: sv.inputs.map((i) => ({ prevTxid: i.txid, vout: i.vout, scriptSig: "0x" })), outputs: outs };
  const r = await signAndSubmit(rpc, tx, priv);
  return r.ok ? { ...r, spentTxids: [...new Set(sv.inputs.map((i) => i.txid.toLowerCase()))] } : r;
}

// Per-output validation shared by buildSignSubmit / sendMany / fillOffer. The per-caller deltas are REAL
// and preserved exactly: sendMany requires ≥1 output while buildSignSubmit/fillOffer deliberately allow an
// empty set (a token-priced fill carries NO CSD outputs); the caps differ (8 / 500 / 100); and the error
// STRINGS cross the dApp trust boundary, so each caller supplies its own `messages` text — this helper
// unifies the LOOP, never the prose (the machine `code` is what unifies the class, WS5). Returns {sumOut}
// (safe-integer-guarded); the isSafeInteger(sumOut + fee) coupling STAYS at the call site (buildSignSubmit
// intentionally lacks one). buildSignSubmit combined its positive+safe-integer check into ONE message, so
// its notPositive and notSafe strings are identical — byte-for-byte equivalent to the old combined guard.
interface OutputMessages { tooMany: string; minOne?: string; badAddr: string; notPositive: string; notSafe: string; sumOverflow: string }
function validateOutputs(outs: { to: string; value: number }[], opts: { max: number; minOne: boolean; messages: OutputMessages }): SubmitResult | { sumOut: number } {
  const m = opts.messages;
  if (opts.minOne && outs.length < 1) return { ok: false, error: m.minOne!, sighashMatch: false, code: "BAD_OUTPUTS" };
  if (outs.length > opts.max) return { ok: false, error: m.tooMany, sighashMatch: false, code: "BAD_OUTPUTS" };
  let sumOut = 0;
  for (const o of outs) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(o.to))) return { ok: false, error: m.badAddr, sighashMatch: false, code: "BAD_OUTPUTS" };
    const v = Number(o.value);
    if (!(v > 0)) return { ok: false, error: m.notPositive, sighashMatch: false, code: "BAD_OUTPUTS" };
    if (!Number.isSafeInteger(v)) return { ok: false, error: m.notSafe, sighashMatch: false, code: "BAD_OUTPUTS" };
    sumOut += v;
    if (!Number.isSafeInteger(sumOut)) return { ok: false, error: m.sumOverflow, sighashMatch: false, code: "BAD_OUTPUTS" };
  }
  return { sumOut };
}

// `payouts` are optional value outputs carried in the SAME tx as the app payload (e.g. a
// CairnX protocol fee to the treasury on a deploy / name registration). Same posture as
// send/fillOffer: each recipient validated, sums safe-integer-guarded, inputs selected
// internally, change ONLY to the wallet's own address; a dApp can't pick UTXOs or redirect change.
async function buildSignSubmit(rpc: string, app: App, fee: number, priv: string, payouts: { to: string; value: number }[] = []): Promise<SubmitResult> {
  if (!Number.isSafeInteger(fee) || fee < 0) return { ok: false, error: "fee out of safe integer range", sighashMatch: false, code: "BAD_FEE" };
  // Cap the value outputs a Propose may carry (normally one protocol-fee output). Prevents a
  // hostile dApp from flooding the clear-signing window with hundreds of disguised payments.
  const chk = validateOutputs(payouts, {
    max: 8, minOne: false,
    messages: { tooMany: "too many outputs on a proposal (max 8)", badAddr: "each recipient must be a 0x… 20-byte address", notPositive: "each amount must be a positive safe integer", notSafe: "each amount must be a positive safe integer", sumOverflow: "outputs exceed the safe integer range" },
  });
  if (!("sumOut" in chk)) return chk;
  const outputs = payouts.map((o) => ({ value: Number(o.value), scriptPubkey: String(o.to) }));
  return assembleValueTx(rpc, outputs, fee, app, priv);
}

export function propose(rpc: string, p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; outputs?: { to: string; value: number }[] }, priv: string): Promise<SubmitResult> {
  // Validate the dApp-supplied payloadHash shape up front (parity with fillOffer's proposalId guard) so a
  // malformed value fails closed with a clear error instead of throwing a cryptic codec error deep inside
  // bytesArr() AFTER the SafeInteger checks pass (audit VAL-3). A real cairnx payloadHash is sha256 = 0x+64hex.
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(p.payloadHash))) {
    return Promise.resolve({ ok: false, error: "payloadHash must be a 0x… 32-byte hash", sighashMatch: false, code: "BAD_REQUEST" });
  }
  // Validate expiresEpoch up front: a negative/fractional/>2^53 value would otherwise wrap or throw
  // inside u64() serialization, committing signed bytes (e.g. 0xFFFF…FF "never expires") that don't
  // match the dApp's intent. Same SafeInteger posture as amounts/fee. (redteam LOW-1)
  if (!Number.isSafeInteger(p.expiresEpoch) || p.expiresEpoch < 0) {
    return Promise.resolve({ ok: false, error: "expiresEpoch must be a non-negative safe integer", sighashMatch: false, code: "BAD_REQUEST" });
  }
  return buildSignSubmit(rpc, { type: "Propose", domain: p.domain, payloadHash: p.payloadHash, uri: p.uri, expiresEpoch: p.expiresEpoch }, p.fee, priv, Array.isArray(p.outputs) ? p.outputs : []);
}
export function attest(rpc: string, p: { proposalId: string; score: number; confidence: number; fee: number }, priv: string): Promise<SubmitResult> {
  // Validate the proposalId shape up front (parity with fillOffer) so a malformed dApp-supplied value fails
  // closed instead of throwing a cryptic codec error inside bytesArr() (audit VAL-3). A proposalId is a txid.
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(p.proposalId))) {
    return Promise.resolve({ ok: false, error: "proposalId must be a 0x… 32-byte txid", sighashMatch: false, code: "BAD_REQUEST" });
  }
  // Clamp to u32 here (parity with fillOffer) so the signed bytes equal the displayed score/confidence.
  return buildSignSubmit(rpc, { type: "Attest", proposalId: p.proposalId, score: p.score >>> 0, confidence: p.confidence >>> 0 }, p.fee, priv);
}

// Plain CSD transfer (app:None). Built + signed entirely client-side — sighash via
// our golden-vector-validated codec, so no node template is needed; /tx/submit
// validates the signature against the node's own (identical) sighash.
export async function send(rpc: string, p: { to: string; amount: number; fee: number }, priv: string): Promise<SubmitResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.to)) return { ok: false, error: "recipient must be a 0x… 20-byte address", sighashMatch: false, code: "BAD_OUTPUTS" };
  if (!(p.amount > 0)) return { ok: false, error: "amount must be positive", sighashMatch: false, code: "BAD_OUTPUTS" };
  // CSD amounts are integer base units carried as JS numbers. Above 2^53 a Number
  // silently loses precision, so the value you sign could differ from what you meant.
  // Refuse anything outside the exactly-representable range (well above total supply).
  if (!Number.isSafeInteger(p.amount) || !Number.isSafeInteger(p.fee) || p.fee < 0 || !Number.isSafeInteger(p.amount + p.fee))
    return { ok: false, error: "amount/fee exceed the safe integer range", sighashMatch: false, code: "BAD_FEE" };
  const outputs = [{ value: p.amount, scriptPubkey: p.to }];
  return assembleValueTx(rpc, outputs, p.fee, { type: "None" }, priv);
}

// Multi-output transfer (app:None). Same single-key / single-signature model as
// send(): every recipient is validated, the sum of all outputs + fee is safe-integer
// guarded, inputs are selected INTERNALLY (never supplied by a caller/dApp), and the
// change always returns to this account's own address. Used by the Console's send card
// for 1→many payments; send() above is the single-recipient convenience wrapper.
export async function sendMany(rpc: string, p: { outputs: { to: string; value: number }[]; fee: number }, priv: string): Promise<SubmitResult> {
  const outs = Array.isArray(p.outputs) ? p.outputs : [];
  const chk = validateOutputs(outs, {
    max: 500, minOne: true,
    messages: { minOne: "at least one output required", tooMany: "too many outputs (max 500)", badAddr: "each recipient must be a 0x… 20-byte address", notPositive: "each amount must be positive", notSafe: "an amount exceeds the safe integer range", sumOverflow: "total outputs exceed the safe integer range" },
  });
  if (!("sumOut" in chk)) return chk;
  if (!Number.isSafeInteger(p.fee) || p.fee < 0 || !Number.isSafeInteger(chk.sumOut + p.fee))
    return { ok: false, error: "amount/fee exceed the safe integer range", sighashMatch: false, code: "BAD_FEE" };
  const outputs = outs.map((o) => ({ value: Number(o.value), scriptPubkey: String(o.to) }));
  return assembleValueTx(rpc, outputs, p.fee, { type: "None" }, priv);
}

// Merge many small coins into ONE output back to the wallet's own address, so a later large send
// fits the MAX_TX_INPUTS per-transaction cap (a pure-50-CSD-coinbase holder otherwise tops out at
// 512×50 = 25,600 CSD per tx and, worse, pays the fee on 500+ inputs every time). Same trust
// posture as every other spend: every input CHAIN-VERIFIED before signing (TXB-1, verifyInputValues
// unchanged), the single output goes ONLY to the address derived from the signing key (a caller/UI
// cannot redirect it), signed locally via the shared signAndSubmit. Selection is SMALLEST-FIRST —
// the deliberate opposite of send's largest-first cover-`need` — because the point is to retire
// fragments; up to MAX_TX_INPUTS coins per run, callers re-run to merge the rest (`remaining`).
// CSD has NO coinbase-maturity rule (verified against consensus params 2026-07-09), so any
// ≥1-confirmation coin is mergeable. Popup-only (NOT in DAPP_METHODS — a dApp has no business
// restructuring the user's coins; there is nothing to clear-sign that the preview doesn't show).
export async function consolidate(rpc: string, p: { fee: number }, priv: string): Promise<SubmitResult & { merged?: number; remaining?: number; total?: number }> {
  const fee = Number(p?.fee);
  if (!Number.isSafeInteger(fee) || !(fee > 0)) return { ok: false, error: "fee must be a positive integer", sighashMatch: false, code: "BAD_FEE" };
  if (fee > MAX_FEE) return { ok: false, error: `fee exceeds the ${MAX_FEE / 1e8} CSD safety cap — refusing`, sighashMatch: false, code: "FEE_CAP" };
  const addr = addrFromPriv(priv);
  let utxos: any[];
  try { ({ utxos } = await balance(rpc, addr)); }
  catch { return { ok: false, error: "couldn't fetch your coins (node unreachable or erroring); nothing was signed, try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" }; }
  // Same ghost handling as selectVerified: known-unprovable outpoints are pre-excluded, fresh
  // ghosts exclude-and-retry within the same bounded round budget, and no coin is EVER spent
  // unverified. tamper/transient verdicts refuse exactly as a send would.
  const now = Date.now();
  for (const [k, exp] of ghostSeen) if (exp <= now) ghostSeen.delete(k);
  const exclude = new Set<string>(ghostSeen.keys());
  const verified = new Map<string, number>();
  for (let round = 0; round < MAX_SELECT_ROUNDS; round++) {
    const pool = spendableCoins(utxos, exclude).sort((a, b) => a.value - b.value).slice(0, MAX_TX_INPUTS);
    if (pool.length < 2) return { ok: false, error: "nothing to consolidate — fewer than two spendable coins", sighashMatch: false, code: "NOTHING_TO_CONSOLIDATE" };
    const ver = await verifyInputValues(rpc, pool, verified);
    if (!ver.ok) {
      if (ver.kind === "tamper") return { ok: false, error: "could not verify selected coins against the chain (refusing to risk a burned fee)", sighashMatch: false, code: "VERIFY_TAMPER" };
      if (ver.kind === "transient") return { ok: false, error: "couldn't fetch source transactions to verify coin values (node unreachable or erroring); nothing was signed, try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
      for (const g of ver.ghosts) { const k = opKey(g.txid, g.vout); exclude.add(k); ghostSeen.set(k, now + GHOST_TTL_MS); }
      if (ghostSeen.size > 2048) ghostSeen.clear();
      continue;
    }
    const outValue = ver.total - fee; // ver.total is CHAIN-VERIFIED and safe-integer-guarded by the fold
    if (!(outValue > 0)) return { ok: false, error: "these coins are too small to cover the fee — nothing to gain by merging them", sighashMatch: false, code: "INSUFFICIENT" };
    // Same proportional fee cap assembleValueTx applies to every other value tx (min(100 CSD,
    // max(1 CSD, 10% of the CHAIN-VERIFIED inputs)) — consolidate builds its tx directly rather than
    // through assembleValueTx, so it MUST re-assert the single-fee-chokepoint invariant itself: a
    // compromised UI must not be able to steer this into burning a huge fee past the 0.01 CSD the
    // preview shows. No honest merge approaches it (the popup hardcodes 0.01 CSD).
    const propCap = Math.max(100_000_000, Math.floor(ver.total * 0.10));
    if (fee > propCap) return { ok: false, error: `fee exceeds ${propCap / 1e8} CSD (10% of the coins this merge uses) — refusing`, sighashMatch: false, code: "FEE_CAP" };
    const remaining = spendableCoins(utxos, exclude).length - pool.length;
    const tx: Tx = { version: 1, locktime: 0, app: { type: "None" }, inputs: pool.map((i) => ({ prevTxid: i.txid, vout: i.vout, scriptSig: "0x" })), outputs: [{ value: outValue, scriptPubkey: addr }] };
    const r = await signAndSubmit(rpc, tx, priv);
    return { ...r, merged: pool.length, remaining, total: ver.total, ...(r.ok ? { spentTxids: [...new Set(pool.map((i) => i.txid.toLowerCase()))] } : {}) };
  }
  return { ok: false, error: "couldn't settle on a verifiable set of coins (unprovable coins kept appearing) — try again in a moment", sighashMatch: false, code: "GHOST_INPUTS_SKIPPED" };
}

// Read-only preview for the consolidate confirmation card: how many coins are spendable, how many
// one run would merge, their REPORTED total and the resulting single-coin value. Display only —
// consolidate() re-derives everything from chain-verified values before signing, so a hostile RPC
// inflating this preview gains nothing (the signed tx uses verified totals or refuses).
export async function consolidatePreview(rpc: string, addr: string, fee: number): Promise<{ ok: boolean; coins?: number; merge?: number; total?: number; out?: number; error?: string }> {
  try {
    const { utxos } = await balance(rpc, addr);
    const pool = spendableCoins(utxos).sort((a, b) => a.value - b.value);
    const merge = Math.min(pool.length, MAX_TX_INPUTS);
    let total = 0;
    for (const c of pool.slice(0, merge)) { total += c.value; if (!Number.isSafeInteger(total)) return { ok: false, error: "coin values out of range" }; }
    return { ok: true, coins: pool.length, merge, total, out: Math.max(0, total - Number(fee)) };
  } catch { return { ok: false, error: "node unreachable" }; }
}

// Fill an on-chain offer (CairnX-style atomic delivery-versus-payment): ONE transaction
// that carries an Attest app payload AND payment outputs. Same trust posture as sendMany —
// recipients validated, sums safe-integer guarded, inputs selected INTERNALLY, change only
// ever returns to this account's own address. The attest fee floor (0.05 CSD) applies.
export async function fillOffer(
  rpc: string,
  p: { proposalId: string; score: number; confidence: number; outputs: { to: string; value: number }[]; fee: number },
  priv: string,
): Promise<SubmitResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(p.proposalId))) return { ok: false, error: "proposalId must be a 0x… 32-byte txid", sighashMatch: false, code: "BAD_REQUEST" };
  const outs = Array.isArray(p.outputs) ? p.outputs : [];
  // outs MAY be empty: a CairnX v1.2 token-priced fill pays in tokens (resolver-debited,
  // marked by confidence=1e6) and carries no CSD payment — the tx is attest + change only.
  const chk = validateOutputs(outs, {
    max: 100, minOne: false,
    messages: { tooMany: "too many outputs (max 100)", badAddr: "each recipient must be a 0x… 20-byte address", notPositive: "each amount must be positive", notSafe: "an amount exceeds the safe integer range", sumOverflow: "total outputs exceed the safe integer range" },
  });
  if (!("sumOut" in chk)) return chk;
  if (!Number.isSafeInteger(p.fee) || p.fee < 0 || !Number.isSafeInteger(chk.sumOut + p.fee))
    return { ok: false, error: "amount/fee exceed the safe integer range", sighashMatch: false, code: "BAD_FEE" };
  const outputs = outs.map((o) => ({ value: Number(o.value), scriptPubkey: String(o.to) }));
  return assembleValueTx(rpc, outputs, p.fee, { type: "Attest", proposalId: p.proposalId, score: p.score >>> 0, confidence: p.confidence >>> 0 }, priv, "tx would have no outputs — add a payment or leave change");
}

// Register a Cairn item's off-chain content (hash-verified by the server).
export function registerContent(apiBase: string, content: any, txid: string): Promise<any> {
  return fetch(`${apiBase}/api/content`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...content, txid }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

// Sign in with CSD against the Cairn API: fetch nonce, sign its digest locally, verify.
export async function signIn(apiBase: string, priv: string): Promise<{ ok: boolean; addr?: string; session?: string; error?: string }> {
  const n = await post(apiBase, "/auth/nonce", {});
  if (!n?.ok || !n.nonce) return { ok: false, error: "could not get nonce" };
  // Derive the digest LOCALLY from the nonce — never sign the server's `digest`
  // field. Otherwise a malicious/MITM'd API could return a tx sighash and harvest a
  // valid spend signature from the login flow (see test/poc-signin-oracle.ts).
  const { sig64, pub33 } = signSighash(loginDigest(String(n.nonce)), priv);
  const v = await post(apiBase, "/auth/verify", { nonce: n.nonce, pub33, sig64 });
  // Normalize the failure shape to this function's declared `error` key — post() returns {ok:false,err}
  // on a non-2xx body (VAL-2), and this legacy path's callers read `.error`.
  return v?.ok ? v : { ok: false, error: v?.error ?? v?.err ?? "sign-in failed" };
}
