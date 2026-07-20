// BP4/N11: makeSerializer - the single-flight primitive that serializes LC.sync so two concurrent consumers
// of the wallet's SHARED light client cannot interleave ingests (LightClient.ingest throws "out-of-order
// ingest" on an interleave -> a spurious fail-closed decline on a legitimate fill/name-verify). This file
// covers BOTH halves of the fix: (1) a BEHAVIORAL unit test that the exported primitive actually serializes,
// and (2) a SOURCE guard that the primitive is APPLIED at its one use-site (liveSpvSource.prepare wraps
// LC.sync in serializeSync). Half (2) exists because the G3-review found that removing the wrapper while
// keeping the primitive left the whole suite GREEN (the "guard-of-the-guard" gap, N24 class). A live
// concurrent-prepare() test is not offline-runnable: liveSpvSource builds its OWN vendored LightClient (real
// PoW headers) with no injection seam, and bolting a test-only seam onto a fund path is exactly the
// over-engineering the wallet's rules forbid - so the wiring is pinned at the source, in the repo's own
// source-scan idiom (cf. test/pentest.ts).
//
// Run: node --import tsx test/spv-serializer.test.mjs   (offline)
import { readFileSync } from "node:fs";
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

// USE-SITE GUARD (N24 guard-of-the-guard). The primitive above is only worth anything if prepare() actually
// WRAPS LC.sync in it. The G3 review's MUT-G stripped the wrapper (keeping the primitive) and the entire
// behavioral suite stayed GREEN - the exact failure class this campaign keeps re-learning. liveSpvSource
// constructs the real vendored LightClient (real PoW), so we pin the wiring at the source instead of mocking
// a money path. These are the assertions that RED on that mutation.
console.log("\nliveSpvSource.prepare use-site (BP4/N11 wiring, source-pinned):");
const nspvSrc = readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8");
const wrapped = /serializeSync\(\s*async[\s\S]{0,600}?await LC\.sync\(/;   // serializeSync(async ... await LC.sync( in order
const syncCount = (nspvSrc.match(/await LC\.sync\(/g) || []).length;

ok("prepare() WRAPS LC.sync in serializeSync (the fix is APPLIED, not merely defined)", wrapped.test(nspvSrc));
ok("exactly one LC.sync call-site (a new, unwrapped sync would escape the serializer - re-audit if this trips)", syncCount === 1);
ok("the sync call sits AFTER the serializer is constructed (no un-serialized sync path)",
   nspvSrc.indexOf("await LC.sync(") > nspvSrc.indexOf("const serializeSync = makeSerializer()") &&
   nspvSrc.indexOf("const serializeSync = makeSerializer()") !== -1);

// MUTATION (mirrors the G3 MUT-G): a prepare() body with the wrapper stripped MUST fail the guard. Inline
// fixtures (repo idiom, cf. the primitive mutation above) so the guard's failability is self-evident and
// robust to reindentation of the real source.
const wrappedFixture = "      await serializeSync(async () => {\n        const cur = 0;\n        await LC.sync(want);\n      });";
const nakedFixture   = "        const cur = 0;\n        await LC.sync(want);";
ok("guard PASSES on wrapped source", wrapped.test(wrappedFixture));
ok("MUTATION[wrapper stripped -> naked LC.sync]: guard REDS (proves it covers the G3/MUT-G gap the suite missed)", !wrapped.test(nakedFixture));

console.log(`\nspv-serializer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
