// src/core/headerstore.ts against real IndexedDB in Chrome: one-transaction writes (a request issued after an await
// lands in an auto-committed transaction, which an in-memory IndexedDB stand-in does not model), the bounded key
// listing, truncation, malformed values, VersionError recreate, a blocked recreate, and acquisition over the real store.
// Needs playwright-core (PLAYWRIGHT_CORE, see scripts/playwright-core.mjs) and a Chromium (PLAYWRIGHT_CHROMIUM, or
// playwright's own). Without playwright-core or a Chromium binary it prints SKIP; it runs where both are installed.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { checker } from "./helpers/check.mjs";
import { findChromium } from "../scripts/playwright-core.mjs";

const chromium = await findChromium();
if (!chromium) {
  console.log("SKIP: playwright-core not found (set PLAYWRIGHT_CORE); runs when it is installed");
  process.exit(0);
}
const t = checker("headerstore in Chrome (real IndexedDB)");
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL("../src/core/headerstore.ts", import.meta.url))],
  bundle: true, format: "iife", globalName: "HS", platform: "browser", target: "es2022", write: false, logLevel: "warning",
})).outputFiles[0].text;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ["--no-sandbox"] });
} catch (e) {
  if (!/executable doesn't exist|ENOENT/i.test(String(e?.message))) throw e;
  console.log(`SKIP: no Chromium binary for playwright-core (set PLAYWRIGHT_CHROMIUM): ${String(e.message).split("\n")[0]}`);
  process.exit(0);
}

// Each scenario runs in a fresh context (its own storage) on a routed http origin, where IndexedDB is available.
async function scenario(name, fn, arg) {
  const ctx = await browser.newContext();
  try {
    await ctx.route("http://hs.test/**", (r) => r.request().url().endsWith("/hs.js")
      ? r.fulfill({ contentType: "text/javascript", body: bundle })
      : r.fulfill({ contentType: "text/html", body: '<!doctype html><script src="/hs.js"></script>' }));
    const page = await ctx.newPage();
    await page.goto("http://hs.test/");
    // A hung IndexedDB call (an open or delete that never settles) is a failure, not a stalled run.
    return await Promise.race([page.evaluate(fn, arg), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 10 s")), 10_000))]);
  } catch (e) {
    console.log(`    ${name}: ${e.message.split("\n")[0]}`);
    return null;
  } finally {
    await ctx.close();
  }
}
const H = "0x" + "ab".repeat(32);

const multi = await scenario("multi-chunk write", async (H) => {
  const u8 = (k, n) => new Uint8Array(n).fill(k);
  const s = await HS.openHeaderStore();
  await s.write({ put: [{ k: 7, records: u8(7, 2808 * 84) }, { k: 8, records: u8(8, 4096 * 84) }], head: { v: 2, tip: 36863, tipHash: H } });
  s.close();
  const r = await HS.openHeaderStore();
  const c7 = await r.getChunk(7), c8 = await r.getChunk(8);
  return { keys: await r.listChunks(), l7: c7.length, l8: c8.length, b7: c7[100], b8: c8[100], head: await r.getHead() };
}, H);
t.check("two chunks and the head in one write read back on a new connection", multi?.keys.join() === "7,8" && multi.l7 === 2808 * 84 && multi.l8 === 4096 * 84 && multi.b7 === 7 && multi.b8 === 8 && multi.head?.tip === 36863);

const listed = await scenario("bounded listing", async () => {
  (await HS.openHeaderStore()).close();
  const db = await new Promise((res) => { const q = indexedDB.open(HS.DB_NAME); q.onsuccess = () => res(q.result); });
  const tx = db.transaction("chunks", "readwrite");
  for (const k of [3, 6, 9, HS.MAX_CHUNK + 1, 1e9, "x"]) tx.objectStore("chunks").put(new ArrayBuffer(84), k);
  await new Promise((res) => { tx.oncomplete = res; });
  db.close();
  return (await HS.openHeaderStore()).listChunks();
});
t.check(`keys outside 7..7+4096 are not listed (${listed})`, listed?.join() === "9");

const trunc = await scenario("truncation", async (H) => {
  const s = await HS.openHeaderStore();
  await s.write({ put: [7, 8, 9, 10].map((k) => ({ k, records: new Uint8Array(84).fill(k) })) });
  await s.write({ put: [{ k: 8, records: new Uint8Array(168).fill(80) }], deleteAbove: 8, head: { v: 2, tip: 32769, tipHash: H } });
  const c8 = await s.getChunk(8);
  return { keys: await s.listChunks(), len: c8.length, b: c8[0], tip: (await s.getHead()).tip };
}, H);
t.check("a truncation rewrites the top chunk and deletes those above in one write", trunc?.keys.join() === "7,8" && trunc.len === 168 && trunc.b === 80 && trunc.tip === 32769);

const onetx = await scenario("one transaction per write", async (H) => {
  const s = await HS.openHeaderStore();
  await s.write({ put: [7, 8, 9].map((k) => ({ k, records: new Uint8Array(84).fill(k) })) });
  const real = IDBDatabase.prototype.transaction;
  let n = 0;
  IDBDatabase.prototype.transaction = function (...a) { n++; return real.apply(this, a); };
  try {
    await s.write({ put: [{ k: 8, records: new Uint8Array(84).fill(88) }], deleteAbove: 8, head: { v: 2, tip: 32768, tipHash: H } });
  } finally {
    IDBDatabase.prototype.transaction = real;
  }
  return n;
}, H);
t.check(`a truncation (put, deleteAbove and head) is one transaction, so it commits whole or not at all (${onetx})`, onetx === 1);

const bad = await scenario("malformed values", async () => {
  const s = await HS.openHeaderStore();
  s.close();
  const db = await new Promise((res) => { const q = indexedDB.open(HS.DB_NAME); q.onsuccess = () => res(q.result); });
  const tx = db.transaction(["chunks", "meta"], "readwrite");
  tx.objectStore("chunks").put("not bytes", 7);
  tx.objectStore("meta").put({ v: 1, tip: 40000, tipHash: "0x00" }, "head");
  await new Promise((res) => { tx.oncomplete = res; });
  db.close();
  const r = await HS.openHeaderStore();
  let threw = false;
  try { await r.write({ put: [{ k: 6, records: new Uint8Array(84) }] }); } catch { threw = true; }
  return { chunk: await r.getChunk(7), head: await r.getHead(), threw, keys: await r.listChunks() };
});
t.check("a non-ArrayBuffer chunk and a malformed head read as absent", bad !== null && bad.chunk === null && bad.head === null);
t.check("a write for a key below chunk 7 rejects before any transaction", bad?.threw === true && bad.keys.join() === "7");

const ver = await scenario("VersionError", async () => {
  await new Promise((res) => { const q = indexedDB.open(HS.DB_NAME, 5); q.onupgradeneeded = () => q.result.createObjectStore("future"); q.onsuccess = () => { q.result.close(); res(); }; });
  const s = await HS.openHeaderStore();
  if (!s) return { opened: false };
  await s.write({ put: [{ k: 9, records: new Uint8Array(84).fill(9) }] });
  const keys = await s.listChunks();
  s.close();
  const v = await new Promise((res) => { const q = indexedDB.open(HS.DB_NAME); q.onsuccess = () => { const d = q.result; res({ version: d.version, stores: [...d.objectStoreNames].join() }); d.close(); }; });
  return { opened: true, keys, ...v };
});
t.check(`a newer schema (VersionError) is deleted and recreated at version 1, and the next write succeeds (${JSON.stringify(ver)})`, ver?.opened === true && ver.keys.join() === "9" && ver.version === 1 && ver.stores === "chunks,meta");

const blocked = await scenario("blocked recreate", async () => {
  const held = await new Promise((res) => { const q = indexedDB.open(HS.DB_NAME, 5); q.onupgradeneeded = () => q.result.createObjectStore("future"); q.onsuccess = () => res(q.result); });
  const s = await HS.openHeaderStore();
  held.close();
  return s === null;
});
t.check("a recreate blocked by another open connection degrades to no cache (null), not a throw", blocked === true);

const acq = await scenario("acquisition over the real store", async () => {
  const s = await HS.openHeaderStore();
  await s.write({ put: [{ k: 9, records: new Uint8Array(84).fill(1) }] });
  let fetches = 0;
  const a = HS.chunkAcquirer({
    store: s, lru: new HS.ChunkLru(8), serialize: (op) => op(),
    verify: (rec, spec) => { if (rec[0] !== spec.k) throw new Error("walk failed"); },
    fetchChunk: async (spec) => { fetches++; return new Uint8Array(84).fill(spec.k); },
  });
  const got = await a.acquire(40000);
  await a.writes();
  s.close();
  const r = await HS.openHeaderStore();
  return { fetches, got: got.records[0], stored: (await r.getChunk(9))[0] };
});
t.check("a corrupt stored chunk is refetched once and the store holds the verified bytes after", acq?.fetches === 1 && acq.got === 9 && acq.stored === 9);

await browser.close();
t.done("headerstore-chrome");
