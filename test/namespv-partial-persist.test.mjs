// Partial-progress persistence for the namespv header sync (BP8b), against the header store.
//
// Defect shape: the suffix was persisted only after a FULLY successful sync, so a rate-limited (429'd) cold
// bootstrap persisted nothing and every retry restarted from the baked anchor. syncWithPartialPersist calls
// `persist` after each fully synced SYNC_PERSIST_WINDOW, and prepare()'s catch persists the verified tail before
// classifying the failure, so the next attempt resumes and bills only the remaining span.
//
// Three layers (cf. spv-serializer.test.mjs / namespv-reseed-recover.test.mjs):
//   (1) BEHAVIORAL units on the exported syncWithPartialPersist, driven by a fake lc that follows the vendored
//       LightClient contract the helper relies on (sync appends verified headers one by one, a mid-sync throw
//       keeps the verified prefix in memory).
//   (2) SOURCE pins that prepare() wires the helper inside the serialized block, persists the tail in its catch
//       before classifying, and that no partial-persist path can advance the lapse floor.
//   (3) BEHAVIORAL storage-poisoning checks through the REAL liveSpvSource over real mainnet headers: a forged
//       stored suffix record or a forged stored anchored chunk is never adopted, the verified one replaces it,
//       and the unpoisoned store restores with no /api/headers request.
//
// Run: npx tsx test/namespv-partial-persist.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { deserializeHeader } from "../src/vendor/cairnx-spv.js";
import { syncWithPartialPersist, SYNC_PERSIST_WINDOW, liveSpvSource, detachStoreWrite, flushSpvStoreWrites } from "../src/core/namespv.ts";
import { checker } from "./helpers/check.mjs";
import { records, hashOf, serveFixture, memStore, legacyOf, FIX_TOP, FIX_ANCHORS } from "./helpers/spvfixture.mjs";

const t = checker("namespv-partial-persist");
const tipOf = (lc) => lc.baseHeight + lc.chain.length - 1;
const attempt = async (name, fn) => {
  try { t.check(name, await fn()); }
  catch (e) { t.check(`${name} (threw: ${e?.message ?? e})`, false); }
};

// Fake lc, faithful to the vendored contract: `net.budget` models the /api/headers request budget; when it runs
// out mid-sync the transport throws like an exhausted 429 ladder, with the verified prefix retained in memory.
function fakeLc(base, tipInclusive, net) {
  const lc = {
    baseHeight: base,
    chain: new Array(tipInclusive - base + 1).fill(0),
    async sync(to) {
      for (let h = tipOf(lc) + 1; h <= to; h++) {
        if (net.budget <= 0) throw new Error("/api/headers 429");
        net.budget--; net.billed++;
        lc.chain.push(h);
      }
    },
  };
  return lc;
}

console.log("syncWithPartialPersist - behavioral:");
const W = SYNC_PERSIST_WINDOW;
const BASE = 1000;
const WANT = BASE + W * 2 + Math.floor(W / 2);      // about 2.5 windows: a long cold span
const SPAN = WANT - BASE;

// The persisted tip survives "service worker death"; persist() takes no argument, so it reads the lc at call time.
const persisted = [];
await attempt("a 429 partway through a cold sync persists window progress and fails closed", async () => {
  const net = { budget: W + Math.floor(W / 4), billed: 0 };   // dies mid window 2
  const lc = fakeLc(BASE, BASE, net);
  let threw = false;
  try { await syncWithPartialPersist(lc, WANT, () => { persisted.push(tipOf(lc)); }); } catch { threw = true; }
  // window 1 (BASE + W) fully synced and persisted; window 2 died mid-flight, its verified prefix stays in
  // memory for the caller's catch-tail persist (pinned at the source below).
  return threw && persisted.length === 1 && persisted[0] === BASE + W && tipOf(lc) === BASE + net.billed;
});
t.check("persist is called exactly on a window boundary, never on a torn tip", persisted.every((p) => (p - BASE) % W === 0));

