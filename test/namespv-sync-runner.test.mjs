// The background sync's runner through the production liveSpvSource on real headers to 146,829 (test/helpers/
// spvfixture.mjs, the table cut at 131,071): six pages in flight, ingested by height whatever order they arrive in;
// reads and lookups run between pages; a restart mid-sync resumes from the persisted tail; a transient failure stops
// the run and the next lookup resumes; no background run within 60 s, offline or with Save-Data; and through the
// Wallet: the popup's prewarm starts it, the install hook's does not, and a dropped source (an endpoint or a vault
// change) requests and writes nothing more.
// Run: npx tsx test/namespv-sync-runner.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, records, hashOf, SEAL_ANCHORS, SEAL_TOP } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites, IN_FLIGHT, BACKGROUND_GAP_MS } from "../src/core/namespv.ts";
import { checkSeals } from "../src/core/spvseal.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";

const { check, done } = checker("the background sync: six in flight, order, resume, stops");
const API = "https://cairn-substrate.test", API_B = "https://headers-b.cairn-substrate.test";
const CH = 4096, PAGE = 512;
const topOf = (k) => k * CH + CH - 1;
const net = { tip: SEAL_TOP };
serveFixture(net);
const served = globalThis.fetch;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, n = 400) => { for (let i = 0; i < n && !f(); i++) await tick(); return f(); };

// The header requests as made: each with its host, its range and when it was in flight. `hold(from)` true keeps a page
// unanswered until `release()`; `delay(i)` delays the i-th request's answer.
const hdr = { reqs: [], inflight: 0, max: 0, hold: () => false, held: [], delay: () => 0 };
const release = () => { for (const r of hdr.held.splice(0)) r(); };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = /^(https:\/\/[^/]+)\/api\/headers\/(\d+)\/(\d+)$/.exec(u);
  if (!m) return served(url, init);
  const req = { host: m[1], from: Number(m[2]), n: Number(m[3]) };
  const i = hdr.reqs.push(req) - 1;
  hdr.inflight++; hdr.max = Math.max(hdr.max, hdr.inflight);
  try {
    if (hdr.hold(req.from)) await new Promise((r) => hdr.held.push(r));
    const d = hdr.delay(i);
    if (d) await tick(d);
    return await served(url.replace(m[1], API), init);
  } finally { hdr.inflight--; }
};
const resetLog = () => { hdr.reqs.length = 0; hdr.max = 0; hdr.hold = () => false; hdr.delay = () => 0; net.log.length = 0; };

function storeTo(tip) {
  const st = memStore();
  for (let k = 31; k <= Math.floor(tip / CH); k++) st.chunks.set(k, records(k * CH, Math.min(topOf(k), tip)));
  st.head = { v: 2, tip, tipHash: hashOf(tip) };
  return st;
}
const opts = (st, extra = {}) => ({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => st, ...extra });
// The requests a sequential sync makes from `tip` to `want`: one per page, a cut first page asked whole (it ends on a
// page top, so it shares the page's edge-cached URL), the last cut at `want`.
const plan = (tip, want) => {
  const out = [];
  for (let c = tip; c < want;) {
    const e = Math.min(want, c + 1 - ((c + 1) % PAGE) + PAGE - 1);
    out.push((c + 1) % PAGE && e % PAGE === PAGE - 1 ? `${c + 1 - ((c + 1) % PAGE)}/${PAGE}` : `${c + 1}/${e - c}`);
    c = e;
  }
  return out;
};
const sample = async (src, from, to) => { let bad = 0; for (let h = from; h <= to; h += 97) if ((await src.hashAt(h)) !== hashOf(h)) bad++; return bad; };
const now0 = Date.now();
let clock = now0;
Date.now = () => clock;

