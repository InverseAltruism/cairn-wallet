// The production liveSpvSource against a served chain or a stored chunk that does not match: the table pins
// (section 6 cases 1 and 8), a structural break above the anchor (case 2), the user's clock (case 3), a corrupt
// chunk (cases 9 and 17) and a proof racing an acquisition (case 16). Each refusal is paired with the honest
// path on the same call shape. Real mainnet headers (test/helpers/spvfixture.mjs), offline.
// Run: npx tsx test/namespv-store-pins.test.mjs
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, legacyOf, records, hashOf, headerOf, forge, rehash, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites } from "../src/core/namespv.ts";
import { SPV_ANCHORS } from "../src/core/spvanchors.ts";

const t = checker("namespv over the header store: pins, reorg, clock, corrupt chunks, concurrency");
const { check } = t;

const API = "https://cairn-substrate.test";
const net = {};
serveFixture(net);
// A gate on the chunk-26 pages, to hold an acquisition in flight.
let gate = null;
{
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const m = /\/api\/headers\/(\d+)\//.exec(String(url));
    if (gate && m && Number(m[1]) >= 106496 && Number(m[1]) <= 110591) { gate.waiting++; await gate.open; }
    return inner(url, init);
  };
}

// Wallet.spvOpts() with the store and the chrome.storage keys replaced by test doubles.
function opts(store, kv = new Map()) {
  return {
    rpcBase: `${API}/api/rpc`, headersBase: API, anchors: FIX_ANCHORS, store: async () => store, legacy: legacyOf(kv),
    floor: { get: async () => Number(kv.get("spvNodeTipFloor")) || 0, set: async (v) => { kv.set("spvNodeTipFloor", v); } },
  };
}
const reset = () => { net.log.length = 0; net.tip = FIX_TOP; net.tamper = undefined; net.down = false; };
const pages = (from, to) => { const out = []; for (let p = from - (from % 512); p <= to; p += 512) out.push(`${p}/512`); return out; };
const ANCHOR_PAGES = pages(110592, NEWEST);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const bytesEq = (a, b) => !!a && !!b && a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e?.message ?? e); } };
/** Rows of a page with the rows at the given heights replaced by f(row). */
const tamperAt = (heights, f) => (from, rows) => rows.map((r) => heights.includes(r.height) ? f(r) : r);
const PIN = (h) => `could not match the chain to its built-in checkpoints (height ${h})`;
const CLOCK = "dated more than 2 hours ahead of this computer's clock";
const anchorRefetched = () => net.log.some((p) => ANCHOR_PAGES.includes(p));
check("rehash recomputes the claimed hash the front door serves", rehash(forge({ height: 1, header: headerOf(108000), hash: "" })).hash !== hashOf(108000) && rehash({ header: headerOf(108000) }).hash === hashOf(108000));

/** A store holding the verified anchor chunk and a suffix to `tip`, written by an honest session. */
async function storeTo(tip) {
  reset();
  net.tip = tip;
  const st = memStore();
  await (await liveSpvSource(opts(st))).prepare(tip - 12);
  await flushSpvStoreWrites();
  reset();
  if (st.head?.tip !== tip) throw new Error(`setup: the store reached ${st.head?.tip}, not ${tip}`);
  return st;
}

console.log("the anchor table seam takes only a prefix of the release table:");
{
  reset();
  const forged = [...FIX_ANCHORS]; forged[20] = hashOf(NEWEST - 1);
  for (const [label, anchors] of [["a changed entry", forged], ["one entry past the release table", [...SPV_ANCHORS, hashOf(FIX_TOP)]], ["an empty table", []]]) {
    reset();
    const st = memStore();
    const err = await rejects(liveSpvSource({ ...opts(st), anchors }));
    check(`${label} is refused before any request or store write (${err?.slice(0, 80)})`, /must be the release table or a prefix of it/.test(err ?? "") && net.log.length === 0 && st.writes.length === 0);
  }
  const src = await liveSpvSource(opts(memStore()));
  check("honest path: the fixture's 21-entry prefix builds and anchors 114,687", FIX_ANCHORS.length === 21 && (await src.hashAt(NEWEST)) === hashOf(NEWEST));
}

