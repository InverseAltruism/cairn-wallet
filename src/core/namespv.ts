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
import { LightClient, CsdClient, rpcTxToTx, txid as ctxid, sighash, merkleRoot, addrFromPub, verifyDigest, resolve, type RpcTxJson, type Tx } from "../vendor/cairnx-spv.js";

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
}

export interface NameClaim { addr?: string; owner?: string; via?: string; lapsed?: boolean }
export interface NameHint { txid: string; height: number; pos: number; kind?: string }

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
}

// Headers to sync past the last record so its inclusion proof has a confirmation cushion. The verifier
// never needs the full chain tip for inclusion — only up to the records it must prove.
const CONF_BUFFER = 12;

const fail = (reason: string): NameVerification => ({ verified: false, reason, scope: "as-shown" });

// outputs → addr→sum(value) map (the resolver's `paidTo`). Mirrors the scanner: a malformed output is
// SKIPPED (conservative — dropping a fee output can only make a fee look unpaid → reject, never overpay).
function outputsToPaidTo(outputs: Tx["outputs"]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const o of outputs) {
    const v = Number(o.value);
    if (!Number.isSafeInteger(v) || v < 0) continue;
    const a = String(o.scriptPubkey ?? "").toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(a)) continue;
    const addr = "0x" + a;
    m[addr] = (BigInt(m[addr] ?? "0") + BigInt(v)).toString();
  }
  return m;
}

// Recover + AUTHENTICATE a tx's signer. scriptSig = 0x40‖sig64‖0x21‖pub33 (99 bytes). The signature MUST
// validate against sighash(tx): the merkle root commits the tx BODY but not the scriptSig, so without this
// a lying node could re-attribute (or fabricate) a record's author. null on any malformation / bad sig.
function recoverSigner(tx: Tx): string | null {
  const ss = tx.inputs?.[0]?.scriptSig;
  if (typeof ss !== "string") return null;
  const hex = ss.startsWith("0x") ? ss.slice(2) : ss;
  if (hex.length !== 198 || hex.slice(0, 2) !== "40" || hex.slice(130, 132) !== "21") return null;
  const sig = "0x" + hex.slice(2, 130), pub = "0x" + hex.slice(132, 198);
  try { if (!verifyDigest(sig, pub, sighash(tx))) return null; return addrFromPub(pub).toLowerCase(); }
  catch { return null; }
}

// Reconstruct a resolver ChainEvent from a merkle-verified, signer-authenticated tx. Returns null for a
// non-cairnx tx or a bad signature (the caller fail-closes — a hinted tx we can't faithfully replay is a
// lying read). Field shapes match the scanner exactly so resolve() produces identical state.
function toChainEvent(tx: Tx, id: string, height: number, pos: number): Record<string, unknown> | null {
  if (!tx.app || tx.app.type === "None") return null;
  const signer = recoverSigner(tx);
  if (!signer) return null;
  const paidTo = outputsToPaidTo(tx.outputs);
  if (tx.app.type === "Propose") {
    return { kind: "propose", id: id.toLowerCase(), proposer: signer, uri: tx.app.uri, payloadHash: String(tx.app.payloadHash).toLowerCase(), expiresEpoch: Number(tx.app.expiresEpoch), height, pos, paidTo };
  }
  const conf = Number(tx.app.confidence);
  return { kind: "attest", txid: id.toLowerCase(), proposalId: String(tx.app.proposalId).toLowerCase(), attester: signer, score: Number(tx.app.score), confidence: Number.isSafeInteger(conf) && conf >= 0 ? conf : 0, height, pos, paidTo };
}

/**
 * Verify `name → claim.addr` against the chain via SPV + an audited replay. Returns a tri-state-friendly
 * NameVerification. `hints` are the UNTRUSTED txids from /cairnx/name-history; `src` is the PoW-verified
 * block source. Pure over `src` so it is fully Node-testable.
 */
