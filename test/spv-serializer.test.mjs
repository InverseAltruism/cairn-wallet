// BP4/N11: makeSerializer - the single-flight primitive that serializes every light-client sync (and every chunk
// acquisition) so two concurrent consumers of the wallet's SHARED light client cannot interleave ingests
// (LightClient.ingest throws "out-of-order ingest" on an interleave -> a spurious fail-closed decline on a
// legitimate fill/name-verify). This file covers three layers: (1) a BEHAVIORAL unit test that the exported
// primitive actually serializes, (2) a SOURCE guard that the primitive is APPLIED: every light-client sync in
// liveSpvSource sits inside the one serializeSync block of prepare(), and chunk acquisition gets the same
// serializer, and (3) BEHAVIORAL checks through the real liveSpvSource over real headers: concurrent prepare()
// calls sync once, concurrent chunk reads fetch the chunk once. Layer (2) exists because the G3-review found that
// removing the wrapper while keeping the primitive left the whole suite GREEN (the "guard-of-the-guard" gap, N24).
//
// Run: npx tsx test/spv-serializer.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { makeSerializer, liveSpvSource, flushSpvStoreWrites } from "../src/core/namespv.ts";
import { checker } from "./helpers/check.mjs";
import { hashOf, serveFixture, memStore, legacyOf, FIX_TOP, FIX_ANCHORS } from "./helpers/spvfixture.mjs";

const t = checker();
const ok = t.check;
const okA = async (name, fn) => { try { ok(name, await fn()); } catch (e) { ok(`${name} (threw: ${e?.message ?? e})`, false); } };
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

// USE-SITE GUARD (N24 guard-of-the-guard). The primitive above is only worth anything if every sync runs inside it.
// liveSpvSource constructs the real vendored LightClient (real PoW), so the wiring is pinned at the source.
console.log("\nliveSpvSource use-site (BP4/N11 wiring, source-pinned):");
const nspvSrc = readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8");
// Comments are stripped so prose mentioning a call cannot count as, or hide, a call site.
const code = nspvSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const pStart = code.indexOf("async prepare(maxEventHeight");
const prep = code.slice(pStart, code.indexOf("async blockAt(", pStart));
const serStart = prep.indexOf("await serializeSync(async () => {");
const serEnd = prep.indexOf("const verifiedTip = tipOf(LC)");
const block = prep.slice(serStart, serEnd);
const norm = (m) => m.replace(/\s+/g, " ");
const sites = (text) => [...text.matchAll(/await (sync(?:WithPartialPersist|Aligned)\([^;]*?\));/g)].map((m) => norm(m[1]));

ok("prepare() body and its serialized block located", pStart > 0 && serStart > 0 && serEnd > serStart);
ok("exactly one serializeSync block in the file (prepare's)", (code.match(/\bserializeSync\(/g) || []).length === 1);
// The fourth site is the reseed's sync on to the node tip when the work comparison at `want` is undecided.
const PREP_SITES = "syncWithPartialPersist(LC, want, persist) | syncAligned(LC, want) | syncAligned(fresh, want) | syncAligned(fresh, nodeTip)";
ok("the four prepare-level sync call sites are exactly syncWithPartialPersist(LC), syncAligned(LC), syncAligned(fresh, want) and syncAligned(fresh, nodeTip), in that order",
  sites(prep).join(" | ") === PREP_SITES);
ok("every one of them sits INSIDE the serialized block (a sync outside it would race the shared light client)",
  sites(block).length === 4 && sites(block).join() === sites(prep).join());
ok("the file's whole sync call-site set is that, plus syncAligned inside syncWithPartialPersist (reached only from the serialized block): an unwrapped new sync trips this",
  sites(code).join(" | ") === `${PREP_SITES} | syncAligned(lc, next)`);
ok("no direct light-client sync outside syncAligned (only lc.sync inside the helper)",
  (code.match(/\b(?:LC|fresh|lc)\.sync\(/g) || []).join() === "lc.sync(");
ok("the serializer is constructed before the block that uses it", code.indexOf("const serializeSync = makeSerializer()") > 0 && code.indexOf("const serializeSync = makeSerializer()") < code.indexOf("await serializeSync("));
ok("chunk acquisition gets the same serializer: chunkAcquirer({ ..., serialize: serializeSync, ... }), constructed once",
  (code.match(/\bchunkAcquirer\(/g) || []).length === 1 && /chunkAcquirer\(\{[^}]*\bserialize: serializeSync\b[^}]*\}\)/.test(code));

// MUTATION fixtures (repo idiom): the sync-site pin must RED when a sync escapes the block.
const inBlock = (text) => sites(text.slice(text.indexOf("await serializeSync("), text.indexOf("\n});") + 4)).join(" | ");
const goodBlock = "await serializeSync(async () => {\n try {\n await syncWithPartialPersist(LC, want, persist);\n await syncAligned(LC, want);\n } catch (e) { await syncAligned(fresh, want); }\n});";
const nakedBlock = "await serializeSync(async () => {\n try {\n await syncWithPartialPersist(LC, want, persist);\n } catch (e) { await syncAligned(fresh, want); }\n});\nawait syncAligned(LC, want);";
const expected = "syncWithPartialPersist(LC, want, persist) | syncAligned(LC, want) | syncAligned(fresh, want)";
ok("site pin PASSES on the wrapped fixture", inBlock(goodBlock) === expected);
ok("MUTATION[a sync moved out of the serialized block]: the in-block set no longer matches", inBlock(nakedBlock) !== expected);

// Behavioral, through the real liveSpvSource over real mainnet headers.
console.log("\nliveSpvSource concurrency (BP4/N11, behavioral):");
const opts = (store) => ({
  rpcBase: "https://spv.invalid/api/rpc", headersBase: "https://spv.invalid", anchors: FIX_ANCHORS,
  store: async () => store, legacy: legacyOf(new Map()),
  floor: { get: async () => null, set: async () => {} },
});
await okA("two concurrent prepare() calls sync once (no out-of-order ingest) and both see the same verified tip", async () => {
  const net = { tip: FIX_TOP };
  const restore = serveFixture(net);
  try {
    const store = memStore();
    const s = await liveSpvSource(opts(store));
    net.log.length = 0;                                       // the anchor chunk's 8 requests belong to the restore
    const [a, b] = await Promise.all([s.prepare(FIX_TOP), s.prepare(FIX_TOP)]);
    await flushSpvStoreWrites();
    return a.verifiedTip === FIX_TOP && b.verifiedTip === FIX_TOP && net.log.join() === "114688/512" && (await s.hashAt(FIX_TOP)) === hashOf(FIX_TOP);
  } finally { restore(); }
});
await okA("three concurrent reads in one anchored chunk fetch the chunk once (8 aligned pages), and each returns the chain's hash", async () => {
  const net = { tip: FIX_TOP };
  const restore = serveFixture(net);
  try {
    const s = await liveSpvSource(opts(memStore()));
    net.log.length = 0;
    const hs = await Promise.all([108000, 108500, 109000].map((h) => s.hashAt(h)));
    await flushSpvStoreWrites();
    return net.log.length === 8 && hs.every((h, i) => h === hashOf([108000, 108500, 109000][i]));
  } finally { restore(); }
});

t.done("spv-serializer");
