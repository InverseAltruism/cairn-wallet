// The header-store write is off the click path. suffixWrite() builds the write inside the serialized block; only
// the store transaction is detached (detachStoreWrite): one chained writer per store, and a write that arrives while
// another is in flight is merged into the pending one by chunk key (mergeStoreWrites), so a burst of advances
// costs at most two transactions and loses no chunk. flushSpvStoreWrites() awaits the detached writes so
// namespv-partial-persist and the restore tests can inspect a store.
//
// Run: npx tsx test/namespv-snapshot-detach.test.mjs   (offline)
import { detachStoreWrite, flushSpvStoreWrites, mergeStoreWrites } from "../src/core/namespv.ts";
import { checker } from "./helpers/check.mjs";
import { memStore } from "./helpers/spvfixture.mjs";

const t = checker("store write detach:");
const tick = () => new Promise((r) => setTimeout(r, 5));
const attempt = async (name, fn) => {
  try { t.check(name, await fn()); }
  catch (e) { t.check(`${name} (threw: ${e?.message ?? e})`, false); }
};
const quiet = async (fn) => {
  const real = console.warn;
  const warns = [];
  console.warn = (...a) => { warns.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.warn = real; }
  return warns;
};

const rec = (n) => new Uint8Array(84).fill(n);
const head = (tip) => ({ v: 2, tip, tipHash: "0x" + tip.toString(16).padStart(64, "0") });
const wr = (k, n, extra = {}) => ({ put: [{ k, records: rec(n) }], ...extra });

// A memStore whose write() counts its calls and can be held at a gate, to model a transaction in flight.
function controlled(opts) {
  const store = memStore(opts);
  const inner = store.write;
  const ctl = { calls: 0, gate: null, release: null };
  ctl.hold = () => { ctl.gate = new Promise((r) => { ctl.release = () => { ctl.gate = null; r(); }; }); };
  store.write = async (w) => { ctl.calls++; if (ctl.gate) await ctl.gate; return inner(w); };
  return { store, ctl };
}

await attempt("detach returns before the store write resolves; flush then settles with the data stored", async () => {
  const { store, ctl } = controlled();
  ctl.hold();
  detachStoreWrite(store, wr(8, 1, { head: head(7) }));
  const returnedBefore = store.chunks.size === 0;
  await tick();
  let flushed = false;
  const f = flushSpvStoreWrites().then(() => { flushed = true; });
  await tick();
  const pendingWhileHeld = flushed === false;
  ctl.release();
  await f;
  return returnedBefore && pendingWhileHeld && flushed && store.chunks.get(8)?.[0] === 1 && store.head?.tip === 7;
});

await attempt("a burst of 6 writes while one is in flight costs 2 store.write calls and the store holds every chunk", async () => {
  const { store, ctl } = controlled();
  ctl.hold();
  detachStoreWrite(store, wr(8, 1, { head: head(1) }));
  await tick();                                                   // the first transaction is now in flight
  for (let i = 2; i <= 6; i++) detachStoreWrite(store, wr(7 + i, i, { head: head(i) }));
  ctl.release();
  await flushSpvStoreWrites();
  const ks = [...store.chunks.keys()].sort((a, b) => a - b).join();
  return ctl.calls === 2 && ks === "8,9,10,11,12,13" && store.head?.tip === 6 && [8, 9, 10, 11, 12, 13].every((k, i) => store.chunks.get(k)[0] === i + 1);
});

await attempt("newer wins: two pending writes of one chunk key leave the newer bytes", async () => {
  const { store, ctl } = controlled();
  ctl.hold();
  detachStoreWrite(store, wr(8, 1));
  await tick();
  detachStoreWrite(store, wr(9, 2));
  detachStoreWrite(store, wr(9, 3));
  ctl.release();
  await flushSpvStoreWrites();
  return ctl.calls === 2 && store.chunks.get(9)?.[0] === 3 && store.chunks.get(8)?.[0] === 1;
});

await attempt("a later deleteAbove drops the older pending puts above it and the stored chunks above it", async () => {
  const { store, ctl } = controlled();
  store.chunks.set(12, rec(9));                                   // already stored above the truncation
  ctl.hold();
  detachStoreWrite(store, wr(8, 1));
  await tick();
  detachStoreWrite(store, wr(10, 2));                             // older, above the later deleteAbove
  detachStoreWrite(store, wr(9, 3, { deleteAbove: 9, head: head(9) }));
  ctl.release();
  await flushSpvStoreWrites();
  return [...store.chunks.keys()].sort((a, b) => a - b).join() === "8,9" && store.chunks.get(9)?.[0] === 3 && store.head?.tip === 9;
});

await attempt("a failing write is warned and the next write still runs", async () => {
  const { store, ctl } = controlled({ failWrite: (_w, i) => i === 0 });
  ctl.hold();
  detachStoreWrite(store, wr(8, 1));
  await tick();
  detachStoreWrite(store, wr(9, 2, { head: head(2) }));
  ctl.release();
  const warns = await quiet(async () => { await flushSpvStoreWrites(); });
  // the failing first transaction wrote nothing; the second landed
  return store.writes[0].failed === true && !store.chunks.has(8) && store.chunks.get(9)?.[0] === 2 && store.head?.tip === 2
    && ctl.calls === 2 && warns.some((w) => /header store write failed/.test(w));
});

await attempt("the failure itself is warned, never thrown to the caller or to flush", async () => {
  const { store } = controlled({ failWrite: () => true });
  let threw = false;
  const warns = await quiet(async () => {
    try { detachStoreWrite(store, wr(8, 1)); await flushSpvStoreWrites(); } catch { threw = true; }
  });
  return !threw && warns.some((w) => /header store write failed/.test(w));
});

await attempt("writes to different stores are independent: each store gets its own writer", async () => {
  const a = controlled(), b = controlled();
  a.ctl.hold();
  detachStoreWrite(a.store, wr(8, 1));
  detachStoreWrite(b.store, wr(8, 2));
  await tick();
  const bLanded = b.store.chunks.get(8)?.[0] === 2 && a.store.chunks.size === 0;   // b is not queued behind a's open transaction
  a.ctl.release();
  await flushSpvStoreWrites();
  return bLanded && a.store.chunks.get(8)?.[0] === 1;
});

t.check("mergeStoreWrites: newer puts and head win, older puts above newer.deleteAbove are dropped",
  (() => {
    const m = mergeStoreWrites(wr(10, 1, { head: head(1) }), { put: [{ k: 9, records: rec(2) }, { k: 10, records: rec(3) }], deleteAbove: 10, head: head(2) });
    const by = new Map(m.put.map((p) => [p.k, p.records[0]]));
    const dropped = mergeStoreWrites({ put: [{ k: 11, records: rec(1) }, { k: 8, records: rec(1) }] }, { deleteAbove: 9 });
    return by.get(9) === 2 && by.get(10) === 3 && m.deleteAbove === 10 && m.head.tip === 2
      && dropped.put.length === 1 && dropped.put[0].k === 8 && dropped.deleteAbove === 9;
  })());
t.check("mergeStoreWrites keeps the older head and deleteAbove when the newer write carries none",
  (() => { const m = mergeStoreWrites(wr(8, 1, { head: head(5), deleteAbove: 8 }), wr(9, 2)); return m.head.tip === 5 && m.deleteAbove === 8 && m.put.length === 2; })());
t.check("mergeStoreWrites refuses a write carrying del (suffix writes never do)",
  (() => { try { mergeStoreWrites({ del: [8] }, wr(9, 1)); return false; } catch (e) { return /carry no del/.test(e.message); } })());

t.done("namespv-snapshot-detach");
