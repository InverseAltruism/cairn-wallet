// BP4/N11: makeSerializer - the single-flight primitive that serializes LC.sync so two concurrent consumers
// of the wallet's SHARED light client cannot interleave ingests (LightClient.ingest throws "out-of-order
// ingest" on an interleave -> a spurious fail-closed decline on a legitimate fill/name-verify). This unit
// test drives the exported primitive directly; the serialization's USE around LC.sync is in namespv.ts
// liveSpvSource.prepare and is exercised end-to-end by the fill-fclaim-preflight suite.
//
// Run: node --import tsx test/spv-serializer.test.mjs   (offline)
import assert from "node:assert/strict";
import { makeSerializer } from "../src/core/namespv.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}`); };
const okA = async (name, fn) => { try { ok(name, await fn()); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.stack || e.message); } };
const tick = () => new Promise((r) => setTimeout(r, 5));

console.log("makeSerializer (BP4/N11 single-flight for LC.sync):");

await okA("concurrent ops NEVER overlap (max in-flight == 1) - the out-of-order-ingest defense", async () => {
  const s = makeSerializer();
  let inFlight = 0, maxInFlight = 0;
  const op = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await tick(); inFlight--; };
  await Promise.all([s(op), s(op), s(op), s(op), s(op)]);   // fired concurrently
  return maxInFlight === 1;
});

await okA("FIFO: ops run in submission order", async () => {
  const s = makeSerializer();
  const order = [];
  await Promise.all([1, 2, 3, 4].map((n) => s(async () => { await tick(); order.push(n); })));
  return order.join("") === "1234";
});

await okA("a throwing op propagates its OWN error to its OWN caller (fail-closed)", async () => {
  const s = makeSerializer();
  let caught = null;
  await s(async () => { throw new Error("boom"); }).catch((e) => { caught = e; });
  return caught instanceof Error && caught.message === "boom";
});

await okA("a prior op's throw does NOT wedge the chain - later ops still run", async () => {
  const s = makeSerializer();
  const results = [];
  const p1 = s(async () => { throw new Error("boom"); }).catch(() => results.push("p1-threw"));
  const p2 = s(async () => { results.push("p2-ran"); return 2; });
  const p3 = s(async () => { results.push("p3-ran"); return 3; });
  const [, r2, r3] = await Promise.all([p1, p2, p3]);
  return r2 === 2 && r3 === 3 && results.includes("p2-ran") && results.includes("p3-ran");
});

await okA("a caller sees its own op's RESULT", async () => {
  const s = makeSerializer();
  const r = await s(async () => { await tick(); return 42; });
  return r === 42;
});

// MUTATION: without the tail.then chaining (run op immediately), concurrent ops overlap -> the no-overlap
// invariant breaks. Prove the chaining is load-bearing by replicating the mutated primitive here.
await okA("MUTATION[no chaining -> immediate run]: concurrent ops now OVERLAP (proves the chain is the serializer)", async () => {
  const mutated = () => { return (op) => op(); };   // the single-flight removed
  const s = mutated();
  let inFlight = 0, maxInFlight = 0;
  const op = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await tick(); inFlight--; };
  await Promise.all([s(op), s(op), s(op)]);
  return maxInFlight > 1;   // the real makeSerializer keeps this at 1; the mutant overlaps
});

console.log(`\nspv-serializer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
