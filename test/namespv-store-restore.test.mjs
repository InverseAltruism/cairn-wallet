// The production liveSpvSource over a header store, on real mainnet headers (test/helpers/spvfixture.mjs):
// chunk-7 indexing from the names floor, height routing, the fresh-install and warm-restart request counts,
// the per-proof write volume, a real name proved end to end through the store, and a store that cannot be
// opened or written (Plan 86 sections 3.2, 3.5 and 3.6, section 6 cases 4 and 10).
// Offline: every request is answered from the fixture. Run: npx tsx test/namespv-store-restore.test.mjs
import { readFileSync } from "node:fs";
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, legacyOf, records, hashOf, headerOf, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites, verifyNameUnion } from "../src/core/namespv.ts";
import { SPV_ANCHORS, SPV_FLOOR } from "../src/core/spvanchors.ts";

const t = checker("namespv over the header store: indexing, routing, restore, write volume");
const { check } = t;

const API = "https://cairn-substrate.test";
const RPC = `${API}/api/rpc`;
const net = {};
serveFixture(net);
// A real name (cairn.csd, one event at 30,224 in chunk 7) with its block body and spent prevout, read from the
// local resolver and node on 2026-10-14. Every other block body is served empty by the fixture.
const NAME = JSON.parse(readFileSync(new URL("./fixtures/name-cairn-30224.json", import.meta.url), "utf8"));
{
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === `${RPC}/block/height/${NAME.block.height}`) return Response.json(NAME.block);
    if (u === `${RPC}/tx/${NAME.prevout.txid}`) return Response.json(NAME.prevout);
    return inner(url, init);
  };
}
const nameFetch = async (url) => String(url).endsWith("/cairnx/name-history/cairn") ? Response.json(NAME.history) : new Response("{}", { status: 404 });
const SOURCES = [{ label: "cairn", base: `${API}/trade/api` }];

// Wallet.spvOpts() with the store and the chrome.storage keys replaced by test doubles.
function opts(store, kv = new Map()) {
  return {
    rpcBase: RPC, headersBase: API, anchors: FIX_ANCHORS,
    store: typeof store === "function" ? store : async () => store,
    legacy: legacyOf(kv),
    floor: { get: async () => Number(kv.get("spvNodeTipFloor")) || 0, set: async (v) => { kv.set("spvNodeTipFloor", v); } },
  };
}
const reset = () => { net.log.length = 0; net.tip = FIX_TOP; net.tamper = undefined; net.down = false; };
const pages = (from, to) => { const out = []; for (let p = from - (from % 512); p <= to; p += 512) out.push(`${p}/512`); return out; };
const ANCHOR_PAGES = pages(110592, NEWEST);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const bytesEq = (a, b) => !!a && !!b && a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
const aligned = () => net.log.every((p) => { const [from, n] = p.split("/").map(Number); return from % 512 === 0 && n === 512; });
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e?.message ?? e); } };
check("the fixture's top anchored chunk ends at the table prefix's newest entry", FIX_ANCHORS[FIX_ANCHORS.length - 1] === hashOf(NEWEST) && FIX_ANCHORS.every((h, i) => h === SPV_ANCHORS[i]));

console.log("chunk 7 is indexed from the names floor (29,960), not from 28,672 (plan 3.2, review A.6):");
reset();
{
  const src = await liveSpvSource(opts(memStore()));
  net.log.length = 0;
  for (const h of [29960, 29961, 30224, 32767]) {
    const hash = await src.hashAt(h), merkle = await src.merkleAt(h), b = await src.blockAt(h).catch((e) => ({ merkle: String(e) }));
    check(`hashAt, merkleAt and blockAt(${h}) return the real header's hash and merkle root`, hash === hashOf(h) && merkle === headerOf(h).merkle && b.merkle === headerOf(h).merkle);
  }
  check("hashAt(29,960) is the names-floor pin", (await src.hashAt(29960)) === SPV_FLOOR.hash);
  check("hashAt(32,767) is the first table anchor", (await src.hashAt(32767)) === SPV_ANCHORS[0]);
  check(`chunk 7 cost one acquisition: its 6 aligned pages from 29,696, once (${net.log.join(" ")})`, same(net.log, pages(29960, 32767)));
}

