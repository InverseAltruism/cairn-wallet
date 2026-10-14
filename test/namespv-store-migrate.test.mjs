// The one-time migration of the pre-0.2.99 chrome.storage.local header snapshot (`spvHeaderChain`, v1) into the
// header store, through the real liveSpvSource (cairn docs/Plans/86 section 3.8; section 6 cases 5, 7, 12, 21).
//
// Invariants pinned here:
//   - v1 bytes enter the store only as a chunk that walks to the table's two hashes, or above the newest anchor
//     through fromRecords; a v1 that fails either way is deleted and the wallet seeds from the table.
//   - With a head in the store, the store wins: v1 contributes only the headers above the stored tip.
//   - v1 is deleted only after the head it pairs with has been written and read back.
//   - A long-unused store below the newest anchor is seeded at the anchor, never forward-synced across the gap.
//
// Synthetic bases: the fixture holds 29,696 to 32,767 and 106,496 to 115,199, so a real 0.2.73 snapshot (29,915
// to the tip) cannot be built from it. The snapshots here start at 106,496 (chunks 26 and 27 plus a suffix) or
// at 29,915 and stop at 32,767 (chunk 7); the per-header shape is the one 0.2.73's toSnapshot wrote.
//
// Run: npx tsx test/namespv-store-migrate.test.mjs   (offline)
import { liveSpvSource, flushSpvStoreWrites, LEGACY_MAX_BYTES } from "../src/core/namespv.ts";
import { checker } from "./helpers/check.mjs";
import { records, hashOf, headerOf, v1Snapshot, serveFixture, memStore, legacyOf, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";

const t = checker("namespv-store-migrate");
const HB = 84;
const MERKLE = 36;
const C26 = [106496, 110591], C27 = [110592, NEWEST];

// The production call shape (Wallet.spvOpts), with the store and the chrome.storage.local key as doubles.
const opts = (store, legacy) => ({
  rpcBase: "https://spv.invalid/api/rpc", headersBase: "https://spv.invalid", anchors: FIX_ANCHORS,
  store: async () => store, legacy,
  floor: { get: async () => null, set: async () => {} },
});
const withNet = async (net, fn) => { const restore = serveFixture(net); try { return await fn(); } finally { restore(); } };
const attempt = async (name, fn) => {
  try { t.check(name, await fn()); }
  catch (e) { t.check(`${name} (threw: ${e?.message ?? e})`, false); }
};
const same = (a, b) => !!a && !!b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const merkleHex = (h) => "0x" + Buffer.from(records(h, h).subarray(MERKLE, MERKLE + 32)).toString("hex");
const pages = (lo, hi) => { const out = []; for (let p = lo - (lo % 512); p <= hi; p += 512) out.push(`${p}/512`); return out; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const putKeys = (st) => st.writes.flatMap((w) => (w.put ?? []).map((p) => p.k));
const flipMerkle = (snap, h) => {
  const e = snap.headers[h - snap.baseHeight];
  e.header = { ...e.header, merkle: "0x" + (e.header.merkle[2] === "0" ? "1" : "0") + e.header.merkle.slice(3) };
  return snap;
};
/** A store image as an earlier session left it. */
const storeWith = (chunks, tip) => {
  const s = memStore();
  for (const [k, lo, hi] of chunks) s.chunks.set(k, records(lo, hi));
  if (tip) s.head = { v: 2, tip, tipHash: hashOf(tip) };
  return s;
};
/** Records the order of store writes, head reads and v1 deletes. */
const traced = (st, legacy) => {
  const seq = [];
  const w = st.write.bind(st), g = st.getHead.bind(st), d = legacy.del;
  st.write = async (x) => { await w(x); seq.push(x.head ? "write+head" : "write"); };
  st.getHead = async () => { const h = await g(); seq.push("getHead"); return h; };
  legacy.del = async () => { seq.push("del"); await d(); };
  return seq;
};

// ── case 5(a): v1 only ──
console.log("5(a) v1 only:");
{
  const kv = new Map([["spvHeaderChain", v1Snapshot(106496, FIX_TOP)]]);
  const legacy = legacyOf(kv);
  const st = memStore();
  const seq = traced(st, legacy);
  const net = { tip: FIX_TOP };
  await attempt("the chunks v1 covers are stored, the suffix is restored, and proofs need no /api/headers request", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    const r = await s.prepare(FIX_TOP - 12);
    return r.verifiedTip === FIX_TOP && (await s.hashAt(108000)) === hashOf(108000) && (await s.merkleAt(108000)) === merkleHex(108000)
      && (await s.hashAt(115000)) === hashOf(115000) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
  t.check("store holds chunk 26, chunk 27 and the suffix 114,688 to 115,199 byte-for-byte",
    same(st.chunks.get(26), records(...C26)) && same(st.chunks.get(27), records(...C27)) && same(st.chunks.get(28), records(114688, FIX_TOP)));
  t.check("head is the last write and names the restored tip", st.head?.tip === FIX_TOP && st.head.tipHash === hashOf(FIX_TOP)
    && st.writes.findIndex((w) => w.head) === st.writes.length - 1);
  const lastWrite = seq.lastIndexOf("write+head");
  t.check("order: chunk writes, then the head write, then a head read-back, then the v1 delete",
    lastWrite > 0 && seq.slice(0, lastWrite).filter((x) => x.startsWith("write")).every((x) => x === "write")
    && seq.indexOf("getHead", lastWrite) > lastWrite && seq.indexOf("del") > seq.indexOf("getHead", lastWrite));
  t.check("v1 deleted once, no attempt counted", !kv.has("spvHeaderChain") && legacy.calls.del === 1 && !kv.has("spvMigrateAttempts"));
}

console.log("5(a) v1 only, chunk 7 (29,915 to 32,767):");
{
  const kv = new Map([["spvHeaderChain", v1Snapshot(29915, 32767)]]);
  const legacy = legacyOf(kv);
  const st = memStore();
  const net = { tip: NEWEST };
  await attempt("chunk 7 is migrated (29,915 to 29,959 dropped) and a proof at 30,000 costs no request beyond the anchor chunk", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    const anchorFetch = eq(net.log, pages(...C27));
    return anchorFetch && (await s.hashAt(30000)) === hashOf(30000) && (await s.hashAt(29960)) === hashOf(29960) && eq(net.log, pages(...C27));
  }));
  await flushSpvStoreWrites();
  t.check("stored chunk 7 is exactly 29,960 to 32,767", same(st.chunks.get(7), records(29960, 32767)));
  t.check("v1 deleted after the head was written", !kv.has("spvHeaderChain") && legacy.calls.del === 1 && st.head?.tip === NEWEST);
}

// ── case 5(a), suffix: a forged v1 record above the anchor stops fromRecords there ──
console.log("5(a) v1 forged above the anchor:");
{
  const kv = new Map([["spvHeaderChain", flipMerkle(v1Snapshot(106496, FIX_TOP), 115000)]]);
  const legacy = legacyOf(kv);
  const st = memStore();
  const net = { tip: FIX_TOP };
  await attempt("the forged suffix record is never answered: the sync refetches from 115,000 and serves the chain's header", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    const restoredTip = st.head?.tip;
    await s.prepare(FIX_TOP - 12);
    return restoredTip === 114999 && net.log.some((p) => p.startsWith("114688/")) && (await s.merkleAt(115000)) === merkleHex(115000);
  }));
  await flushSpvStoreWrites();
  t.check("the store holds the chain's suffix, never the forged record", same(st.chunks.get(28), records(114688, FIX_TOP)));
  t.check("v1 deleted", !kv.has("spvHeaderChain") && legacy.calls.del === 1);
}

