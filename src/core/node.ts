// Talks to a CSD node (reads + non-custodial submit) and the Cairn API (sign-in). Browser fetch.
// The build is FULLY LOCAL and never trusts a server-supplied hash: coin-select from CHAIN-VERIFIED
// utxos, assemble the whole tx and compute OUR OWN codec sighash locally, sign it, then POST /tx/submit.
// We never sign a signing_hash the node handed us, so a malicious/MITM'd RPC cannot steer a signature
// onto a different transaction. The private key only ever lives in the wallet; nothing here sends it away.
import { signSighash, buildScriptSig, addrFromPriv, sighash as codecSighash, txid as codecTxid, loginDigest, bytesArr, type App, type Tx } from "./csdtx.js";
import { fmtCsd, csdBase } from "./cairnx.js";
import type { TxInclusion } from "./inclusion.js";
import { selectInputs, strip0x, MAX_TX_INPUTS, MAX_DOMAIN_BYTES, MAX_URI_BYTES, MIN_FEE_PROPOSE } from "../vendor/cairnx-spv.js";
import { byteCapRefusal } from "./signfields.js";
import { firstAnswer, hostsFor, isBackup, submitEach, type HostAnswer } from "./hosts.js";
import { classifyAnswer, isSubmitDuplicateErr, type HostVerdict, type RefusalReason, type SubmitAnswer, type SubmitOutcome } from "./submitverdict.js";

