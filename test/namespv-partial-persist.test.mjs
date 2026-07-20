// BP8b (REBIND N10 wallet-half / N14 "hard wall, not a slow retry"): partial-progress snapshot
// persistence for the namespv header sync.
//
// Defect shape: namespv persisted its header snapshot only after a FULLY successful LC.sync, so a
// rate-limited (429'd) cold bootstrap persisted NOTHING and every retry restarted from the baked
// checkpoint. Fix: syncWithPartialPersist checkpoints the verified chain after each fully synced
// SYNC_PERSIST_WINDOW, and prepare()'s catch persists the mid-window tail before failing closed, so
// the next attempt RESUMES and bills only the remaining span.
//
// Three layers here (the repo's established split for liveSpvSource internals, cf.
// spv-serializer.test.mjs / namespv-reseed-recover.test.mjs):
//   (1) BEHAVIORAL units on the exported syncWithPartialPersist, driven by a fake lc that is
//       faithful to the vendored LightClient contract the helper relies on (verified by reading
//       src/vendor/cairnx-spv.js LightClient.sync/ingest: sync appends verified headers one by one,
//       a mid-sync throw RETAINS the already-verified prefix in memory, toSnapshot serializes the
//       current chain). The vendored bundle only changes through the PROVENANCE gate.
//   (2) SOURCE pins that prepare() actually WIRES the helper inside the serialized critical
//       section, persists the tail in its catch BEFORE classification, and that no partial-persist
//       path can advance the lapse floor (the B5a floorAdvance invariant).
//   (3) A BEHAVIORAL storage-poisoning check through the REAL liveSpvSource + vendored
//       fromSnapshot: a poisoned snapshot is NEVER adopted (re-verify-on-load is the defense BP8b
//       must not weaken; more frequent persistence changes WHEN we write, never what restore trusts).
//
// Run: node --import tsx test/namespv-partial-persist.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { syncWithPartialPersist, SYNC_PERSIST_WINDOW, liveSpvSource, CP } from "../src/core/namespv.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}`); };
const okA = async (name, fn) => { try { ok(name, await fn()); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.stack || e.message); } };

// Fake lc, faithful to the vendored contract (see header): `net.budget` models the /api/headers
// request budget; when it runs out mid-sync the transport throws EXACTLY like an exhausted 429
// ladder, with the verified prefix retained in memory.
function fakeLc(base, tipInclusive, net) {
  const lc = {
    baseHeight: base,
    chain: new Array(tipInclusive - base + 1).fill(0),
    async sync(to) {
      for (let h = lc.baseHeight + lc.chain.length; h <= to; h++) {
        if (net.budget <= 0) throw new Error("/api/headers 429");
        net.budget--; net.billed++;
        lc.chain.push(h);                    // header verified + appended (ingest contract)
      }
    },
    toSnapshot() { return { base: lc.baseHeight, tip: lc.baseHeight + lc.chain.length - 1 }; },
  };
  return lc;
}

console.log("syncWithPartialPersist (BP8b) - behavioral:");

const W = SYNC_PERSIST_WINDOW;
const BASE = 1000;
const WANT = BASE + W * 2 + Math.floor(W / 2);      // ~2.5 windows: a genuinely long cold span
const SPAN = WANT - BASE;

// Shared across the resume pair: the persisted snapshot survives "service worker death".
const cache = { snap: null, sets: 0, torn: 0 };
const persist = async (s) => {
  cache.sets++;
  cache.snap = s;
  return s; // (value unused)
};

