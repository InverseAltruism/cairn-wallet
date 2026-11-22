// The sealed restore through the production liveSpvSource on real headers to 146,829 (test/helpers/spvfixture.mjs, the
// table cut at 131,071; chunks 32 and 33 sealable). What it reads and holds (invariant 3), the same headers with and
// without seals, the work a seal carries against a count made here from the compact bits (each seeding path: the
// table, a seal, the session pin, a rebase), the wait while locked and the unlocked path that does not wait
// (invariant 4), the key fetched at each write, stale lists as a normal store state (invariant 1), and the Wallet's
// wiring. Run: npx tsx test/namespv-seal-restore.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, records, hashOf, legacyOf, v1Snapshot, SEAL_ANCHORS, SEAL_NEWEST, SEAL_TOP } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites } from "../src/core/namespv.ts";
import { checkSeals, sealKeyGetter, sealRecord } from "../src/core/spvseal.ts";
import { importKeyRaw } from "../src/core/keystore.ts";
import { DB_VERSION } from "../src/core/headerstore.ts";
import { LightClient, deserializeHeader } from "../src/vendor/cairnx-spv.js";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";

const { check, done } = checker("sealed restore: reads, work, the locked wait, stale lists, wiring");
const API = "https://cairn-substrate.test";
const net = { tip: SEAL_TOP };
serveFixture(net);
const CH = 4096, SEED = 46, NEWEST_K = 31;
const TABLE = { newest: SEAL_NEWEST, newestHash: hashOf(SEAL_NEWEST) };
const topOf = (k) => k * CH + CH - 1;
const tick = () => new Promise((r) => setTimeout(r, 5));

// The chainwork at h counted from the light client's seed below the table's newest entry, from the compact bits.
const workOfBits = (bits) => {
  const exp = bits >>> 24, mant = BigInt(bits & 0xffffff);
  const target = exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
  return (1n << 256n) / (target + 1n);
};
const cum = [0n];
for (let x = SEAL_NEWEST - SEED + 1; x <= SEAL_TOP; x++) cum.push(cum[cum.length - 1] + workOfBits(Number(deserializeHeader(records(x, x)).bits)));
const workAt = (h) => cum[h - (SEAL_NEWEST - SEED)];

const vk = await importKeyRaw("0a".repeat(32));
let cur = vk;
const sealKey = sealKeyGetter(() => cur);
const K = await sealKey();
const honestTops = [32, 33].map((k) => ({ k, top: hashOf(topOf(k)), work: workAt(topOf(k)) }));
function honestStore(tip = SEAL_TOP) {
  const st = memStore();
  for (let k = NEWEST_K; k <= Math.floor(tip / CH); k++) st.chunks.set(k, records(k * CH, Math.min(topOf(k), tip)));
  st.head = { v: 2, tip, tipHash: hashOf(tip) };
  st.seals = sealRecord(K, TABLE, honestTops.filter((e) => topOf(e.k) <= tip - CH));
  return st;
}
const opts = (st, extra = {}) => ({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => st, sealKey, unlocked: () => Promise.resolve(), ...extra });
// Records which light clients the restore builds: { first, anchor, n } per LightClient.fromRecords call.
async function seeds(fn) {
  const orig = LightClient.fromRecords, calls = [];
  LightClient.fromRecords = function (recs, at, ...rest) { calls.push({ first: at.firstHeight, anchor: at.anchorHeight, n: recs.length / 84 }); return orig.call(this, recs, at, ...rest); };
  try { return { out: await fn(), calls }; } finally { LightClient.fromRecords = orig; }
}
const storedWork = (st) => (checkSeals(K, st.seals, TABLE) ?? []).map((e) => ({ k: e.k, ok: e.work === workAt(topOf(e.k)) && e.top === hashOf(topOf(e.k)) }));