console.log("1. six pages in flight, answered out of order, ingested by height:");
{
  resetLog();
  const src = await liveSpvSource(opts(storeTo(136000)));
  resetLog();
  // Within each window the later pages answer first.
  hdr.delay = (i) => (IN_FLIGHT - (i % IN_FLIGHT)) * 8;
  src.background();
  await until(() => hdr.reqs.length > 0 && src.syncProgress() === null);
  const p = await src.prepare(SEAL_TOP - 12);
  const asked = hdr.reqs.map((r) => `${r.from}/${r.n}`);
  check(`the run requests the sequential plan's pages, each once (${asked.length} of ${plan(136000, SEAL_TOP).length})`, asked.join() === plan(136000, SEAL_TOP).join());
  check(`  six in flight at most and at once (${hdr.max})`, hdr.max === IN_FLIGHT);
  check(`  verified to ${p.verifiedTip}, every sampled height the chain's own (${await sample(src, 136001, SEAL_TOP)} differ)`, p.verifiedTip === SEAL_TOP && (await sample(src, 136001, SEAL_TOP)) === 0);
  await flushSpvStoreWrites();
}

console.log("2. reads and lookups run between the run's pages:");
{
  const st = storeTo(136000);
  const src = await liveSpvSource(opts(st));
  resetLog();
  // The run's pages from the second window on wait; an anchored chunk read (chunk 26) is not one of them.
  hdr.hold = (from) => from > 136000 && hdr.reqs.filter((r) => r.from > 136000).length > IN_FLIGHT;
  src.background();
  await until(() => hdr.held.length > 0);
  const read = await Promise.race([src.hashAt(108000), tick(3000).then(() => "waited")]);
  const lookup = await Promise.race([src.prepare(137000 - 12).then((r) => r.verifiedTip), tick(3000).then(() => "waited")]);
  const tipThen = (await src.prepare(0)).verifiedTip;
  check(`a read in chunk 26 answers while the run waits on a page (${read === hashOf(108000)})`, read === hashOf(108000));
  check(`a lookup whose height the run passed answers while the run still waits (${lookup}, run at ${tipThen} of ${SEAL_TOP})`, lookup >= 137000 - 12 && tipThen < SEAL_TOP);
  release(); hdr.hold = () => false;
  check("  the run then reaches the node tip", await until(() => hdr.inflight === 0 && hdr.held.length === 0) && (await src.prepare(SEAL_TOP - 12)).verifiedTip === SEAL_TOP);
  await flushSpvStoreWrites();
}

console.log("3. a restart mid-sync resumes from the persisted tail:");
{
  const st = storeTo(131071);
  const ctl = new AbortController();
  const src = await liveSpvSource(opts(st, { signal: ctl.signal }));
  resetLog();
  // Two windows are answered, then the worker dies: nothing more is answered and its source is gone.
  hdr.hold = (from) => from > 131071 && hdr.reqs.filter((r) => r.from > 131071).length > 2 * IN_FLIGHT;
  src.background();
  await until(() => hdr.held.length > 0);
  await tick(50);
  ctl.abort();
  await flushSpvStoreWrites();
  const firstRun = hdr.reqs.length;
  const kept = st.head?.tip ?? 0;
  release();
  resetLog();
  const src2 = await liveSpvSource(opts(st));
  resetLog();
  const p = await src2.prepare(SEAL_TOP - 12);
  const again = hdr.reqs.filter((r) => r.from <= kept);
  check(`after ${firstRun} requests the store holds the first two windows (${kept}, ${kept - 131071} headers)`, kept === 131071 + 2 * IN_FLIGHT * PAGE);
  check(`  the next source resumes at ${hdr.reqs[0]?.from} and asks no height it had (${again.length} repeated), verified to ${p.verifiedTip}`, hdr.reqs[0]?.from === kept + 1 && again.length === 0 && p.verifiedTip === SEAL_TOP);
  await flushSpvStoreWrites();
}

console.log("4. a transient failure stops the run; the next lookup resumes:");
{
  const src = await liveSpvSource(opts(storeTo(136000)));
  resetLog();
  let failing = true;
  const fail = 136000 + 3 * PAGE;
  net.unserved = (from) => failing && from > fail;
  const low = src.prepare(136100 - 12);
  const high = src.prepare(SEAL_TOP - 12).then((r) => r.verifiedTip, (e) => `refused: ${String(e?.message ?? e).slice(0, 40)}`);
  const lowTip = (await low).verifiedTip;
  const highOut = await high;
  const reached = (await src.prepare(0)).verifiedTip;
  check(`a lookup below the failure answers (${lowTip}); one above it is refused as today (${highOut})`, lowTip >= 136100 - 12 && String(highOut).startsWith("refused"));
  failing = false; net.unserved = undefined;
  resetLog();
  const p = await src.prepare(SEAL_TOP - 12);
  check(`  the next lookup resumes at ${hdr.reqs[0]?.from}, above the ${reached} reached, verified to ${p.verifiedTip}`, hdr.reqs[0]?.from === reached + 1 && p.verifiedTip === SEAL_TOP);
  await flushSpvStoreWrites();
}

