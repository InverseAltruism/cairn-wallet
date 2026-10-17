// The fill lanes over the header store (cairn docs/Plans/86 section 3.5): an offer created below the newest anchor
// is proven through per-height chunk acquisition on the production liveSpvSource, in the fclaim lane (the offer
// block, through bindBlock) and the legacy lane (provenOfferPayto). Each proof is paired with the case where the
// chunk cannot be acquired (its /api/headers pages unserved and absent from the store), which must refuse.
// Section 6 case 19: a body server on another chain refuses with the configured RPC in the reason.
// Real data: mainnet headers (test/helpers/spvfixture.mjs) and the real block 30,332 with the offer's spent prevout.
// The fclaim scan window is a synthetic world near its own tip (no real fclaim exists on a chunk-7 offer: every
// chunk-7 offer expired before V28), joined to the live source by splitSource. Offline.
// Run: npx tsx test/fillspv-store.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serveFixture, serveOffer, splitSource, memStore, legacyOf, OFFER, FIX_TOP, FIX_ANCHORS } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites } from "../src/core/namespv.ts";
import { liveFillSpvSource, provenOfferPayto } from "../src/core/fillspv.ts";
import { fclaim, epochOf, feeBpsAt, V29_HEIGHT } from "../src/vendor/cairnx-spv.js";
import { proposeTx, addrFromPriv, ctxid, merkleRoot, rpcTxToTx, prevoutFor, pick } from "./_spvrig.ts";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

const API = "https://cairn-substrate.test";
const PROXY = `${API}/api/rpc`;
const LOCAL = "http://127.0.0.1:18999";
const net = {};
serveFixture(net);
serveOffer(net);
const CHUNK7 = (from) => from < 32768;
const reset = () => { net.log.length = 0; net.tip = FIX_TOP; net.unserved = undefined; net.blocks.set(OFFER.height, OFFER.block); };
const opts = (store, rpcBase = PROXY) => ({ rpcBase, headersBase: API, anchors: FIX_ANCHORS, store: async () => store, legacy: legacyOf(new Map()) });
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e?.message ?? e); } };
const chunk7Pages = () => net.log.filter((p) => Number(p.split("/")[0]) < 32768);

// The fclaim window: my fclaim on the real offer, ten blocks below a synthetic tip past V29.
const meKey = "0x" + "1a".repeat(32), ME = addrFromPriv(meKey).toLowerCase();
const TIP = V29_HEIGHT + 60;
const FILLER = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 1, script_sig: "0x" }], outputs: [{ value: 1, script_pubkey: "0x" + "77".repeat(20) }] };
const blocks = new Map();
const claimTx = proposeTx({ ...pick(fclaim({ offer: OFFER.offerId })), priv: meKey, expiresEpoch: epochOf(TIP - 10) + 2 });
blocks.set(TIP - 10, [claimTx]);
const FCLAIM = ctxid(rpcTxToTx(claimTx)).toLowerCase();
const window = {
  async prepare() { return { verifiedTip: TIP, nodeTip: TIP }; },
  async blockAt(h) {
    const txs = blocks.get(h) ?? [FILLER];
    return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } })))), txs };
  },
  async prevoutScriptPubkey(t) { return prevoutFor(t); },
};
const fillIo = async (live) => liveFillSpvSource({
  rpcBase: PROXY, headersBase: API, spvSource: splitSource(live, window),
  hints: { offerId: OFFER.offerId, fclaimTxid: FCLAIM, me: ME, offerHeight: OFFER.height },
});

console.log("fill lanes over the header store, offer at 30,332 (chunk 7, below the newest anchor):");

await test("fixture: the offer is in its real block and was signed by the owner of the coin it spends", async () => {
  const tx = OFFER.block.txs.find((t) => t.txid === OFFER.offerId);
  assert.equal(tx.app.type, "Propose");
  assert.equal(OFFER.seller, "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec");
  assert.ok(OFFER.height >= 29960 && OFFER.height <= 32767, "the offer is in chunk 7, below every anchor");
});