console.log("1. what a sealed restore reads and holds (invariant 3):");
{
  const st = honestStore();
  net.log.length = 0;
  const { out: src, calls } = await seeds(() => liveSpvSource(opts(st)));
  const p = await src.prepare(SEAL_TOP - 12);
  check(`it reads the table chunk, the seed chunk 33 and the tail 34 and 35, nothing else (${st.readKeys.join(",")})`, st.readKeys.join(",") === "31,33,34,35");
  check(`it seeds one client at the seal's top 139,263 holding ${calls[0]?.n} headers (at most 8,237), and requests no header (${net.log.length})`,
    calls.length === 1 && calls[0].anchor === topOf(33) && calls[0].n <= 8237 && calls[0].n === SEED + CH + (SEAL_TOP - topOf(34)) && net.log.length === 0 && p.verifiedTip === SEAL_TOP);
  const plain = await liveSpvSource({ ...opts(honestStore()), sealKey: async () => null, unlocked: undefined });
  await plain.prepare(SEAL_TOP - 12);
  let differ = 0, checked = 0;
  for (let h = SEAL_NEWEST - CH + 1; h <= SEAL_TOP; h += 7) { checked++; if ((await src.hashAt(h)) !== (await plain.hashAt(h)) || (await src.merkleAt(h)) !== (await plain.merkleAt(h))) differ++; }
  check(`with and without seals the same verified header and merkle root at ${checked} heights from 126,976 to the tip (${differ} differ)`, differ === 0 && checked > 2800);
  check("a sealed chunk below the client's base answers from its stored bytes walked to the seal (no request)", (await src.hashAt(topOf(32) - 5)) === hashOf(topOf(32) - 5) && net.log.length === 0);
}

console.log("2. the work in a seal counts from the seed below the table's newest entry, once, on every path:");
{
  // A first session to 142,000 seeds at the table and seals chunk 32 from that client.
  net.tip = 142000;
  const st = memStore();
  const s1 = await liveSpvSource(opts(st));
  await s1.prepare(142000 - 12);
  await flushSpvStoreWrites();
  const w1 = storedWork(st);
  check(`table-seeded session: chunk 32's seal carries the work and top counted here (${JSON.stringify(w1)})`, w1.length === 1 && w1[0].ok);
  // The same store without its list (as 0.3.4 or a locked session leaves it): the restore seeds at the table, the
  // catch-up seals chunk 32 and rebases the client onto it, and the sync on to the tip seals 33 on the rebased client.
  st.seals = null;
  net.tip = SEAL_TOP;
  const { calls: rebased } = await seeds(async () => {
    const s2 = await liveSpvSource(opts(st));
    await s2.prepare(SEAL_TOP - 12);
  });
  await flushSpvStoreWrites();
  const w2 = storedWork(st);
  check(`rebased client (seeded at ${rebased.map((c) => c.anchor).join(",")}): chunk 33's seal carries the work counted here (${JSON.stringify(w2)})`,
    rebased.some((c) => c.anchor === topOf(32) && c.first === topOf(32) - SEED + 1) && w2.length === 2 && w2.every((e) => e.ok));
  // A restore seeded at chunk 32's seal (the store cut back to 142,000) syncs on and seals chunk 33.
  const st2 = honestStore(142000);
  const pinSlot = { value: null, get: async () => pinSlot.value, set: async (p) => { pinSlot.value = p; } };
  const s2 = await liveSpvSource(opts(st2, { pin: pinSlot }));
  await s2.prepare(SEAL_TOP - 12);
  await flushSpvStoreWrites();
  const w3 = storedWork(st2);
  check(`seal-seeded client: chunk 33's seal carries the work counted here (${JSON.stringify(w3)})`, w3.length === 2 && w3.every((e) => e.ok));
  check(`  and its session pin at ${pinSlot.value?.tip} carries the work counted here`, pinSlot.value?.tip === SEAL_TOP && BigInt(pinSlot.value.work) === workAt(SEAL_TOP));
  // A worker restart in the same session with its pin at 143,000, above seal 33 (the walk from 139,263 crosses no
  // table entry): the client is seeded at the pin, and the pin it writes at the tip carries the work counted here.
  const st3 = honestStore();
  pinSlot.value = { v: 1, newest: SEAL_NEWEST, tip: 143000, hash: hashOf(143000), work: workAt(143000).toString() };
  const { calls } = await seeds(async () => { const s3 = await liveSpvSource(opts(st3, { pin: pinSlot })); await s3.prepare(SEAL_TOP - 12); });
  check(`pin-seeded client (seeded at ${calls.map((c) => c.anchor).join(",")}): the pin it writes at ${pinSlot.value?.tip} carries the work counted here`,
    calls.some((c) => c.anchor === 143000 && c.first === 143000 - SEED + 1) && pinSlot.value?.tip === SEAL_TOP && BigInt(pinSlot.value.work) === workAt(SEAL_TOP));
}