// ── case 5(b): v1 poisoned below the anchor ──
console.log("5(b) v1 poisoned in chunk 26:");
{
  const kv = new Map([["spvHeaderChain", flipMerkle(v1Snapshot(106496, FIX_TOP), 108000)]]);
  const legacy = legacyOf(kv);
  const st = memStore();
  const net = { tip: FIX_TOP };
  await attempt("v1 is deleted and the wallet seeds from the table: 8 requests for chunk 27, then the suffix", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    const seeded = eq(net.log, pages(...C27));
    const r = await s.prepare(FIX_TOP - 12);
    return seeded && !kv.has("spvHeaderChain") && legacy.calls.del === 1 && r.verifiedTip === FIX_TOP;
  }));
  await flushSpvStoreWrites();
  await attempt("a proof at 108,000 answers the chain's header, fetched (8 requests for chunk 26)", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacyOf(kv)));
    const before = net.log.length;
    const ok = (await s.merkleAt(108000)) === merkleHex(108000) && (await s.hashAt(108000)) === hashOf(108000);
    return ok && eq(net.log.slice(before), pages(...C26));
  }));
  await flushSpvStoreWrites();
  t.check("no write ever carried a chunk 26 other than the chain's", st.writes.every((w) => (w.put ?? []).every((p) => p.k !== 26 || same(p.records, records(...C26))))
    && same(st.chunks.get(26), records(...C26)));
  t.check("a failing v1 is not a migration attempt", !kv.has("spvMigrateAttempts"));
}