await okA("429 partway through a cold sync PERSISTS window progress (not nothing) and fails closed", async () => {
  const net = { budget: W + Math.floor(W / 4), billed: 0 };   // dies mid-window 2
  const lc = fakeLc(BASE, BASE, net);
  const persistChecked = async (s) => { if (s.tip !== lc.baseHeight + lc.chain.length - 1) cache.torn++; return persist(s); };
  let threw = false;
  try { await syncWithPartialPersist(lc, WANT, persistChecked); } catch { threw = true; }
  // window 1 (BASE+W) fully synced and PERSISTED; window 2 died mid-flight but its verified prefix
  // is retained in memory for the caller's catch-tail persist (pinned at the source below).
  return threw && cache.snap !== null && cache.snap.tip === BASE + W && cache.sets === 1
    && lc.baseHeight + lc.chain.length - 1 === BASE + net.billed;
});

ok("no snapshot handed to persist was ever torn (tip matched the lc at call time)", cache.torn === 0);

await okA("the NEXT attempt RESUMES from the persisted snapshot: heights billed < the full span", async () => {
  // restart: a fresh lc restored from the persisted partial snapshot (fromSnapshot re-verifies in
  // production; the fake models the restored chain), full budget.
  const net2 = { budget: Number.MAX_SAFE_INTEGER, billed: 0 };
  const lc2 = fakeLc(cache.snap.base, cache.snap.tip, net2);
  const resumeFrom = cache.snap.tip;
  await syncWithPartialPersist(lc2, WANT, persist);
  await lc2.sync(WANT);                                       // prepare()'s final leg
  // instrumented resume: the second attempt bills ONLY the remaining span, never the full one
  return net2.billed === WANT - resumeFrom && net2.billed < SPAN
    && lc2.baseHeight + lc2.chain.length - 1 === WANT;
});

await okA("a sync shorter than one window never enters the loop: ZERO extra persists (warm hot path)", async () => {
  const net = { budget: Number.MAX_SAFE_INTEGER, billed: 0 };
  const lc = fakeLc(BASE, BASE, net);
  let sets = 0;
  await syncWithPartialPersist(lc, BASE + W - 1, async () => { sets++; });
  return sets === 0 && net.billed === 0;                      // final leg belongs to the caller
});

await okA("a FAILING persist is fail-soft: the sync itself still completes (never a refusal)", async () => {
  const net = { budget: Number.MAX_SAFE_INTEGER, billed: 0 };
  const lc = fakeLc(BASE, BASE, net);
  await syncWithPartialPersist(lc, BASE + W * 2 + 5, async () => { throw new Error("QUOTA"); });
  return lc.baseHeight + lc.chain.length - 1 >= BASE + W * 2; // both windows synced despite persist failures
});

// ── (2) source pins: the helper is WIRED in prepare(), tail-persisted in the catch, floor-safe ──
console.log("\nliveSpvSource.prepare use-site (BP8b wiring, source-pinned):");
const src = readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8");
const pStart = src.indexOf("async prepare(maxEventHeight");
const pEnd = src.indexOf("async blockAt(", pStart);
const prep = src.slice(pStart, pEnd);
ok("prepare() body located", pStart > 0 && pEnd > pStart);

