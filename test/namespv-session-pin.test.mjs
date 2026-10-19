// The session pin (src/core/spvpin.ts): a worker restart in the same browser session restores the stored suffix by
// a hash walk to the pin in chrome.storage.session, and every other case runs the full restore. Real mainnet
// headers through the production liveSpvSource (test/helpers/spvfixture.mjs); the pin slot is an in-memory double.
//
// Which restore ran is read from the light clients it builds through the vendored LightClient.fromRecords (a test
// instrument, restored after each use): the full restore seeds at the anchor and ingests the stored suffix; the pin
// path seeds at the pin. Restore parity (1b): with the clock moved back, the pin path accepts exactly the heights
// the full restore accepts, because it re-runs the time rules on the walked record with the latest timestamp.
//
// RED-FIRST (each mutation turns the named section red):
//   (1) the fast path off (walkToPin not called)                          -> 1
//  (14) no time-rule check on the walked records (MUTATE_PIN_TIME)       -> 1b
//  (15) walkToPin naming the pin's height instead of the latest-dated    -> 12b
//       (the real fixture's timestamps rise every block, so 12b re-dates a record in a hash-linked run)
//   (2) walkToPin returning true without verifyLinkedRecords             -> 2
//   (3) no `pin.newest !== newest` check                                  -> 4
//   (4) no checkpoint-range check in walkToPin                            -> 5
//   (5) the pin-seeded client given only the records up to the pin        -> 6
//   (6) workBase 0n (the pin's work not carried)                          -> 7
//   (7) workBase not reset when a reseed adopts                           -> 8
//   (8) writePin without `+ workBase`                                     -> 9
//   (9) suffixWrite without the walked records                            -> 10
//  (10) headerAt answering null below the pin-seeded base                -> 1
//  (11) parsePin without the work pattern                                 -> 11
//  (12) walkToPin without a yield per run                                -> 12
//  (13) Wallet.spvOpts without the pin line                               -> 13
// Run: npx tsx test/namespv-session-pin.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, legacyOf, records, hashOf, headerOf, forge, rehash, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites, syncAligned, SPV_CHECKPOINTS } from "../src/core/namespv.ts";
import { parsePin, walkToPin, latestTimeHolds } from "../src/core/spvpin.ts";
import { SPV_ANCHORS } from "../src/core/spvanchors.ts";
import { createHash } from "node:crypto";
import { LightClient, deserializeHeader, serializeHeader } from "../src/vendor/cairnx-spv.js";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";

const { check, done } = checker("session pin: a worker restart walks the stored suffix to the pin");
const API = "https://cairn-substrate.test";
const net = {};
serveFixture(net);
const HB = 84, SEED = 46;
const realNow = Date.now;
const clockReal = () => { Date.now = realNow; };
const reset = (tip = FIX_TOP) => { net.log.length = 0; net.tip = tip; net.tamper = undefined; clockReal(); };
const bytesEq = (a, b) => !!a && !!b && a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
// The error a restart's build or first prepare throws, or null; a section whose restart throws fails its checks.
const restart = async (o, want = FIX_TOP - 12) => { try { const src = await liveSpvSource(o); return { src, p: await src.prepare(want) }; } catch (e) { return { error: String(e?.message ?? e), p: {} }; } };

// Runs `fn` with LightClient.fromRecords recorded. `path` is "pin" when a client was seeded at the pin (pinTip),
// "full" when one was seeded at the anchor with stored records after it, else "none".
async function restorePath(fn, { pinTip = FIX_TOP, newest = NEWEST } = {}) {
  const orig = LightClient.fromRecords, calls = [];
  LightClient.fromRecords = function (recs, at, ...rest) { calls.push({ n: recs.length / HB, first: at.firstHeight, anchor: at.anchorHeight }); return orig.call(this, recs, at, ...rest); };
  try {
    const out = await fn();
    const pin = calls.some((c) => c.anchor === pinTip && c.first === pinTip - SEED + 1);
    const full = calls.some((c) => c.anchor === newest && c.n > SEED);
    return { out, path: pin && !full ? "pin" : full && !pin ? "full" : pin ? "both" : "none", calls };
  } finally { LightClient.fromRecords = orig; }
}