// ── case 5(c): chunks without a head (a migration killed before the head) ──
console.log("5(c) chunks present, no head:");
{
  const kv = new Map([["spvHeaderChain", v1Snapshot(106496, FIX_TOP)]]);
  const legacy = legacyOf(kv);
  const st = storeWith([[26, ...C26]]);
  const net = { tip: FIX_TOP };
  await attempt("the migration runs: the head is written and proofs need no request", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    return st.head?.tip === FIX_TOP && (await s.hashAt(108000)) === hashOf(108000) && (await s.hashAt(112000)) === hashOf(112000) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
  t.check("the chunk already present is kept, not rewritten; chunk 27 is added", !putKeys(st).includes(26) && putKeys(st).includes(27) && same(st.chunks.get(26), records(...C26)));
  t.check("v1 deleted once", !kv.has("spvHeaderChain") && legacy.calls.del === 1);
}
{
  // Chunks 26 and 27 both present: the anchor chunk comes from v1 into memory; nothing below 28 is rewritten.
  const kv = new Map([["spvHeaderChain", v1Snapshot(106496, FIX_TOP)]]);
  const legacy = legacyOf(kv);
  const st = storeWith([[26, ...C26], [27, ...C27]]);
  await withNet({ tip: FIX_TOP }, () => liveSpvSource(opts(st, legacy)));
  await flushSpvStoreWrites();
  t.check("with 26 and 27 present only the suffix and the head are written", eq(putKeys(st), [28]) && st.head?.tip === FIX_TOP && !kv.has("spvHeaderChain"));
}
{
  // A resumed migration does not re-read v1 for a chunk it already stored, so it costs no request even when that
  // part of v1 would fail its walk; the stored chunk is walked whenever it is read.
  const kv = new Map([["spvHeaderChain", flipMerkle(v1Snapshot(106496, FIX_TOP), 108000)]]);
  const st = storeWith([[26, ...C26]]);
  const net = { tip: FIX_TOP };
  await attempt("a resumed migration skips the chunk already stored and completes with no request", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacyOf(kv)));
    return st.head?.tip === FIX_TOP && !kv.has("spvHeaderChain") && (await s.merkleAt(108000)) === merkleHex(108000) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
}
{
  // A present chunk is kept by the migration unread; it is walked when it is read, and a failing one is refetched.
  const kv = new Map([["spvHeaderChain", v1Snapshot(106496, FIX_TOP)]]);
  const st = storeWith([[26, ...C26]]);
  st.chunks.get(26)[(107496 - 106496) * HB + MERKLE] ^= 1;
  const net = { tip: FIX_TOP };
  await attempt("a corrupt chunk left by an earlier run is never answered: the proof refetches it", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacyOf(kv)));
    return (await s.merkleAt(107496)) === merkleHex(107496) && eq(net.log, pages(...C26));
  }));
  await flushSpvStoreWrites();
  t.check("the refetched chunk replaced the corrupt one", same(st.chunks.get(26), records(...C26)));
}