console.log("3. locked with a list stored, nothing is built or requested until unlock (invariant 4):");
{
  const st = honestStore();
  let unlock;
  const unlocked = new Promise((r) => { unlock = r; });
  cur = null;
  net.log.length = 0;
  let built = false;
  const pending = liveSpvSource(opts(st, { unlocked: () => unlocked })).then((s) => { built = true; return s; });
  await tick(); await tick();
  check(`while locked: no source, no header request (${net.log.length}) and no chunk read (${st.readKeys.length})`, !built && net.log.length === 0 && st.readKeys.length === 0);
  cur = vk;
  unlock();
  const src = await pending;
  check(`after unlock it restores from the seal (reads ${st.readKeys.join(",")})`, built && st.readKeys.join(",") === "31,33,34,35" && (await src.prepare(SEAL_TOP - 12)).verifiedTip === SEAL_TOP);
  // Without an unlock signal and no key, the seals are ignored and every stored header is verified.
  cur = null;
  const st2 = honestStore();
  const { calls } = await seeds(async () => (await liveSpvSource(opts(st2, { unlocked: undefined }))).prepare(SEAL_TOP - 12));
  check(`a locked restore reads every chunk (${st2.readKeys.join(",")}) and seeds at the table with all ${calls[0]?.n} records`, st2.readKeys.join(",") === "31,32,33,34,35" && calls[0]?.anchor === SEAL_NEWEST && calls[0]?.n === SEED + SEAL_TOP - SEAL_NEWEST);
  cur = vk;
  // A proven empty list means what no list means: the restore verifies from the table.
  const st4 = honestStore();
  st4.seals = sealRecord(K, TABLE, []);
  const { calls: c4 } = await seeds(async () => (await liveSpvSource(opts(st4))).prepare(SEAL_TOP - 12));
  check(`an empty list seeds at the table with every stored record (${c4[0]?.anchor}, ${c4[0]?.n} records)`, c4[0]?.anchor === SEAL_NEWEST && c4[0]?.n === SEED + SEAL_TOP - SEAL_NEWEST);
  // Unlocked, the wait is not taken: an unlock signal that never settles changes nothing.
  const st3 = honestStore();
  const t0 = performance.now();
  const never = new Promise((resolve) => { void resolve; /* never called: an unlock that does not come */ });
  const src3 = await liveSpvSource(opts(st3, { unlocked: () => never }));
  check(`unlocked, the restore never waits on the signal (built in ${Math.round(performance.now() - t0)} ms, reads ${st3.readKeys.join(",")})`, !!src3 && st3.readKeys.join(",") === "31,33,34,35");
}