await attempt("the NEXT attempt resumes from the persisted tip: heights billed < the full span", async () => {
  const net2 = { budget: Number.MAX_SAFE_INTEGER, billed: 0 };
  const lc2 = fakeLc(BASE, persisted[0], net2);
  await syncWithPartialPersist(lc2, WANT, () => {});
  await lc2.sync(WANT);                                       // prepare()'s final leg
  return net2.billed === WANT - persisted[0] && net2.billed < SPAN && tipOf(lc2) === WANT;
});

await attempt("a sync shorter than one window never enters the loop: zero persists (warm hot path)", async () => {
  const net = { budget: Number.MAX_SAFE_INTEGER, billed: 0 };
  const lc = fakeLc(BASE, BASE, net);
  let calls = 0;
  await syncWithPartialPersist(lc, BASE + W - 1, () => { calls++; });
  return calls === 0 && net.billed === 0;                     // the final leg belongs to the caller
});

await attempt("a persist that goes through the detached writer on a FAILING store is fail-soft: the sync completes", async () => {
  const net = { budget: Number.MAX_SAFE_INTEGER, billed: 0 };
  const lc = fakeLc(BASE, BASE, net);
  const store = memStore({ failWrite: () => true });
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  try {
    await syncWithPartialPersist(lc, BASE + W * 2 + 5, () => detachStoreWrite(store, { put: [{ k: 8, records: new Uint8Array(84) }] }));
    await flushSpvStoreWrites();
  } finally { console.warn = realWarn; }
  return tipOf(lc) >= BASE + W * 2 && store.writes.length >= 1 && store.writes.every((w) => w.failed) && warns.some((w) => /header store write failed/.test(w));
});

// ── (2) source pins ──
console.log("\nliveSpvSource.prepare use-site (BP8b wiring, source-pinned):");
const src = readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8");
const pStart = src.indexOf("async prepare(maxEventHeight");
const pEnd = src.indexOf("async blockAt(", pStart);
const prep = src.slice(pStart, pEnd);
t.check("prepare() body located", pStart > 0 && pEnd > pStart);