// Bounded waits (2026-07-09): a node that ACCEPTS the connection but never answers used to hang
// these fetches forever; the popup's "sending…" spinner never settled and there was no in-popup
// recovery. A timeout converts the stall into the existing fail-closed error paths (get() throws →
// caller catch; a submit that timed out reads as unclear, submitverdict.ts). Reads are short; submit is
// generous (the node can be busy validating a 512-input tx).
// 12s, not 8s: the cairn proxy's failover chain worst-cases at 4s (routed backend) + 6s (fallback)
// = 10s of legitimate inner wait; an 8s outer abort raced that chain and turned a survivable
// one-backend outage into spurious VERIFY_UNAVAILABLE on every read (timeout-inversion class,
// docs/Plans/66 B1). The outer timeout must sit ABOVE the inner worst case.
const GET_TIMEOUT_MS = 12_000;
const POST_TIMEOUT_MS = 20_000;
async function get(rpc: string, path: string): Promise<any> {
  const r = await fetch(`${rpc}${path}`, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`); return r.json();
}
// One POST, never a throw: a request that failed or timed out is `thrown`, any answer is its status and parsed body
// (`undefined` when it is not JSON). submitverdict.ts reads a submit's answer; post() below reads sign-in's.
async function postRaw(base: string, path: string, body: unknown): Promise<SubmitAnswer> {
  let r: Response;
  try { r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(POST_TIMEOUT_MS) }); }
  catch { return { thrown: true }; }
  let j: unknown;
  try { j = await r.json(); } catch { j = undefined; }
  return { status: r.status, body: j };
}
// Sign-in's POST: a 2xx JSON object is returned as it is, anything else as {ok:false, err}.
async function post(base: string, path: string, body: unknown): Promise<any> {
  const a = await postRaw(base, path, body);
  if ("thrown" in a) return { ok: false, err: `${path} -> network error` };
  const j: any = a.body;
  if (a.status < 200 || a.status > 299) return { ok: false, err: (j && (j.err ?? j.error)) || `${path} -> ${a.status}` };
  if (j === undefined) return { ok: false, err: `${path} -> non-JSON response` };
  if (j === null || typeof j !== "object" || Array.isArray(j)) return { ok: false, err: `${path} -> unreadable response` };
  return j;
}

// Reads take `rpc`, the wallet's RPC, and go to its hosts through firstAnswer (hosts.ts); a function named `...At` or
// documented as reading one host reads exactly the host it is given, for a step that must stay on one host.
export async function tipAt(host: string): Promise<number> { return Number((await get(host, "/tip")).height ?? 0); }
export async function tip(rpc: string): Promise<number> { return (await firstAnswer(rpc, tipAt)).value; }
// Display only; reads one host. The Cairn proxy answers /tx/:id/status (mined, pending or unknown across both backends); a
// loopback node has no such route (404), so its /tx/:id says mined, or not mined (`definite` when its scan was
// complete; it has no mempool view). null: nothing knowable this time.
export async function txInclusion(host: string, txid: string): Promise<TxInclusion | null> {
  try {
    const r = await fetch(`${host}/tx/${txid}/status`, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
    if (r.ok) {
      const j: any = await r.json();
      if (j?.ok !== true || !["mined", "pending", "unknown"].includes(j.state)) return null;
      if (j.state === "mined") return Number.isSafeInteger(j.height) ? { state: "mined", height: j.height } : null;
      return j.state === "pending" ? { state: "pending" } : { state: "unknown", definite: j.definite === true };
    }
    if (r.status !== 404) return null;
    const t: any = await get(host, `/tx/${txid}`);
    if (t?.ok === true && Number.isSafeInteger(t.height)) return { state: "mined", height: t.height };
    return t?.ok === false ? { state: "unknown", definite: t.complete === true } : null;
  } catch { return null; }   // unreachable or unreadable: the row stays open and is read again next block
}
export async function getProposal(rpc: string, txid: string): Promise<any | null> {
  try { const { value: j } = await firstAnswer(rpc, (h) => get(h, `/proposal/${txid}`)); return j?.proposal ?? (j?.payload_hash ? j : null); } catch { return null; }
}
// Throws on a body without a `utxos` array, so every spend path refuses it as VERIFY_UNAVAILABLE before signing.
// `truncated`: the node's bound cut the list (node 0.1.17 `--utxos-bound`, the largest coins first), so `utxos` holds
// some of the address's coins and `confirmed` stays the whole balance. A coin missing from a cut list proves nothing.
// balanceAt reads one host; balance reads the wallet's hosts and says `via: "backup"` when the second host answered.
type Balance = { confirmed: number; utxos: any[]; truncated: boolean };
async function balanceAt(host: string, addr: string): Promise<Balance> {
  const j = await get(host, `/utxos/${addr}?available=true`);
  if (!j || typeof j !== "object" || !Array.isArray(j.utxos)) throw new Error(`/utxos -> malformed response`);
  return { confirmed: Number(j.confirmed_balance ?? 0), utxos: j.utxos, truncated: j.truncated === true };
}
export async function balance(rpc: string, addr: string): Promise<Balance & { via?: "backup" }> {
  const { value, host } = await firstAnswer(rpc, (h) => balanceAt(h, addr));
  return isBackup(host) ? { ...value, via: "backup" } : value;
}
// Reads one host. The mined utxo set, coins held by the mempool included (balance() leaves those out). The proxy serves it
// at /utxos-all/:addr; its /utxos/:addr is mempool-filtered, so only a bare node origin falls back to the
// node's own /utxos/:addr. null: not readable, and no caller may conclude anything from it. `complete` is false
// when the node's bound cut the list: a coin in it is mined, a coin missing from it proves nothing.
export async function confirmedUtxos(host: string, addr: string): Promise<{ utxos: { txid: string; vout: number }[]; complete: boolean } | null> {
  try {
    const r = await fetch(`${host}/utxos-all/${addr}`, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
    let j: any;
    if (r.ok) j = await r.json();
    else if (r.status === 404 && new URL(host).pathname.replace(/\/+$/, "") === "") j = await get(host, `/utxos/${addr}`);
    else return null;
    return j && typeof j === "object" && Array.isArray(j.utxos) ? { utxos: j.utxos, complete: j.truncated !== true } : null;
  } catch { return null; }   // unreachable or unreadable: no "gone" verdict this pass
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

// W6 (ND-1): a stranger can anchor one tx carrying `expires_epoch: 9007199254740993` and 1 sat to a
// victim. Consensus puts NO upper bound on expires_epoch (app_state.rs compares it only against the
// current epoch), so the node serves it verbatim; JSON.parse silently rounds it to 9007199254740992, the
// recomputed codecTxid therefore differs, and that classified "tamper", which is DECISIVE for the whole
// spend. consolidate() selects smallest-first, so the dust coin sits in every pool: VERIFY_TAMPER forever,
// permanently, for the price of one dust tx, on the documented remedy for the large-send class.
// The scan runs over the RAW body BEFORE nodeTxToTx/codecTxid, because once JSON.parse has run the wallet
// can no longer distinguish "the node served an exactly representable u64" from "JSON.parse lost
// precision". Fields are exactly the codec-serialized numerics: version, locktime, output value, and the
// app legs expires_epoch (Propose) and score/confidence (Attest).
// THE OBJECTION, PRE-ANSWERED: this lets a forging node make a coin SKIPPABLE rather than decisively
// refused. It grants no new power. A forging node can ALREADY make any coin skippable by answering
// {ok:false}, which classifies "notfound". What must not weaken is the well-formed case, and it does not:
// a body whose numbers are all exactly representable and whose recomputed txid differs is still "tamper".
const representableNum = (v: unknown): boolean => typeof v !== "number" || Number.isSafeInteger(v);
function bodyNumbersRepresentable(body: any): boolean {
  if (!representableNum(body?.version) || !representableNum(body?.locktime)) return false;
  const a = body?.app;
  if (a && typeof a === "object"
      && (!representableNum(a.expires_epoch) || !representableNum(a.score) || !representableNum(a.confidence))) return false;
  for (const o of Array.isArray(body?.outputs) ? body.outputs : []) if (!representableNum(o?.value)) return false;
  return true;
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
// txid still matches the prevout; any tamper is detected and the send is refused (fail-closed).
//
// Per-input verdicts are CLASSIFIED (Plan 65, ghost-coin incident): a node can hold UTXO-index
// entries whose source tx is in NO block of its own chain (a failed reorg-undo leaves them behind).
// Under the old any-null-kills-all fold, ONE such coin bricked every spend from the wallet forever.
// The classes and their handling (in selectVerified):
//   number       verified value; the only thing that can ever be spent
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
// never rejects; every failure is a verdict value; so verifyInputValues' semantics are unchanged
// from the Promise.all it replaces, minus the unbounded burst).
// `decisive` (optional) short-circuits: once ANY completed result satisfies it, workers stop pulling
// NEW items (in-flight ones finish, leaving later slots undefined). Used so a single tamper/transient
// verdict doesn't force a black-holing node to grind through all 512 inputs 8-at-a-time (≈8.5 min of
// timeouts) before refusing; the caller only needs to KNOW one exists (both are fail-closed refusals
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
// BN0w (W9 wallet half): "horizon" is the fourth verdict, for a node v0.1.6+ answering 503 with body
// code SCAN_HORIZON on /tx/:id: its bounded back-scan ran out of budget BEFORE proving presence OR
// absence. The coin is REAL (the node's own utxo index reported it); this node just cannot look back
// far enough to prove it right now. Severity sits BELOW tamper and transient (neither refusal class
// may be weakened) and ABOVE notfound (a proved absence). Like notfound it is skippable PER COIN
// (the 0.2.53 rule: a partial send still completes) and NON-decisive in the verify pool. Inert until
// a node emitting the signal ships; a plain 503 keeps classifying "transient" exactly as fielded.
// W6 (ND-1): "unrepresentable" is the FIFTH verdict, for a body whose codec-serialized numbers cannot
// survive JSON.parse exactly (see bodyNumbersRepresentable). It mirrors "horizon": non-decisive, skippable
// PER COIN, its own array and its own reporting line. It is deliberately NOT aliased to "notfound", whose
// copy says the coin "could not be found on the chain" about a coin that demonstrably exists, and NOT to
// "tamper", which would keep the whole spend refused.
type InputVerdict = number | "notfound" | "transient" | "tamper" | "horizon" | "unrepresentable";
type VerifyResult =
  | { ok: true; total: number }
  | { ok: false; kind: "tamper" }
  | { ok: false; kind: "transient" }
  | { ok: false; kind: "horizon"; horizons: { txid: string; vout: number }[]; ghosts: { txid: string; vout: number }[] }
  | { ok: false; kind: "unrepresentable"; unrepresentables: { txid: string; vout: number }[]; ghosts: { txid: string; vout: number }[] }
  | { ok: false; kind: "notfound"; ghosts: { txid: string; vout: number }[] };
// The outpoint key: csd-tx selectInputs' dedupe rule (lower case, `0x` stripped), written in the `0x` form the node
// serves so keys already stored on history rows still match.
export const opKey = (txid: unknown, vout: unknown) => `0x${strip0x(String(txid).toLowerCase())}:${Number(vout)}`;
async function verifyInputValues(
  host: string,
  inputs: { txid: string; vout: number }[],
  // per-CALL cache: a coin verified in an earlier selection round is never refetched in a later one.
  // Deliberately not cross-call (a txid does commit to its outputs immutably, but re-verifying every
  // spend keeps the "always verify before signing" property trivially auditable).
  verified: Map<string, number> = new Map(),
): Promise<VerifyResult> {
  // Each input is verified INDEPENDENTLY, so the per-input `/tx` fetches overlap; an N-input send
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
      const r = await fetch(`${host}/tx/${i.txid}`, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
      if (r.status === 404) return "notfound";
      // BN0w (W9): ONLY the exact 503 + body code SCAN_HORIZON pair classifies "horizon" (the node
      // v0.1.6 scan-outcome wire contract, normative in the compute-substrate README: 503 +
      // Retry-After + {ok:false, code:"SCAN_HORIZON"}). A plain 503, an unreadable body, or any
      // OTHER code (SCAN_INCOMPLETE / SCAN_DECODE mean the walk broke, not that it ran long) stays
      // "transient": refuse the whole spend retryably, the fielded fail-closed behavior.
      if (r.status === 503) {
        try { const j: any = await r.json(); if (j?.code === "SCAN_HORIZON") return "horizon"; } catch { /* unreadable body: transient below */ }
        return "transient";
      }
      if (!r.ok) return "transient";
      let j: any; try { j = await r.json(); } catch { return "transient"; }
      body = j?.tx;
    } catch { return "transient"; }
    if (!body) return "notfound"; // the node's canonical 2xx miss: {ok:false,err:"not found"}, no tx
    // W6 (ND-1): classify BEFORE nodeTxToTx/codecTxid. After JSON.parse the precision loss is invisible,
    // so the recomputed txid would differ and the coin would read "tamper" (decisive for the whole spend).
    if (!bodyNumbersRepresentable(body)) return "unrepresentable";
    let tx: Tx, recomputed: string;
    // robustness nit (audit D): codecTxid itself can throw on a malformed body, so decode AND
    // recompute inside one try; any failure is a fail-closed reject, never an uncaught throw.
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
  // 8-at-a-time for minutes). notfound must NOT short-circuit; every ghost has to be collected to
  // exclude it. When we stop early, later slots are undefined, but the tamper/transient checks below
  // fire before the fold, so the undefined tail is never summed.
  // BN0w: "horizon" is NON-decisive exactly like notfound: every horizon coin must be collected so
  // the caller can skip it per coin; it must never short-circuit the bounded pool.
  const verdicts = await mapLimit(inputs, VERIFY_CONCURRENCY, verifyOne, (v) => v === "tamper" || v === "transient");
  // Severity order: any tamper refuses the whole spend immediately (never route around a forging RPC);
  // any transient refuses retryably without excluding anything; only pure not-founds are skippable.
  // BN0w extends it: tamper > transient > horizon > notfound. Horizon and notfound are BOTH per-coin
  // skips; horizon outranks notfound only in REPORTING (the refusal copy must never defame a real coin).
  if (verdicts.includes("tamper")) return { ok: false, kind: "tamper" };
  if (verdicts.includes("transient")) return { ok: false, kind: "transient" };
  const ghosts = inputs.filter((_, k) => verdicts[k] === "notfound");
  const horizons = inputs.filter((_, k) => verdicts[k] === "horizon");
  // W6 (ND-1): its own array and its own REPORTING rung, after horizon and before notfound. The decisive
  // fold above (tamper, then transient, and mapLimit's short-circuit predicate) is untouched: this verdict
  // is per-coin skippable, so it must never be able to refuse a whole spend.
  const unrepresentables = inputs.filter((_, k) => verdicts[k] === "unrepresentable");
  if (horizons.length) return { ok: false, kind: "horizon", horizons, ghosts };
  if (unrepresentables.length) return { ok: false, kind: "unrepresentable", unrepresentables, ghosts };
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
// re-select EXCLUDING those outpoints and try again; bounded rounds, and no coin is ever spent
// unverified. A hostile RPC gains nothing it didn't have (it already controls the /utxos enumeration
// entirely); tamper still kills the whole spend with no retry. Session ghost cache: outpoints that
// answered not-found are pre-excluded for a short TTL so an immediate user retry doesn't burn a round;
// module state dies with the MV3 service worker (~30s idle), which is desirable; after a node repair
// or endpoint switch the coins are re-checked from scratch.
const MAX_SELECT_ROUNDS = 3;      // bounds /tx traffic: at most 3 selections per spend attempt
const GHOST_TTL_MS = 120_000;
const ghostSeen = new Map<string, number>(); // skipKey(host, outpoint) -> expiry
// BN0w: horizon outpoints (real coins the node's bounded scan could not reach; see verifyInputValues)
// are cached like ghosts so an immediate retry pre-excludes them without re-probing, but tracked
// SEPARATELY: the refusal copy for a horizon coin must say the node cannot look back far enough,
// never that the coin "could not be verified". An outpoint lives in exactly ONE of the two caches
// (each classification event moves it), so the honest counts below cannot double-book a coin.
const horizonSeen = new Map<string, number>(); // skipKey(host, outpoint) -> expiry
// Unrepresentable outpoints (W6, see verifyInputValues) are cached the same way, in their own map for their own
// copy, and an outpoint lives in exactly one of the three. Without the cache each selection round rediscovers them
// one largest-first layer at a time, so three layers spend all MAX_SELECT_ROUNDS and every retry refuses
// VERIFY_UNAVAILABLE (test/maxsendable.test.mjs case 11). The verdict is a property of the served body; a node
// that serves another body for the txid is the same class as one that answers not-found, which ghostSeen already
// caches.
const unrepSeen = new Map<string, number>(); // skipKey(host, outpoint) -> expiry
const SKIP_CACHE_MAX = 2048; // per map: a hostile RPC cannot grow one unboundedly
// The caches hold a verdict of the host that gave it: keyed by host and outpoint, so a coin one host could not prove
// is checked again when another host lists it (hosts.ts: the main host and the second host).
const skipKey = (host: string, op: string): string => `${host} ${op}`;
/** Drops expired entries and returns every outpoint a cache still excludes for `host`. */
function sessionExclusions(host: string, now: number): Set<string> {
  for (const m of [ghostSeen, horizonSeen, unrepSeen]) for (const [k, exp] of m) if (exp <= now) m.delete(k);
  const pre = skipKey(host, "");
  return new Set<string>([...ghostSeen.keys(), ...horizonSeen.keys(), ...unrepSeen.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)));
}
/** Files outpoint `op` of `host` under `into` (one of the three caches) and out of the other two. */
function rememberSkip(into: Map<string, number>, host: string, op: string, now: number): void {
  const k = skipKey(host, op);
  for (const m of [ghostSeen, horizonSeen, unrepSeen]) if (m !== into) m.delete(k);
  into.set(k, now + GHOST_TTL_MS);
  if (into.size > SKIP_CACHE_MAX) into.clear();
}
function roundsExhausted(count: number, value: number): { error: string; code: string } {
  return { error: `this node could not prove ${count} coin(s) totalling ${fmtCsd(value)} yet, and the wallet stopped after ${MAX_SELECT_ROUNDS} rounds of checks before reaching coins it can prove. The node may still be rebuilding its transaction index, for example after a restart. Nothing was signed; try again shortly`, code: "VERIFY_UNAVAILABLE" };
}
// `needOf` is what the spend must cover (amount plus fee), or for maxSendable a function of the utxo set and the coins
// excluded so far, evaluated at the start of every round so the target follows the exclusions this loop makes. With a
// number every round uses that number, exactly as a send passes it.
type NeedOf = (utxos: any[], exclude: ReadonlySet<string>, truncated: boolean, host: string) => number;
// `verified` lets maxSendable's final pass reuse the verdicts its first pass fetched (a txid commits to its output
// values, so a verified value cannot change); a send passes none and fetches every coin it selects.
async function selectVerified(rpc: string, addr: string, needOf: number | NeedOf, verified: Map<string, number> = new Map()): Promise<{ inputs: SelectedInput[]; total: number } | { error: string; code: string }> {
  // The utxo read itself can fail (node down / timeout). Catch it HERE so the failure surfaces as
  // the retryable structured VERIFY_UNAVAILABLE every caller already handles, instead of throwing
  // out of assembleValueTx and landing in the popup's ambiguous "may be in flight" catch branch:
  // nothing has been signed at this point, so the outcome is definitively clean.
  // One host per spend: the host that answered the coin list is asked for every coin's source transaction, so the
  // verdicts below are that host's, as with one host (a host a block behind could otherwise answer "not found").
  let utxos: any[], truncated: boolean, confirmed: number, host: string;
  try { ({ value: { utxos, truncated, confirmed }, host } = await firstAnswer(rpc, (h) => balanceAt(h, addr))); }
  catch { return { error: "couldn't fetch your coins (node unreachable or erroring); nothing was signed, try again in a moment", code: "VERIFY_UNAVAILABLE" }; }
  const now = Date.now();
  const exclude = sessionExclusions(host, now);
  const reportedVal = new Map<string, number>(utxos.map((u: any) => [opKey(u.txid, u.vout), Number(u.value) || 0]));
  // ghosts already known from the session cache that are present in THIS utxo set count toward the
  // honest error (they are why the reported balance overstates what is spendable); BN0w counts the
  // horizon class separately for the same reason with its own honest copy.
  let ghostCount = 0, ghostValue = 0;
  let horizonCount = 0, horizonValue = 0;
  let unrepCount = 0, unrepValue = 0;   // W6 (ND-1): booked separately so the final copy stays honest
  for (const [k, v] of reportedVal) {
    const sk = skipKey(host, k);
    if (ghostSeen.has(sk)) { ghostCount++; ghostValue += v; }
    if (horizonSeen.has(sk)) { horizonCount++; horizonValue += v; }
    if (unrepSeen.has(sk)) { unrepCount++; unrepValue += v; }
  }
  let selExhausted = false;                 // loop left because selection failed (vs ghost-round budget spent)
  let need = typeof needOf === "number" ? needOf : 0;
  for (let round = 0; round < MAX_SELECT_ROUNDS; round++) {
    if (typeof needOf === "function") need = needOf(utxos, exclude, truncated, host);
    const sel = selectInputs(utxos, need, exclude);
    if (!sel) { selExhausted = true; break; } // remaining verifiable coins can't cover `need`, or can't within the input cap (diagnosed below)
    const ver = await verifyInputValues(host, sel.inputs, verified);
    if (ver.ok) {
      if (ver.total < need || !Number.isSafeInteger(ver.total) || !Number.isSafeInteger(ver.total - need)) return { error: "insufficient confirmed balance", code: "INSUFFICIENT" };
      return { inputs: sel.inputs, total: ver.total };
    }
    if (ver.kind === "tamper")
      return { error: "could not verify selected inputs against the chain (refusing to risk a burned fee)", code: "VERIFY_TAMPER" };
    if (ver.kind === "transient")
      return { error: "couldn't fetch source transactions to verify input values (node unreachable or erroring); nothing was signed, try again in a moment", code: "VERIFY_UNAVAILABLE" };
    // BN0w: horizon coins are skipped per coin exactly like ghosts (exclude and re-select; an
    // unproved coin is NEVER spent) but booked separately so the final copy stays honest.
    if (ver.kind === "horizon") {
      for (const h of ver.horizons) {
        const k = opKey(h.txid, h.vout);
        if (!exclude.has(k)) { horizonCount++; horizonValue += reportedVal.get(k) ?? 0; }
        exclude.add(k); rememberSkip(horizonSeen, host, k, now);
      }
    }
    // W6 (ND-1): unrepresentable coins exclude-and-retry per coin exactly like ghosts and horizons (an
    // unproved coin is NEVER spent), and are cached like them (unrepSeen).
    if (ver.kind === "unrepresentable") {
      for (const u of ver.unrepresentables) {
        const k = opKey(u.txid, u.vout);
        if (!exclude.has(k)) { unrepCount++; unrepValue += reportedVal.get(k) ?? 0; }
        exclude.add(k); rememberSkip(unrepSeen, host, k, now);
      }
    }
    for (const g of ver.ghosts) {           // ghosts: exclude and re-select; an unverified coin is NEVER spent
      const k = opKey(g.txid, g.vout);
      if (!exclude.has(k)) { ghostCount++; ghostValue += reportedVal.get(k) ?? 0; }
      exclude.add(k); rememberSkip(ghostSeen, host, k, now);
    }
  }
  // TOO_MANY_INPUTS vs INSUFFICIENT (2026-07-09): selectInputs returns null BOTH when the balance
  // genuinely can't cover `need` AND when it could but not within the MAX_TX_INPUTS cap; a
  // pure-50-CSD-coinbase holder tops out at 512×50 = 25,600 CSD per tx, and telling them
  // "insufficient confirmed balance" is false and alarming. Diagnose which it was: if the full
  // spendable set (same predicate, ghosts excluded) covers `need`, the cap was the blocker.
  // A list the node cut holds only its largest coins: when more than the cap of them are listed and the whole balance
  // it reports covers `need`, the cap is the blocker too.
  if (selExhausted) {
    let spendable = 0;
    const listed = spendableCoins(utxos, exclude);
    for (const c of listed) {
      spendable += c.value;
      if (!Number.isSafeInteger(spendable)) { spendable = 0; break; } // beyond-supply garbage: fall through to INSUFFICIENT
    }
    if (spendable >= need || (truncated && listed.length > MAX_TX_INPUTS && Number.isSafeInteger(confirmed) && confirmed >= need))
      return { error: `this spend needs more coins than the ${MAX_TX_INPUTS}-input per-transaction limit allows: send a smaller amount, or consolidate your coins first (settings ▸ coins)`, code: "TOO_MANY_INPUTS" };
  }
  if (!ghostCount && !horizonCount && !unrepCount) return { error: "insufficient confirmed balance", code: "INSUFFICIENT" };
  // The round budget ran out while selection still had untried coins, so nothing is known about
  // whether the provable coins cover `need`. Typical after a node restart: SCAN_HORIZON on many coins
  // while its tx index converges. Retryable: the session caches above pre-exclude the coins seen.
  if (!selExhausted) return roundsExhausted(ghostCount + horizonCount + unrepCount, ghostValue + horizonValue + unrepValue);
  // BN0w (W9): horizon outranks ghost in reporting (severity below tamper/transient, above notfound).
  // The copy must stay honest: these coins are REAL and belong to this wallet; the node's bounded
  // back-scan just cannot reach their source txs yet. Never say "could not be verified" about them.
  // Not retryable as-is (same posture as GHOST_INPUTS_SKIPPED): the coins stay excluded until the
  // node's index converges or it is upgraded; a smaller spend covered by provable coins works now.
  if (horizonCount) {
    console.warn(`cairn-wallet: skipped ${horizonCount} coin(s) beyond the node's scan horizon (real, provable once the node is upgraded); spendable balance is temporarily lower by ~${fmtCsd(horizonValue)}`);
    const alsoGhosts = ghostCount ? `; ${ghostCount} other coin(s) totalling ${fmtCsd(ghostValue)} could not be found on the chain and were also skipped` : "";
    return { error: `your node cannot look back far enough to prove ${horizonCount} coin(s) totalling ${fmtCsd(horizonValue)}; they are real and will be spendable once the node is upgraded${alsoGhosts}. The remaining provable coins couldn't cover this ${fmtCsd(need)} spend (amount plus fee)`, code: "VERIFY_HORIZON" };
  }
  // W6 (ND-1): reported AFTER horizon and BEFORE notfound. The copy must never say "could not be found"
  // (the coin demonstrably exists) and never say "tampered" (nothing was proved either way): the honest
  // statement is that this wallet cannot represent a number in the source transaction exactly.
  if (unrepCount) {
    console.warn(`cairn-wallet: skipped ${unrepCount} coin(s) whose source transaction carries a number this wallet cannot represent exactly; spendable balance is temporarily lower by ~${fmtCsd(unrepValue)}`);
    const alsoGhosts = ghostCount ? `; ${ghostCount} other coin(s) totalling ${fmtCsd(ghostValue)} could not be found on the chain and were also skipped` : "";
    return { error: `${unrepCount} coin(s) totalling ${fmtCsd(unrepValue)} were skipped because their source transaction carries a number this wallet cannot represent exactly, so it cannot be proved either way${alsoGhosts}. The remaining provable coins couldn't cover this ${fmtCsd(need)} spend (amount plus fee)`, code: "VERIFY_UNREPRESENTABLE" };
  }
  console.warn(`cairn-wallet: skipped ${ghostCount} coin(s) the node could not prove (source tx not found); reported balance may be overstated by ~${fmtCsd(ghostValue)}`);
  // Non-retryable: the skipped coins stay excluded until the node can PROVE them, so an immediate retry
  // changes nothing (distinct from the retryable VERIFY_UNAVAILABLE transient class above).
  return { error: `${ghostCount} coin(s) totalling ${fmtCsd(ghostValue)} could not be verified on the chain and were skipped; the remaining verifiable coins couldn't cover this ${fmtCsd(need)} spend (amount plus fee)`, code: "GHOST_INPUTS_SKIPPED" };
}