console.log("5. no background run within 60 s of the last, offline or with Save-Data:");
{
  const src = await liveSpvSource(opts(storeTo(136000)));
  resetLog();
  net.tip = 137000;
  src.background();
  await until(() => hdr.reqs.length > 0 && src.syncProgress() === null);
  const first = hdr.reqs.length;
  net.tip = SEAL_TOP;
  clock += BACKGROUND_GAP_MS - 1000;
  src.background();
  await tick(60);
  const inGap = hdr.reqs.length - first;
  clock += 2000;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  for (const n of [{ onLine: false }, { onLine: true, connection: { saveData: true } }]) {
    Object.defineProperty(globalThis, "navigator", { value: n, configurable: true });
    src.background();
  }
  await tick(60);
  const blocked = hdr.reqs.length - first;
  Object.defineProperty(globalThis, "navigator", nav ?? { value: undefined, configurable: true });
  src.background();
  await until(() => hdr.reqs.length > first && src.syncProgress() === null);
  const after = (await src.prepare(0)).verifiedTip;
  check(`the first run syncs (${first} requests); within 60 s, offline and with Save-Data nothing more (${inGap}, ${blocked})`, first > 0 && inGap === 0 && blocked === 0);
  check(`  past the gap, online, the next run syncs to the node tip (${after})`, after === SEAL_TOP);
  await flushSpvStoreWrites();
}

// The Wallet's own singleton and setters; only the builder is the test's, per source a store wrapper counting writes.
function walletOn(st) {
  const w = new Wallet(memoryStore(), memoryStore());
  const built = [];
  w.spvBuildForTest = (o) => {
    const id = built.length + 1;
    const writes = [];
    const own = { ...st, write: (x) => { writes.push(x); return st.write(x); } };
    const src = liveSpvSource({ ...o, anchors: SEAL_ANCHORS, store: async () => own, legacy: undefined });
    built.push({ id, writes, host: o.headersBase, src, opts: o });
    return src;
  };
  return { w, built };
}

console.log("6. the popup's prewarm starts the background run; the install hook's builds only:");
{
  clock += 2 * BACKGROUND_GAP_MS;
  net.tip = SEAL_TOP;
  const { w, built } = walletOn(storeTo(136000));
  await w.create("correct horse battery");
  await w.setApi(API);
  resetLog();
  w.prewarmSpv();
  await until(() => built.length === 1);
  await built[0].src;
  await tick(60);
  const byInstall = hdr.reqs.length;
  await w.lock();
  w.syncSpv();
  await tick(60);
  const locked = hdr.reqs.length;
  await w.unlock("correct horse battery");
  w.syncSpv();
  const s = await built[0].src;
  await until(() => hdr.reqs.length > 0 && s.syncProgress() === null);
  check(`the install hook's prewarm makes no header request (${byInstall}), nor the popup's while locked (${locked})`, byInstall === 0 && locked === 0);
  check(`  unlocked, the popup's prewarm syncs to the node tip (${(await s.prepare(0)).verifiedTip}) in ${hdr.reqs.length} requests`, (await s.prepare(0)).verifiedTip === SEAL_TOP && hdr.reqs.length === plan(136000, SEAL_TOP).length);
  await flushSpvStoreWrites();
}

