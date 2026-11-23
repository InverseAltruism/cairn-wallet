// The foreground comes first (src/core/netgate.ts and the runner's pages in src/core/namespv.ts), through the
// production liveSpvSource on real headers to 146,829: a background page in flight when a balance starts is cancelled
// and asked again once the foreground has been quiet; no background page starts while a request a user waits on is in
// flight; a lookup's own pages never wait; a request that never settles stops counting; and the sync does not hold
// the worker: a page's ingest and the rebase's re-ingest yield (ingestSliced), through a yield that a nested timer's
// clamp does not slow. Every wallet request in src/core and the worker goes through the gate (source scan).
// Run: npx tsx test/netgate.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, records, hashOf, SEAL_ANCHORS, SEAL_TOP } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites, ingestSliced, yieldTask } from "../src/core/namespv.ts";
import { foreground, foregroundQuiet, foregroundBusy, QUIET_MS, HOLD_MAX_MS } from "../src/core/netgate.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";

const { check, done } = checker("the foreground comes first");
const API = "https://cairn-substrate.test";
const CH = 4096;
const net = { tip: SEAL_TOP };
serveFixture(net);
const served = globalThis.fetch;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, n = 600) => { for (let i = 0; i < n && !f(); i++) await tick(); return f(); };

// Header requests as fetch makes them: held while `hold` says so, and ended by their signal as fetch ends them.
const hdr = { reqs: [], inflight: 0, hold: () => false, held: new Set(), aborted: 0, tips: [] };
const release = () => { for (const r of [...hdr.held]) r(); };
const utxo = { gate: null };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/\/utxos(-all)?\//.test(u)) {
    if (utxo.gate) await utxo.gate;
    return new Response(JSON.stringify({ confirmed_balance: 0, utxos: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.endsWith("/tip")) hdr.tips.push(performance.now());
  if (!/\/api\/headers\//.test(u)) return served(url, init);
  const hm = /\/api\/headers\/(\d+)\/(\d+)/.exec(u);
  const req = { from: Number(hm[1]), n: Number(hm[2]), at: performance.now(), aborted: false };
  hdr.reqs.push(req);
  hdr.inflight++;
  try {
    if (hdr.hold(req)) {
      await new Promise((ok, fail) => {
        const go = () => { hdr.held.delete(go); ok(); };
        hdr.held.add(go);
        init?.signal?.addEventListener("abort", () => { hdr.held.delete(go); req.aborted = true; hdr.aborted++; fail(init.signal.reason); }, { once: true });
      });
    }
    return await served(url, init);
  } finally { hdr.inflight--; }
};
const quiet = async () => { for (let n = -1; n !== hdr.reqs.length || hdr.inflight > 0;) { n = hdr.reqs.length; await tick(400); } };
const reset = () => { hdr.reqs.length = 0; hdr.aborted = 0; hdr.hold = () => false; };
function storeTo(tip) {
  const st = memStore();
  for (let k = 31; k <= Math.floor(tip / CH); k++) st.chunks.set(k, records(k * CH, Math.min(k * CH + CH - 1, tip)));
  st.head = { v: 2, tip, tipHash: hashOf(tip) };
  return st;
}
const opts = (st, extra = {}) => ({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => st, ...extra });
const sample = async (src, from, to) => { let bad = 0; for (let h = from; h <= to; h += 97) if ((await src.hashAt(h)) !== hashOf(h)) bad++; return bad; };

console.log("1. a page's ingest lets a timer that came due during it run before the page ends:");
{
  const lc = { baseHeight: 1000, chain: [], ingest(h) { this.chain.push(h); } };
  let seenAt = null;
  const first = lc.ingest.bind(lc);
  lc.ingest = function (h) {
    if (h === 1000) { setTimeout(() => { seenAt = 1000 + this.chain.length - 1; }, 0); const t = performance.now(); while (performance.now() - t < 3); }
    first(h);
  };
  await ingestSliced(lc, 1000, 512, () => ({ header: {} }));
  check(`the timer ran with ${seenAt === null ? "none" : seenAt - 999} of the page's 512 headers ingested`, seenAt !== null && seenAt < 1000 + 511);
  check("  every header was ingested in height order", lc.chain.length === 512 && lc.chain.every((h, i) => h === 1000 + i));
}

console.log("2. without setImmediate (a browser worker) the yield is a MessageChannel task, not a clamped timer:");
{
  const saved = globalThis.setImmediate;
  delete globalThis.setImmediate;
  const t = performance.now();
  try { for (let i = 0; i < 300; i++) await yieldTask(); } finally { globalThis.setImmediate = saved; }
  const ms = performance.now() - t;
  // 300 setTimeout(0) yields take at least 300 ms in Node (1 ms each) and 1,200 ms nested in Chrome (4 ms each).
  check(`300 yields took ${ms.toFixed(0)} ms (under 150)`, ms < 150);
}

console.log("3. the gate: quiet only QUIET_MS after the last foreground request; a request that never settles stops counting:");
{
  let end;
  const op = foreground(() => new Promise((r) => { end = r; }));
  let quietAt = null;
  foregroundQuiet().then(() => { quietAt = performance.now(); });
  const ac = new AbortController();
  const w = foregroundQuiet(ac.signal).then(() => "quiet", () => "aborted");
  await tick(50);
  check(`not quiet while a request is in flight (busy ${foregroundBusy()})`, quietAt === null && foregroundBusy());
  ac.abort();
  check(`  a wait ends when its signal aborts (${await w})`, (await w) === "aborted");
  end(); await op;
  const tEnd = performance.now();
  await until(() => quietAt !== null);
  check(`  quiet ${(quietAt - tEnd).toFixed(0)} ms after it ended (QUIET_MS ${QUIET_MS})`, quietAt - tEnd >= QUIET_MS - 2);
  // The cap: the timer foreground() arms for HOLD_MAX_MS releases a request that never settles.
  const realSet = globalThis.setTimeout;
  let cap = null;
  globalThis.setTimeout = (f, ms, ...a) => { if (ms === HOLD_MAX_MS) cap = f; return realSet(f, ms, ...a); };
  void foreground(() => new Promise(() => {}));
  globalThis.setTimeout = realSet;
  const before = await Promise.race([foregroundQuiet().then(() => "quiet"), tick(QUIET_MS * 2).then(() => "busy")]);
  check(`  a request that never settles holds the gate (${before}) until its ${HOLD_MAX_MS} ms cap`, before === "busy" && typeof cap === "function");
  cap();
  const after = await Promise.race([foregroundQuiet().then(() => "quiet"), tick(QUIET_MS * 3).then(() => "busy")]);
  check(`  after the cap the gate is quiet again (${after})`, after === "quiet");
}

console.log("4. a balance during a background run: the page in flight is cancelled, none starts until the foreground is quiet, the run ends at the tip:");
{
  const src = await liveSpvSource(opts(storeTo(136000)));
  const w = new Wallet(memoryStore());
  await w.create("correct horse battery");
  reset();
  hdr.hold = () => true;
  src.background();
  await until(() => hdr.held.size > 0);
  let open; utxo.gate = new Promise((r) => { open = r; });
  const bal = w.balance();
  await until(() => hdr.aborted > 0, 200);
  const cancelled = hdr.aborted, mark = hdr.reqs.length;
  hdr.hold = () => false;
  await tick(100);
  const duringBalance = hdr.reqs.length - mark;
  const tOpen = performance.now();
  open(); utxo.gate = null;
  await bal;
  await until(() => hdr.reqs.length > mark, 400);
  const firstAfter = hdr.reqs[mark];
  check(`the ${cancelled} background page(s) in flight were cancelled when the balance started, ${duringBalance} asked while it was in flight`, cancelled > 0 && duringBalance === 0);
  check(`  the next page went out ${firstAfter ? (firstAfter.at - tOpen).toFixed(0) : "never"} ms after the balance answered (at least QUIET_MS)`, !!firstAfter && firstAfter.at - tOpen >= QUIET_MS - 5);
  await quiet();
  const tip = (await src.prepare(0)).verifiedTip;
  check(`  the run then reaches the node tip (${tip}) with the honest headers (${await sample(src, 136001, SEAL_TOP)} wrong)`, tip === SEAL_TOP && (await sample(src, 136001, SEAL_TOP)) === 0);
  await flushSpvStoreWrites();
}

console.log("4b. the background run's own tip read is not foreground: its first page does not wait QUIET_MS after it:");
{
  const src = await liveSpvSource(opts(storeTo(140000)));
  await tick(QUIET_MS * 2);
  reset(); hdr.tips.length = 0;
  src.background();
  await until(() => hdr.reqs.length > 0);
  const gap = hdr.reqs[0].at - hdr.tips[hdr.tips.length - 1];
  check(`the first page went out ${gap.toFixed(0)} ms after the run's tip read (under ${QUIET_MS / 2})`, hdr.tips.length > 0 && gap < QUIET_MS / 2);
  await quiet(); await flushSpvStoreWrites();
}

console.log("5. a lookup's own pages do not wait for the foreground:");
{
  const src = await liveSpvSource(opts(storeTo(136000)));
  reset();
  // A foreground request in flight for the whole lookup.
  let end; const op = foreground(() => new Promise((r) => { end = r; }));
  const t = performance.now();
  const r = await Promise.race([src.prepare(137000 - 12).then((x) => x.verifiedTip), tick(3000).then(() => "waited")]);
  end(); await op;
  check(`the lookup verified to ${r} in ${(performance.now() - t).toFixed(0)} ms while a foreground request was in flight`, r === 137000);
  await quiet(); await flushSpvStoreWrites();
}

console.log("5b. background pages waiting on the foreground go ahead as a lookup's pages once it waits:");
{
  const src = await liveSpvSource(opts(storeTo(136000)));
  await tick(QUIET_MS * 2);
  reset();
  // A foreground request held in flight: the background run's pages wait for it.
  let end; const op = foreground(() => new Promise((r) => { end = r; }));
  src.background();
  await tick(300);
  const waitedPages = hdr.reqs.length;
  const r = await Promise.race([src.prepare(137000 - 12).then((x) => x.verifiedTip), tick(3000).then(() => "waited")]);
  end(); await op;
  check(`no background page went out while the request was in flight (${waitedPages}); a lookup then verified to ${r} with it still in flight`, waitedPages === 0 && r === 137000);
  await quiet(); await flushSpvStoreWrites();
}

console.log("5c. a lookup that needs only the first page of a background window: the pages above its height wait for it:");
{
  const src = await liveSpvSource(opts(storeTo(140000)));
  await tick(QUIET_MS * 2);
  reset();
  hdr.hold = () => true;
  src.background();
  await until(() => hdr.held.size >= 2);
  const window = hdr.reqs.map((r) => r.from);
  hdr.hold = () => false;
  const mark = hdr.reqs.length;
  const tip = await src.prepare(140200 - 12).then((x) => x.verifiedTip);
  const asked = hdr.reqs.slice(mark).map((r) => r.from);
  check(`the window asked ${window.join(",")}; until the lookup verified to ${tip} it asked ${asked.join(",")}, none above 140,200`, window.some((f) => f > 140200) && tip >= 140200 && asked.length > 0 && asked.every((f) => f <= 140200));
  await quiet();
  check(`  the pages above it follow once the foreground is quiet: the run reaches ${(await src.prepare(0)).verifiedTip}`, (await src.prepare(0)).verifiedTip === SEAL_TOP);
  await flushSpvStoreWrites();
}

console.log("5d. the page that holds the lookup's height, planned for the background, is asked only up to it:");
{
  // From 140,000 the background window asks 139,776 (a page) and 140,288 to 140,799; a lookup for 140,500 needs the
  // second only to 140,500, which a sync to the lookup's height asks.
  const src = await liveSpvSource(opts(storeTo(140000)));
  await tick(QUIET_MS * 2);
  reset();
  hdr.hold = () => true;
  src.background();
  await until(() => hdr.held.size >= 2);
  hdr.hold = () => false;
  const mark = hdr.reqs.length;
  const tip = await src.prepare(140500 - 12).then((x) => x.verifiedTip);
  const asked = hdr.reqs.slice(mark).map((r) => `${r.from}/${r.n}`);
  check(`the lookup verified to ${tip}, asking ${asked.join(", ")}: the page holding 140,500 cut there`, tip === 140500 && asked.includes("140288/213") && !asked.some((a) => a.startsWith("140288/") && a !== "140288/213"));
  await quiet();
  check(`  the run then reaches ${(await src.prepare(0)).verifiedTip} with the honest headers (${await sample(src, 140001, SEAL_TOP)} wrong)`, (await src.prepare(0)).verifiedTip === SEAL_TOP && (await sample(src, 140001, SEAL_TOP)) === 0);
  await flushSpvStoreWrites();
}

console.log("6. every wallet request in src/core and the worker goes through the gate:");
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const files = ["src/background.ts", ...readdirSync(new URL("../src/core/", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => `src/core/${f}`)];
  const bare = [];
  for (const f of files) {
    const code = strip(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    for (const m of code.matchAll(/(?<![\w.])fetch\(/g)) bare.push(`${f}: ${code.slice(m.index, code.indexOf("\n", m.index)).slice(0, 70)}`);
  }
  // The gate's own call, the background run's page requests (they give way in runPage) and tip read, and the USD line,
  // which the popup reads in its own context.
  const allowed = [/^src\/core\/netgate\.ts: fetch\(input, init\)/, /^src\/core\/namespv\.ts: fetch\(`\$\{headersBase\}\/api\/headers\//, /^src\/core\/namespv\.ts: fetch\(\.\.\.a\) \}\);/, /^src\/core\/market\.ts: fetch\(`\$\{apiBase/];
  const stray = bare.filter((b) => !allowed.some((a) => a.test(b)));
  check(`no request bypasses the gate (${stray.length ? stray.join(" | ") : "none"}; ${bare.length} bare fetch calls, each allowed)`, stray.length === 0 && bare.length === allowed.length);
}

await done();