const wired = /serializeSync\(\s*async[\s\S]{0,700}?await syncWithPartialPersist\(LC, want, persistSnap\);[\s\S]{0,300}?await LC\.sync\(want\)/;
ok("prepare() runs syncWithPartialPersist INSIDE the serialized section, BEFORE the final LC.sync leg", wired.test(prep));
ok("exactly one syncWithPartialPersist call-site (an unwrapped second sync path would escape the serializer)",
   (src.match(/await syncWithPartialPersist\(/g) || []).length === 1);
// the catch persists the mid-window tail BEFORE classifying transient-vs-structural, guarded on progress
const catchIdx = prep.indexOf("} catch (e) {");
const tailPersistIdx = prep.indexOf("await opts.cache.set(LC.toSnapshot())");
const classifyIdx = prep.indexOf("const msg = String((e as Error)");
ok("the catch persists partial progress (tail) BEFORE the transient/structural classification",
   catchIdx > 0 && tailPersistIdx > catchIdx && classifyIdx > tailPersistIdx);
ok("the tail persist is progress-guarded (no rewrite when nothing was ingested)",
   /LC\.baseHeight \+ LC\.chain\.length - 1 > cur/.test(prep.slice(catchIdx, classifyIdx)));
// B5a composition: NO partial-persist path may advance the lapse floor. floorAdvance lives strictly
// AFTER the serialized block (a throw skips it), and neither the helper nor the catch touches it.
const serIdx = prep.indexOf("await serializeSync(");
const serEnd = prep.indexOf("const verifiedTip = LC.baseHeight");
ok("floorAdvance sits strictly AFTER the serialized sync block (a rethrow skips it: partial persist never advances the floor)",
   serIdx > 0 && serEnd > serIdx && prep.indexOf("floorAdvance(") > serEnd && !prep.slice(serIdx, serEnd).includes("floorAdvance("));
const helperDef = src.slice(src.indexOf("export async function syncWithPartialPersist"), src.indexOf("}", src.indexOf("export async function syncWithPartialPersist(")) + 1);
ok("syncWithPartialPersist itself never touches the floor (no floorAdvance / opts.floor reference)",
   helperDef.length > 0 && !/floorAdvance|opts\.floor/.test(helperDef));

// MUTATION fixtures (repo idiom, cf. spv-serializer.test.mjs): the wiring guard must RED when the
// partial-persist call is stripped back to the persist-only-on-full-success shape.
const wiredFixture = "await serializeSync(async () => {\n  try {\n    await syncWithPartialPersist(LC, want, persistSnap);\n    await LC.sync(want);\n  } catch (e) {}\n});";
const strippedFixture = "await serializeSync(async () => {\n  try {\n    await LC.sync(want);\n  } catch (e) {}\n});";
ok("wiring guard PASSES on the wired shape", wired.test(wiredFixture));
ok("MUTATION[persist-only-on-full-success]: wiring guard REDS on the stripped shape", !wired.test(strippedFixture));

// ── (3) storage-poisoning: a poisoned snapshot is NEVER adopted (re-verify-on-load intact) ──────
console.log("\nrestore re-verification (storage-poisoning defense, behavioral):");
const origFetch = globalThis.fetch;
try {
  // dead transport: every request answers 500 (NOT 429/502/503, so no retry ladder delays the test).
  // With the network dead, the ONLY way liveSpvSource can produce a usable source is to trust the
  // cached snapshot WITHOUT re-verifying it. The real code must therefore REJECT (fail closed).
  globalThis.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) });
  // shape-valid, verify-invalid snapshot: passes superficial checks (v:1, checkpoint-covering
  // window) but its headers are forged, so fromSnapshot's re-verification must throw.
  const base = CP.height - 45;                     // mirrors the real seed window (LWMA context)
  const headers = [];
  for (let h = base; h <= CP.height + 10; h++) {
    headers.push({
      height: h,
      hash: "0x" + h.toString(16).padStart(64, "0"),
      header: { prev: "0x" + (h - 1).toString(16).padStart(64, "0"), merkle: "0x" + "22".repeat(32), time: 1700000000 + h, bits: 0x207fffff, nonce: 0 },
      chainwork: "1",
      trusted: true,
    });
  }
  const poisoned = { v: 1, baseHeight: base, headers };
  let got = 0;
  const cacheOpt = { get: async () => { got++; return poisoned; }, set: async () => {} };
  let rejected = false, resolvedSource = null;
  try { resolvedSource = await liveSpvSource({ rpcBase: "https://poison.invalid/api/rpc", headersBase: "https://poison.invalid", cache: cacheOpt }); }
  catch { rejected = true; }
  ok("the poisoned snapshot was actually offered to the restore path", got >= 1);
  ok("liveSpvSource REJECTS: the poisoned snapshot is never adopted as a verified chain (mutation: skip re-verify-on-load and this REDS)",
     rejected && resolvedSource === null);
} finally { globalThis.fetch = origFetch; }

console.log(`\nnamespv-partial-persist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