console.log("routing by height (plan 3.5):");
reset();
{
  const st = memStore();
  const src = await liveSpvSource(opts(st));
  check(`a fresh build fetches the anchor chunk only, 8 requests (${net.log.length})`, same(net.log, ANCHOR_PAGES));
  net.log.length = 0;
  check("a height in chunk 26 is answered from that chunk", (await src.hashAt(108000)) === hashOf(108000));
  check(`  ...one acquisition, 8 requests (${net.log.join(" ")})`, same(net.log, pages(106496, 110591)));
  net.log.length = 0;
  const reads = st.reads;
  check("a chunk-27 height (the anchor chunk held in memory) is answered with no request and no store read", (await src.hashAt(113000)) === hashOf(113000) && (await src.hashAt(NEWEST)) === SPV_ANCHORS[20] && net.log.length === 0 && st.reads === reads);
  check("a height above the anchor is not answered before the light client has it", (await src.hashAt(115000)) === null && net.log.length === 0);
  const p = await src.prepare(FIX_TOP - 12);
  check(`prepare syncs the suffix: verified tip ${p.verifiedTip}, one page (${net.log.join(" ")})`, p.verifiedTip === FIX_TOP && same(net.log, ["114688/512"]));
  net.log.length = 0;
  check("a height above the anchor is answered from the light client with no request", (await src.hashAt(115000)) === hashOf(115000) && (await src.merkleAt(FIX_TOP)) === headerOf(FIX_TOP).merkle && net.log.length === 0);
  check("a height below 29,960 is null with zero requests", (await src.hashAt(29959)) === null && (await src.merkleAt(29000)) === null && net.log.length === 0);
  const below = await rejects(src.blockAt(29000));
  check(`blockAt below 29,960 refuses with zero requests (${below})`, /no PoW-verified header at 29000/.test(below ?? "") && net.log.length === 0);
  net.log.length = 0;
  await src.hashAt(29961);
  check(`a proof at 29,961 costs one chunk (${net.log.length} requests)`, same(net.log, pages(29960, 32767)));
}

console.log("fresh install, then warm restart (plan 3.6):");
reset();
const warm = memStore();
{
  const src = await liveSpvSource(opts(warm));
  check(`the build makes exactly the 8 anchor-chunk requests (${net.log.length})`, same(net.log, ANCHOR_PAGES));
  net.log.length = 0;
  const p = await src.prepare(FIX_TOP - 12);
  check(`prepare(${FIX_TOP - 12}) fetches only the suffix page (${net.log.join(" ")}) and reaches ${p.verifiedTip}`, p.verifiedTip === FIX_TOP && same(net.log, ["114688/512"]));
  await flushSpvStoreWrites();
  check(`the store holds chunk 27 and the suffix chunk 28 (${[...warm.chunks.keys()]})`, same([...warm.chunks.keys()].sort((a, b) => a - b), [27, 28]));
  check("  chunk 27 is the real anchor chunk", bytesEq(warm.chunks.get(27), records(110592, NEWEST)));
  check("  chunk 28 is the real suffix 114,688 to 115,199", bytesEq(warm.chunks.get(28), records(114688, FIX_TOP)));
  check(`  the head is the real tip and tip hash (${warm.head?.tip})`, warm.head?.v === 2 && warm.head.tip === FIX_TOP && warm.head.tipHash === hashOf(FIX_TOP));
}
{
  reset();
  const writes = warm.writes.length;
  const src = await liveSpvSource(opts(warm));
  check(`a warm restart builds with zero header requests (${net.log.length})`, net.log.length === 0);
  const p = await src.prepare(FIX_TOP - 12);
  check(`  and prepare to the same height makes zero requests (${net.log.length}), tip ${p.verifiedTip}`, net.log.length === 0 && p.verifiedTip === FIX_TOP);
  check("  hashAt answers the anchor and suffix heights from the restored chain", (await src.hashAt(NEWEST)) === SPV_ANCHORS[20] && (await src.hashAt(114688)) === hashOf(114688) && (await src.hashAt(FIX_TOP)) === hashOf(FIX_TOP) && net.log.length === 0);
  await flushSpvStoreWrites();
  check(`  the restore wrote nothing (${warm.writes.length - writes} writes)`, warm.writes.length === writes);
  check("every /api/headers request in this file so far was a 512-aligned page", aligned());
}

