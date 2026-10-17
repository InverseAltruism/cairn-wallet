// Name proofs over the header store (cairn docs/Plans/86 sections 3.5 and 6), on real mainnet headers and the real
// cairn.csd record at 30,224 (chunk 7, below the newest anchor):
//  - case 10: a hint below the names floor is dropped and its source flagged, never refused, and costs no request;
//    a hint at 29,961 costs one chunk;
//  - case 19: a Local node RPC serving another chain's block refuses with the configured RPC in the reason;
//  - the confirm-time hint-set skip re-acquires a chunk that is not in memory and refuses on a hash mismatch.
// Every refusal is paired with the honest path on the same call shape. Offline. Run: npx tsx test/namespv-hints-floor.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serveFixture, serveOffer, memStore, legacyOf, OFFER, FIX_TOP, FIX_ANCHORS } from "./helpers/spvfixture.mjs";
import { liveSpvSource, verifyNameUnion, flushSpvStoreWrites } from "../src/core/namespv.ts";
import { SPV_FLOOR } from "../src/core/spvanchors.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

const API = "https://cairn-substrate.test";
const PROXY = `${API}/api/rpc`;
const LOCAL = "http://127.0.0.1:18999";
const net = {};
serveFixture(net);
serveOffer(net);
const NAME = JSON.parse(readFileSync(new URL("./fixtures/name-cairn-30224.json", import.meta.url), "utf8"));
const realBlock = () => net.blocks.set(NAME.block.height, NAME.block);
realBlock();
net.txs.set(NAME.prevout.txid, NAME.prevout);
const reset = () => { net.log.length = 0; net.tip = FIX_TOP; net.unserved = undefined; realBlock(); };
const opts = (store = memStore(), rpcBase = PROXY) => ({ rpcBase, headersBase: API, anchors: FIX_ANCHORS, store: async () => store, legacy: legacyOf(new Map()) });

const PRIMARY = { label: "primary", base: `${API}/trade/api` };
const SECOND = { label: "clarvis", base: "https://clarvis.test/trade/api" };
const junk = (height) => ({ txid: "0x" + "ee".repeat(32), height, pos: 1, kind: "name" });
/** name-history per base: `served[base]` is a list of extra hints, or "only:" to serve them alone. */
const historyFetch = (served) => async (url) => {
  const u = String(url);
  const base = [PRIMARY, SECOND].find((s) => u.startsWith(s.base))?.base;
  if (!base || !u.endsWith("/cairnx/name-history/cairn")) return new Response("{}", { status: 404 });
  const extra = served[base] ?? [];
  const events = extra.only ? extra.only : [...NAME.history.events, ...extra];
  return Response.json({ ...NAME.history, events });
};
const below = () => net.log.filter((p) => Number(p.split("/")[0]) + 511 < SPV_FLOOR.height);

console.log("section 6 case 10: a hint below the names floor, or just above it:");

await test("one source serving the real record and a hint at 29,000: verified, flagged disagree, no request for it", async () => {
  reset();
  const v = await verifyNameUnion("cairn", [PRIMARY], await liveSpvSource(opts()), historyFetch({ [PRIMARY.base]: [junk(29000)] }));
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.addr, NAME.history.resolve.addr);
  assert.equal(v.disagree, true);
  assert.equal(v.recovered, undefined, "a clean union, not a per-source recovery");
  assert.deepEqual(below(), []);
});

await test("honest path: the same source without the low hint verifies with disagree false", async () => {
  reset();
  const v = await verifyNameUnion("cairn", [PRIMARY], await liveSpvSource(opts()), historyFetch({}));
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.disagree, false);
});

await test("two sources, one serving only a hint below the floor: the honest source verifies cleanly, flagged", async () => {
  reset();
  const v = await verifyNameUnion("cairn", [PRIMARY, SECOND], await liveSpvSource(opts()), historyFetch({ [SECOND.base]: { only: [junk(29000), junk(0)] } }));
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.disagree, true);
  assert.equal(v.soleSource, undefined);
  assert.equal(v.recovered, undefined);
  assert.deepEqual(below(), []);
});

await test("a hint at 29,961 (a txid not in that block) costs one chunk-7 acquisition and the union still verifies", async () => {
  reset();
  const src = await liveSpvSource(opts());
  net.log.length = 0;
  const v = await verifyNameUnion("cairn", [PRIMARY, SECOND], src, historyFetch({ [SECOND.base]: [junk(29961)] }));
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.disagree, true);
  assert.deepEqual(net.log, ["29696/512", "30208/512", "30720/512", "31232/512", "31744/512", "32256/512"]);
});

console.log("section 6 case 19: a Local node RPC on another chain:");