// `code` (WS5, additive since 0.2.54): a stable UPPER_SNAKE machine tag on every {ok:false} so dApp
// consumers switch on the code instead of the human `error` string (which is UX copy and may change).
// `sighashMatch` is DEPRECATED and vestigial; it is constant-equal to `ok` (true only when WE computed
// and matched the sighash, which is the entire local-build flow) and no reader was found; but it is KEPT
// on every result (incl. preflight errors) because dropping it is a dApp-visible shape change for zero gain.
// spentTxids (successful submits: the source txids of the inputs spent, so the merge rows they consumed
// latch confirmed) and inputs (every result with a txid: the spent `txid:vout` outpoints, kept on history
// rows for the "gone" check), hosts (each host's answer to the submit, a server's text included) and mainHolds (the main
// host answered "accepted" or "already present") are internal; background.ts strips them before a result reaches a page.
export interface SubmitResult { ok: boolean; txid?: string; error?: string; sighashMatch: boolean; code?: string; reason?: RefusalReason; spentTxids?: string[]; inputs?: string[]; hosts?: HostLog[]; mainHolds?: boolean }

interface SelectedInput { txid: string; vout: number; value: number }

// Defense-in-depth absolute fee cap (NETNEW-NO-MAX-FEE-CAP-1). A legitimate CSD miner fee is well under 1 CSD;
// the clear-sign window already WARNs above 5 CSD. Hard-refuse an absurd caller/dApp-supplied fee at the single
// chokepoint every value tx routes through, so a compromised UI can't steer a user PAST the visible warning
// into burning a huge fee. 100 CSD is ~100× any real fee; no legitimate flow approaches it.
const MAX_FEE = 100 * 1e8; // base units (100 CSD)
// The proportional fee bound on a spend's chain-verified input total, max(1 CSD, 10% of it). assembleValueTx,
// consolidate and maxSendable apply it. csd-tx's feeCap is the same rule, but the vendored bundle does not export it, so
// this copy stays until a re-vendor adds it to scripts/build-spv-vendor.sh; test/feecap-parity.test.mjs pins the two
// equal against the csd-tx version package.json pins.
export const proportionalFeeCap = (verifiedTotal: number): number => Math.max(100_000_000, Math.floor(verifiedTotal * 0.10));