export async function verifyName(name: string, claim: NameClaim, hints: NameHint[], src: SpvSource): Promise<NameVerification> {
  try {
    if (!claim?.addr || !/^0x[0-9a-f]{40}$/.test(String(claim.addr).toLowerCase())) return fail("the resolver returned no usable address for this name");
    if (claim.lapsed) return fail(`${name}.csd lease has lapsed — refusing to send`);
    if (!Array.isArray(hints) || hints.length === 0) return fail("no on-chain records were offered for this name");

    // group hinted txids by block height — verify each block ONCE against its PoW-committed merkle root
    const byHeight = new Map<number, NameHint[]>();
    let maxHeight = 0;
    for (const h of hints) {
      const height = Number(h.height);
      if (!Number.isInteger(height) || height < 0) return fail("a record hint has an invalid height");
      (byHeight.get(height) ?? byHeight.set(height, []).get(height)!).push(h);
      if (height > maxHeight) maxHeight = height;
    }
    // sync verified headers up to the LAST record (+cushion) — not the whole chain. `nodeTip` (untrusted)
    // drives only the lease-lapse epoch, fail-closed: a higher tip can only make a name read as lapsed.
    const { verifiedTip, nodeTip } = await src.prepare(maxHeight);
    if (maxHeight > verifiedTip) return fail(`a record at height ${maxHeight} is above the verified tip (${verifiedTip})`);
    const lapseTip = Math.max(verifiedTip, Number.isFinite(nodeTip) ? nodeTip : 0);

    const events: Record<string, unknown>[] = [];
    for (const [height, hs] of byHeight) {
      const { merkle, txs } = await src.blockAt(height);            // THROWS if the header can't be PoW-verified
      // A plain/coinbase tx may carry no `app`; default it to {None} BEFORE decode so a hostile node
      // can't omit `app` on one filler tx to make rpcTxToTx throw and DoS the whole verify (swapguard does
      // the same `jt.app || {type:"None"}` guard). A None tx still has a real txid → the merkle bind holds.
      const rebuilt = txs.map((t) => rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } }));
      const ids = rebuilt.map(ctxid);
      // FULL-block bind: the entire tx-set must hash to the verified header's merkle root, so the node
      // cannot have omitted/altered/added any committed body within this block (completeness-in-block).
      if (String(merkleRoot(ids)).toLowerCase() !== String(merkle).toLowerCase()) return fail(`block ${height} doesn't match its verified merkle root (tampered read path)`);
      for (const hint of hs) {
        const pos = ids.findIndex((x) => x.toLowerCase() === String(hint.txid).toLowerCase());
        if (pos < 0) return fail(`record ${hint.txid} is not in verified block ${height}`);
        const ev = toChainEvent(rebuilt[pos], ids[pos], height, pos);
        if (!ev) return fail(`record ${hint.txid} couldn't be authenticated (not a signed cairnx record)`);
        events.push(ev);
      }
    }

    // Replay the AUDITED resolver over ONLY the verified events. nameHistory() guarantees this scoped set
    // reproduces the full-chain name record (proven by cairnx/test/namehist.test.ts). `lapseTip` (≥ the
    // node-reported chain tip) drives the lease-lapse epoch fail-closed.
    const state = resolve(events, lapseTip);
    const rec = state.names[name];
    if (!rec) return fail("the verified records don't establish ownership of this name");
    if (rec.expired) return fail(`${name}.csd lease has lapsed (per the chain) — refusing to send`);
    const owner = String(rec.owner).toLowerCase();
    const addr = String(rec.addr ?? rec.owner).toLowerCase();
    // THE comparison: the chain-recomputed address must equal what the resolver claimed. A hostile
    // resolver that fabricated a redirect cannot pass this — it has no signed, mined events for 0xATTACKER.
    if (addr !== String(claim.addr).toLowerCase())
      return fail("the resolver's address does NOT match what the chain proves — refusing (possible hostile resolver)");
    return { verified: true, addr, owner, via: rec.addr ? "nset" : "owner", depth: Math.max(0, verifiedTip - maxHeight + 1), scope: "as-shown" };
  } catch (e) {
    return fail(`couldn't verify on-chain (fail-closed): ${(e as Error)?.message ?? e}`);
  }
}

// ── production SPV source: the real PoW-verified light client over the cairn server ──────────────────
export interface LiveSpvOpts {
  rpcBase: string;       // e.g. https://cairn-substrate.com/api/rpc  (CsdClient block/tx reads)
  headersBase: string;   // e.g. https://cairn-substrate.com          (/api/headers batch header source)
  // optional header-chain snapshot cache (the wallet store) so we don't re-sync every verify; re-verified on load
  cache?: { get(): Promise<unknown | null>; set(s: unknown): Promise<void> };
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

  return {
    async prepare(maxEventHeight: number) {
      let nodeTip = 0;
      try { nodeTip = Number((await client.tip())?.height); } catch { /* node tip unknown → lapse uses verified tip */ }
      // sync only as far as the records need (+cushion), capped by the node tip — keeps an old, sparse
      // name's cold sync small (and within the headers budget) instead of fetching the whole chain.
      const want = Math.min(Number.isFinite(nodeTip) && nodeTip > 0 ? nodeTip : maxEventHeight + CONF_BUFFER, maxEventHeight + CONF_BUFFER);
      const cur = LC.baseHeight + LC.chain.length - 1;
      if (want > cur) {
        await LC.sync(want);                           // a lying-high header THROWS here (fail-closed)
        if (opts.cache) { try { await opts.cache.set(LC.toSnapshot()); } catch { /* cache best-effort */ } }
      }
      return { verifiedTip: LC.baseHeight + LC.chain.length - 1, nodeTip };
    },
    async blockAt(height: number) {
      const vh = LC.chain[height - LC.baseHeight];
      if (!vh) throw new Error(`no PoW-verified header at ${height}`);
      const b = await client.blockByHeight(height);
      return { merkle: String(vh.header.merkle), txs: b.txs };
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
