// A header source the wallet dropped (its opts.signal aborted) requests no further page and writes nothing, at every
// site a request or a write leaves from, through the production liveSpvSource on real headers to 146,829 (the table
// cut at 131,071). Each case holds one write or one page, drops the source, releases, and asserts that nothing landed
// and nothing more was asked; then 50 drops at random points of a run leave the store as it was at the drop.
// Run: npx tsx test/namespv-dropped-source.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, records, hashOf, legacyOf, v1Snapshot, SEAL_ANCHORS, SEAL_TOP } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites } from "../src/core/namespv.ts";
import { sealKeyGetter } from "../src/core/spvseal.ts";
import { importKeyRaw } from "../src/core/keystore.ts";

const { check, done } = checker("a dropped header source requests and writes nothing more");
const API = "https://cairn-substrate.test", CH = 4096;
const topOf = (k) => k * CH + CH - 1;
const net = { tip: SEAL_TOP };
serveFixture(net);
const served = globalThis.fetch;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, n = 600) => { for (let i = 0; i < n && !f(); i++) await tick(); return f(); };

// Every header request with its signal; `hold(from)` keeps one unanswered until release(); `status(from)` answers it
// with that status instead (429 with Retry-After 1 s).
const hdr = { reqs: [], held: [], hold: () => false, status: () => 0, ignoreAbort: false };
const release = () => { for (const r of hdr.held.splice(0)) r(); };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(u);
  if (!m) return served(url, init);
  const req = { from: Number(m[1]), signal: init?.signal ?? null };
  hdr.reqs.push(req);
  if (hdr.hold(req.from)) {
    await new Promise((r, rej) => { hdr.held.push(r); if (!hdr.ignoreAbort) req.signal?.addEventListener("abort", () => rej(new DOMException("This operation was aborted", "AbortError")), { once: true }); });
  }
  const st = hdr.status(req.from);
  if (st) return new Response("{}", { status: st, headers: { "retry-after": "1" } });
  return served(url, init);
};
const reset = () => { hdr.reqs.length = 0; hdr.held.length = 0; hdr.hold = () => false; hdr.status = () => 0; hdr.ignoreAbort = false; net.tip = SEAL_TOP; };

function storeTo(tip, seal = null) {
  const st = memStore();
  for (let k = 31; k <= Math.floor(tip / CH); k++) st.chunks.set(k, records(k * CH, Math.min(topOf(k), tip)));
  st.head = { v: 2, tip, tipHash: hashOf(tip) };
  if (seal) st.seals = seal;
  return st;
}
// The store with one write held: `gate(w)` true holds that write until release().
function holding(st, gate) {
  const writes = [];
  const inner = st.write.bind(st);
  st.write = async (w) => { if (gate(w)) await new Promise((r) => hdr.held.push(r)); writes.push(w); return inner(w); };
  return writes;
}
const vk = await importKeyRaw("0a".repeat(32));
const realKey = sealKeyGetter(() => vk);
const opts = (st, ctl, extra = {}) => ({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => st, signal: ctl.signal, ...extra });
const settle = async () => { await tick(80); await flushSpvStoreWrites(); await tick(20); };

console.log("1. persist: the write built before the seal key's await does not land after a drop:");
{
  reset();
  const st = storeTo(140000);
  const ctl = new AbortController();
  let keyGate = null, keyWaits = 0;
  const sealKey = async () => { keyWaits++; if (keyGate) await keyGate.p; return realKey(); };
  const src = await liveSpvSource(opts(st, ctl, { sealKey, unlocked: () => Promise.resolve() }));
  await settle();
  const before = st.writes.length;
  keyGate = {}; keyGate.p = new Promise((r) => { keyGate.r = r; });
  const waits = keyWaits;
  const lookup = src.prepare(SEAL_TOP - 12).catch((e) => `refused: ${e.message}`);
  await until(() => keyWaits > waits);
  const asked = hdr.reqs.length;
  ctl.abort();
  keyGate.r(); keyGate = null;
  const out = await lookup;
  await settle();
  check(`no write after the drop (${st.writes.length - before}), no page asked after it (${hdr.reqs.length - asked}), the lookup refused (${String(out).slice(0, 40)})`,
    st.writes.length === before && hdr.reqs.length === asked && String(out).startsWith("refused"));
}