const wired = /serializeSync\(\s*async[\s\S]{0,700}?await syncWithPartialPersist\(LC, want, persist\);[\s\S]{0,300}?await syncAligned\(LC, want\)/;
t.check("prepare() runs syncWithPartialPersist(LC, want, persist) INSIDE the serialized block, BEFORE the final syncAligned leg", wired.test(prep));
t.check("exactly one syncWithPartialPersist call site (an unwrapped second sync path would escape the serializer)",
  (src.match(/await syncWithPartialPersist\(/g) || []).length === 1);
// The catch persists the verified tail BEFORE classifying transient-vs-structural.
const catchIdx = prep.indexOf("} catch (e) {");
const tailPersistIdx = prep.indexOf("persist();", catchIdx);
const classifyIdx = prep.indexOf("const msg = String((e as Error)");
t.check("the catch calls persist() BEFORE the transient/structural classification",
  catchIdx > 0 && tailPersistIdx > catchIdx && classifyIdx > tailPersistIdx);
const serIdx = prep.indexOf("await serializeSync(");
const serEnd = prep.indexOf("const verifiedTip = tipOf(LC)");
t.check("floorAdvance sits strictly AFTER the serialized block (a rethrow skips it: a partial persist never advances the floor)",
  serIdx > 0 && serEnd > serIdx && prep.indexOf("floorAdvance(") > serEnd && !prep.slice(serIdx, serEnd).includes("floorAdvance("));
const helperStart = src.indexOf("export async function syncWithPartialPersist");
const helperDef = src.slice(helperStart, src.indexOf("\n}\n", helperStart) + 3);
t.check("syncWithPartialPersist itself never touches the floor (no floorAdvance / opts.floor reference)",
  helperDef.length > 60 && !/floorAdvance|opts\.floor/.test(helperDef));
const writeFn = src.slice(src.indexOf("const suffixWrite = "), src.indexOf("const persist = "));
t.check("suffixWrite writes nothing when no header was ingested past the persisted tip", /if \(!store \|\| tip <= persistedTip\) return null;/.test(writeFn));

// MUTATION fixtures: the wiring guard must RED when the call is stripped back to persist-only-on-full-success.
const wiredFixture = "await serializeSync(async () => {\n  try {\n    await syncWithPartialPersist(LC, want, persist);\n    await syncAligned(LC, want);\n  } catch (e) {}\n});";
const strippedFixture = "await serializeSync(async () => {\n  try {\n    await syncAligned(LC, want);\n  } catch (e) {}\n});";
t.check("wiring guard PASSES on the wired shape", wired.test(wiredFixture));
t.check("MUTATION[persist-only-on-full-success]: wiring guard REDS on the stripped shape", !wired.test(strippedFixture));

// ── (3) behavioral, through the real liveSpvSource ──
console.log("\nrestore re-verification and persistence (behavioral, real headers):");
const opts = (store) => ({
  rpcBase: "https://spv.invalid/api/rpc", headersBase: "https://spv.invalid", anchors: FIX_ANCHORS,
  store: async () => store, legacy: legacyOf(new Map()),
  floor: { get: async () => null, set: async () => {} },
});
const cloneStore = (from) => {
  const s = memStore();
  for (const [k, v] of from.chunks) s.chunks.set(k, v.slice());
  s.head = from.head ? { ...from.head } : null;
  return s;
};
const withNet = async (net, fn) => { const restore = serveFixture(net); try { return await fn(); } finally { restore(); } };
const quietWarn = async (fn) => {
  const realWarn = console.warn;
  const warns = [];
  console.warn = (...a) => { warns.push(a.map(String).join(" ")); };
  try { return { value: await fn(), warns }; } finally { console.warn = realWarn; }
};
const same = (a, b) => !!a && !!b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const flipAt = (chunk, recIndex, byteInRecord) => { const c = chunk.slice(); c[recIndex * 84 + byteInRecord] ^= 0x01; return c; };
const PREV = 4, MERKLE = 36;     // byte offsets inside an 84-byte record
const merkleHex = (h) => "0x" + Buffer.from(records(h, h).subarray(MERKLE, MERKLE + 32)).toString("hex");

// A good store: the anchor chunk, the suffix to FIX_TOP and chunk 26, written by a real first session.
const good = memStore();
await withNet({ tip: FIX_TOP }, async () => {
  const s = await liveSpvSource(opts(good));
  await s.prepare(FIX_TOP);
  await s.hashAt(108000);
  await flushSpvStoreWrites();
});
t.check("setup: the first session stored chunks 26, 27 and the suffix chunk 28 to the fixture top",
  [26, 27, 28].every((k) => good.chunks.has(k)) && good.head?.tip === FIX_TOP && same(good.chunks.get(28), records(114688, FIX_TOP)) && same(good.chunks.get(26), records(106496, 110591)));

// (3a) a stored suffix record is forged: restore must not adopt it, the sync refetches it.
const FORGED_H = 115000;
{
  const poisoned = cloneStore(good);
  const bad = flipAt(poisoned.chunks.get(28), FORGED_H - 114688, MERKLE);
  const r1 = deserializeHeader(bad.subarray((FORGED_H - 114688) * 84, (FORGED_H - 114687) * 84)).merkle;
  poisoned.chunks.set(28, bad);
  t.check("setup: the stored record at 115,000 really differs from the chain's", r1 !== deserializeHeader(records(FORGED_H, FORGED_H)).merkle);
  const net = { tip: FIX_TOP };
  await attempt("a forged stored suffix record is never adopted: hashAt/merkleAt serve the chain's header and the sync refetched it", () => withNet(net, async () => {
    const { value: ok } = await quietWarn(async () => {
      const s = await liveSpvSource(opts(poisoned));
      await s.prepare(FIX_TOP);
      const refetched = net.log.some((e) => { const [from, n] = e.split("/").map(Number); return from <= FORGED_H && FORGED_H < from + n; });
      return refetched && (await s.hashAt(FORGED_H)) === hashOf(FORGED_H) && (await s.hashAt(FIX_TOP)) === hashOf(FIX_TOP)
        && (await s.merkleAt(FORGED_H)) === merkleHex(FORGED_H);
    });
    return ok;
  }));
  await flushSpvStoreWrites();
  t.check("the stored suffix was replaced by the verified chain once the sync finished", same(poisoned.chunks.get(28), records(114688, FIX_TOP)) && poisoned.head?.tip === FIX_TOP);
}
// Paired honest path, production call shape: the unpoisoned store restores with no /api/headers request.
{
  const honest = cloneStore(good);
  const net = { tip: FIX_TOP };
  await attempt("honest: the unpoisoned store restores to the stored tip with zero /api/headers requests", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(honest));
    const r = await s.prepare(FIX_TOP);
    return net.log.length === 0 && r.verifiedTip === FIX_TOP && (await s.hashAt(FORGED_H)) === hashOf(FORGED_H);
  }));
  await flushSpvStoreWrites();
  t.check("honest: nothing is written back when nothing advanced", honest.writes.length === 0);
}

