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
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { mkCoin, txReply } from "./_coin.ts";

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

await test("fclaim lane: the offer block is acquired from chunk 7 and the offer's terms are proven", async () => {
  reset();
  const st = memStore();
  const live = await liveSpvSource(opts(st));
  net.log.length = 0;
  const io = await fillIo(live);
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
  assert.equal(io.provenTerms.height, OFFER.height);
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
  assert.equal(io.provenTerms.height, OFFER.height);
});

console.log("the wallet's fclaim-lane preflight (fillOffer) on the same sources:");

// Wallet.fillOffer on my fclaim for the real offer. The light client is the split source over a live store source
// whose RPC is `rpcBase`; the resolver, the coin and the submit route are stubbed. Returns the result and the submits.
async function walletFill(rpcBase, { unserved, block } = {}) {
  reset();
  if (unserved) net.unserved = unserved;
  if (block) net.blocks.set(OFFER.height, block);
  const w = new Wallet(memoryStore());
  assert.equal((await w.importKey(meKey, "pw-fillspv-store-1")).addr.toLowerCase(), ME);
  w.nameSpvForTest = splitSource(await liveSpvSource(opts(memStore(), rpcBase)), window);
  const coin = mkCoin(200_000_000);
  const served = { id: OFFER.offerId, seller: OFFER.seller, give: { ticker: "CAIRN", amount: "500000000" }, want: { value: "100000000", payto: OFFER.seller }, status: "open", height: OFFER.height, feeBps: feeBpsAt(OFFER.height), paid: "0", delivered: "0", fclaimId: FCLAIM, fclaimHeight: TIP - 10, fclaimExpiresEpoch: epochOf(TIP - 10) + 2 };
  const submits = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { submits.push(u); return Response.json({ ok: true, txid: "0x" + "aa".repeat(32) }); }
    if (/\/cairnx\/offer\//.test(u)) return u.includes("clarvis") || !u.endsWith(FCLAIM) ? new Response("{}", { status: 404 }) : Response.json(served);
    if (/\/utxos\//.test(u)) return Response.json({ confirmed_balance: coin.coin.value, utxos: [coin.coin] });
    if (u.endsWith(`/tx/${OFFER.prevout.txid}`)) return inner(url, init);
    const t = txReply(u, [coin]);
    if (t) return t;
    return inner(url, init);
  };
  try {
    const outputs = [{ to: OFFER.seller, value: 100_000_000 }, { to: "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016", value: 1_000_000 }];
    return { r: await w.fillOffer({ proposalId: FCLAIM, outputs }), submits };
  } finally { globalThis.fetch = inner; }
}

await test("a Local node on another chain: fillOffer refuses RPC_BLOCK_MISMATCH naming the RPC, nothing submitted", async () => {
  const other = { ...JSON.parse(readFileSync(new URL("./fixtures/name-cairn-30224.json", import.meta.url), "utf8")).block, height: OFFER.height };
  const { r, submits } = await walletFill(LOCAL, { block: other });
  assert.equal(r.ok, false);
  assert.equal(r.code, "RPC_BLOCK_MISMATCH", `${r.code}: ${r.error}`);
  assert.equal(r.error, `refusing to sign: block ${OFFER.height} from ${LOCAL} does not match the block header the wallet verified. If that is your own node, check that it follows the main chain; otherwise try again in a moment.`);
  assert.equal(submits.length, 0);
});

await test("a chunk that cannot be fetched stays the retryable VERIFY_UNAVAILABLE, nothing submitted", async () => {
  const { r, submits } = await walletFill(PROXY, { unserved: CHUNK7 });
  assert.equal(r.code, "VERIFY_UNAVAILABLE", `${r.code}: ${r.error}`);
  assert.equal(submits.length, 0);
});

await test("honest path: the canonical body gets past the SPV io to the grant replay (no RPC or availability refusal)", async () => {
  const { r } = await walletFill(LOCAL);
  assert.ok(r.code !== "RPC_BLOCK_MISMATCH" && r.code !== "VERIFY_UNAVAILABLE", `${r.code}: ${r.error}`);
  console.log(`    (the replay refuses on the offer itself: ${r.code}: ${String(r.error).slice(0, 90)})`);
});

console.log("the wallet's SPV source follows the RPC and API settings in the same session:");

// The Wallet's own spvSource() and spvOpts(), with only the header store and the anchor table replaced (no IndexedDB
// in this process; the fixture holds the FIX_ANCHORS chunks). Every request URL is logged.
const OTHER_BODY = () => ({ ...JSON.parse(readFileSync(new URL("./fixtures/name-cairn-30224.json", import.meta.url), "utf8")).block, height: OFFER.height });
async function settingsWallet() {
  const w = new Wallet(memoryStore());
  await w.init();
  const prodOpts = Object.getPrototypeOf(w).spvOpts;
  w.spvOpts = function () { return { ...prodOpts.call(this), store: async () => memStore(), anchors: FIX_ANCHORS }; };
  return w;
}
const logged = async (fn, gate = () => null) => {
  const urls = [], inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => { urls.push(String(url)); const g = gate(String(url)); if (g) return g; return inner(url, init); };
  try { return { out: await fn(), urls }; } finally { globalThis.fetch = inner; }
};
// makeFillSpvIo's call shape: the wallet's spvOpts and its shared source (split with the synthetic fclaim window).
const walletFillIo = async (w) => liveFillSpvSource({
  ...w.spvOpts(), spvSource: splitSource(await w.spvSource(), window),
  hints: { offerId: OFFER.offerId, fclaimTxid: FCLAIM, me: ME, offerHeight: OFFER.height },
});

await test("setRpc to a Local node: the next fill reads the offer block from it and a refusal names it, not the old RPC", async () => {
  reset();
  const w = await settingsWallet();
  const old = (await w.status()).rpc;
  assert.equal((await w.spvSource()).bodySource, old, "setup: the source reads bodies from the saved RPC");
  await w.setRpc(LOCAL);
  net.blocks.set(OFFER.height, OTHER_BODY());
  const { out: err, urls } = await logged(() => rejects(walletFillIo(w)));
  assert.equal((await w.spvSource()).bodySource, LOCAL);
  assert.ok(err?.includes(`block ${OFFER.height} from ${LOCAL} does not match`), err ?? "no refusal");
  assert.ok(urls.includes(`${LOCAL}/block/height/${OFFER.height}`), "the offer block is read from the Local node");
  assert.ok(!urls.some((u) => u.startsWith(old)), "nothing is read from the old RPC");
});

await test("honest path: after setRpc the Local node serving the canonical body proves the offer", async () => {
  reset();
  const w = await settingsWallet();
  await w.spvSource();
  await w.setRpc(LOCAL);
  const io = await walletFillIo(w);
  assert.equal(io.provenTerms.height, OFFER.height);
  assert.equal(io.provenTerms.value, "100000000");
});

await test("setApi: headers for a chunk not yet held come from the new API", async () => {
  reset();
  const w = await settingsWallet();
  const oldApi = (await w.status()).api;
  await w.spvSource();
  const API2 = "https://api2.cairn-substrate.test";
  await w.setApi(API2);
  const { out: hash, urls } = await logged(async () => (await w.spvSource()).hashAt(OFFER.height));
  assert.equal(hash, OFFER.block.hash);
  const headerReads = urls.filter((u) => u.includes("/api/headers/"));
  assert.ok(headerReads.length > 0 && headerReads.every((u) => u.startsWith(`${API2}/api/headers/`)), headerReads.join(" "));
  assert.ok(!urls.some((u) => u.startsWith(`${oldApi}/api/headers/`)));
});

await test("an unchanged setting keeps the built source: no rebuild and no request", async () => {
  reset();
  const w = await settingsWallet();
  const before = await w.spvSource();
  const st = await w.status();
  const { urls } = await logged(async () => { await w.setRpc(st.rpc); await w.setApi(st.api); });
  assert.equal(await w.spvSource(), before);
  assert.deepEqual(urls, []);
});

await test("a build on the old endpoints that fails after the switch does not drop the source built on the new ones", async () => {
  reset();
  const w = await settingsWallet();
  const { api: oldApi } = await w.status();
  let release;
  const held = new Promise((r) => { release = r; });
  const { out } = await logged(async () => {
    const oldBuild = w.spvSource().then(() => "built", (e) => String(e?.message ?? e));
    await w.setRpc(LOCAL);
    await w.setApi("https://api2.cairn-substrate.test");
    const freshP = w.spvSource();                    // started on the new endpoints before the old build fails
    release();
    const old = await oldBuild, fresh = await freshP;
    return { old, fresh, after: await w.spvSource() };
  }, (u) => (u.startsWith(`${oldApi}/api/headers/`) ? held.then(() => new Response("{}", { status: 503 })) : null));
  assert.notEqual(out.old, "built", "setup: the old build failed");
  assert.equal(out.fresh.bodySource, LOCAL);
  assert.equal(out.after, out.fresh, "the failed old build left the new source in place");
});

console.log(`fillspv-store: ${n} passed, 0 failed`);
