// The header sync on an engine without AbortSignal.any (the manifest names no minimum Chrome version, and the function
// is not on every engine it admits; this file removes it from Node's AbortSignal before the wallet's code loads).
// The production liveSpvSource on real headers to 146,829 (test/helpers/spvfixture.mjs, the table cut at 131,071):
//   (1) a lookup syncs to its height; (2) a background run syncs to the node tip and a lookup after it asks nothing
//   more; (3) a source dropped while a page is in flight aborts that request; (4) after many pages, the source's own
//   signal holds no listener a settled request added (its drop listener only), with or without AbortSignal.any;
//   (5) the helper itself against AbortSignal.any's contract: an input already aborted, one that aborts later (the
//   first reason wins), and done().
// Run: npx tsx test/namespv-no-signal-any.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { getEventListeners } from "node:events";
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, records, hashOf, SEAL_ANCHORS, SEAL_TOP } from "./helpers/spvfixture.mjs";

const { check, done } = checker("the header sync without AbortSignal.any");
const nativeAny = AbortSignal.any;
delete AbortSignal.any;
check("setup: this engine has no AbortSignal.any", typeof AbortSignal.any === "undefined");
const { liveSpvSource, flushSpvStoreWrites, following } = await import("../src/core/namespv.ts");

const API = "https://cairn-substrate.test", CH = 4096;
const net = { tip: SEAL_TOP };
serveFixture(net);
const served = globalThis.fetch;
const hdr = { reqs: [], hold: () => false, held: [] };
globalThis.fetch = async (url, init) => {
  const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(String(url));
  if (m) {
    const req = { from: Number(m[1]), signal: init?.signal };
    hdr.reqs.push(req);
    if (hdr.hold(req.from)) await new Promise((r, rej) => { hdr.held.push(r); init?.signal?.addEventListener("abort", () => rej(init.signal.reason), { once: true }); });
  }
  return served(url, init);
};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, n = 2000) => { for (let i = 0; i < n && !f(); i++) await tick(); return f(); };
const quiet = async () => { for (let n = -1; n !== hdr.reqs.length;) { n = hdr.reqs.length; await tick(400); } };
function storeTo(tip) {
  const st = memStore();
  for (let k = 31; k <= Math.floor(tip / CH); k++) st.chunks.set(k, records(k * CH, Math.min(k * CH + CH - 1, tip)));
  st.head = { v: 2, tip, tipHash: hashOf(tip) };
  return st;
}
const source = (stop) => liveSpvSource({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => storeTo(136000), signal: stop.signal });

console.log("1. a lookup syncs to its height:");
{
  hdr.reqs.length = 0;
  const stop = new AbortController();
  const src = await source(stop);
  const p = await src.prepare(146000).then((r) => r, (e) => ({ error: String(e?.message ?? e) }));
  check(`(1) the lookup's headers verified to ${p.verifiedTip ?? p.error} with ${hdr.reqs.length} page requests`, p.verifiedTip >= 146012 && hdr.reqs.length > 0);
  const listeners = getEventListeners(stop.signal, "abort").length;
  check(`(4) after ${hdr.reqs.length} pages the source's signal holds ${listeners} listener (its drop listener)`, listeners === 1);
}

console.log("2. a background run syncs to the node tip:");
{
  hdr.reqs.length = 0;
  const stop = new AbortController();
  const src = await source(stop);
  src.background();
  await until(() => hdr.reqs.length > 0); await quiet();
  const pages = hdr.reqs.length;
  const p = await src.prepare(SEAL_TOP - 12).then((r) => r, (e) => ({ error: String(e?.message ?? e).slice(0, 80) }));
  check(`(2) the run reached the node tip (${p.verifiedTip ?? p.error}) with ${pages} page requests; the lookup after it asked ${hdr.reqs.length - pages}`, p.verifiedTip === SEAL_TOP && pages > 0 && hdr.reqs.length === pages);
  const listeners = getEventListeners(stop.signal, "abort").length;
  check(`(4) after the background run's ${pages} pages the source's signal holds ${listeners} listener`, listeners === 1);
}

console.log("3. a source dropped while a page is in flight:");
{
  hdr.reqs.length = 0;
  const stop = new AbortController();
  const src = await source(stop);
  hdr.hold = () => true;
  const p = src.prepare(146000).then(() => "answered", (e) => `refused: ${e?.message}`);
  await until(() => hdr.held.length > 0);
  const inFlight = hdr.reqs[0]?.signal;
  stop.abort();
  const out = await p;
  hdr.hold = () => false;
  check(`(3) the request in flight is aborted with the source (${inFlight?.aborted}), the wait refused (${out.slice(0, 70)})`, inFlight?.aborted === true && out.startsWith("refused"));
}

console.log("4. the same listener count with AbortSignal.any present:");
{
  AbortSignal.any = nativeAny;
  hdr.reqs.length = 0;
  const stop = new AbortController();
  const src = await source(stop);
  const p = await src.prepare(146000).then((r) => r, (e) => ({ error: String(e?.message ?? e).slice(0, 80) }));
  check(`(4) ${hdr.reqs.length} pages, verified to ${p.verifiedTip ?? p.error}, ${getEventListeners(stop.signal, "abort").length} listener on the source's signal`, p.verifiedTip >= 146012 && getEventListeners(stop.signal, "abort").length === 1);
}

console.log("5. the helper against AbortSignal.any's contract:");
{
  const a = new AbortController(), b = new AbortController();
  b.abort(new Error("b first"));
  const pre = following([a.signal, b.signal]);
  check(`(5) an input already aborted: the signal is aborted with its reason (${pre.signal.reason?.message}), no listener left on the others`, pre.signal.aborted && pre.signal.reason?.message === "b first" && getEventListeners(a.signal, "abort").length === 0);
  const c = new AbortController(), d = new AbortController();
  const later = following([c.signal, d.signal]);
  check("(5) none aborted: the signal is not, and it listens to each input", !later.signal.aborted && getEventListeners(c.signal, "abort").length === 1 && getEventListeners(d.signal, "abort").length === 1);
  d.abort(new Error("d"));
  c.abort(new Error("c"));
  check(`(5) the first to abort gives the reason (${later.signal.reason?.message}); its listeners are gone from every input`, later.signal.aborted && later.signal.reason?.message === "d" && getEventListeners(c.signal, "abort").length === 0);
  const e = new AbortController(), settled = following([e.signal]);
  settled.done();
  e.abort();
  check("(5) after done() the input's abort no longer reaches it, and it holds no listener", !settled.signal.aborted && getEventListeners(e.signal, "abort").length === 0);
}

await flushSpvStoreWrites();
done("namespv-no-signal-any");