console.log("4. the key is fetched for each write: after a lock, writes carry no list:");
{
  net.tip = 142000;
  const st = memStore();
  const src = await liveSpvSource(opts(st));
  await src.prepare(142000 - 12);
  await tick(); await flushSpvStoreWrites();
  const before = JSON.stringify(st.seals);
  cur = null;
  net.tip = SEAL_TOP;
  st.writes.length = 0;
  await src.prepare(SEAL_TOP - 12);
  await flushSpvStoreWrites();
  check(`locked mid-session: the suffix write lands without a list (${st.writes.length} writes, ${st.writes.filter((w) => w.seals).length} with one) and the stored list stays`, st.writes.length > 0 && st.writes.every((w) => !w.seals) && JSON.stringify(st.seals) === before);
  cur = vk;
  const again = await liveSpvSource(opts(st));
  await again.prepare(SEAL_TOP - 12);
  await tick(); await flushSpvStoreWrites();
  check("  the next unlocked restore seals the chunk the locked write left unsealed", storedWork(st).length === 2 && storedWork(st).every((e) => e.ok));
}

console.log("5. stale lists are a normal store state (invariant 1):");
{
  // A write without a list over sealed chunks: chunk 33 rewritten (other bytes), the list still names its old top.
  const st = honestStore();
  const r = st.chunks.get(33).slice(); r[84 * 7 + 40] ^= 0xff; st.chunks.set(33, r);
  net.log.length = 0;
  const { out: src, calls } = await seeds(() => liveSpvSource(opts(st)));
  const p = await src.prepare(SEAL_TOP - 12);
  await tick(); await flushSpvStoreWrites();
  check(`a write without a list over sealed chunk 33: seeded at seal 32 instead (${calls[0]?.anchor}), no refusal, verified to ${p.verifiedTip}`, calls[0]?.anchor === topOf(32) && p.verifiedTip === SEAL_TOP);
  check("  the headers of 33 are verified the slow way and the store's chunk 33 and list are rewritten", (await src.hashAt(topOf(33))) === hashOf(topOf(33)) && Buffer.from(st.chunks.get(33)).equals(Buffer.from(records(33 * CH, topOf(33)))) && storedWork(st).length === 2 && storedWork(st).every((e) => e.ok));
  // The list names a chunk 0.3.4 deleted (a truncation into the sealed run).
  const st2 = honestStore();
  for (const k of [33, 34, 35]) st2.chunks.delete(k);
  st2.chunks.set(32, records(32 * CH, 32 * CH + 99));
  const src2 = await liveSpvSource(opts(st2));
  const p2 = await src2.prepare(SEAL_TOP - 12);
  await tick(); await flushSpvStoreWrites();
  check(`a list naming chunks 0.3.4 truncated: seeded at the table, verified to ${p2.verifiedTip}, list rewritten`, p2.verifiedTip === SEAL_TOP && storedWork(st2).length === 2 && storedWork(st2).every((e) => e.ok));
}

{
  // Chunk 32 holds other bytes under an intact seal 33: the restore seeds at 33, and a read in 32 refetches the chunk.
  const st = honestStore();
  const r = st.chunks.get(32).slice(); r[84 * 300 + 40] ^= 0xff; st.chunks.set(32, r);
  net.log.length = 0;
  const src = await liveSpvSource(opts(st));
  await src.prepare(SEAL_TOP - 12);
  const h = 32 * CH + 300;
  const honest = (await src.hashAt(h)) === hashOf(h) && (await src.hashAt(h - 1)) === hashOf(h - 1);
  check(`a sealed chunk below the seed with other bytes: the read at ${h} answers the honest header from a refetch of its 8 pages (${net.log.length} requests)`,
    honest && net.log.length === 8);
}

{
  // The same stored bytes, and a header source serving other bytes for chunk 32: that read is not verified, the call
  // answers null, nothing throws, and the client above keeps answering.
  const st = honestStore();
  const r = st.chunks.get(32).slice(); r[84 * 300 + 40] ^= 0xff; st.chunks.set(32, r);
  const src = await liveSpvSource(opts(st));
  await src.prepare(SEAL_TOP - 12);
  net.tamper = (from, rows) => (from >= 32 * CH && from <= topOf(32) ? rows.map((x, i) => (i === 3 ? { ...x, header: { ...x.header, nonce: x.header.nonce + 1 } } : x)) : rows);
  const h = 32 * CH + 300;
  const got = await src.hashAt(h).catch((e) => `threw ${e}`);
  net.tamper = undefined;
  check(`a refetched sealed chunk that fails its seal answers null for that call (${got}), and the tip still answers`, got === null && (await src.hashAt(SEAL_TOP)) === hashOf(SEAL_TOP));
}