console.log("write volume per proof (plan 3.5 table, first row):");
// No real name has events in both chunk 7 and chunk 26 (the local resolver's 164 names, read 2026-10-14), so the
// two-chunk pin runs at the SpvSource seam; the one-chunk name below runs verifyNameUnion end to end.
reset();
{
  const st = memStore();
  let src = await liveSpvSource(opts(st));
  await src.prepare(FIX_TOP - 12);
  await flushSpvStoreWrites();
  const w0 = st.writes.length;
  net.log.length = 0;
  const b7 = await src.blockAt(30224), b26 = await src.blockAt(108000);
  await flushSpvStoreWrites();
  const puts = st.writes.slice(w0).flatMap((w) => (w.put ?? []).map((p) => p.k));
  check("proofs at a chunk-7 height and a chunk-26 height bind the real merkle roots", b7.merkle === headerOf(30224).merkle && b26.merkle === headerOf(108000).merkle);
  // Chunk 7 spans 6 aligned pages (29,696 to 32,767), chunk 26 spans 8.
  check(`  two chunk acquisitions: 14 requests (${net.log.length}), aligned`, same(net.log, [...pages(29960, 32767), ...pages(106496, 110591)]) && aligned());
  check(`  two chunk puts, chunks 7 and 26, in ${st.writes.length - w0} writes (${puts})`, same(puts, [7, 26]) && st.writes.length - w0 === 2);
  check("  the stored chunks are the real ones, chunk 7 from 29,960", bytesEq(st.chunks.get(7), records(SPV_FLOOR.height, 32767)) && bytesEq(st.chunks.get(26), records(106496, 110591)));
  net.log.length = 0;
  await src.blockAt(30224); await src.blockAt(108000); await src.hashAt(30000); await src.merkleAt(110000);
  await flushSpvStoreWrites();
  check(`repeating them costs zero requests and zero writes (${net.log.length}, ${st.writes.length - w0 - 2})`, net.log.length === 0 && st.writes.length === w0 + 2);
  src = await liveSpvSource(opts(st));
  const reads = st.reads;
  const again = [await src.blockAt(30224), await src.blockAt(108000)];
  await flushSpvStoreWrites();
  check(`a new source on the same store costs zero requests for them (${net.log.length})`, net.log.length === 0 && again[0].merkle === headerOf(30224).merkle && again[1].merkle === headerOf(108000).merkle);
  check(`  they are store hits, one read (and walk) per chunk on load: ${st.reads - reads} chunk reads, no writes`, st.reads - reads === 2 && st.writes.length === w0 + 2);

  reset();
  const v = await verifyNameUnion("cairn", SOURCES, src, nameFetch);
  check(`verifyNameUnion proves cairn.csd through the restored store (${v.verified ? v.addr : v.reason})`, v.verified === true && v.addr === NAME.history.resolve.addr && v.via === "owner");
  check(`  with zero header requests, chunk 7 coming from the store (${net.log.length})`, net.log.length === 0);
}
{
  reset();
  const v = await verifyNameUnion("cairn", SOURCES, await liveSpvSource(opts(memStore())), nameFetch);
  check(`on a fresh install the same proof costs the anchor chunk and chunk 7 only (${net.log.length} requests)`, v.verified === true && same(net.log, [...ANCHOR_PAGES, ...pages(29960, 32767)]));
}

console.log("a header store that cannot be written, opened or found (section 6 case 4):");
for (const [label, store, st] of (() => {
  const failing = memStore({ failWrite: () => true });
  return [
    ["a store whose write rejects", failing, failing],
    ["opts.store that throws", async () => { throw new Error("UnknownError: the database is unavailable"); }, null],
    ["opts.store that returns null", async () => null, null],
  ];
})()) {
  reset();
  let p, b;
  try {
    const src = await liveSpvSource(opts(store));
    p = await src.prepare(FIX_TOP - 12);
    b = await src.blockAt(108000);
  } catch (e) { p = b = { error: String(e?.message ?? e) }; }
  const flushed = await rejects(flushSpvStoreWrites());
  check(`${label}: prepare returns the verified tip (${p.verifiedTip ?? p.error}) and a chunk-26 proof passes`, p.verifiedTip === FIX_TOP && b.merkle === headerOf(108000).merkle);
  check(`  the session ran on the network and memory alone (${net.log.length} requests), no write error escaped`, same(net.log, [...ANCHOR_PAGES, "114688/512", ...pages(106496, 110591)]) && flushed === null);
  if (st) check(`  every write was attempted and failed, nothing stored (${st.writes.length} writes)`, st.writes.length >= 2 && st.writes.every((w) => w.failed) && st.chunks.size === 0 && st.head === null);
}

t.done("namespv-store-restore");
