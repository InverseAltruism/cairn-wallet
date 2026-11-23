// A buy whose header source is dropped while its burial scan waits for the headers to the node tip. The real
// Wallet.fillOffer, the real liveFillSpvSource and the real liveSpvSource (the cut-table bundle, test/helpers/
// cuttable.mjs, on a chain generated above the real headers at 146,000 with the bits the vendored light client
// computes, so blocks can carry the offers and the reservations). Only the prevout oracle is the rig's (its prevouts
// have no bodies). Held headers end at H; the node tip is three pages above. The buyer's hold ends below the node tip,
// so a fill mined at the true tip comes after the hold and its payment burns. The endpoint changes while the sync's
// first page (to T2, its top) waits, so the dropped source can hold headers that stop at T2, below the hold's end.
//   (1) the dropped source must not answer at its stale tip: nothing is signed (0.3.5: the old source went on to
//       the node tip and refused the lapsed hold).
//   (2) the burial scan's own guard: a verified tip below the node tip the source read refuses (liveFillSpvSource),
//       and a verified tip equal to it builds the scan.
//   (3) the honest path on the same chain: a live hold, no endpoint change: the fill is signed.
import "./helpers/backup-host.mjs";
import { createHash } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { cutTableBundle } from "./helpers/cuttable.mjs";
import { memStore, records, hashOf, headerOf, has, row } from "./helpers/spvfixture.mjs";
import { proposeTx, addrFromPriv, ctxid, rpcTxToTx, merkleRoot, prevoutFor, pick, nodeBlockBody, FILLER } from "./_spvrig.ts";
import { mkCoin, txReply } from "./_coin.ts";

const { check, done } = checker("a buy whose header source is dropped mid-scan");
const C = await cutTableBundle([
  'export { liveSpvSource, flushSpvStoreWrites } from "./src/core/namespv.ts";',
  'export { liveFillSpvSource } from "./src/core/fillspv.ts";',
  'export { Wallet } from "./src/core/wallet.ts";',
  'export { memoryStore } from "./src/core/storage.ts";',
  'export { requiredFillOutputs, FEE_BPS, FEE_BPS_V16, V16_HEIGHT } from "./src/core/cairnx.ts";',
  'export { LightClient, serializeHeader, offer, fclaim, fclaimHoldEnd, epochOf } from "./src/vendor/cairnx-spv.js";',
].join("\n"), { powList: true });

const F = 146000, H = 146400, T2 = 146431, TOP = 147200, SEED = 46;
const API_A = "https://cairn-substrate.com", API_B = "https://headers-b.cairn-substrate.test";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, n = 2000) => { for (let i = 0; i < n && !f(); i++) await tick(); return f(); };
const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const now = (Number(headerOf(F).time) + 60 * 86400) * 1000;
Date.now = () => now;

// Two buyers, each with an offer and a reservation granted the block after it. The first's hold ends between T2 and
// the node tip; the second's after the node tip.
const sellerKey = "0x" + "5e".repeat(32), SELLER = addrFromPriv(sellerKey).toLowerCase();
const V = 5_000_000;
const holdAfter = (grant, least) => { for (let E = C.epochOf(grant); E <= C.epochOf(grant) + 2; E++) if (C.fclaimHoldEnd(E) >= least) return E; throw new Error(`no hold from ${grant} reaches ${least}`); };
const buyers = [
  { key: "0x" + "1a".repeat(32), offerAt: 146419, grantH: 146420, least: T2 + 8 },
  { key: "0x" + "2b".repeat(32), offerAt: 147149, grantH: 147150, least: TOP + 8 },
].map((b, i) => {
  const E = holdAfter(b.grantH, b.least);
  const offTx = proposeTx({ ...pick(C.offer({ give: { ticker: "AAA", amount: String(10 + i) }, want: { value: String(V), payto: SELLER } })), priv: sellerKey, expiresEpoch: 9e9 });
  const offerId = ctxid(rpcTxToTx(offTx)).toLowerCase();
  const fcTx = proposeTx({ ...pick(C.fclaim({ offer: offerId })), priv: b.key, expiresEpoch: E });
  return { ...b, E, giveAmount: String(10 + i), me: addrFromPriv(b.key).toLowerCase(), offTx, offerId, fcTx, fid: ctxid(rpcTxToTx(fcTx)).toLowerCase(), holdEnd: C.fclaimHoldEnd(E) };
});
const lapsing = buyers[0], live = buyers[1];
if (!(lapsing.holdEnd > T2 + 4 && lapsing.holdEnd < TOP && live.holdEnd > TOP + 4)) throw new Error(`hold ends ${lapsing.holdEnd}, ${live.holdEnd}`);