await test("a Local node serving another chain's block at 30,224: not verified, the reason names the RPC", async () => {
  reset();
  net.blocks.set(NAME.block.height, { ...OFFER.block, height: NAME.block.height });
  const v = await verifyNameUnion("cairn", [PRIMARY], await liveSpvSource(opts(memStore(), LOCAL)), historyFetch({}));
  assert.equal(v.verified, false);
  assert.ok(v.reason.includes(`block ${NAME.block.height} from ${LOCAL} does not match its verified merkle root`), v.reason);
  assert.match(v.reason, /another chain/);
});

await test("honest path: the proxy serving the canonical block verifies", async () => {
  reset();
  const v = await verifyNameUnion("cairn", [PRIMARY], await liveSpvSource(opts(memStore(), PROXY)), historyFetch({}));
  assert.equal(v.verified, true, v.reason);
});

console.log("the confirm-time hint-set skip over the store (plan 3.5, wallet.ts rememberHintSet / tryConfirmHintSet):");

// The wallet with its production name sources and RPC; the light client is the live store source over the fixture.
async function walletOn(store) {
  const w = new Wallet(memoryStore());
  w.nameSpvForTest = await liveSpvSource({ ...opts(store), rpcBase: "https://cairn-substrate.com/api/rpc", headersBase: API });
  return w;
}
const sites = { blocks: 0, served: {} };
{
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    // Both production sources (cairn-substrate.com and clarvis) answer from PRIMARY's history plus `sites.served`.
    if (u.endsWith("/cairnx/name-history/cairn")) return historyFetch({ [PRIMARY.base]: sites.served.extra ?? [] })(u.replace(/^https:\/\/(clarvis\.)?cairn-substrate\.com\/trade\/api/, PRIMARY.base));
    if (u.endsWith("/cairnx/resolve/cairn")) return Response.json(NAME.history.resolve);
    if (/\/block\/height\/\d+$/.test(u)) sites.blocks++;
    return inner(url, init);
  };
}

await test("a reviewed name whose chunk is not in memory: the skip re-acquires it from the store and holds", async () => {
  reset();
  const st = memStore();
  const w = await walletOn(st);
  const first = await w.verifyName("cairn");
  assert.equal(first.verified, true, first.reason);
  assert.ok(w.nameHintCacheForTest().has("cairn"), "the clean verdict was cached");
  await flushSpvStoreWrites();
  assert.ok(st.chunks.has(7));
  const cold = await walletOn(st);
  cold.nameHintCacheForTest().set("cairn", w.nameHintCacheForTest().get("cairn"));
  const reads = st.reads, blocks = sites.blocks;
  net.log.length = 0;
  const c = await cold.confirmName("cairn");
  assert.equal(c.ok, true);
  assert.equal(c.verified, true);
  assert.equal(c.addr, NAME.history.resolve.addr);
  assert.equal(sites.blocks, blocks, "the skip held: no block body was read");
  assert.equal(st.reads - reads, 1, "chunk 7 was read (and walked) from the store");
  assert.deepEqual(net.log, [], "no header request");
});

await test("a cached hash that differs from the stored chunk's: the skip is refused and the full proof runs", async () => {
  reset();
  const st = memStore();
  const w = await walletOn(st);
  assert.equal((await w.verifyName("cairn")).verified, true);
  const entry = w.nameHintCacheForTest().get("cairn");
  entry.hashes[NAME.block.height] = "0x" + "ab".repeat(32);
  const blocks = sites.blocks;
  const c = await w.confirmName("cairn");
  assert.equal(c.verified, true, "the full proof still verifies the honest name");
  assert.equal(sites.blocks, blocks + 1, "the skip was refused: the block body was read again");
});

await test("review then confirm with the same below-floor hint: the disagreement survives the cached skip", async () => {
  reset();
  sites.served.extra = [junk(29000)];
  try {
    const w = await walletOn(memStore());
    const review = await w.resolveName("cairn");
    assert.equal(review.verified, true);
    assert.equal(review.disagree, true, "the review warns");
    assert.ok(w.nameHintCacheForTest().has("cairn"), "the clean (non-recovered) verdict was cached");
    const blocks = sites.blocks;
    const c = await w.confirmName("cairn");
    assert.equal(sites.blocks, blocks, "the confirm used the cached skip");
    assert.equal(c.verified, true);
    assert.equal(c.disagree, true, "the confirm step still warns");
  } finally { sites.served.extra = undefined; }
});

await test("honest path: clean hints show no disagreement at review or at the cached confirm", async () => {
  reset();
  const w = await walletOn(memStore());
  const review = await w.resolveName("cairn");
  assert.equal(review.disagree, false);
  const blocks = sites.blocks;
  const c = await w.confirmName("cairn");
  assert.equal(sites.blocks, blocks, "the confirm used the cached skip");
  assert.equal(c.disagree, false);
});

console.log(`namespv-hints-floor: ${n} passed, 0 failed`);
