// 0.2.70: cache.set is off the click path. toSnapshot() is captured inside the lock;
// only the write is detached. flushSpvSnapshotWrites awaits the pending write so
// namespv-partial-persist / storage-durability can still observe durability.
import { detachSnapshotWrite, flushSpvSnapshotWrites } from "../src/core/namespv.ts";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const okA = async (n, fn) => { try { ok(n, await fn()); } catch (e) { fail++; console.log("  ✗", n, "\n      ", e.stack || e.message); } };

console.log("snapshot detach (0.2.70):");

await okA("detach returns before cache.set resolves", async () => {
  let resolved = false;
  let release;
  const gate = new Promise((r) => { release = r; });
  const cache = { set: async (s) => { await gate; cache.got = s; resolved = true; } };
  detachSnapshotWrite(cache, { v: 1 });
  const returnedBefore = resolved === false;
  release();
  await flushSpvSnapshotWrites();
  return returnedBefore && resolved === true && cache.got.v === 1;
});

await okA("latest-wins: a newer snap replaces a pending one", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const cache = { set: async (s) => { if (seen.length === 0) await gate; seen.push(s.n); } };
  detachSnapshotWrite(cache, { n: 1 });
  detachSnapshotWrite(cache, { n: 2 });
  detachSnapshotWrite(cache, { n: 3 });
  release();
  await flushSpvSnapshotWrites();
  // first in-flight write (n=1) may land; subsequent coalesced writes land as latest (3)
  return seen.includes(3) && !seen.includes(2);
});

await okA("flush waits for the detached write (durability hook)", async () => {
  const cache = { got: null, set: async (s) => { await new Promise((r) => setTimeout(r, 20)); cache.got = s; } };
  detachSnapshotWrite(cache, { k: "snap" });
  await flushSpvSnapshotWrites();
  return cache.got && cache.got.k === "snap";
});

console.log(`\nnamespv-snapshot-detach: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