function slot(initial = null) {
  const s = { value: initial, sets: 0, get: async () => s.value, set: async (p) => { s.sets++; s.value = p; } };
  return s;
}
function opts(store, pin, anchors = FIX_ANCHORS) {
  const kv = new Map();
  return { rpcBase: `${API}/api/rpc`, headersBase: API, anchors, store: async () => store, legacy: legacyOf(kv),
    floor: { get: async () => 0, set: async () => {} }, ...(pin ? { pin } : {}) };
}
// The vendored work accounting for the real chain seeded at the anchor, to compare a pin's work with.
async function workAt(tip, newest = NEWEST) {
  const pages = async (from, count) => { const out = []; for (let h = from; h < from + count; h++) out.push({ header: headerOf(h), hash: hashOf(h) }); return out; };
  const { client } = await LightClient.fromRecords(records(newest - SEED + 1, newest), { firstHeight: newest - SEED + 1, anchorHeight: newest }, { headersBatchProvider: pages, checkpoints: SPV_CHECKPOINTS });
  await syncAligned(client, tip);
  return client.chainwork.toString();
}
// A session that fills the store to `tip` and writes the pin (the first worker start of a browser session).
async function firstSession(tip = FIX_TOP, anchors = FIX_ANCHORS) {
  reset(tip);
  const st = memStore(), pin = slot();
  await (await liveSpvSource(opts(st, pin, anchors))).prepare(tip - 12);
  await flushSpvStoreWrites();
  return { st, pin };
}

console.log("1. the pin is written after a full restore, and a restart restores by the walk:");
{
  const { st, pin } = await firstSession();
  check(`the pin is the verified tip (${pin.value?.tip}), its hash and the anchor it counts from`, pin.value?.v === 1 && pin.value.tip === FIX_TOP && pin.value.hash === hashOf(FIX_TOP) && pin.value.newest === NEWEST);
  check("  its work is the vendored chainwork from the anchor seed", pin.value?.work === await workAt(FIX_TOP));
  reset();
  const { out: { src, p, error }, path } = await restorePath(() => restart(opts(st, pin)));
  if (error) console.log(`    restart threw: ${error.slice(0, 120)}`);
  check(`with the pin and the real clock the restart takes the pin path (${path}) and reaches the tip (${p.verifiedTip}) with zero requests (${net.log.length})`, path === "pin" && p.verifiedTip === FIX_TOP && net.log.length === 0);
  const lo = FIX_TOP - SEED + 1;
  const ok = [NEWEST + 1, 114800, lo - 1, lo, FIX_TOP];
  const answers = src ? await Promise.all(ok.map(async (h) => (await src.hashAt(h)) === hashOf(h) && (await src.merkleAt(h)) === headerOf(h).merkle)) : [false];
  check(`  hashAt and merkleAt answer the walked heights and the pin-seeded ones (${ok.join(", ")})`, answers.every(Boolean));
  reset();
  const { path: control } = await restorePath(() => restart(opts(st, null)));
  check(`  control: without the pin the restart runs the full restore (${control})`, control === "full");
}

console.log("1b. restore parity: with the clock moved back, the pin path accepts exactly the heights the full restore accepts:");
{
  const { st, pin } = await firstSession();
  // The clock is set so the stored headers from 115,100 on are dated more than 2 hours ahead of it; F is the first
  // stored height the drift bound refuses (timestamps need not rise every block).
  const cutoff = Number(headerOf(115100).time) - 1;
  const F = (() => { for (let h = NEWEST + 1; h <= FIX_TOP; h++) if (Number(headerOf(h).time) > cutoff) return h; return null; })();
  const atClock = () => { Date.now = () => (cutoff - 2 * 3600) * 1000; };
  const accepted = async (src) => { let h = NEWEST; while (h < FIX_TOP && (await src.hashAt(h + 1)) === hashOf(h + 1)) h++; return h; };
  const run = async (slotOrNull) => {
    reset(); atClock();
    const r = await restorePath(async () => {
      try { const src = await liveSpvSource(opts(st, slotOrNull)); return { top: await accepted(src), refusal: await src.prepare(FIX_TOP - 12).then(() => null, (e) => String(e?.message ?? e)) }; }
      catch (e) { return { error: String(e?.message ?? e) }; }
    });
    clockReal();
    return r;
  };
  const full = await run(null);
  const pinned = await run(pin);
  check(`setup: the drift bound refuses from height ${F} with this clock`, F !== null && F > NEWEST + SEED && F <= 115100);
  check(`the full restore accepts through ${full.out.top} and the sync refuses on the clock`, full.path === "full" && full.out.top === F - 1 && /dated more than 2 hours ahead/.test(full.out.refusal ?? ""));
  check(`the pin restart falls back (${pinned.path}, ${pinned.calls.length} light clients built) and accepts the same heights (through ${pinned.out.top})`, pinned.path === "full" && pinned.out.top === full.out.top);
  check("  and refuses the same way", pinned.out.refusal === full.out.refusal);
  check("latestTimeHolds: the vendored client refuses the latest-dated record under this clock and accepts it under the real one",
    await (async () => { atClock(); const no = await latestTimeHolds(records(F - SEED, F), F - SEED, SPV_CHECKPOINTS); clockReal(); const yes = await latestTimeHolds(records(F - SEED, F), F - SEED, SPV_CHECKPOINTS); return no === false && yes === true; })());
}

