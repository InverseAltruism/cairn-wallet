// The header store migration when the store cannot be written, and what it may touch in chrome.storage.local
// (cairn docs/Plans/86 section 3.8; section 6 cases 6 and 11).
//
// Invariants pinned here:
//   - v1 (`spvHeaderChain`) survives a failed migration, which counts one attempt (`spvMigrateAttempts`); the
//     next healthy start completes it and deletes v1 once; after MIGRATE_MAX failures v1 is deleted and the
//     session runs from memory. The counter is cleared after a success and after that deletion.
//   - The migration writes only `spvHeaderChain` and `spvMigrateAttempts`; every key 0.2.73 reads stays
//     byte-identical, and after a success `spvHeaderChain` is absent, so a rollback to 0.2.73 cold-syncs.
//
// Synthetic base: the v1 snapshots start at 106,496 because the fixture holds no headers from 32,768 to 106,495
// (see test/namespv-store-migrate.test.mjs).
//
// Run: npx tsx test/namespv-store-migrate-attempts.test.mjs   (offline)
import { liveSpvSource, flushSpvStoreWrites, MIGRATE_MAX, LEGACY_MAX_BYTES } from "../src/core/namespv.ts";
import { Wallet } from "../src/core/wallet.ts";
import { chromeStore, memoryStore } from "../src/core/storage.ts";
import { checker } from "./helpers/check.mjs";
import { records, hashOf, v1Snapshot, serveFixture, memStore, legacyOf, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";

const t = checker("namespv-store-migrate-attempts");
const C26 = [106496, 110591], C27 = [110592, NEWEST];

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

t.check("setup: MIGRATE_MAX is 3, as section 3.8 states", MIGRATE_MAX === 3);

// ── case 6: a store whose write of chunk 27 fails once, then a healthy start ──
console.log("6 a write fails after one chunk, then the store recovers:");
{
  const kv = new Map([["spvHeaderChain", v1Snapshot(106496, FIX_TOP)]]);
  const legacy = legacyOf(kv);
  let failing = true;
  const st = memStore({ failWrite: (w) => failing && (w.put ?? []).some((p) => p.k === 27) });
  const net = { tip: FIX_TOP };
  await attempt("first start: the session answers from memory with no request", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    return (await s.hashAt(115000)) === hashOf(115000) && (await s.hashAt(112000)) === hashOf(112000) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
  t.check("first start: v1 is kept and attempt 1 is counted", kv.has("spvHeaderChain") && legacy.calls.del === 0 && kv.get("spvMigrateAttempts") === 1);
  t.check("first start: no head was written (chunk 26 alone is in the store)", st.head === null && st.chunks.has(26) && !st.chunks.has(27));
  failing = false;
  await attempt("next start with a healthy store completes the migration with no request", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    return (await s.hashAt(108000)) === hashOf(108000) && (await s.hashAt(115000)) === hashOf(115000) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
  t.check("v1 deleted exactly once, after the head", !kv.has("spvHeaderChain") && legacy.calls.del === 1 && st.head?.tip === FIX_TOP);
  t.check("the store is complete: 26, 27 and the suffix", same(st.chunks.get(26), records(...C26)) && same(st.chunks.get(27), records(...C27)) && same(st.chunks.get(28), records(114688, FIX_TOP)));
  t.check("the attempt counter is cleared after the success", !kv.has("spvMigrateAttempts"));
  await withNet(net, () => liveSpvSource(opts(st, legacy)));
  t.check("a third start finds no v1 and deletes nothing more", legacy.calls.del === 1 && legacy.calls.get === 3);
}

console.log("6 three failed starts in a row:");
{
  const kv = new Map([["spvHeaderChain", v1Snapshot(106496, FIX_TOP)]]);
  const legacy = legacyOf(kv);
  const st = memStore({ failWrite: () => true });
  const net = { tip: FIX_TOP };
  const counts = [];
  for (let i = 1; i <= MIGRATE_MAX; i++) {
    await attempt(`start ${i}: the source builds and answers above the anchor from memory`, () => withNet(net, async () => {
      const s = await liveSpvSource(opts(st, legacy));
      return (await s.hashAt(115000)) === hashOf(115000);
    }));
    await flushSpvStoreWrites();
    counts.push([kv.has("spvHeaderChain"), kv.get("spvMigrateAttempts") ?? 0, legacy.calls.del]);
  }
  t.check("starts 1 and 2 keep v1 and count 1 then 2", JSON.stringify(counts.slice(0, 2)) === JSON.stringify([[true, 1, 0], [true, 2, 0]]));
  t.check("start 3 deletes v1 once and clears the counter", JSON.stringify(counts[2]) === JSON.stringify([false, 0, 1]));
  await attempt("after the deletion the session still proves a height below the anchor (fetched, held in memory)", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(st, legacy));
    const before = net.log.length;
    const r = await s.prepare(FIX_TOP - 12);
    return r.verifiedTip === FIX_TOP && (await s.hashAt(108000)) === hashOf(108000) && (await s.hashAt(108001)) === hashOf(108001)
      && net.log.slice(before).filter((p) => Number(p.split("/")[0]) <= C26[1]).length === 8;
  }));
  await flushSpvStoreWrites();
  t.check("the fourth start counts nothing and deletes nothing (there is no v1)", legacy.calls.del === 1 && !kv.has("spvMigrateAttempts"));
}