console.log("case 1: the served chain contradicts the newest anchor:");
{
  reset();
  const st = memStore();
  const before = st.image();
  net.tamper = tamperAt([112700], forge);
  const err = await rejects(liveSpvSource(opts(st)));
  await flushSpvStoreWrites();
  check(`(a) empty store, one row of the served chunk 27 differs: the build refuses with the checkpoint copy (${err?.slice(0, 120)})`, !!err && err.includes(PIN(114687)) && /chunk 27/.test(err));
  check("    the store image is byte-identical and nothing was written", st.image() === before && st.writes.length === 0);
  net.tamper = undefined;
  const src = await liveSpvSource(opts(st));
  const p = await src.prepare(FIX_TOP - 12);
  const b = [await src.blockAt(108000), await src.blockAt(115000)];
  check(`    honest path: the real chain seeds, syncs to ${p.verifiedTip} and proves a chunk-26 and a suffix height`, p.verifiedTip === FIX_TOP && b[0].merkle === headerOf(108000).merkle && b[1].merkle === headerOf(115000).merkle);
}
{
  const st = await storeTo(114900);
  const before = st.image();
  // A different chain above the anchor: every served row from 114,688 altered, with its claimed hash consistent.
  net.tamper = (from, rows) => rows.map((r) => r.height > NEWEST ? rehash(forge(r)) : r);
  const src = await liveSpvSource(opts(st));
  check("(b) a store holding chunk 27 and a suffix restores with zero requests", net.log.length === 0 && (await src.hashAt(114900)) === hashOf(114900));
  const err = await rejects(src.prepare(FIX_TOP - 12));
  await flushSpvStoreWrites();
  check(`    served headers above 114,687 that do not validate from the anchor: prepare refuses with the checkpoint copy (${err?.slice(0, 100)})`, !!err && err.includes(PIN(114687)));
  check("    the store image is byte-identical after the writes flush", st.image() === before);
  check("    the stored suffix is still served by this source", (await src.hashAt(114900)) === hashOf(114900));
  net.tamper = undefined;
  const p = await src.prepare(FIX_TOP - 12);
  await flushSpvStoreWrites();
  check(`    honest path: the same source syncs to ${p.verifiedTip}, proves a suffix height, and the store holds the new tip`, p.verifiedTip === FIX_TOP && (await src.blockAt(115100)).merkle === headerOf(115100).merkle && st.head.tip === FIX_TOP && bytesEq(st.chunks.get(28), records(114688, FIX_TOP)));
}
{
  // Case 8: a chain that differs at the names floor.
  const st = await storeTo(FIX_TOP);
  const before = st.image();
  net.tamper = tamperAt([29960], forge);
  const src = await liveSpvSource(opts(st));
  const err = await rejects(src.blockAt(30224));
  await flushSpvStoreWrites();
  check(`(c) the served chain differs at the floor: the chunk-7 proof refuses naming chunk 7 (${err?.slice(0, 160)})`, !!err && err.includes(PIN(32767)) && /chunk 7 \(heights 29960 to 32767\)/.test(err));
  check("    hashAt in chunk 7 is null and the store is intact", (await src.hashAt(30224)) === null && st.image() === before && !st.chunks.has(7));
  net.tamper = undefined;
  const b = await src.blockAt(30224);
  await flushSpvStoreWrites();
  check("    honest path: the real chunk 7 is acquired, proves 30,224 and is stored", b.merkle === headerOf(30224).merkle && bytesEq(st.chunks.get(7), records(29960, 32767)));
}