console.log("2. a stored record changed below the pin fails the walk, and the full restore refetches it:");
{
  const { st, pin } = await firstSession();
  const bad = 114800, k = 28, at = (bad - k * 4096) * HB;
  const chunk = st.chunks.get(k).slice();
  chunk[at + 40] ^= 1; // a merkle-root byte
  st.chunks.set(k, chunk);
  reset();
  const { src, p } = await restart(opts(st, pin));
  check(`the restart refetched from the changed record (${net.log.join(" ")}) and reached ${p.verifiedTip}`, p.verifiedTip === FIX_TOP && net.log.length > 0);
  check("  the changed header is not used: merkleAt(114,800) is the real root", !!src && (await src.merkleAt(bad)) === headerOf(bad).merkle);
  await flushSpvStoreWrites();
  check("  and the store is repaired", bytesEq(st.chunks.get(k), records(k * 4096, FIX_TOP)));
}

console.log("3. a pin whose hash is not the stored chain's runs the full restore:");
{
  const { st, pin } = await firstSession();
  pin.value = { ...pin.value, hash: hashOf(FIX_TOP - 1) };
  reset();
  const { out, path } = await restorePath(() => restart(opts(st, pin)));
  check(`full restore (${path}), tip ${out.p.verifiedTip}`, path === "full" && out.p.verifiedTip === FIX_TOP);
}

console.log("4. a pin counted from another anchor runs the full restore:");
{
  const { st, pin } = await firstSession();
  pin.value = { ...pin.value, newest: NEWEST - 4096 };
  reset();
  const { out, path } = await restorePath(() => restart(opts(st, pin)));
  check(`full restore (${path}), tip ${out.p.verifiedTip}`, path === "full" && out.p.verifiedTip === FIX_TOP);
}

console.log("5. a release checkpoint between the anchor and the pin runs the full restore (the walk checks no pin):");
{
  const anchors = SPV_ANCHORS.slice(0, 20); // newest 110,591; the release entry at 114,687 lies above it
  const newest = 110591;
  const { st, pin } = await firstSession(FIX_TOP, anchors);
  check(`setup: the pin counts from 110,591 and covers 114,687 (${pin.value?.newest}, ${pin.value?.tip})`, pin.value?.newest === newest && pin.value.tip === FIX_TOP && SPV_CHECKPOINTS[114687] === SPV_ANCHORS[20]);
  reset();
  const { out, path } = await restorePath(() => restart(opts(st, pin, anchors)), { newest });
  check(`full restore (${path}), tip ${out.p.verifiedTip}`, path === "full" && out.p.verifiedTip === FIX_TOP);
}