await test("fclaim lane: the offer block is acquired from chunk 7 and the offer's seller, payto and terms are proven", async () => {
  reset();
  const st = memStore();
  const live = await liveSpvSource(opts(st));
  net.log.length = 0;
  const io = await fillIo(live);
  assert.equal(io.provenSeller, OFFER.seller);
  assert.equal(io.provenPayto, OFFER.seller, "the offer names no payto, so the payment goes to its author");
  assert.equal(io.provenTerms.height, OFFER.height);
  assert.equal(io.provenTerms.value, "100000000");
  assert.equal(io.provenTerms.feeBps, feeBpsAt(OFFER.height));
  assert.equal((await io.provenEvent(OFFER.offerId))?.kind, "propose");
  assert.deepEqual(chunk7Pages(), ["29696/512", "30208/512", "30720/512", "31232/512", "31744/512", "32256/512"]);
  await flushSpvStoreWrites();
  assert.ok(st.chunks.has(7), "the acquired chunk is stored");
});

await test("fclaim lane: with chunk 7 neither served nor stored, building the fill io refuses (nothing to sign against)", async () => {
  reset();
  net.unserved = CHUNK7;
  const live = await liveSpvSource(opts(memStore()));
  const err = await rejects(fillIo(live));
  assert.ok(err, "the io must not build without the offer's proof");
  assert.match(err, /headers/);
});

await test("fclaim lane: a later session proves the offer from the stored chunk with chunk 7 unserved", async () => {
  reset();
  const st = memStore();
  await fillIo(await liveSpvSource(opts(st)));
  await flushSpvStoreWrites();
  reset();
  net.unserved = CHUNK7;
  const io = await fillIo(await liveSpvSource(opts(st)));
  assert.equal(io.provenSeller, OFFER.seller);
  assert.deepEqual(chunk7Pages(), []);
});

await test("legacy lane: provenOfferPayto proves payto, seller and terms through the store (production call shape)", async () => {
  reset();
  const live = await liveSpvSource(opts(memStore()));
  const p = await provenOfferPayto({ rpcBase: PROXY, headersBase: API, offerId: OFFER.offerId, offerHeight: OFFER.height, spvSource: live });
  assert.ok(p, "the honest offer proves");
  assert.equal(p.seller, OFFER.seller);
  assert.equal(p.payto, OFFER.seller);
  assert.equal(p.terms.height, OFFER.height);
  assert.equal(p.terms.value, "100000000");
});

await test("legacy lane: with chunk 7 unavailable provenOfferPayto returns null (the preflight refuses, retryable)", async () => {
  reset();
  net.unserved = CHUNK7;
  const live = await liveSpvSource(opts(memStore()));
  const p = await provenOfferPayto({ rpcBase: PROXY, headersBase: API, offerId: OFFER.offerId, offerHeight: OFFER.height, spvSource: live });
  assert.equal(p, null);
});

console.log("section 6 case 19: a Local node RPC on another chain:");

await test("a body from another chain at the offer height: the fill io refuses and names the configured RPC", async () => {
  reset();
  const other = JSON.parse(readFileSync(new URL("./fixtures/name-cairn-30224.json", import.meta.url), "utf8")).block;
  net.blocks.set(OFFER.height, { ...other, height: OFFER.height });
  const live = await liveSpvSource(opts(memStore(), LOCAL));
  assert.equal(live.bodySource, LOCAL);
  const err = await rejects(fillIo(live));
  assert.ok(err?.includes(`block ${OFFER.height} from ${LOCAL} does not match its verified merkle root`), err ?? "no refusal");
  assert.match(err, /another chain/);
  const p = await provenOfferPayto({ rpcBase: LOCAL, headersBase: API, offerId: OFFER.offerId, offerHeight: OFFER.height, spvSource: live });
  assert.equal(p, null, "the legacy lane refuses the same body");
});

await test("honest path: the same Local node serving the canonical body proves the offer", async () => {
  reset();
  const live = await liveSpvSource(opts(memStore(), LOCAL));
  const io = await fillIo(live);
  assert.equal(io.provenSeller, OFFER.seller);
});

console.log(`fillspv-store: ${n} passed, 0 failed`);
