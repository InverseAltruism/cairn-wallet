// The sealed restore through the production liveSpvSource on real headers to 146,829 (test/helpers/spvfixture.mjs, the
// table cut at 131,071; chunks 32 and 33 sealable). What it reads and holds (invariant 3), the same headers with and
// without seals, the work a seal carries against a count made here from the compact bits (each seeding path: the
// table, a seal, the session pin, a rebase), the wait while locked and the unlocked path that does not wait
// (invariant 4), the key fetched at each write, stale lists as a normal store state (invariant 1), and the Wallet's
// wiring. Run: npx tsx test/namespv-seal-restore.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, records, hashOf, SEAL_ANCHORS, SEAL_NEWEST, SEAL_TOP } from "./helpers/spvfixture.mjs";
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
  // A first session to 142,000 seeds at the table; its catch-up seals chunk 32 and rebases the client there.
  net.tip = 142000;
  const st = memStore();
  const s1 = await liveSpvSource(opts(st));
  await s1.prepare(142000 - 12);
  await flushSpvStoreWrites();
  await tick(); await flushSpvStoreWrites();
  const w1 = storedWork(st);
  check(`table-seeded session: chunk 32's seal carries the work and top counted here (${JSON.stringify(w1)})`, w1.length === 1 && w1[0].ok);
  // The same session after its rebase onto chunk 32 syncs on to the tip: chunk 33's seal is made on the rebased client.
  net.tip = SEAL_TOP;
  await s1.prepare(SEAL_TOP - 12);
  await flushSpvStoreWrites();
  const w2 = storedWork(st);
  check(`rebased client: chunk 33's seal carries the work counted here (${JSON.stringify(w2)})`, w2.length === 2 && w2.every((e) => e.ok));
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
  // Unlocked, the wait is not taken: an unlock signal that never settles changes nothing.
  const st3 = honestStore();
  const t0 = performance.now();
  const src3 = await liveSpvSource(opts(st3, { unlocked: () => new Promise(() => {}) }));
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

check(`the header database stays at version 1 (a bump makes 0.3.4 delete it) (${DB_VERSION})`, DB_VERSION === 1);
done("namespv-seal-restore");