console.log("6. headers stored above the pin are restored with every check:");
{
  const { st } = await firstSession();
  const pin = slot({ v: 1, newest: NEWEST, tip: 115000, hash: hashOf(115000), work: await workAt(115000) });
  reset();
  const { src, p } = await restart(opts(st, pin));
  check(`a pin below the stored tip restores the rest from the store: tip ${p.verifiedTip}, zero requests (${net.log.length})`, p.verifiedTip === FIX_TOP && net.log.length === 0 && !!src && (await src.hashAt(115100)) === hashOf(115100));
  const k = 28, at = (115100 - k * 4096) * HB, chunk = st.chunks.get(k).slice();
  chunk[at + 40] ^= 1;
  st.chunks.set(k, chunk);
  reset();
  const { src: src2, p: p2 } = await restart(opts(st, slot({ v: 1, newest: NEWEST, tip: 115000, hash: hashOf(115000), work: await workAt(115000) })));
  check(`  a changed record above the pin stops the restore there and is refetched (${net.log.join(" ")})`, p2.verifiedTip === FIX_TOP && net.log.length > 0 && !!src2 && (await src2.merkleAt(115100)) === headerOf(115100).merkle);
}

// The reseed after a pin restore: the store and pin end at 115,000, the served page breaks once at 115,001, the
// name's `want` is 115,050 and the node tip 115,199. `inflate` adds 100 headers' worth to the chainwork the
// vendored getter reports for the client whose tip is 115,000 (the instrument of namespv-reseed-work.test.mjs).
async function reseedAfterPin({ inflate }) {
  const { st, pin } = await firstSession(115000);
  const desc = Object.getOwnPropertyDescriptor(LightClient.prototype, "chainwork");
  try {
    if (inflate) {
      Object.defineProperty(LightClient.prototype, "chainwork", { configurable: true, get() {
        const real = desc.get.call(this);
        return this.chain[this.chain.length - 1]?.height === 115000 ? real + real * 100n / BigInt(this.chain.length) : real;
      } });
    }
    reset(FIX_TOP);
    let broken = false;
    net.tamper = (from, rows) => {
      if (broken || !rows.some((r) => r.height === 115001)) return rows;
      broken = true;
      return rows.map((r) => (r.height === 115001 ? rehash(forge(r)) : r));
    };
    const { src, p } = await restart(opts(st, pin), 115050 - 12);
    await flushSpvStoreWrites();
    return { p, src, st, pin, log: [...net.log] };
  } finally {
    Object.defineProperty(LightClient.prototype, "chainwork", desc);
  }
}

console.log("7. after a pin restore the reseed compares the held chain's work from the anchor seed:");
{
  const { p, log } = await reseedAfterPin({ inflate: true });
  check(`a held branch with more work than the honest chain at want is compared at the node tip and replaced (${p.verifiedTip}; ${log.join(" ")})`, p.verifiedTip === FIX_TOP && log.join(" ") === "115001/50 114688/363 114688/512");
}

console.log("8. a reseed that adopts carries no pin offset into the new chain:");
{
  const { p, src, st, pin, log } = await reseedAfterPin({ inflate: false });
  check(`honest path: the reseed adopts at want (${p.verifiedTip}; ${log.join(" ")})`, p.verifiedTip === 115050 && log.join(" ") === "115001/50 114688/363" && !!src && (await src.hashAt(115050)) === hashOf(115050));
  check(`  the new pin is the adopted tip with the vendored work from the anchor seed (${pin.value?.tip})`, pin.value?.tip === 115050 && pin.value.hash === hashOf(115050) && pin.value.work === await workAt(115050));
  check("  the store holds the adopted chain", st.head?.tip === 115050 && bytesEq(st.chunks.get(28), records(114688, 115050)));
}

console.log("9 and 10. a sync after a pin restore writes the real records and the work from the anchor seed:");
{
  const { st, pin } = await firstSession(115000);
  reset(FIX_TOP);
  const { p } = await restart(opts(st, pin));
  await flushSpvStoreWrites();
  check(`the sync fetched the suffix page once (${net.log.join(" ")}) and reached ${p.verifiedTip}`, p.verifiedTip === FIX_TOP && net.log.join(" ") === "114688/512");
  check("  the pin moved to the tip with the vendored work from the anchor seed", pin.value?.tip === FIX_TOP && pin.value.hash === hashOf(FIX_TOP) && pin.value.work === await workAt(FIX_TOP));
  check("  the suffix chunk written spans the walked and the synced records, byte for byte", bytesEq(st.chunks.get(28), records(114688, FIX_TOP)) && st.head?.tip === FIX_TOP);
}