// (3b) a stored anchored chunk (26) has one byte flipped: it is never adopted, the verified one replaces it.
for (const [label, flip, read, real] of [
  ["a prev byte of the record after it", [108001 - 106496, PREV], (s) => s.hashAt(108000), hashOf(108000)],
  ["a merkle byte of the record itself", [108000 - 106496, MERKLE], (s) => s.merkleAt(108000), merkleHex(108000)],
]) {
  const poisoned = cloneStore(good);
  poisoned.chunks.set(26, flipAt(poisoned.chunks.get(26), flip[0], flip[1]));
  const net = { tip: FIX_TOP };
  await attempt(`a stored chunk 26 with ${label} flipped is never adopted: the served header is the chain's`, () => withNet(net, async () => {
    const { value: ok } = await quietWarn(async () => {
      const s = await liveSpvSource(opts(poisoned));
      await s.prepare(FIX_TOP);
      const got = await read(s);
      const pages = net.log.map((e) => Number(e.split("/")[0]));
      return got === real && pages.length === 8 && pages.every((p) => p >= 106496 && p <= 110591);   // exactly chunk 26's 8 aligned pages
    });
    return ok;
  }));
  await flushSpvStoreWrites();
  t.check(`stored chunk 26 (${label}) is replaced by the verified one`, same(poisoned.chunks.get(26), records(106496, 110591)));
}
{
  const honest = cloneStore(good);
  const net = { tip: FIX_TOP };
  await attempt("honest: the unpoisoned stored chunk 26 serves hashAt with no /api/headers request and no write", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(honest));
    await s.prepare(FIX_TOP);
    const h = await s.hashAt(108000);
    await flushSpvStoreWrites();
    return h === hashOf(108000) && net.log.length === 0 && honest.writes.length === 0;
  }));
}

// A failed sync keeps the verified progress: the tail is persisted before the failure is classified.
{
  const partial = cloneStore(good);
  const keep = 114999 - 114688 + 1;                                  // stored suffix ends at 114,999
  partial.chunks.set(28, partial.chunks.get(28).slice(0, keep * 84));
  partial.head = { v: 2, tip: 114999, tipHash: hashOf(114999) };
  // The served page carries a forged header at 115,100: heights 115,000 to 115,099 verify, then the sync throws.
  const net = { tip: FIX_TOP, tamper: (from, rows) => rows.map((r) => (r.height === 115100 ? { ...r, header: { ...r.header, merkle: "0x" + (r.header.merkle[2] === "0" ? "1" : "0") + r.header.merkle.slice(3) } } : r)) };
  await attempt("a sync that fails mid-way persists its verified tail (115,000 to 115,099) before failing closed", () => withNet(net, async () => {
    const { value: ok } = await quietWarn(async () => {
      const s = await liveSpvSource(opts(partial));
      let threw = false;
      try { await s.prepare(FIX_TOP); } catch { threw = true; }
      await flushSpvStoreWrites();
      return threw && same(partial.chunks.get(28), records(114688, 115099)) && partial.head?.tip === 115099;
    });
    return ok;
  }));
}
// And a failure with nothing ingested writes nothing.
{
  const idle = cloneStore(good);
  const net = { tip: FIX_TOP };
  await attempt("a transient failure before any header was ingested writes nothing and still fails closed", () => withNet(net, async () => {
    const s = await liveSpvSource(opts(idle));
    net.down = true;                                                 // the node tip is unknown, so want = maxEventHeight + 12
    const { value: threw } = await quietWarn(async () => { try { await s.prepare(FIX_TOP); return false; } catch { return true; } });
    await flushSpvStoreWrites();
    return threw && idle.writes.length === 0;
  }));
}

t.done("namespv-partial-persist");