// The generated chain above F: each block's merkle root commits its body.
globalThis.__testPowOk = new Set();
const placed = new Map();
for (const b of buyers) { placed.set(b.offerAt, [...(placed.get(b.offerAt) ?? []), b.offTx]); placed.set(b.grantH, [...(placed.get(b.grantH) ?? []), b.fcTx]); }
const G = new Map(), bodyByHash = new Map();
{
  const { client } = await C.LightClient.fromRecords(records(F - SEED + 1, F), { firstHeight: F - SEED + 1, anchorHeight: F }, { checkpoints: { [F]: hashOf(F) } });
  let prev = hashOf(F), time = Number(headerOf(F).time);
  for (let h = F + 1; h <= TOP; h++) {
    time += 119;
    const txs = placed.get(h) ?? [FILLER];
    const merkle = merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } }))));
    const base = { version: 1, prev, merkle, time, nonce: h };
    let bits = null;
    try { client.ingest(h, { ...base, bits: 1 }); }
    catch (e) { const m = /LWMA ([0-9a-f]+)$/.exec(String(e?.message)); if (!m) throw e; bits = parseInt(m[1], 16); }
    const header = { ...base, bits };
    const hash = hex(sha256d(C.serializeHeader(header)));
    globalThis.__testPowOk.add(hash);
    client.ingest(h, header);
    G.set(h, { height: h, header, hash });
    bodyByHash.set(hash, { height: h, txs });
    prev = hash;
  }
}
const rowAt = (h) => (h <= F ? (has(h) ? row(h) : null) : G.get(h) ?? null);
const recordsTo = (lo, hi) => { const b = new Uint8Array((hi - lo + 1) * 84); for (let h = lo; h <= hi; h++) b.set(h <= F ? records(h, h) : C.serializeHeader(G.get(h).header), (h - lo) * 84); return b; };
function storeToH() { // the held store, to H
  const st = memStore();
  for (let k = 31; k <= Math.floor(H / 4096); k++) st.chunks.set(k, recordsTo(k * 4096, Math.min(k * 4096 + 4095, H)));
  st.head = { v: 2, tip: H, tipHash: G.get(H).hash };
  return st;
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } });
const net = { hold: () => false, held: [], headerPages: [], submits: [], prepared: [] };
const release = () => { for (const r of net.held.splice(0)) r(); };
function serve(buyer) {
  const coin = mkCoin(100_000_002);
  const servedOffer = { id: buyer.offerId, seller: SELLER, give: { ticker: "AAA", amount: buyer.giveAmount }, want: { value: String(V), payto: SELLER }, status: "open", height: buyer.offerAt, feeBps: buyer.offerAt >= C.V16_HEIGHT ? C.FEE_BPS_V16 : C.FEE_BPS, fclaimId: buyer.fid, fclaimHeight: buyer.grantH, fclaimExpiresEpoch: buyer.E };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(u);
    if (m) {
      const from = Number(m[1]), n = Number(m[2]);
      net.headerPages.push({ host: new URL(u).origin, from });
      if (net.hold(from)) await new Promise((r) => net.held.push(r));
      if (from + n - 1 > TOP) return new Response(JSON.stringify({ ok: false }), { status: 502 });
      const rows = []; for (let h = from; h < from + n; h++) rows.push(rowAt(h));
      return new Response(JSON.stringify({ ok: true, from, count: n, headers: rows }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const blk = /\/block\/(0x[0-9a-f]{64})$/.exec(u);
    if (blk && bodyByHash.has(blk[1])) { const b = bodyByHash.get(blk[1]); return new Response(nodeBlockBody(b.txs), { status: 200 }); }
    if (u.endsWith("/tip")) return new Response(JSON.stringify({ height: TOP, hash: G.get(TOP).hash }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/tx/submit")) { net.submits.push(JSON.parse(init?.body || "{}")); return json({ ok: true, txid: "0x" + "aa".repeat(32) }); }
    if (u.includes("clarvis")) return json({ ok: false }, 404);
    if (u.includes("/cairnx/offer/")) return json(servedOffer);
    if (/\/utxos\//.test(u)) return json({ confirmed_balance: coin.coin.value, utxos: [coin.coin] });
    const t = txReply(u, [coin]);
    if (t) return t;
    return json({}, 404);
  };
  return C.requiredFillOutputs(servedOffer, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
}
async function walletFor(buyer) {
  const w = new C.Wallet(C.memoryStore(), C.memoryStore());
  const st = storeToH();
  w.spvBuildForTest = async (o) => {
    const s = await C.liveSpvSource({ ...o, store: async () => st, legacy: undefined });
    const prepare = (h) => s.prepare(h).then((r) => { net.prepared.push(r); return r; }, (e) => { net.prepared.push({ error: String(e?.message ?? e) }); throw e; });
    return { ...s, prepare, prevoutScriptPubkey: async (p) => prevoutFor(p) };
  };
  await w.importKey(buyer.key, "pw-dropped-source-1");
  await w.setApi(API_A);
  return w;
}

console.log("1. the endpoint changes while the burial scan waits for the headers above H:");
{
  const w = await walletFor(lapsing);
  const outputs = serve(lapsing);
  Object.assign(net, { headerPages: [], submits: [], held: [] });
  // The run's first window asks the page holding 146,401 to 146,431 (asked whole, from 145,920), 146,432 and 146,944:
  // the first waits.
  net.hold = (from) => from === 145920;
  const pending = w.fillOffer({ proposalId: lapsing.fid, outputs });
  await until(() => net.held.length > 0);
  await w.setApi(API_B);
  net.hold = () => false;
  release();
  const r = await pending;
  await tick(50); await C.flushSpvStoreWrites();
  console.log(`  outcome: ${JSON.stringify({ ok: r?.ok, code: r?.code, error: String(r?.error ?? "").slice(0, 120), prepared: net.prepared })}`);
  check(`nothing is signed or sent for a hold that ends at ${lapsing.holdEnd}, before the node tip ${TOP} (${net.submits.length} submits, ${r?.ok ? "signed" : r?.code})`, r?.ok !== true && net.submits.length === 0);
}

console.log("2. the burial scan's own guard, on the real liveFillSpvSource:");
{
  const st = storeToH();
  serve(lapsing);
  const base = await C.liveSpvSource({ rpcBase: `${API_A}/api/rpc`, headersBase: API_A, store: async () => st, legacy: undefined });
  const real = { ...base, prevoutScriptPubkey: async (p) => prevoutFor(p) };
  await real.prepare(T2 - 12);
  // A source that answers its held tip and the node tip it read, with no sync: the shape a short tip takes.
  const short = { ...real, prepare: async () => ({ verifiedTip: T2, nodeTip: TOP, tipKnown: true, servedTip: TOP }) };
  const hints = { offerId: lapsing.offerId, fclaimTxid: lapsing.fid, me: lapsing.me, offerHeight: lapsing.offerAt };
  const out = await C.liveFillSpvSource({ rpcBase: `${API_A}/api/rpc`, headersBase: API_A, spvSource: short, hints }).then(() => "built", (e) => `refused: ${e?.message}`);
  check(`a verified tip ${T2} below the node tip ${TOP} refuses (${out.slice(0, 90)})`, out.startsWith("refused"));
  const even = { ...real, prepare: async () => ({ verifiedTip: T2, nodeTip: T2, tipKnown: true, servedTip: T2 }) };
  const out2 = await C.liveFillSpvSource({ rpcBase: `${API_A}/api/rpc`, headersBase: API_A, spvSource: even, hints }).then(() => "built", (e) => `refused: ${e?.message}`);
  check(`  a verified tip equal to the node tip builds the scan (${out2.slice(0, 90)})`, out2 === "built");
}

console.log("3. the honest path: a live hold, no endpoint change, the real source syncs to the node tip:");
{
  const w = await walletFor(live);
  const outputs = serve(live);
  Object.assign(net, { headerPages: [], submits: [], held: [], hold: () => false });
  const r = await w.fillOffer({ proposalId: live.fid, outputs });
  await tick(50); await C.flushSpvStoreWrites();
  check(`the fill is signed (${r?.ok ? "signed" : `${r?.code}: ${String(r?.error).slice(0, 100)}`}, ${net.submits.length} submit), after a sync to the node tip (${net.prepared.at(-1)?.verifiedTip})`, r?.ok === true && net.submits.length >= 1 && net.prepared.at(-1)?.verifiedTip === TOP);
}

done("fill-dropped-source");