// The coins csd-tx selectInputs would accept, each once (opKey is its dedupe key), in the reported order:
// selectInputs answering a one-coin pool is the spendability predicate, so the rule is csd-tx's own.
// selectVerified uses it to tell TOO_MANY_INPUTS from a shortfall; consolidate sorts it smallest-first.
export function spendableCoins(utxos: any[], exclude?: ReadonlySet<string>): SelectedInput[] {
  const seen = new Set<string>();
  const out: SelectedInput[] = [];
  for (const x of utxos ?? []) {
    if (x == null) continue;
    const key = opKey(x.txid, x.vout);
    if (seen.has(key)) continue;
    const c = selectInputs([x], 1, exclude)?.inputs[0];
    if (!c) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// The duplicate rule's home is submitverdict.ts; cairn-sdk's classifySubmit names it here.
export { isSubmitDuplicateErr };

/** One host's verdict on a submit (submitverdict.ts classifyAnswer); never rejects. */
async function submitTo(host: string, body: unknown): Promise<HostVerdict> {
  return classifyAnswer(await postRaw(host, "/tx/submit", body));
}
// What each host answered, for diagnostics: kept off what a page receives (background.ts pageResult).
type HostLog = { host: string; kind: HostVerdict["kind"]; reason?: RefusalReason; text?: string };
const hostLog = ({ host, verdict: v }: HostAnswer): HostLog =>
  ({ host, kind: v.kind, ...(v.kind === "refused" ? { reason: v.reason } : {}), ...("text" in v ? { text: v.text } : {}) });
const DUPLICATE_TEXT = "this transaction, or one spending the same coins, is already pending. Check your history once it is mined before sending again";
// The result of a submit for the sender. The txid is the local one whenever a host may hold the transaction (sent,
// duplicate, unclear); a refusal carries none, since a txid would read as "it went through". SUBMIT_REJECTED: every
// host refused (a node's 200 ok:false, or a proxy's 400, 413 or 429 before forwarding); SUBMIT_MAYBE_INFLIGHT: a host
// may hold it (a throw, a timeout, a 5xx, an unreadable answer); SUBMIT_DUPLICATE: a host holds this transaction, or
// one spending the same coins, so "nothing was sent" would be false. `reason` classes a refusal (additive).
function submitResult(o: SubmitOutcome, localTxid: string): Omit<SubmitResult, "hosts"> {
  if (o.kind === "sent") return { ok: true, txid: localTxid, error: undefined, sighashMatch: true, code: undefined };
  if (o.kind === "duplicate") return { ok: false, txid: localTxid, error: DUPLICATE_TEXT, sighashMatch: true, code: "SUBMIT_DUPLICATE" };
  if (o.kind === "unclear") return { ok: false, txid: localTxid, error: o.mainRefused ? `${o.text}; the other server has not answered, so it may still go through` : o.text, sighashMatch: true, code: "SUBMIT_MAYBE_INFLIGHT", ...(o.mainRefused ? { reason: o.mainRefused } : {}) };
  return { ok: false, txid: undefined, error: o.text, sighashMatch: true, code: "SUBMIT_REJECTED", reason: o.reason };
}

// Build the FULL tx locally (we set the app ourselves), sign OUR OWN codec sighash,
// and submit. We never sign a hash a server handed us; so a malicious or MITM'd RPC
// cannot trick the wallet into signing a different transaction; the node re-derives
// the same sighash and would reject any tampering anyway.
// Sign every input with the one whole-tx sighash and submit. All inputs are blanked
// in the sighash and all belong to this account's single key, so one signature is
// reused across them. Returns sighashMatch:true because WE computed the sighash.
async function signAndSubmit(rpc: string, tx: Tx, priv: string): Promise<SubmitResult> {
  const { sig64, pub33 } = signSighash(codecSighash(tx), priv);
  const scriptSig = buildScriptSig(sig64, pub33);
  for (const i of tx.inputs) i.scriptSig = scriptSig;
  // The txid leaves out the scriptSig (sha256d over the stripped tx), so it is known before submit and is the
  // answer, not a fallback: a host's echo is only a cross-check of the codec copy, logged and never used (a constant
  // echo would otherwise dedupe later sends out of history and point the explorer link at another transaction).
  const localTxid = codecTxid(tx);
  // The same bytes to every host of the RPC at once (hosts.ts submitEach): one signing, one txid. The result comes at
  // the first acceptance; another host's later answer is logged and changes nothing in the result. A later answer
  // that settles the history row is kept for it (laterFact).
  const body = { tx: txToNodeJson(tx) };
  const main = hostsFor(rpc)[0]!;
  let settle: (f: LaterFact) => void = () => undefined;
  const later = new Promise<LaterFact>((res) => { settle = res; });
  const { outcome, answers, capped } = await submitEach(rpc, (h) => submitTo(h, body), (a, afterCap) => {
    console.info("[node] a later submit answer", localTxid, hostLog(a));
    if (a.host === main) settle(holds(a.verdict) ? "mainHolds" : "open");
    else settle(afterCap && a.verdict.kind === "refused" ? "noneTook" : "open");
  });
  for (const { verdict: v } of answers)
    if (v.kind === "accepted" && v.txid && v.txid.toLowerCase() !== localTxid.toLowerCase())
      console.warn(`[node] submit echoed txid ${v.txid} != locally computed ${localTxid}, using local (codec cross-check)`);
  // One fact for the history row: whether the main host holds the transaction (it answered "accepted" or "already
  // present"). A row recorded while it does not stays maybe until it does (history.ts maybeRecord); when the result
  // came before the main host answered, its later answer is kept for that; after the cap on the main host's refusal,
  // the other host's later refusal is kept as "no host took it" (laterFact).
  const mainAnswer = answers.find((a) => a.host === main);
  const mainHolds = !!mainAnswer && holds(mainAnswer.verdict);
  if ((!mainAnswer && outcome.kind === "sent") || capped) keepLater(localTxid, later);
  return { ...submitResult(outcome, localTxid), hosts: answers.map(hostLog), mainHolds };
}
/** What a host's answer after the result says for the history row: the main host holds it, no host took it (the
 *  other host refused after the cap on the main host's refusal), or nothing settled. */
export type LaterFact = "mainHolds" | "noneTook" | "open";
const holds = (v: HostVerdict): boolean => v.kind === "accepted" || v.kind === "duplicate";
// The later fact of a submit whose result came before the host that settles its row answered, by txid, until history
// takes it. Bounded: an entry no flow takes is dropped with the oldest; module state dies with the worker, and the row
// then stays maybe.
const laterFacts = new Map<string, Promise<LaterFact>>();
const LATER_MAX = 64;
function keepLater(txid: string, p: Promise<LaterFact>): void {
  laterFacts.set(txid, p);
  if (laterFacts.size > LATER_MAX) laterFacts.delete(laterFacts.keys().next().value!);
}
/** The later fact kept for `txid`, taken once; undefined when none is kept. */
export function laterFact(txid: string): Promise<LaterFact> | undefined {
  const p = laterFacts.get(txid);
  laterFacts.delete(txid);
  return p;
}

// Shared assembly tail for every value-moving tx (send / sendMany / fillOffer / buildSignSubmit).
// The CALLER validates its own payment outputs + fee (caps, address shape, safe-integer sums); this
// selects inputs from CHAIN-VERIFIED utxos, returns change ONLY to the wallet's own address (never a
// caller-chosen one), refuses an empty output set, then signs + submits. Single-sourcing it keeps
// that security posture; "inputs internal, change to self"; in ONE audited place. `outputs` are the
// payment outputs BEFORE change; `emptyError` is the message if nothing (incl. change) would be paid.
async function assembleValueTx(
  rpc: string,
  outputs: { value: number; scriptPubkey: string }[],
  fee: number,
  app: App,
  priv: string,
  emptyError = "tx would have no outputs",
  beforeSign?: (txid: string) => SubmitResult | null,
): Promise<SubmitResult> {
  // Reject a zero (or negative) fee at the SINGLE place every value tx is assembled; send, sendMany,
  // propose, attest and fillOffer all route through here. The node enforces a minimum feerate, so a
  // zero-fee tx is built and signed but then silently dropped by the mempool; surface it as a clear
  // error up front instead (audit FEE-FLOOR). Non-negative integer / safe-integer checks stay with the
  // callers that own the fee value.
  // Refuse the zero address at the SINGLE place every value tx is assembled; send, sendMany,
  // propose, attest, fillOffer and buildSignSubmit all route through here. A payment to 0x000…0 is an
  // irrecoverable burn; the popup send form already blocks it, but the dApp send/sendMany/fillOffer paths
  // bypass that form, so the universal backstop lives here (audit M1 / V23 nset-clear burn class). The
  // node accepts a zero-address output, so this MUST be caught client-side. Change is always to self.
  const early = feeBoundsRefusal(fee) ?? zeroAddrRefusal(outputs);
  if (early) return { ok: false, ...early, sighashMatch: false };
  const addr = addrFromPriv(priv);
  const need = outputs.reduce((s, o) => s + o.value, 0) + fee;
  const sv = await selectVerified(rpc, addr, need);
  if ("error" in sv) return { ok: false, error: sv.error, sighashMatch: false, code: sv.code };
  // Proportional fee bound on the CHAIN-VERIFIED selected total, KEEP-IN-SYNC with csd-tx feeCap
  // (packages/tx/src/index.ts: max(1 CSD, 10% of inputs)). Combined with the flat MAX_FEE pre-check
  // above, the effective cap is min(100 CSD, max(1 CSD, 10% of verified inputs)); strictly TIGHTER
  // than either alone: the flat cap alone let a hostile dApp fee of e.g. 400 CSD through on whale
  // coins (>1000 CSD selected). Every legitimate flow's explicit fee is ≤ 0.25 CSD (name fees are
  // OUTPUTS, never this fee param), 4x under the 1 CSD floor; no honest tx can trip this.
  const propCap = proportionalFeeCap(sv.total);
  if (fee > propCap)
    return { ok: false, error: `fee exceeds ${fmtCsd(propCap)} (10% of the coins this spend uses); refusing (a legitimate fee is well under 1 CSD)`, sighashMatch: false, code: "FEE_CAP" };
  const outs = [...outputs];
  const change = sv.total - need; // CHAIN-VERIFIED input total, not the RPC's report
  if (change > 0) outs.push({ value: change, scriptPubkey: addr }); // change back to self
  if (outs.length === 0) return { ok: false, error: emptyError, sighashMatch: false, code: "NO_OUTPUTS" };
  const tx: Tx = { version: 1, locktime: 0, app, inputs: sv.inputs.map((i) => ({ prevTxid: i.txid, vout: i.vout, scriptSig: "0x" })), outputs: outs };
  // The txid leaves out the scriptSig, so this is the txid of the transaction signAndSubmit signs.
  const held = beforeSign?.(codecTxid(tx));
  if (held) return held;
  const r = await signAndSubmit(rpc, tx, priv);
  if (!r.txid) return r;
  return { ...r, inputs: sv.inputs.map((i) => opKey(i.txid, i.vout)), ...(r.ok ? { spentTxids: [...new Set(sv.inputs.map((i) => i.txid.toLowerCase()))] } : {}) };
}

// Per-output validation shared by buildSignSubmit / sendMany / fillOffer. D7 (register §3,
// 2026-09-12): the per-site prose table is COLLAPSED; 16 hand-written strings across three call
// sites, all carrying the same BAD_OUTPUTS code and differing only in the cap number and trivial
// wording. The helper now interpolates the cap itself, one accurate generic message per failure
// mode. The per-caller deltas that are REAL stay: the caps (8/500/100) and minOne (sendMany
// requires ≥1 output; buildSignSubmit/fillOffer deliberately allow an empty set; a token-priced
// fill carries NO CSD outputs). The machine `code` is what unifies the class (WS5). Returns
// {sumOut, outputs} (safe-integer-guarded); the isSafeInteger(sumOut + fee) coupling STAYS at the call
// site (buildSignSubmit intentionally lacks one). Each value is read with csdBase, the parse the approval
// window prints it through (an integer number or a decimal-digit string), and the outputs are built from that
// parse, so the window and the signed tx read one value (test/output-value-parse.test.mjs). An element that is not an
// object is refused like any other bad output, so a page's `[null]` gets BAD_OUTPUTS here and BAD_REQUEST before the
// queue, never a throw (test/send-fill-prequeue.test.mjs).
// An id or an address is read only from a string: String() reads a JSON list as its elements' text and throws on an
// object whose `toString` is not a function (signfields.ts `shape` guards a score or confidence the same way).
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/, TXID_RE = /^0x[0-9a-fA-F]{64}$/;
const isText = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);
type ParsedOutputs = { sumOut: number; outputs: { value: number; scriptPubkey: string }[] };
function validateOutputs(outs: readonly unknown[], opts: { max: number; minOne: boolean }): SubmitResult | ParsedOutputs {
  if (opts.minOne && outs.length < 1) return { ok: false, error: "at least one output is required", sighashMatch: false, code: "BAD_OUTPUTS" };
  if (outs.length > opts.max) return { ok: false, error: `too many outputs (max ${opts.max})`, sighashMatch: false, code: "BAD_OUTPUTS" };
  let sumOut = 0;
  const outputs: ParsedOutputs["outputs"] = [];
  for (const el of outs) {
    if (!el || typeof el !== "object") return { ok: false, error: "each output must be an object { to, value }", sighashMatch: false, code: "BAD_OUTPUTS" };
    const o = el as { to?: unknown; value?: unknown };
    if (!isText(o.to, ADDR_RE)) return { ok: false, error: "each recipient must be a 0x… 20-byte address", sighashMatch: false, code: "BAD_OUTPUTS" };
    const b = csdBase(o.value);
    const v = b !== null && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : NaN;
    if (!(v > 0) || !Number.isSafeInteger(v)) return { ok: false, error: "each amount must be a positive safe integer", sighashMatch: false, code: "BAD_OUTPUTS" };
    sumOut += v;
    if (!Number.isSafeInteger(sumOut)) return { ok: false, error: "outputs exceed the safe integer range", sighashMatch: false, code: "BAD_OUTPUTS" };
    outputs.push({ value: v, scriptPubkey: o.to as string });
  }
  return { sumOut, outputs };
}

// `payouts` are optional value outputs carried in the SAME tx as the app payload (e.g. a
// CairnX protocol fee to the treasury on a deploy / name registration). Same posture as
// send/fillOffer: each recipient validated, sums safe-integer-guarded, inputs selected
// internally, change ONLY to the wallet's own address; a dApp can't pick UTXOs or redirect change.
async function buildSignSubmit(rpc: string, app: App, fee: number, priv: string, payouts: { to: string; value: number }[] = []): Promise<SubmitResult> {
  const badFee = feeTypeRefusal(fee);
  if (badFee) return { ok: false, ...badFee, sighashMatch: false };
  // Cap the value outputs a Propose may carry (normally one protocol-fee output). Prevents a
  // hostile dApp from flooding the clear-signing window with hundreds of disguised payments.
  const chk = validateOutputs(payouts, { max: 8, minOne: false });
  if (!("sumOut" in chk)) return chk;
  return assembleValueTx(rpc, chk.outputs, fee, app, priv);
}

type Refusal = { code: string; error: string };
// The fee checks that need no coins, one home each: the engine runs them at signing and proposeRefusal before the queue.
// The proportional cap needs the selected inputs, so it stays in assembleValueTx.
const feeTypeRefusal = (fee: unknown): Refusal | null =>
  Number.isSafeInteger(fee) && (fee as number) >= 0 ? null : { code: "BAD_FEE", error: "fee out of safe integer range" };
function feeBoundsRefusal(fee: number): Refusal | null {
  if (!(fee > 0)) return { code: "FEE_TOO_LOW", error: "fee must be positive (the node enforces a minimum fee)" };
  if (fee > MAX_FEE) return { code: "FEE_CAP", error: `fee exceeds the ${fmtCsd(MAX_FEE)} safety cap; refusing (a legitimate fee is well under 1 CSD)` };
  return null;
}
function zeroAddrRefusal(outputs: { scriptPubkey: string }[]): Refusal | null {
  // (0x)? so the guard matches whether or not the caller carries the codec prefix (QA #3)
  return outputs.some((o) => /^(0x)?0{40}$/i.test(o.scriptPubkey))
    ? { code: "ZERO_ADDR_REFUSED", error: "refusing to send to the zero address (0x000…0): these funds would be unrecoverable" } : null;
}

// The coin-free checks of a send, a multi-output send and a fill, in the order the engine runs them. send, sendMany and
// fillOffer below run their own before they select a coin, and background.ts asks the same function before it queues a
// page's request (sendRefusal, fillTxRefusal), so the approval window does not open for a request the signer refuses
// on its parameters alone (test/send-fill-prequeue.test.mjs). What needs the selected coins (the proportional fee cap,
// the balance) stays in assembleValueTx, which repeats the fee bounds and the zero address for every value tx.
type Checked = SubmitResult | ParsedOutputs;
const asRefusal = (c: Checked): Refusal | null => ("sumOut" in c ? null : { code: String(c.code), error: String(c.error) });
const sumRange = (): SubmitResult => ({ ok: false, error: "amount/fee exceed the safe integer range", sighashMatch: false, code: "BAD_FEE" });
const sumFits = (sumOut: number, fee: unknown): boolean => Number.isSafeInteger(fee) && (fee as number) >= 0 && Number.isSafeInteger(sumOut + (fee as number));
function coinFree(fee: number, parsed: ParsedOutputs): Checked {
  const bad = feeBoundsRefusal(fee) ?? zeroAddrRefusal(parsed.outputs);
  return bad ? { ok: false, ...bad, sighashMatch: false } : parsed;
}
function sendChecks(p: { to: unknown; amount: unknown; fee: unknown }): Checked {
  if (!isText(p.to, ADDR_RE)) return { ok: false, error: "recipient must be a 0x… 20-byte address", sighashMatch: false, code: "BAD_OUTPUTS" };
  // `>` would coerce a JSON object, which throws when it carries a `toString` that is not a function
  const amount = p.amount !== null && typeof p.amount === "object" ? Number.NaN : p.amount;
  if (!((amount as number) > 0)) return { ok: false, error: "amount must be positive", sighashMatch: false, code: "BAD_OUTPUTS" };
  // CSD amounts are integer base units carried as JS numbers. Above 2^53 a Number silently loses precision, so the
  // value signed could differ from the one meant: anything outside the exactly representable range is refused.
  if (!Number.isSafeInteger(p.amount) || !sumFits(p.amount as number, p.fee)) return sumRange();
  return coinFree(p.fee as number, { sumOut: p.amount as number, outputs: [{ value: p.amount as number, scriptPubkey: p.to as string }] });
}
function sendManyChecks(p: { outputs: unknown; fee: unknown }): Checked {
  const chk = validateOutputs(Array.isArray(p.outputs) ? p.outputs : [], { max: 500, minOne: true });
  if (!("sumOut" in chk)) return chk;
  return sumFits(chk.sumOut, p.fee) ? coinFree(p.fee as number, chk) : sumRange();
}
function fillChecks(p: { proposalId: unknown; outputs: unknown; fee: unknown }): Checked {
  if (!isText(p.proposalId, TXID_RE)) return { ok: false, error: "proposalId must be a 0x… 32-byte txid", sighashMatch: false, code: "BAD_REQUEST" };
  // outs MAY be empty: a token-priced fill pays in tokens (resolver-debited, marked by confidence 1e6) and carries no
  // CSD payment; the tx is attest + change only.
  const chk = validateOutputs(Array.isArray(p.outputs) ? p.outputs : [], { max: 100, minOne: false });
  if (!("sumOut" in chk)) return chk;
  return sumFits(chk.sumOut, p.fee) ? coinFree(p.fee as number, chk) : sumRange();
}
/** Why the engine refuses a page's send on its parameters alone, or null. `s` is signfields.ts sendFields: `outputs`
 *  (signed by sendMany) when the page passed an array, else the one output from `to` and `amount` (signed by send). */
export function sendRefusal(s: { many: boolean; outputs: readonly unknown[]; fee: unknown }): Refusal | null {
  const one = s.outputs[0] as { to?: unknown; value?: unknown } | undefined;
  return asRefusal(s.many || !one ? sendManyChecks({ outputs: s.outputs, fee: s.fee }) : sendChecks({ to: one.to, amount: one.value, fee: s.fee }));
}
/** Why the engine refuses a fill's transaction on its parameters alone (signfields.ts fillFields), or null. The fill's
 *  preflight checks that read nothing come first (fillpreflight.ts fillRefusal). */
export function fillTxRefusal(f: { proposalId: unknown; outputs: readonly unknown[]; fee: unknown }): Refusal | null {
  return asRefusal(fillChecks(f));
}
/** A proposal's fee: the coin-free fee checks, and the node's proposal minimum (it rejects a Propose below
 *  MIN_FEE_PROPOSE, the floor csd-tx's buildPropose applies). background.ts asks it for a seal too. */
export function proposeFeeRefusal(fee: unknown): Refusal | null {
  const bad = feeTypeRefusal(fee) ?? feeBoundsRefusal(fee as number);
  if (bad) return bad;
  return (fee as number) < MIN_FEE_PROPOSE ? { code: "FEE_TOO_LOW", error: `a proposal's fee must be at least ${fmtCsd(MIN_FEE_PROPOSE)}, the minimum the network takes` } : null;
}
/** Why the engine refuses a proposal's parameters, before it selects a coin, or null. background.ts asks the same
 *  function before it queues a page's propose, so the window never opens for a request the signer would refuse
 *  (test/propose-prequeue.test.mjs). A malformed payloadHash or expiresEpoch would otherwise throw in the codec or wrap
 *  in u64() (a signed "never expires"); a domain or uri of the wrong type throws there, and one past the consensus byte
 *  caps or with an unpaired surrogate signs a transaction the node rejects. `outputs` is what proposeFields reads (an
 *  array, or none). What it cannot judge stays at signing: the proportional fee cap and the balance need the selected
 *  coins. The node's other Propose rules (an empty domain or uri, an all-zero payload hash) are not in csd-sdk, and the
 *  wallet does not re-declare consensus: the node refuses those at submit, with nothing spent. */
export function proposeRefusal(p: { domain: unknown; payloadHash: unknown; uri: unknown; expiresEpoch: unknown; fee: unknown; outputs: { to: string; value: number }[] }): Refusal | null {
  if (!isText(p.payloadHash, TXID_RE)) return { code: "BAD_REQUEST", error: "payloadHash must be a 0x… 32-byte hash" };
  if (!Number.isSafeInteger(p.expiresEpoch) || (p.expiresEpoch as number) < 0) return { code: "BAD_REQUEST", error: "expiresEpoch must be a non-negative safe integer" };
  const text = byteCapRefusal("domain", p.domain, MAX_DOMAIN_BYTES) ?? byteCapRefusal("uri", p.uri, MAX_URI_BYTES);
  if (text) return { code: "BAD_REQUEST", error: text };
  const fee = proposeFeeRefusal(p.fee);
  if (fee) return fee;
  const chk = validateOutputs(p.outputs, { max: 8, minOne: false });
  return "sumOut" in chk ? zeroAddrRefusal(chk.outputs) : { code: "BAD_OUTPUTS", error: String(chk.error) };
}
export function propose(rpc: string, p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; outputs?: { to: string; value: number }[] }, priv: string): Promise<SubmitResult> {
  const outputs = Array.isArray(p.outputs) ? p.outputs : [];
  const bad = proposeRefusal({ ...p, outputs });
  if (bad) return Promise.resolve({ ok: false, error: bad.error, sighashMatch: false, code: bad.code });
  return buildSignSubmit(rpc, { type: "Propose", domain: p.domain, payloadHash: p.payloadHash, uri: p.uri, expiresEpoch: p.expiresEpoch }, p.fee, priv, outputs);
}
/** Why the engine refuses an attest on its parameters alone, before it selects a coin, or null: the proposalId (a txid;
 *  a malformed one would otherwise throw in the codec), then the coin-free fee checks buildSignSubmit and
 *  assembleValueTx run. background.ts asks it before it queues a page's attest (test/request-shape-prequeue.test.mjs). */