console.log("7. an endpoint change mid-run: the dropped source requests and writes nothing more; one host per run:");
{
  clock += 2 * BACKGROUND_GAP_MS;
  const st = storeTo(136000);
  const { w, built } = walletOn(st);
  await w.create("correct horse battery");
  await w.setApi(API);
  resetLog();
  hdr.hold = (from) => from > 136000 && hdr.reqs.filter((r) => r.host === API && r.from > 136000).length > IN_FLIGHT;
  w.syncSpv();
  await until(() => hdr.held.length > 0);
  const a = built[0];
  const aBefore = a.writes.length;
  await w.setApi(API_B);
  const mark = hdr.reqs.length;
  release(); hdr.hold = () => false;
  w.syncSpv();
  await until(() => built.length === 2);
  const b = built[1];
  const pB = await (await b.src).prepare(SEAL_TOP - 12);
  await until(() => hdr.inflight === 0);
  await flushSpvStoreWrites();
  const aAfter = hdr.reqs.slice(mark).filter((r) => r.host === API);
  const kB = await w.sealKey();
  check(`after the change the dropped source asks no page of ${API} (${aAfter.length}) and makes no write (${a.writes.length - aBefore})`, aAfter.length === 0 && a.writes.length === aBefore);
  check(`  the new source reads every header page from ${API_B} (${hdr.reqs.slice(mark).filter((r) => r.host === API_B).length} of ${hdr.reqs.length - mark}), verified to ${pB.verifiedTip}`,
    hdr.reqs.length > mark && hdr.reqs.slice(mark).every((r) => r.host === API_B) && pB.verifiedTip === SEAL_TOP);
  check(`  the stored list and head are the new source's (head ${st.head?.tip}, list ${checkSeals(kB, st.seals, { newest: 131071, newestHash: hashOf(131071) })?.map((e) => e.k).join(",")})`,
    st.head?.tip === SEAL_TOP && b.writes.some((x) => x.seals) && b.writes.at(-1)?.head?.tip === SEAL_TOP);
}

console.log("8. a vault change: a source mid-run and a source parked on the unlock stop:");
{
  clock += 2 * BACKGROUND_GAP_MS;
  const st = storeTo(136000);
  const { w, built } = walletOn(st);
  await w.create("correct horse battery");
  await w.setApi(API);
  resetLog();
  hdr.hold = (from) => from > 136000 && hdr.reqs.filter((r) => r.from > 136000).length > IN_FLIGHT;
  w.syncSpv();
  await until(() => hdr.held.length > 0);
  const a = built[0], aBefore = a.writes.length;
  const pending = (await a.src).prepare(SEAL_TOP - 12).then((r) => r.verifiedTip, (e) => `threw ${e?.message}`);
  await w.reset();
  const mark = hdr.reqs.length;
  release(); hdr.hold = () => false;
  const settled = await Promise.race([pending, tick(3000).then(() => "hung")]);
  await tick(60); await flushSpvStoreWrites();
  check(`after the reset the old source asks no page (${hdr.reqs.length - mark}), writes nothing (${a.writes.length - aBefore}) and its lookup settles (${settled})`,
    hdr.reqs.length === mark && a.writes.length === aBefore && typeof settled === "number");

  // Parked: a sealed store waits for the unlock; the reset drops it, and the next vault's unlock wakes nothing.
  const st2 = storeTo(SEAL_TOP);
  const { w: w2, built: built2 } = walletOn(st2);
  await w2.create("correct horse battery");
  const first = await w2.spvSource().catch(() => null);
  await first?.prepare(0);
  await flushSpvStoreWrites();
  const listed = !!st2.seals;
  await w2.lock();
  resetLog();
  await w2.setApi(API);
  w2.prewarmSpv();
  await until(() => built2.length === 2);
  const parked = built2[1];
  const out = parked.src.then(() => "built", (e) => `ended: ${e?.message}`);
  await tick(30);
  await w2.reset();
  const ended = await Promise.race([out, tick(3000).then(() => "hung")]);
  await w2.create("another battery staple");
  await w2.balance().catch(() => null);
  await tick(60); await flushSpvStoreWrites();
  check(`a source parked on the unlock (list stored: ${listed}) ends at the reset (${ended}) with no request (${hdr.reqs.length}) and no write (${parked.writes.length})`,
    listed && ended.startsWith("ended") && hdr.reqs.length === 0 && parked.writes.length === 0);
}

done("namespv-sync-runner");