console.log("case 2: a structural break above the anchor:");
// A 3-block PoW-valid reorg is not constructible offline (the fixture holds the one real chain and alternative
// headers would need real work), so the break is a served page whose row above the stored tip fails verification.
{
  const st = await storeTo(114900);
  const before = st.image();
  let calls = 0, during = null;
  net.tamper = (from, rows) => {
    if (from !== 114688) return rows;
    if (++calls === 1) return tamperAt([114901], (r) => rehash(forge(r)))(from, rows);
    during = st.image();
    return rows;
  };
  const src = await liveSpvSource(opts(st));
  const p = await src.prepare(FIX_TOP - 12).catch((e) => ({ error: String(e?.message ?? e) }));
  await flushSpvStoreWrites();
  check(`a page that breaks once: the source reseeds and re-syncs to ${p.verifiedTip ?? p.error}`, p.verifiedTip === FIX_TOP && (await src.hashAt(115000)) === hashOf(115000));
  check(`  the seed came from the anchor chunk in memory: the only requests are the two suffix pages (${net.log.join(" ")})`, same(net.log, ["114688/512", "114688/512"]));
  check("  while the reseed sync ran, the store still held the old suffix", during === before);
  const last = st.writes[st.writes.length - 1];
  check(`  then the suffix was replaced from the anchor up: chunk 28 rewritten from 114,688, head ${st.head.tip}`, last.put?.length === 1 && last.put[0].k === 28 && bytesEq(st.chunks.get(28), records(114688, FIX_TOP)) && st.head.tip === FIX_TOP && st.head.tipHash === hashOf(FIX_TOP));
}
{
  const st = await storeTo(114900);
  const before = st.image();
  net.tamper = tamperAt([114901], (r) => rehash(forge(r)));
  const src = await liveSpvSource(opts(st));
  const err = await rejects(src.prepare(FIX_TOP - 12));
  await flushSpvStoreWrites();
  check(`a page that stays broken: prepare fails closed (${err})`, /invalid PoW at 114901/.test(err ?? "") && !err.includes("built-in checkpoints"));
  check(`  the reseed was tried once, from memory (${net.log.join(" ")})`, same(net.log, ["114688/512", "114688/512"]));
  check("  the old suffix survives: the store image is byte-identical", st.image() === before);
  check("  and the source still answers from it", (await src.hashAt(114900)) === hashOf(114900));
}

console.log("case 3: the user's clock:");
{
  const realNow = Date.now;
  const st = await storeTo(FIX_TOP);
  const before = st.image();
  // A clock set back so that 115,000 is more than 2 h ahead of it; the restore stops at the first such record.
  const now = Number(headerOf(115000).time) - 7200 - 1;
  let stop = 114688;
  while (Number(headerOf(stop).time) <= now + 7200) stop++;
  try {
    Date.now = () => now * 1000;
    const src = await liveSpvSource(opts(st));
    check(`(a) clock behind a stored record: the restore stops at ${stop}, keeping the prefix, with zero requests`, (await src.hashAt(stop - 1)) === hashOf(stop - 1) && (await src.hashAt(stop)) === null && net.log.length === 0);
    await flushSpvStoreWrites();
    check("    the store image is unchanged after the restore", st.image() === before);
    const err = await rejects(src.prepare(FIX_TOP - 12));
    await flushSpvStoreWrites();
    check(`    prepare above it throws the clock copy, not the checkpoint copy (${err?.slice(0, 90)})`, !!err && err.includes(CLOCK) && !err.includes("built-in checkpoints"));
    check(`    no reseed: one suffix page, no anchor refetch (${net.log.join(" ")})`, same(net.log, ["114688/512"]) && !anchorRefetched());
    check("    the store image is unchanged after the refusal", st.image() === before);
  } finally { Date.now = realNow; }
  reset();
  const src = await liveSpvSource(opts(st));
  check("    honest path: a correct clock restores the same store intact with zero requests", (await src.hashAt(FIX_TOP)) === hashOf(FIX_TOP) && net.log.length === 0 && (await src.prepare(FIX_TOP - 12)).verifiedTip === FIX_TOP && net.log.length === 0);
}
{
  const st = await storeTo(114900);
  const before = st.image();
  const ahead = Math.floor(Date.now() / 1000) + 3 * 3600;
  net.tamper = tamperAt([114901], (r) => rehash({ ...r, header: { ...r.header, time: ahead } }));
  const src = await liveSpvSource(opts(st));
  const err = await rejects(src.prepare(FIX_TOP - 12));
  await flushSpvStoreWrites();
  check(`(b) a served header 3 h ahead of the clock is refused with the clock copy (${err?.slice(0, 90)})`, !!err && err.includes(CLOCK) && /time too far in future at 114901/.test(err));
  check(`    the store is kept and nothing was reseeded (${net.log.join(" ")})`, st.image() === before && same(net.log, ["114688/512"]));
  net.tamper = undefined;
  const realNow = Date.now;
  let maxTime = 0;
  for (let h = NEWEST - 45; h <= FIX_TOP; h++) maxTime = Math.max(maxTime, Number(headerOf(h).time));
  try {
    Date.now = () => (maxTime - 3600) * 1000;
    const p = await src.prepare(FIX_TOP - 12);
    const fresh = await liveSpvSource(opts(memStore()));
    const q = await fresh.prepare(FIX_TOP - 12);
    check(`    honest path: with the clock 1 h behind the newest header, the honest headers sync (${p.verifiedTip}, fresh install ${q.verifiedTip})`, p.verifiedTip === FIX_TOP && q.verifiedTip === FIX_TOP);
  } finally { Date.now = realNow; }
}