export function attestRefusal(p: { proposalId: unknown; fee: unknown }): Refusal | null {
  if (!isText(p.proposalId, TXID_RE)) return { code: "BAD_REQUEST", error: "proposalId must be a 0x… 32-byte txid" };
  return feeTypeRefusal(p.fee) ?? feeBoundsRefusal(p.fee as number);
}
export function attest(rpc: string, p: { proposalId: unknown; score: number; confidence: number; fee: number }, priv: string): Promise<SubmitResult> {
  const bad = attestRefusal(p);
  if (bad) return Promise.resolve({ ok: false, error: bad.error, sighashMatch: false, code: bad.code });
  // Clamp to u32 here (parity with fillOffer) so the signed bytes equal the displayed score/confidence.
  return buildSignSubmit(rpc, { type: "Attest", proposalId: p.proposalId as string, score: p.score >>> 0, confidence: p.confidence >>> 0 }, p.fee, priv);
}

// Plain CSD transfer (app:None). Built + signed entirely client-side; sighash via
// our golden-vector-validated codec, so no node template is needed; /tx/submit
// validates the signature against the node's own (identical) sighash.
export async function send(rpc: string, p: { to: string; amount: number; fee: number }, priv: string): Promise<SubmitResult> {
  const chk = sendChecks(p);
  if (!("sumOut" in chk)) return chk;
  return assembleValueTx(rpc, chk.outputs, p.fee, { type: "None" }, priv);
}