console.log("2. the detached writer: a write pending behind one in flight is not written after a drop:");
{
  reset();
  const st = storeTo(136000);
  const ctl = new AbortController();
  const src = await liveSpvSource(opts(st, ctl));
  let first = true;
  const writes = holding(st, (w) => w.head && (first ? !(first = false) : false));
  const lookup = src.prepare(SEAL_TOP - 12).catch(() => "refused");
  // The first window's write is held; the second window's waits pending behind it.
  await until(() => hdr.held.length > 0 && hdr.reqs.length > 18);
  ctl.abort();
  release();
  await lookup; await settle();
  check(`only the write in flight before the drop landed (${writes.length} of the writer's)`, writes.length === 1);
}

console.log("3. the acquirer: a chunk write queued behind one in flight does not land after a drop:");
{
  reset();
  const st = storeTo(136000);
  st.chunks.delete(26); st.chunks.delete(27);
  const ctl = new AbortController();
  const src = await liveSpvSource(opts(st, ctl));
  const writes = holding(st, (w) => w.put?.[0]?.k === 26);
  await Promise.all([src.hashAt(108000), src.hashAt(112000)]);
  await until(() => hdr.held.length > 0);
  ctl.abort();
  release();
  await settle();
  check(`chunk 26's write (in flight) landed and chunk 27's (queued) did not (${writes.map((w) => w.put?.[0]?.k).join(",")})`, writes.length === 1 && writes[0].put[0].k === 26 && !st.chunks.has(27));
}

console.log("4. the seal catch-up: dropped while it waits for the key, it writes no list:");
{
  reset();
  const st = storeTo(SEAL_TOP);
  const ctl = new AbortController();
  let gate = null;
  const sealKey = async () => { if (gate) await gate.p; return realKey(); };
  gate = {}; gate.p = new Promise((r) => { gate.r = r; });
  const built = liveSpvSource(opts(st, ctl, { sealKey, unlocked: () => Promise.resolve() }));
  await tick(100);
  ctl.abort();
  gate.r(); gate = null;
  await built.catch(() => null);
  await settle();
  check(`no list written (${st.writes.filter((w) => w.seals).length} writes with one), none at all (${st.writes.length})`, st.writes.length === 0 && st.seals === null);
}

console.log("5. the legacy migration: dropped mid-migration, it writes no further chunk, no head, and keeps the snapshot:");
{
  // (a) dropped while a chunk write is in flight; (b) dropped later, while the restore reads a stored chunk above the
  // anchor (left by an earlier, unfinished migration), just before the head write that ends the migration.
  for (const at of ["chunk write", "stored chunk read"]) {
    reset();
    const st = memStore();
    if (at === "stored chunk read") {
      st.chunks.set(32, records(32 * CH, topOf(32)));
      const read = st.getChunk.bind(st);
      st.getChunk = async (k) => { if (k === 32) await new Promise((r) => hdr.held.push(r)); return read(k); };
    }
    const kv = new Map([["spvHeaderChain", v1Snapshot(126976, 140000)]]);
    const legacy = legacyOf(kv);
    const ctl = new AbortController();
    let n = 0;
    const writes = holding(st, () => at === "chunk write" && n++ === 0);
    const built = liveSpvSource(opts(st, ctl, { legacy }));
    await until(() => hdr.held.length > 0);
    const before = writes.length;
    ctl.abort();
    release();
    const out = await built.then(() => "built", (e) => `ended: ${e.message}`);
    await settle();
    check(`${at}: ${writes.length - before} writes after the drop, the one in flight landed (${before}); no head (${!!st.head}); the snapshot kept (${legacy.calls.del} deletes); ${out.slice(0, 30)}`,
      writes.length - before === (at === "chunk write" ? 1 : 0) && !st.head && legacy.calls.del === 0 && kv.has("spvHeaderChain"));
  }
}

// A source whose sync has run seven fast pages asks five at once (the width grows by one per fast page).
const WARM = 131071 + 7 * 512;
async function warmed(st, ctl) { const src = await liveSpvSource(opts(st, ctl)); await src.prepare(WARM - 12); hdr.reqs.length = 0; return src; }

console.log("6. a request in flight ends with the drop, and its 429 retries stop:");
{
  reset();
  const st = storeTo(131071);
  const ctl = new AbortController();
  const src = await warmed(st, ctl);
  hdr.hold = (from) => from > WARM;
  const lookup = src.prepare(SEAL_TOP - 12).catch((e) => `refused: ${e.message}`);
  await until(() => hdr.held.length >= 5);
  const inFlight = hdr.reqs.filter((r) => r.from > WARM);
  ctl.abort();
  const out = await Promise.race([lookup, tick(1000).then(() => "hung")]);
  await settle();
  check(`all ${inFlight.length} requests in flight were aborted (${inFlight.filter((r) => r.signal?.aborted).length}) and the lookup refused at once (${String(out).slice(0, 40)})`,
    inFlight.length === 5 && inFlight.every((r) => r.signal?.aborted) && String(out).startsWith("refused"));

  reset();
  const st2 = storeTo(131071);
  const ctl2 = new AbortController();
  const src2 = await warmed(st2, ctl2);
  hdr.status = (from) => (from > WARM ? 429 : 0);
  const lookup2 = src2.prepare(SEAL_TOP - 12).catch(() => "refused");
  await until(() => hdr.reqs.length >= 5);
  ctl2.abort();
  const asked = hdr.reqs.length;
  await lookup2; await tick(1500);
  check(`after the drop the 429 retries stop (${hdr.reqs.length - asked} more requests in 1.5 s)`, hdr.reqs.length === asked);
}