console.log("cases 9 and 17: a corrupt chunk:");
{
  // Case 9: one flipped byte in a stored chunk 26 that no source of this session has read.
  const st = await storeTo(FIX_TOP);
  const bad = records(106496, 110591);
  bad[100 * 84 + 40] ^= 1;
  await st.write({ put: [{ k: 26, records: bad }] });
  const src = await liveSpvSource(opts(st));
  const b = await src.blockAt(108000);
  await flushSpvStoreWrites();
  check(`a flipped stored byte in chunk 26: the proof refetches it (${net.log.length} requests) and passes`, b.merkle === headerOf(108000).merkle && same(net.log, pages(106496, 110591)));
  check("  the store holds the verified chunk afterwards", bytesEq(st.chunks.get(26), records(106496, 110591)));
}
{
  reset();
  const st = memStore();
  const src = await liveSpvSource(opts(st));
  net.log.length = 0;
  net.tamper = tamperAt([109000], forge);
  const err = await rejects(src.blockAt(108000));
  check(`a served chunk 26 that fails its walk: blockAt refuses with the checkpoint copy naming the chunk (${err?.slice(0, 160)})`, !!err && err.includes(PIN(110591)) && /chunk 26 \(heights 106496 to 110591\)/.test(err));
  check("  hashAt for that chunk returns null", (await src.hashAt(108000)) === null);
  await flushSpvStoreWrites();
  check(`  nothing is stored for chunk 26 (${[...st.chunks.keys()]})`, !st.chunks.has(26) && st.writes.every((w) => !(w.put ?? []).some((p) => p.k === 26)));
  net.tamper = undefined;
  check("  honest path: the real chunk 26 is acquired and proves", (await src.blockAt(108000)).merkle === headerOf(108000).merkle);
  await flushSpvStoreWrites();
  check("  and is stored", bytesEq(st.chunks.get(26), records(106496, 110591)));
}
{
  // The anchor chunk and the suffix are stored bytes too: both are walked or re-verified on restore.
  const st = await storeTo(FIX_TOP);
  const c27 = st.chunks.get(27); c27[2000 * 84 + 50] ^= 1;
  const src = await liveSpvSource(opts(st));
  await flushSpvStoreWrites();
  check(`a flipped byte in the stored anchor chunk: the build refetches it (${net.log.length} requests) and restores the suffix`, same(net.log, ANCHOR_PAGES) && (await src.hashAt(FIX_TOP)) === hashOf(FIX_TOP) && bytesEq(st.chunks.get(27), records(110592, NEWEST)));
  reset();
  const c28 = st.chunks.get(28); c28[300 * 84 + 10] ^= 1;
  const s2 = await liveSpvSource(opts(st));
  check(`a flipped byte in the stored suffix: the restore stops below it with zero requests (${await s2.hashAt(114987)})`, net.log.length === 0 && (await s2.hashAt(114987)) === hashOf(114987) && (await s2.hashAt(114988)) === null);
  const p = await s2.prepare(FIX_TOP - 12);
  await flushSpvStoreWrites();
  check(`  the sync refetches the page and the store is rewritten with the verified suffix (${p.verifiedTip})`, p.verifiedTip === FIX_TOP && same(net.log, ["114688/512"]) && bytesEq(st.chunks.get(28), records(114688, FIX_TOP)) && st.head.tip === FIX_TOP);
}
{
  // Case 17: a chunk stored by a first proof, then changed on disk; a new source (a cold LRU) walks it on load.
  reset();
  const st = memStore();
  await (await liveSpvSource(opts(st))).blockAt(108000);
  await flushSpvStoreWrites();
  st.chunks.get(26)[4095 * 84 + 70] ^= 1;
  net.log.length = 0;
  const src = await liveSpvSource(opts(st));
  check("after the first proof stored chunk 26, a byte flipped on disk: a new source builds from the stored anchor with zero requests", net.log.length === 0);
  const b = await src.blockAt(110591);
  await flushSpvStoreWrites();
  check(`  the second proof re-walks chunk 26 on load and refetches it (${net.log.length} requests)`, b.merkle === headerOf(110591).merkle && same(net.log, pages(106496, 110591)) && bytesEq(st.chunks.get(26), records(106496, 110591)));
}