// Multi-output transfer (app:None). Same single-key / single-signature model as
// send(): every recipient is validated, the sum of all outputs + fee is safe-integer
// guarded, inputs are selected INTERNALLY (never supplied by a caller/dApp), and the
// change always returns to this account's own address. Used by the Console's send card
// for 1→many payments; send() above is the single-recipient convenience wrapper.
export async function sendMany(rpc: string, p: { outputs: { to: string; value: number }[]; fee: number }, priv: string): Promise<SubmitResult> {
  const chk = sendManyChecks(p);
  if (!("sumOut" in chk)) return chk;
  return assembleValueTx(rpc, chk.outputs, p.fee, { type: "None" }, priv);
}

// Merge many small coins into ONE output back to the wallet's own address, so a later large send
// fits the MAX_TX_INPUTS per-transaction cap (a pure-50-CSD-coinbase holder otherwise tops out at
// 512×50 = 25,600 CSD per tx and, worse, pays the fee on 500+ inputs every time). Same trust
// posture as every other spend: every input CHAIN-VERIFIED before signing (TXB-1, verifyInputValues
// unchanged), the single output goes ONLY to the address derived from the signing key (a caller/UI
// cannot redirect it), signed locally via the shared signAndSubmit. Selection is SMALLEST-FIRST:
// the deliberate opposite of send's largest-first cover-`need`; because the point is to retire
// fragments; up to MAX_TX_INPUTS coins per run, callers re-run to merge the rest (`remaining`).
// CSD has NO coinbase-maturity rule (verified against consensus params 2026-07-09), so any
// ≥1-confirmation coin is mergeable. Popup-only (NOT in DAPP_METHODS; a dApp has no business
// restructuring the user's coins; there is nothing to clear-sign that the preview doesn't show).
// `truncated`: the node cut the coin list, so `remaining` counts the listed coins left and the address holds more.
export async function consolidate(rpc: string, p: { fee: number }, priv: string): Promise<SubmitResult & { merged?: number; remaining?: number; truncated?: boolean; total?: number }> {
  const fee = Number(p?.fee);
  if (!Number.isSafeInteger(fee) || !(fee > 0)) return { ok: false, error: "fee must be a positive integer", sighashMatch: false, code: "BAD_FEE" };
  if (fee > MAX_FEE) return { ok: false, error: `fee exceeds the ${fmtCsd(MAX_FEE)} safety cap; refusing`, sighashMatch: false, code: "FEE_CAP" };
  const addr = addrFromPriv(priv);
  let utxos: any[], host: string;
  let truncated = false;
  try { ({ value: { utxos, truncated }, host } = await firstAnswer(rpc, (h) => balanceAt(h, addr))); }
  catch { return { ok: false, error: "couldn't fetch your coins (node unreachable or erroring); nothing was signed, try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" }; }
  // Same ghost handling as selectVerified: known-unprovable outpoints are pre-excluded, fresh
  // ghosts exclude-and-retry within the same bounded round budget, and no coin is EVER spent
  // unverified. tamper/transient verdicts refuse exactly as a send would.
  const now = Date.now();
  const exclude = sessionExclusions(host, now);
  const verified = new Map<string, number>();
  for (let round = 0; round < MAX_SELECT_ROUNDS; round++) {
    const pool = spendableCoins(utxos, exclude).sort((a, b) => a.value - b.value).slice(0, MAX_TX_INPUTS);
    if (pool.length < 2) return { ok: false, error: "nothing to consolidate: fewer than two spendable coins", sighashMatch: false, code: "NOTHING_TO_CONSOLIDATE" };
    const ver = await verifyInputValues(host, pool, verified);
    if (!ver.ok) {
      if (ver.kind === "tamper") return { ok: false, error: "could not verify selected coins against the chain (refusing to risk a burned fee)", sighashMatch: false, code: "VERIFY_TAMPER" };
      if (ver.kind === "transient") return { ok: false, error: "couldn't fetch source transactions to verify coin values (node unreachable or erroring); nothing was signed, try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
      // BN0w: both skip classes (ghost + horizon) exclude-and-retry alike here; consolidate simply
      // merges what THIS node can prove today (the send path owns the distinct honest refusal copy).
      if (ver.kind === "horizon") for (const h of ver.horizons) { const k = opKey(h.txid, h.vout); exclude.add(k); rememberSkip(horizonSeen, host, k, now); }
      // W6 (ND-1): the same exclude-and-retry, and THIS is the line that unbricks consolidate() against a
      // single dust coin from a stranger. The pool is smallest-first, so the poison coin was in every
      // round and its "tamper" verdict refused the whole merge, permanently.
      if (ver.kind === "unrepresentable") for (const u of ver.unrepresentables) { const k = opKey(u.txid, u.vout); exclude.add(k); rememberSkip(unrepSeen, host, k, now); }
      for (const g of ver.ghosts) { const k = opKey(g.txid, g.vout); exclude.add(k); rememberSkip(ghostSeen, host, k, now); }
      continue;
    }
    const outValue = ver.total - fee; // ver.total is CHAIN-VERIFIED and safe-integer-guarded by the fold
    if (!(outValue > 0)) return { ok: false, error: "these coins are too small to cover the fee: nothing to gain by merging them", sighashMatch: false, code: "INSUFFICIENT" };
    // Same proportional fee cap assembleValueTx applies to every other value tx (min(100 CSD,
    // max(1 CSD, 10% of the CHAIN-VERIFIED inputs)); consolidate builds its tx directly rather than
    // through assembleValueTx, so it MUST re-assert the single-fee-chokepoint invariant itself: a
    // compromised UI must not be able to steer this into burning a huge fee past the 0.01 CSD the
    // preview shows. No honest merge approaches it (the popup hardcodes 0.01 CSD).
    const propCap = proportionalFeeCap(ver.total);
    if (fee > propCap) return { ok: false, error: `fee exceeds ${fmtCsd(propCap)} (10% of the coins this merge uses); refusing`, sighashMatch: false, code: "FEE_CAP" };
    const remaining = spendableCoins(utxos, exclude).length - pool.length;
    const tx: Tx = { version: 1, locktime: 0, app: { type: "None" }, inputs: pool.map((i) => ({ prevTxid: i.txid, vout: i.vout, scriptSig: "0x" })), outputs: [{ value: outValue, scriptPubkey: addr }] };
    const r = await signAndSubmit(rpc, tx, priv);
    return { ...r, merged: pool.length, remaining, truncated, total: ver.total, ...(r.txid ? { inputs: pool.map((i) => opKey(i.txid, i.vout)) } : {}), ...(r.ok ? { spentTxids: [...new Set(pool.map((i) => i.txid.toLowerCase()))] } : {}) };
  }
  let skipped = 0, skippedValue = 0;
  for (const c of spendableCoins(utxos)) if (exclude.has(opKey(c.txid, c.vout))) { skipped++; skippedValue += c.value; }
  const ex = roundsExhausted(skipped, skippedValue);
  return { ok: false, error: ex.error, sighashMatch: false, code: ex.code };
}

// Read-only preview for the consolidate confirmation card: how many coins are spendable, how many
// one run would merge, their REPORTED total and the resulting single-coin value. Display only:
// consolidate() re-derives everything from chain-verified values before signing, so a hostile RPC
// inflating this preview gains nothing (the signed tx uses verified totals or refuses).
export async function consolidatePreview(rpc: string, addr: string, fee: number): Promise<{ ok: boolean; coins?: number; truncated?: boolean; merge?: number; total?: number; out?: number; error?: string }> {
  try {
    const { utxos, truncated } = await balance(rpc, addr);
    const pool = spendableCoins(utxos).sort((a, b) => a.value - b.value);
    const merge = Math.min(pool.length, MAX_TX_INPUTS);
    let total = 0;
    for (const c of pool.slice(0, merge)) { total += c.value; if (!Number.isSafeInteger(total)) return { ok: false, error: "coin values out of range" }; }
    return { ok: true, coins: pool.length, truncated, merge, total, out: Math.max(0, total - Number(fee)) };
  } catch { return { ok: false, error: "node unreachable" }; }
}

// The largest amount one send (`send`, through assembleValueTx) accepts right now with `fee`, in two passes over the
// engine's own selectVerified. The first finds the figure: each round's target is the reported total of the
// MAX_TX_INPUTS largest coins still eligible (spendableCoins minus the coins that round's checks excluded), the most
// selectInputs can cover in one transaction, and every coin it selects is chain-verified as a send verifies it. The
// second is the send's own call, selectVerified with the number need = figure (amount plus fee), starting from the
// session caches the first pass filled; Max answers only when that pass succeeds, so the figure is one the send's
// selection accepted, not one derived to be acceptable. The same fee checks as a send apply. Signs nothing.
// A send of exactly this amount repeats that numeric pass. It accepts while the state is the same: coins spent,
// arriving or turning unprovable change what it accepts, and once the session caches expire (GHOST_TTL_MS) a send can
// spend its rounds rediscovering skipped coins and refuse VERIFY_UNAVAILABLE, nothing signed, before its retry, which
// starts from what the first attempt cached, goes through (test/maxsendable.test.mjs). Popup-only (not in
// DAPP_METHODS).
// `eligible`: the spendable coins after the checks; `skipped`: the spendable coins the checks left out (unprovable).
/** Max's words when every spendable coin was skipped: each class with what is true about retrying it
 *  (WALLET-ERROR-CODES.md). A coin the caches no longer name (a cleared map) is "could not be proved". */
function allSkippedText(by: { ghost: number; horizon: number; unrep: number }, skipped: number): string {
  const n = (k: number) => `${k} coin${k === 1 ? "" : "s"}`;
  const other = skipped - by.ghost - by.horizon - by.unrep;
  const parts = [
    by.ghost ? `the node cannot find the source of ${n(by.ghost)} on its chain, and retrying changes nothing until it can` : "",
    by.horizon ? `the node cannot look back far enough to prove ${n(by.horizon)}; ${by.horizon === 1 ? "it becomes" : "they become"} spendable once its index catches up or it is upgraded` : "",
    by.unrep ? `${n(by.unrep)} ${by.unrep === 1 ? "carries" : "carry"} a number this wallet cannot represent exactly, so it cannot spend ${by.unrep === 1 ? "it" : "them"}` : "",
    other > 0 ? `${n(other)} could not be proved against the chain` : "",
  ].filter(Boolean);
  return `none of your coins can be checked against the chain: ${parts.join("; ")}. Nothing was signed`;
}
// `truncated`: the node listed only its largest coins, so `eligible` counts those and the address holds more.
export type MaxSend = { ok: true; amount: number; fee: number; inputs: number; eligible: number; skipped: number; capped: boolean; truncated: boolean } | { ok: false; error: string; code: string };
export async function maxSendable(rpc: string, addr: string, fee: number): Promise<MaxSend> {
  if (!Number.isSafeInteger(fee) || !(fee > 0)) return { ok: false, error: "fee must be a positive integer", code: "BAD_FEE" };
  if (fee > MAX_FEE) return { ok: false, error: `fee exceeds the ${fmtCsd(MAX_FEE)} safety cap; refusing`, code: "FEE_CAP" };
  let eligible = 0, skipped = 0, target = 0, truncated = false;
  const skippedBy = { ghost: 0, horizon: 0, unrep: 0 };
  const verified = new Map<string, number>();
  const found = await selectVerified(rpc, addr, (utxos, exclude, cut, host) => {
    truncated = cut;
    const coins = spendableCoins(utxos, exclude).sort((a, b) => b.value - a.value);
    eligible = coins.length;
    const left = spendableCoins(utxos).filter((c) => exclude.has(opKey(c.txid, c.vout)));
    skipped = left.length;
    skippedBy.ghost = left.filter((c) => ghostSeen.has(skipKey(host, opKey(c.txid, c.vout)))).length;
    skippedBy.horizon = left.filter((c) => horizonSeen.has(skipKey(host, opKey(c.txid, c.vout)))).length;
    skippedBy.unrep = left.filter((c) => unrepSeen.has(skipKey(host, opKey(c.txid, c.vout)))).length;
    target = coins.slice(0, MAX_TX_INPUTS).reduce((s, c) => s + c.value, 0);
    // nothing eligible: a positive target makes the selection fail cleanly (INSUFFICIENT, or the skip reason)
    return target > 0 ? target : 1;
  }, verified);
  // Max's own words: the engine's copy for a failed round names the round's internal target as "this spend"
  if ("error" in found) {
    if (eligible === 0 && skipped === 0 && found.code === "INSUFFICIENT") return { ok: true, amount: 0, fee, inputs: 0, eligible: 0, skipped: 0, capped: false, truncated };
    if (eligible === 0 && skipped > 0) return { ok: false, error: allSkippedText(skippedBy, skipped), code: found.code };
    if (found.code === "INSUFFICIENT") return { ok: false, error: "your coins are worth less on the chain than the node reports, so no amount can be worked out. Nothing was signed", code: "INSUFFICIENT" };
    return { ok: false, error: found.error, code: found.code };
  }
  if (target <= fee) return { ok: true, amount: 0, fee, inputs: 0, eligible, skipped, capped: false, truncated };
  const sv = await selectVerified(rpc, addr, target, verified);
  if ("error" in sv) {
    if (sv.code === "VERIFY_TAMPER") return { ok: false, error: sv.error, code: sv.code };
    const next = sv.code === "VERIFY_UNAVAILABLE" ? "try again shortly" : "press Max again to work it out from your coins as they are now";
    return { ok: false, error: `the most one transaction can send could not be confirmed against the chain just now. Nothing was signed; ${next}`, code: sv.code };
  }
  if (fee > proportionalFeeCap(sv.total)) return { ok: false, error: `fee exceeds ${fmtCsd(proportionalFeeCap(sv.total))} (10% of the coins this spend uses); refusing`, code: "FEE_CAP" };
  return { ok: true, amount: target - fee, fee, inputs: sv.inputs.length, eligible, skipped, capped: eligible > MAX_TX_INPUTS, truncated };
}

// Fill an on-chain offer: ONE transaction
// that carries an Attest app payload AND payment outputs. Same trust posture as sendMany:
// recipients validated, sums safe-integer guarded, inputs selected INTERNALLY, change only
// ever returns to this account's own address. The attest fee floor (0.05 CSD) applies.
/** `beforeSign` sees the txid of the assembled transaction and may refuse it before it is signed (wallet.ts fillOffer:
 *  the repeated-fill rule, fillpreflight.ts repeatedFillRefusal). */
export async function fillOffer(
  rpc: string,
  p: { proposalId: string; score: number; confidence: number; outputs: { to: string; value: number }[]; fee: number },
  priv: string,
  beforeSign?: (txid: string) => SubmitResult | null,
): Promise<SubmitResult> {
  const chk = fillChecks(p);
  if (!("sumOut" in chk)) return chk;
  return assembleValueTx(rpc, chk.outputs, p.fee, { type: "Attest", proposalId: p.proposalId, score: p.score >>> 0, confidence: p.confidence >>> 0 }, priv, "tx would have no outputs: add a payment or leave change", beforeSign);
}

// Register a Cairn item's off-chain content (hash-verified by the server). Bounded like every other POST:
// a hung request would otherwise hold flushPending's in-flight latch and a revealClaim approval.
// Never throws. A non-2xx answer resolves { ok: false, error, status } with the HTTP status, so the content queue can
// tell the server's lasting refusal (contentRefusedForGood) from an outage.
export function registerContent(apiBase: string, content: any, txid: string, timeoutMs = POST_TIMEOUT_MS): Promise<any> {
  return fetch(`${apiBase}/api/content`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...content, txid }), signal: AbortSignal.timeout(timeoutMs) }).then(async (r) => {
    let j: any;
    try { j = await r.json(); } catch { j = undefined; }
    if (r.ok) return j && typeof j === "object" ? j : { ok: false, error: "/api/content -> unreadable response" };
    const body = j && typeof j === "object" && !Array.isArray(j) ? j : {};
    return { ...body, ok: false, error: String(body.error ?? body.err ?? `/api/content -> ${r.status}`), status: r.status };
  }).catch((e) => ({ ok: false, error: String(e) }));
}
/** 400, 413 and 422 are the server refusing this body for good (a malformed request, a body over its cap, content it
 *  cannot take); a retry gets the same answer. Anything else may pass later: a 5xx, a rate limit, a 200 {ok:false}, and a
 *  401, 403 or 404, which Cairn's content route never sends (they come from something in front of it, such as an edge
 *  challenge, or from an API setting the user may still fix). */
export function contentRefusedForGood(r: { status?: unknown } | null | undefined): boolean {
  const s = Number(r?.status);
  return s === 400 || s === 413 || s === 422;
}

// Sign in with CSD against the Cairn API: fetch nonce, sign its digest locally, verify.
export async function signIn(apiBase: string, priv: string): Promise<{ ok: boolean; addr?: string; session?: string; error?: string }> {
  const n = await post(apiBase, "/auth/nonce", {});
  if (!n?.ok || !n.nonce) return { ok: false, error: "could not get nonce" };
  // Derive the digest LOCALLY from the nonce; never sign the server's `digest`
  // field. Otherwise a malicious/MITM'd API could return a tx sighash and harvest a
  // valid spend signature from the login flow (see test/poc-signin-oracle.ts).
  const { sig64, pub33 } = signSighash(loginDigest(String(n.nonce)), priv);
  const v = await post(apiBase, "/auth/verify", { nonce: n.nonce, pub33, sig64 });
  // Normalize the failure shape to this function's declared `error` key; post() returns {ok:false,err}
  // on a non-2xx body (VAL-2), and this legacy path's callers read `.error`.
  return v?.ok ? v : { ok: false, error: v?.error ?? v?.err ?? "sign-in failed" };
}