console.log("6. the Wallet hands the source its seal key getter and the unlock signal:");
{
  const w = new Wallet(memoryStore(), memoryStore());
  let seen = null;
  w.spvBuildForTest = async (o) => { seen = o; return { prepare: async () => ({}) }; };
  await w.create("correct horse battery");
  w.prewarmSpv();
  await tick();
  const k1 = await seen.sealKey();
  await w.lock();
  const kLocked = await seen.sealKey();
  let woke = false;
  const waiting = seen.unlocked().then(() => { woke = true; });
  await tick();
  const asleep = !woke;
  await w.unlock("correct horse battery");
  await waiting;
  const k2 = await seen.sealKey();
  check("the getter gives a key unlocked, none locked, the same key after unlock", k1 !== null && kLocked === null && k2 !== null && Buffer.from(k1).equals(Buffer.from(k2)));
  check("the unlock signal waits while locked and settles at unlock", asleep && woke);
}

console.log("7. a reset and a new vault in the same worker drop the source and the session pin:");
{
  const session = memoryStore();
  const w = new Wallet(memoryStore(), session);
  const st = memStore();
  let builds = 0;
  w.spvBuildForTest = (o) => { builds++; return liveSpvSource({ ...o, rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => st, legacy: undefined }); };
  net.tip = SEAL_TOP;
  await w.create("correct horse battery");
  const kA = await w.sealKey();
  await (await w.spvSource()).prepare(SEAL_TOP - 12);
  await tick(); await flushSpvStoreWrites();
  const sealedA = checkSeals(kA, st.seals, TABLE)?.length;
  const pinA = await session.get("spvPin");
  await w.reset();
  const pinAfterReset = await session.get("spvPin");
  await w.create("another battery staple");
  const kB = await w.sealKey();
  const { calls } = await seeds(async () => { await (await w.spvSource()).prepare(SEAL_TOP - 12); });
  await tick(); await flushSpvStoreWrites();
  check(`vault A sealed ${sealedA} chunks and wrote a pin; the reset deletes the pin (${pinA ? "pin" : "none"} then ${pinAfterReset ? "pin" : "none"})`, sealedA === 2 && !!pinA && pinAfterReset == null);
  check(`vault B gets a new source (${builds} builds) whose restore seeds at the table (${calls.map((c) => c.anchor).join(",")}): A's seals do not verify under B's key`, builds === 2 && calls[0]?.anchor === SEAL_NEWEST);
  check("  and the list stored after it verifies under B's key only", checkSeals(kB, st.seals, TABLE)?.length === 2 && checkSeals(kA, st.seals, TABLE) === null);
}

console.log("8. a source parked while locked makes no header request before the balance answer (invariant 10):");
{
  const fetchLog = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (url, init) => { fetchLog.push(String(url)); return inner(url, init); };
  const w = new Wallet(memoryStore(), memoryStore());
  const st = honestStore();
  st.chunks.delete(NEWEST_K);
  w.spvBuildForTest = (o) => liveSpvSource({ ...o, rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => st, legacy: undefined });
  await w.create("correct horse battery");
  await w.lock();
  fetchLog.length = 0;
  w.prewarmSpv();
  await tick(); await tick();
  const whileLocked = fetchLog.filter((u) => u.includes("/api/headers/")).length;
  await w.unlock("correct horse battery");
  await tick(); await tick();
  const beforeBalance = fetchLog.filter((u) => u.includes("/api/headers/")).length;
  await w.balance().catch(() => null);
  for (let i = 0; i < 40 && !fetchLog.some((u) => u.includes("/api/headers/")); i++) await tick();
  const firstHeader = fetchLog.findIndex((u) => u.includes("/api/headers/")), firstBalance = fetchLog.findIndex((u) => u.includes("/utxos/"));
  globalThis.fetch = inner;
  check(`no header request while locked (${whileLocked}) nor between unlock and the balance answer (${beforeBalance})`, whileLocked === 0 && beforeBalance === 0);
  check(`  the parked restore requests the anchor chunk after the balance request (balance at ${firstBalance}, first header page at ${firstHeader})`, firstBalance >= 0 && firstHeader > firstBalance);
}