{
  // A chunk stored above a partial suffix chunk (left by an older session or written by the profile writer) is never
  // read by the restore, and the next persist deletes it (deleteAbove), so the stored suffix is the light client's.
  const st = await storeTo(115000);
  await st.write({ put: [{ k: 29, records: records(110592, 110592 + 4095) }] });   // real records at the wrong heights
  const readsBefore = st.reads;
  const src = await liveSpvSource(opts(st));
  check(`a chunk stored above the partial suffix chunk is not read by the restore (${st.reads - readsBefore} chunk reads: 27 and 28)`, st.reads - readsBefore === 2 && (await src.hashAt(118784)) === null);
  await src.prepare(FIX_TOP - 12);
  await flushSpvStoreWrites();
  check(`  the next persist deletes it: the store holds chunks ${[...st.chunks.keys()].sort((x, y) => x - y)} and the head names the verified tip`, !st.chunks.has(29) && st.head.tip === FIX_TOP && bytesEq(st.chunks.get(28), records(114688, FIX_TOP)));
}

console.log("case 16: proofs while an acquisition is in flight:");
{
  reset();
  const st = memStore();
  const src = await liveSpvSource(opts(st));
  await src.prepare(FIX_TOP - 12);
  await src.blockAt(30224);
  net.log.length = 0;
  let release;
  gate = { waiting: 0, open: new Promise((r) => { release = r; }) };
  const a = src.blockAt(108000), b = src.blockAt(110000);
  while (gate.waiting === 0) await new Promise((r) => setTimeout(r, 1));
  const timeout = new Promise((r) => setTimeout(() => r("timed out"), 1000));
  const reads = await Promise.race([Promise.all([src.hashAt(113000), src.hashAt(115000), src.hashAt(30300)]), timeout]);
  check(`while chunk 26 is held pending, reads of the anchor chunk, the suffix and a cached chunk resolve (${Array.isArray(reads) ? "resolved" : reads})`, Array.isArray(reads) && reads[0] === hashOf(113000) && reads[1] === hashOf(115000) && reads[2] === hashOf(30300));
  release();
  gate = null;
  const [ra, rb] = await Promise.all([a, b]);
  check(`two concurrent proofs in the absent chunk 26 cost one acquisition (${net.log.length} requests)`, ra.merkle === headerOf(108000).merkle && rb.merkle === headerOf(110000).merkle && same(net.log, pages(106496, 110591)));
  await flushSpvStoreWrites();
  check("  and one chunk put", st.writes.filter((w) => (w.put ?? []).some((p) => p.k === 26)).length === 1);
}

t.done("namespv-store-pins");
