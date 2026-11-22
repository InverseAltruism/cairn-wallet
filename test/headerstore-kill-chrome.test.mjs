// A browser killed during a header store write (invariant 12): the store is found as before the write or as after
// it, never between, for the write shapes the sealed store makes (a suffix write with its seal list, a seal-only
// write, a reseed rewrite that truncates, puts and replaces the list). Real Chrome on a persistent profile, launched
// here so its PID is known: the page starts the write through src/core/headerstore.ts and holds its transaction open
// with chained requests; the browser gets SIGKILL before the write, inside the held transaction, after commit, or
// after the held transaction is let go (the control: the held write is the one that lands); a relaunch on the same
// profile reads the store back. Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium
// (PLAYWRIGHT_CHROMIUM or playwright's own); without them it prints SKIP.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { checker } from "./helpers/check.mjs";
import { findChromium } from "../scripts/playwright-core.mjs";

const chromium = await findChromium();
if (!chromium) { console.log("SKIP: playwright-core not found (set PLAYWRIGHT_CORE); runs when it is installed"); process.exit(0); }
const exe = process.env.PLAYWRIGHT_CHROMIUM || chromium.executablePath();
if (!exe || !existsSync(exe)) { console.log(`SKIP: no Chromium binary for playwright-core (set PLAYWRIGHT_CHROMIUM): ${exe}`); process.exit(0); }
const t = checker("header store writes killed in Chrome (invariant 12)");
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL("../src/core/headerstore.ts", import.meta.url))],
  bundle: true, format: "iife", globalName: "HS", platform: "browser", target: "es2022", write: false, logLevel: "warning",
})).outputFiles[0].text;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chrome on `profile`, its DevTools port picked by the OS (127.0.0.1), connected over CDP with the test origin routed.
async function launch(profile) {
  const proc = spawn(exe, ["--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(50);
  let browser = null, lastError = null;
  for (let i = 0; i < 100 && !browser; i++) {
    const port = Number(existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n")[0] : 0);
    try { if (port) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch (e) { lastError = e; }
    if (!browser) await sleep(50);
  }
  if (!browser) { proc.kill("SIGKILL"); throw lastError ?? new Error("Chrome did not open its DevTools port"); }
  const ctx = browser.contexts()[0];
  await ctx.route("http://hs.test/**", (r) => r.request().url().endsWith("/hs.js")
    ? r.fulfill({ contentType: "text/javascript", body: bundle })
    : r.fulfill({ contentType: "text/html", body: '<!doctype html><script src="/hs.js"></script>' }));
  const page = await ctx.newPage();
  await page.goto("http://hs.test/");
  return { proc, browser, page };
}
const kill = async ({ proc, browser }) => {
  const gone = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGKILL");
  await gone;
  await browser.close().catch(() => { /* the connection died with the process */ });
};
const quit = async ({ proc, browser }) => { const gone = new Promise((r) => proc.once("exit", r)); await browser.close(); proc.kill("SIGTERM"); await gone; };

// The store as a comparable value: chunk keys with their first byte and length, the head's tip, the seal list's ks.
const readBack = (page) => page.evaluate(async () => {
  const s = await HS.openHeaderStore();
  const keys = await s.listChunks();
  const chunks = [];
  for (const k of keys) { const c = await s.getChunk(k); chunks.push(`${k}:${c[0]}:${c.length}`); }
  const head = await s.getHead(), seals = await s.getSeals();
  s.close();
  return JSON.stringify({ chunks, tip: head?.tip ?? null, seals: seals?.list?.map((e) => `${e.k}:${e.top.slice(-4)}`).join(",") ?? null });
});

const H = (n) => "0x" + n.toString(16).padStart(64, "0");
// A list entry names its branch in its top: branch 1 is the chain BEFORE holds, branch 3 the reseed's.
const entry = ([k, branch]) => ({ k, top: H(k * 16 + branch), work: String(k), mac: "ab".repeat(32) });
const BEFORE = { put: [32, 33, 34, 35].map((k) => ({ k, fill: 1, n: 4096 })), head: 147455, seals: [[32, 1], [33, 1]] };
// The writes, each applied over BEFORE.
const WRITES = {
  "a suffix write with its seal list": { put: [{ k: 35, fill: 2, n: 4096 }, { k: 36, fill: 2, n: 512 }], deleteAbove: 36, head: 147967, seals: [[32, 1], [33, 1], [34, 1]] },
  "a seal-only write": { put: [], seals: [[32, 1], [33, 1], [34, 1]] },
  "a reseed rewrite (truncate, puts, a new list)": { put: [{ k: 33, fill: 3, n: 4096 }, { k: 34, fill: 3, n: 100 }], deleteAbove: 34, head: 139363, seals: [[32, 3]] },
};

async function applyBefore(page) {
  await page.evaluate(async ({ w, list }) => {
    const s = await HS.openHeaderStore();
    await s.write({ put: w.put.map((p) => ({ k: p.k, records: new Uint8Array(p.n * 84).fill(p.fill) })), head: { v: 2, tip: w.head, tipHash: "0x" + "cd".repeat(32) }, seals: { v: 1, newest: 131071, list } });
    s.close();
  }, { w: BEFORE, list: BEFORE.seals.map(entry) });
}
// Starts `w` through HS.write and keeps its transaction open with a chained read loop on the same transaction.
const holdWrite = (page, w) => page.evaluate(({ w, list }) => {
  const real = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...a) {
    const tx = real.apply(this, a);
    if (a[1] === "readwrite") {
      IDBDatabase.prototype.transaction = real;
      queueMicrotask(() => {
        const spin = () => { if (window.__release) return; const q = tx.objectStore("meta").get("hold"); q.onsuccess = spin; };
        spin();
        window.__held = true;
      });
    }
    return tx;
  };
  HS.openHeaderStore().then((s) => s.write({
    put: w.put.map((p) => ({ k: p.k, records: new Uint8Array(p.n * 84).fill(p.fill) })),
    ...(w.deleteAbove !== undefined ? { deleteAbove: w.deleteAbove } : {}),
    ...(w.head ? { head: { v: 2, tip: w.head, tipHash: "0x" + "cd".repeat(32) } } : {}),
    seals: { v: 1, newest: 131071, list },
  })).then(() => { window.__done = true; });
}, { w, list: w.seals.map(entry) });

const expect = (w) => {
  const chunks = new Map(BEFORE.put.map((p) => [p.k, `${p.k}:${p.fill}:${p.n * 84}`]));
  if (w) {
    if (w.deleteAbove !== undefined) for (const k of [...chunks.keys()]) if (k > w.deleteAbove) chunks.delete(k);
    for (const p of w.put) chunks.set(p.k, `${p.k}:${p.fill}:${p.n * 84}`);
  }
  return JSON.stringify({ chunks: [...chunks].sort((a, b) => a[0] - b[0]).map((e) => e[1]), tip: w?.head ?? BEFORE.head, seals: (w ?? BEFORE).seals.map(entry).map((e) => `${e.k}:${e.top.slice(-4)}`).join(",") });
};

for (const [name, w] of Object.entries(WRITES)) {
  for (const point of ["before the write", "inside the held transaction", "after commit", "after the held transaction is let go"]) {
    const profile = mkdtempSync(join(tmpdir(), "cairn-kill-"));
    let got = null;
    try {
      const b1 = await launch(profile);
      await applyBefore(b1.page);
      if (point === "inside the held transaction") {
        await holdWrite(b1.page, w);
        for (let i = 0; i < 200 && !(await b1.page.evaluate(() => window.__held === true)); i++) await sleep(25);
      } else if (point === "after the held transaction is let go") {
        await holdWrite(b1.page, w);
        for (let i = 0; i < 200 && !(await b1.page.evaluate(() => window.__held === true)); i++) await sleep(25);
        await b1.page.evaluate(() => { window.__release = true; });
        for (let i = 0; i < 200 && !(await b1.page.evaluate(() => window.__done === true)); i++) await sleep(25);
      } else if (point === "after commit") {
        await b1.page.evaluate(async ({ w, list }) => {
          const s = await HS.openHeaderStore();
          await s.write({ put: w.put.map((p) => ({ k: p.k, records: new Uint8Array(p.n * 84).fill(p.fill) })), ...(w.deleteAbove !== undefined ? { deleteAbove: w.deleteAbove } : {}), ...(w.head ? { head: { v: 2, tip: w.head, tipHash: "0x" + "cd".repeat(32) } } : {}), seals: { v: 1, newest: 131071, list } });
        }, { w, list: w.seals.map(entry) });
      }
      await kill(b1);
      const b2 = await launch(profile);
      got = await readBack(b2.page);
      await quit(b2);
    } catch (e) {
      console.log(`    ${name}, ${point}: ${String(e?.message ?? e).split("\n")[0]}`);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
    const after = point.startsWith("after");
    t.check(`${name}, killed ${point}: the store is as ${after ? "after" : "before"} the write (${got})`, got === (after ? expect(w) : expect(null)));
  }
}
t.done("headerstore-kill-chrome");