// ── case 5(d) / 12: both present, v1 newer (0.2.73 ran after a downgrade and synced further) ──
console.log("5(d)/12 both present, v1 newer:");
{
  const kv = new Map([["spvHeaderChain", v1Snapshot(106496, FIX_TOP)]]);
  const legacy = legacyOf(kv);
  const st = storeWith([[27, ...C27], [28, 114688, 114900]], 114900);
  const net = { tip: FIX_TOP };
  await attempt("the store is kept and v1 adds 114,901 to 115,199 with no request", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    const r = await s.prepare(FIX_TOP - 12);
    return r.verifiedTip === FIX_TOP && (await s.hashAt(115100)) === hashOf(115100) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
  t.check("one write: the suffix chunk to 115,199 and the head; nothing below the store's tip from v1",
    st.writes.length === 1 && eq(putKeys(st), [28]) && same(st.chunks.get(28), records(114688, FIX_TOP)) && st.head?.tip === FIX_TOP && !st.chunks.has(26));
  t.check("v1 deleted once", !kv.has("spvHeaderChain") && legacy.calls.del === 1);
}
{
  const kv = new Map([["spvHeaderChain", flipMerkle(v1Snapshot(106496, FIX_TOP), 115000)]]);
  const st = storeWith([[27, ...C27], [28, 114688, 114900]], 114900);
  const net = { tip: FIX_TOP };
  await attempt("v1's headers above the store go through fromRecords: a forged one stops them there, the sync refetches", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacyOf(kv)));
    const restored = st.head?.tip;
    await s.prepare(FIX_TOP - 12);
    return restored === 114999 && (await s.merkleAt(115000)) === merkleHex(115000) && net.log.length > 0;
  }));
  await flushSpvStoreWrites();
  t.check("the store ends with the chain's suffix and v1 is gone", same(st.chunks.get(28), records(114688, FIX_TOP)) && !kv.has("spvHeaderChain"));
}

// ── case 5(e) / 12: both present, the store newer ──
console.log("5(e)/12 both present, the store newer:");
for (const [label, from, to] of [["older, overlapping (106,496 to 114,900)", 106496, 114900], ["older, disjoint (29,915 to 32,767)", 29915, 32767]]) {
  const kv = new Map([["spvHeaderChain", v1Snapshot(from, to)]]);
  const legacy = legacyOf(kv);
  const st = storeWith([[27, ...C27], [28, 114688, FIX_TOP]], FIX_TOP);
  const before = st.image();
  const net = { tip: FIX_TOP };
  await attempt(`${label}: the store wins and restores with no request`, () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    return (await s.hashAt(115000)) === hashOf(115000) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
  t.check(`${label}: nothing from v1 is written (no chunk put, the store image is unchanged)`, putKeys(st).length === 0 && st.image() === before);
  t.check(`${label}: v1 deleted once`, !kv.has("spvHeaderChain") && legacy.calls.del === 1);
}

// ── case 7: a long-unused store whose suffix ends below the newest anchor ──
console.log("7 store ends at 110,000 (chunk 26 partial, from an older table):");
{
  const st = storeWith([[26, 106496, 110000]], 110000);
  const net = { tip: FIX_TOP };
  await attempt("seeds at 114,687: 8 requests for chunk 27 and one suffix page, never a sync of the gap", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacyOf(new Map())));
    const r = await s.prepare(FIX_TOP - 12);
    return r.verifiedTip === FIX_TOP && eq(net.log, [...pages(...C27), "114688/512"]);
  }));
  await attempt("a proof at 108,000 then acquires chunk 26 once: the partial stored copy fails its walk and is replaced", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacyOf(new Map())));
    const start = net.log.length;
    const ok = (await s.hashAt(108000)) === hashOf(108000) && (await s.hashAt(110500)) === hashOf(110500);
    return ok && eq(net.log.slice(start), pages(...C26));
  }));
  await flushSpvStoreWrites();
  t.check("the store now holds the complete chunk 26", same(st.chunks.get(26), records(...C26)));
}