console.log("11. a malformed or unreadable pin runs the full restore:");
{
  const { st } = await firstSession();
  for (const [what, value] of [["work not a number", { v: 1, newest: NEWEST, tip: FIX_TOP, hash: hashOf(FIX_TOP), work: "12x" }], ["no version", { newest: NEWEST, tip: FIX_TOP, hash: hashOf(FIX_TOP), work: "1" }], ["a string", "pin"]]) {
    reset();
    const { p } = await restart(opts(st, slot(value)));
    check(`${what}: the full restore runs and reaches the tip (${p.verifiedTip})`, p.verifiedTip === FIX_TOP);
  }
  reset();
  const throwing = { get: async () => { throw new Error("session storage unavailable"); }, set: async () => {} };
  const { p } = await restart(opts(st, throwing));
  check(`a slot that throws on read: the full restore runs (${p.verifiedTip})`, p.verifiedTip === FIX_TOP);
  check("parsePin keeps only the five fields", JSON.stringify(parsePin({ v: 1, newest: 1, tip: 2, hash: hashOf(FIX_TOP), work: "7", x: 1 })) === JSON.stringify({ v: 1, newest: 1, tip: 2, hash: hashOf(FIX_TOP), work: "7" }));
}

console.log("12. the walk yields once per 4,096-record run:");
{
  const newest = 110591, suffix = records(newest + 1, FIX_TOP);
  let yields = 0;
  const ok = await walkToPin(suffix, newest, { v: 1, newest, tip: FIX_TOP, hash: hashOf(FIX_TOP), work: "1" }, { [newest]: SPV_ANCHORS[19] }, async () => { yields++; });
  let want = newest + 1;
  for (let h = newest + 1; h <= FIX_TOP; h++) if (Number(headerOf(h).time) > Number(headerOf(want).time)) want = h;
  check(`4,608 records walk to the pin in two runs and name the first latest-dated height (${ok}, ${yields} yields)`, ok === want && yields === 2);
}

console.log("12b. the walk names the latest-dated record, not the newest one (timestamps need not rise):");
{
  // A hash-linked run that is not a chain (no PoW: the walk checks links only): the real records 110,592 to 110,691
  // with the record at 110,641 re-dated past every other and the links after it recomputed.
  const newest = 110591, recs = records(newest + 1, newest + 100), mid = 49;
  const h = deserializeHeader(recs.subarray(mid * HB, (mid + 1) * HB));
  recs.set(serializeHeader({ ...h, time: Number(headerOf(newest + 100).time) + 3600 }), mid * HB);
  const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
  for (let i = mid + 1; i < 100; i++) recs.set(sha256d(recs.subarray((i - 1) * HB, i * HB)), i * HB + 4);
  const tipHash = "0x" + sha256d(recs.subarray(99 * HB)).toString("hex");
  const got = await walkToPin(recs, newest, { v: 1, newest, tip: newest + 100, hash: tipHash, work: "1" }, { [newest]: SPV_ANCHORS[19] }, async () => {});
  check(`the walk returns the re-dated height ${newest + 1 + mid} (${got}), not the pin's ${newest + 100}`, got === newest + 1 + mid);
}

console.log("13. the Wallet hands the light client its session storage as the pin slot:");
{
  const session = memoryStore();
  const w = new Wallet(memoryStore(), session);
  let seen = null;
  w.spvBuildForTest = async (o) => { seen = o; return { prepare: async () => ({}) }; };
  w.prewarmSpv();
  await new Promise((r) => setTimeout(r, 0));
  const pin = { v: 1, newest: NEWEST, tip: FIX_TOP, hash: hashOf(FIX_TOP), work: "1" };
  await seen?.pin?.set(pin);
  check("spvOpts carries a pin slot over chrome.storage.session key spvPin", JSON.stringify(await session.get("spvPin")) === JSON.stringify(pin) && JSON.stringify(await seen.pin.get()) === JSON.stringify(pin));
  const w2 = new Wallet(memoryStore(), null);
  let seen2 = null;
  w2.spvBuildForTest = async (o) => { seen2 = o; return { prepare: async () => ({}) }; };
  w2.prewarmSpv();
  await new Promise((r) => setTimeout(r, 0));
  check("  without session storage there is no pin slot (every restore is full)", seen2 !== null && seen2.pin === undefined);
}

clockReal();
done("namespv-session-pin");