// ── case 11: the downgrade contract, through the Wallet's own spvOpts over a chrome.storage.local double ──
console.log("11 chrome.storage.local keys after the migration:");
const ADDR = "0x" + "ab".repeat(20);
const KEPT = {
  vault: { v: 3, iters: 600000, salt: "c2FsdA==", iv: "aXY=", ct: "Y2lwaGVydGV4dA==" },
  [`txHistory:${ADDR}`]: [{ txid: "0x" + "11".repeat(32), ts: 1760000000000, amount: 100000000, maybe: true }],
  [`sealedClaims:${ADDR}`]: { "alice.csd": { iv: "aXY=", ct: "c2VhbA==" } },
  connectedOrigins: { "https://cairn-substrate.com": { addr: ADDR, ts: 1760000000000 } },
  spvNodeTipFloor: 115100,
  customRpcs: ["http://127.0.0.1:8789"],
  customExplorers: ["https://explorer.example"],
};
function chromeLocal(seed, { bytesInUse = (k) => (k === "spvHeaderChain" ? 33_000_000 : 0) } = {}) {
  const mem = new Map(Object.entries(structuredClone(seed)));
  const log = { set: [], remove: [], get: [], order: [] };
  globalThis.chrome = { storage: { local: {
    get: async (k) => { log.get.push(k); log.order.push("get:" + k); return { [k]: structuredClone(mem.get(k)) }; },
    set: async (o) => { for (const k of Object.keys(o)) { log.set.push(k); mem.set(k, structuredClone(o[k])); } },
    remove: async (k) => { log.remove.push(k); mem.delete(k); },
    getBytesInUse: async (k) => { log.order.push("bytes:" + k); return bytesInUse(k); },
  } } };
  return { mem, log };
}
const keptIdentical = (mem) => Object.entries(KEPT).every(([k, v]) => JSON.stringify(mem.get(k)) === JSON.stringify(v));
// Wallet.spvOpts() with only the store replaced: IndexedDB does not exist in this process.
const walletOpts = async (store, local = chromeStore()) => {
  const w = new Wallet(local, null);
  await w.init();
  return { ...w.spvOpts(), store: async () => store, anchors: FIX_ANCHORS };
};

{
  const { mem, log } = chromeLocal({ ...KEPT, spvHeaderChain: v1Snapshot(106496, FIX_TOP), spvMigrateAttempts: 1 });
  const st = memStore();
  const o = await walletOpts(st);
  const writesBefore = log.set.length, removesBefore = log.remove.length, orderBefore = log.order.length;
  const net = { tip: FIX_TOP };
  await attempt("a successful migration through the Wallet's spvOpts answers with no request", () => withNet(net, async () => {
    const s = await liveSpvSource(o);
    return (await s.hashAt(108000)) === hashOf(108000) && (await s.hashAt(115000)) === hashOf(115000) && net.log.length === 0;
  }));
  await flushSpvStoreWrites();
  const touched = [...log.set.slice(writesBefore), ...log.remove.slice(removesBefore)];
  t.check("the size was read from getBytesInUse(\"spvHeaderChain\") before the value", (() => { const o = log.order.slice(orderBefore); const b = o.indexOf("bytes:spvHeaderChain"); return b >= 0 && o.indexOf("get:spvHeaderChain") > b; })());
  t.check("only spvHeaderChain and spvMigrateAttempts were written or removed", touched.length > 0 && touched.every((k) => k === "spvHeaderChain" || k === "spvMigrateAttempts"));
  t.check("vault, txHistory, sealedClaims, connectedOrigins, spvNodeTipFloor, customRpcs, customExplorers are byte-identical", keptIdentical(mem));
  t.check("spvHeaderChain and spvMigrateAttempts are absent, so 0.2.73 cold-syncs", !mem.has("spvHeaderChain") && !mem.has("spvMigrateAttempts"));
}
{
  const { mem, log } = chromeLocal({ ...KEPT, spvHeaderChain: v1Snapshot(106496, FIX_TOP) });
  const st = memStore({ failWrite: () => true });
  const o = await walletOpts(st);
  const writesBefore = log.set.length;
  await withNet({ tip: FIX_TOP }, () => liveSpvSource(o));
  await flushSpvStoreWrites();
  t.check("a failed migration writes only the counter and keeps every other key", log.set.slice(writesBefore).every((k) => k === "spvMigrateAttempts")
    && mem.get("spvMigrateAttempts") === 1 && mem.has("spvHeaderChain") && keptIdentical(mem));
}
{
  const { mem, log } = chromeLocal({ ...KEPT, spvHeaderChain: v1Snapshot(106496, FIX_TOP) }, { bytesInUse: () => LEGACY_MAX_BYTES + 1 });
  const o = await walletOpts(memStore());
  const getsBefore = log.get.length;
  await withNet({ tip: FIX_TOP }, () => liveSpvSource(o));
  t.check("getBytesInUse above 200 MB: spvHeaderChain is removed without being read", !mem.has("spvHeaderChain")
    && !log.get.slice(getsBefore).includes("spvHeaderChain") && keptIdentical(mem));
}
{
  // A Store without bytesInUse (memoryStore, localStore) reports null: the migration still runs.
  const local = memoryStore();
  for (const [k, v] of Object.entries(KEPT)) await local.set(k, v);
  await local.set("spvHeaderChain", v1Snapshot(106496, FIX_TOP));
  const st = memStore();
  const o = await walletOpts(st, local);
  await withNet({ tip: FIX_TOP }, () => liveSpvSource(o));
  await flushSpvStoreWrites();
  t.check("a Store that cannot report its size still migrates", (await local.get("spvHeaderChain")) === null && same(st.chunks.get(26), records(...C26)));
}

t.done();