// ── not a v1 snapshot ──
console.log("v1 that is not a v1 snapshot:");
const relabel = (snap, h, to) => { snap.headers[h - snap.baseHeight] = { ...snap.headers[h - snap.baseHeight], height: to }; return snap; };
for (const [label, value] of [
  ["wrong v", { ...v1Snapshot(106496, 110591), v: 2 }],
  ["empty headers", { v: 1, baseHeight: 106496, headers: [] }],
  ["not an object", "spvHeaderChain"],
  ["a non-contiguous height in chunk 26 (honest bytes, wrong label)", relabel(v1Snapshot(106496, FIX_TOP), 108000, 108001)],
]) {
  const kv = new Map([["spvHeaderChain", value]]);
  const legacy = legacyOf(kv);
  const st = memStore();
  const net = { tip: NEWEST };
  await attempt(`${label}: v1 is deleted and the wallet seeds from the table (8 requests for chunk 27)`, () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    return !kv.has("spvHeaderChain") && legacy.calls.del === 1 && eq(net.log, pages(...C27)) && (await s.hashAt(112000)) === hashOf(112000);
  }));
  await flushSpvStoreWrites();
  t.check(`${label}: nothing from v1 is stored`, !st.chunks.has(26) && !st.chunks.has(28));
}

// ── LEGACY_MAX_BYTES: the size is read before the value ──
console.log("legacy size check:");
for (const [label, bytes, migrates] of [
  ["above 200 MB", async () => LEGACY_MAX_BYTES + 1, false],
  ["exactly 200 MB", async () => LEGACY_MAX_BYTES, true],
  ["the area cannot say (null)", async () => null, true],
  ["the size read throws", async () => { throw new Error("getBytesInUse unavailable"); }, true],
]) {
  const kv = new Map([["spvHeaderChain", v1Snapshot(106496, FIX_TOP)]]);
  const legacy = { ...legacyOf(kv), bytes };
  const st = memStore();
  const net = { tip: FIX_TOP };
  await attempt(`${label}: ${migrates ? "migrates" : "deleted unread"}`, () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    await s.prepare(FIX_TOP - 12);
    const answered = (await s.hashAt(115000)) === hashOf(115000);
    if (!migrates) return answered && legacy.calls.get === 0 && legacy.calls.del === 1 && !st.chunks.has(26) && eq(net.log, [...pages(...C27), "114688/512"]);
    return answered && legacy.calls.get === 1 && legacy.calls.del === 1 && st.chunks.has(26) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
  t.check(`${label}: v1 gone afterwards`, !kv.has("spvHeaderChain"));
}

// ── case 21: a store that comes back empty (openHeaderStore recreated it after a VersionError) ──
console.log("21 empty store, no v1:");
{
  const kv = new Map();
  const legacy = legacyOf(kv);
  const st = memStore();
  const net = { tip: FIX_TOP };
  await attempt("a fresh install: one seed (8 requests) plus the suffix, never a refusal", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    const r = await s.prepare(FIX_TOP - 12);
    return r.verifiedTip === FIX_TOP && eq(net.log, [...pages(...C27), "114688/512"]) && (await s.hashAt(115000)) === hashOf(115000);
  }));
  await flushSpvStoreWrites();
  t.check("no v1 to delete, nothing counted; the store holds the seed chunk and the suffix",
    legacy.calls.del === 0 && kv.size === 0 && same(st.chunks.get(27), records(...C27)) && st.head?.tip === FIX_TOP);
}

t.done();