console.log("7. a window whose first page fails cancels its other pages:");
{
  reset();
  const st = storeTo(131071);
  const ctl = new AbortController();
  const src = await warmed(st, ctl);
  hdr.status = (from) => (from === WARM + 1 ? 404 : 0);
  hdr.hold = (from) => from > WARM + 1;
  const out = await src.prepare(SEAL_TOP - 12).then(() => "verified", (e) => `refused: ${e.message}`);
  const others = hdr.reqs.filter((r) => r.from > WARM + 1);
  await tick(50);
  check(`the lookup is refused (${out.slice(0, 40)}); the window's other ${others.length} pages were aborted (${others.filter((r) => r.signal?.aborted).length})`,
    out.startsWith("refused") && others.length === 4 && others.every((r) => r.signal?.aborted));
  release();
}

console.log("8. a chunk fetch stops between its pages:");
{
  reset();
  const st = storeTo(136000);
  st.chunks.delete(26);
  const ctl = new AbortController();
  const src = await liveSpvSource(opts(st, ctl));
  hdr.hold = (from) => from === 107520;
  const read = src.hashAt(108000);
  await until(() => hdr.held.length > 0);
  ctl.abort();
  await read;
  await settle();
  const pages = hdr.reqs.map((r) => r.from);
  check(`chunk 26 asked its first three pages only (${pages.join(",")}), and stored nothing (${st.writes.length})`, pages.join() === "106496,107008,107520" && st.writes.length === 0);
}

console.log("9. a page that answers after the drop is not ingested:");
{
  reset();
  const st = storeTo(136000);
  const ctl = new AbortController();
  const src = await liveSpvSource(opts(st, ctl));
  // A server that answers the held page after the drop anyway (its response already on the way).
  hdr.ignoreAbort = true;
  hdr.hold = (from) => from === 135680;
  const lookup = src.prepare(SEAL_TOP - 12).catch(() => "refused");
  await until(() => hdr.held.length > 0);
  ctl.abort();
  release();
  await lookup; await settle();
  check(`the held tip stays at 136,000 (136,100 answers ${await src.hashAt(136100)})`, (await src.hashAt(136100)) === null && (await src.hashAt(136000)) === hashOf(136000));
}

console.log("10. 50 drops at random points of a run: the store is as it was at each drop:");
{
  let seed = 7, differ = 0, after = 0, lands = 0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 50; i++) {
    reset();
    const st = storeTo(131071 + Math.floor(rnd() * 8000));
    const ctl = new AbortController();
    const src = await liveSpvSource(opts(st, ctl, { sealKey: realKey, unlocked: () => Promise.resolve() }));
    const lookup = src.prepare(SEAL_TOP - 12).catch(() => "refused");
    await tick(Math.floor(rnd() * 400));
    const asked = hdr.reqs.length, writes = st.writes.length;
    ctl.abort();
    const atDrop = st.image();
    await lookup; await settle();
    if (st.image() !== atDrop) differ++;
    if (hdr.reqs.length !== asked) after++;
    if (st.writes.length > writes) lands++;
  }
  check(`over 50 drops: the store changed after the drop in ${differ}, a page was asked after it in ${after}, a write landed after it in ${lands}`, differ === 0 && after === 0 && lands === 0);
}

console.log("11. the honest path: the same source not dropped syncs and writes:");
{
  reset();
  const st = storeTo(136000);
  const ctl = new AbortController();
  const src = await liveSpvSource(opts(st, ctl, { sealKey: realKey, unlocked: () => Promise.resolve() }));
  const p = await src.prepare(SEAL_TOP - 12);
  await settle();
  check(`verified to ${p.verifiedTip}, the store's head at ${st.head?.tip}, a list written (${!!st.seals})`, p.verifiedTip === SEAL_TOP && st.head?.tip === SEAL_TOP && !!st.seals);
}

done("namespv-dropped-source");