console.log("9. a pin exactly at the sealed top:");
{
  // A pin 0 above the restore's base is not walked: the restore seeds at the seal.
  const st3 = honestStore();
  const pinSlot = { value: { v: 1, newest: SEAL_NEWEST, tip: topOf(33), hash: hashOf(topOf(33)), work: workAt(topOf(33)).toString() }, get: async () => pinSlot.value, set: async (p) => { pinSlot.value = p; } };
  const { out: s3, calls: c3 } = await seeds(async () => { const s = await liveSpvSource(opts(st3, { pin: pinSlot })); await s.prepare(SEAL_TOP - 12); return s; });
  check(`one client seeded at the seal (${c3.map((c) => `${c.anchor}/${c.n}`).join(",")}), honest headers`, c3.length === 1 && c3[0].anchor === topOf(33) && (await s3.hashAt(topOf(33))) === hashOf(topOf(33)) && (await s3.hashAt(SEAL_TOP)) === hashOf(SEAL_TOP));
}

console.log("10. a failed migration write: the base never moves above what is stored:");
{
  const kv = new Map([["spvHeaderChain", v1Snapshot(126976, 145000)]]);
  let failed = false;
  const st = memStore({ failWrite: (w) => (w.head && !failed ? (failed = true) : false) });
  net.tip = SEAL_TOP;
  const src = await liveSpvSource(opts(st, { legacy: legacyOf(kv) }));
  await tick();
  const p = await src.prepare(SEAL_TOP - 12);
  await tick(); await flushSpvStoreWrites();
  const bad = [];
  for (let k = 32; k <= 35; k++) if (!Buffer.from(st.chunks.get(k) ?? []).equals(Buffer.from(records(k * CH, Math.min(topOf(k), SEAL_TOP))))) bad.push(k);
  check(`after the migration write failed once, the chunks written afterwards are the chain's bytes (wrong: ${bad.join(",") || "none"}), verified to ${p.verifiedTip}`, failed && bad.length === 0 && p.verifiedTip === SEAL_TOP);
}

console.log("11. a reseed after a seal-seeded or rebased restore compares work counted once:");
for (const how of ["seal-seeded", "rebased"]) {
  const st = honestStore(145000);
  if (how === "rebased") st.seals = null;
  net.tip = SEAL_TOP;
  let calls = 0;
  net.tamper = (from, rows) => (from === 144896 && ++calls === 1 ? rows.map((x) => (x.height === 145001 ? { ...x, header: { ...x.header, nonce: x.header.nonce + 1 } } : x)) : rows);
  const src = await liveSpvSource(opts(st));
  const p = await src.prepare(SEAL_TOP - 12).catch((e) => ({ error: String(e?.message ?? e) }));
  net.tamper = undefined;
  check(`${how}: a page that breaks once reseeds from the table, and the honest chain with more work is adopted (${p.verifiedTip ?? p.error})`, p.verifiedTip === SEAL_TOP && calls >= 2 && (await src.hashAt(146000)) === hashOf(146000));
}

check(`the header database stays at version 1 (a bump makes 0.3.4 delete it) (${DB_VERSION})`, DB_VERSION === 1);
done("namespv-seal-restore");
