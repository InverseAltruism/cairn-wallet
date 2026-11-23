// The reseed with second chains above the table: one reseed function (seeded at the newest seal or at the table), one
// decision (a chain verified above the held tip with more work), one adoption site, and the background's bounded
// reseed. Chain A is the real headers to 146,829, sealed at chunks 32 and 33. The other chains are generated from a
// fork point with the bits the vendored light client computes (LWMA): B1 replaces A's tip block (a 1-block orphan),
// B34 forks inside chunk 34 above seal 33, B33 and B32 fork inside chunks 33 and 32 below it, L34 and L33 fork the same places with
// less work, and S forks inside chunk 34 with more work but ends below the held tip. The production liveSpvSource runs
// from test/helpers/cuttable.mjs (the table cut at 131,071; proof of work accepted for the generated hashes, in that
// test bundle only).
// Run: npx tsx test/namespv-reseed-bounded.test.mjs   (offline)
import "./helpers/backup-host.mjs";
import { createHash } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { cutTableBundle } from "./helpers/cuttable.mjs";
import { memStore, records, hashOf, headerOf, has, row, SEAL_NEWEST, SEAL_TOP } from "./helpers/spvfixture.mjs";

const { check, done } = checker("the reseed: seeds, the bounded background reseed, the adoption");
const C = await cutTableBundle('export { liveSpvSource, flushSpvStoreWrites, BOUNDED_PAGES } from "./src/core/namespv.ts"; export { sealKeyGetter, checkSeals } from "./src/core/spvseal.ts"; export { importKeyRaw } from "./src/core/keystore.ts"; export { LightClient, serializeHeader } from "./src/vendor/cairnx-spv.js";', { powList: true });

const CH = 4096, SEED = 46, PAGE = 512;
const API = "https://cairn-substrate.test";
const topOf = (k) => k * CH + CH - 1;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, n = 600) => { for (let i = 0; i < n && !(await f()); i++) await tick(); };
const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

// The clock is fixed 400 days after A's tip, past every generated chain's last header.
const now = (Number(headerOf(SEAL_TOP).time) + 400 * 86400) * 1000;
Date.now = () => now;
globalThis.__testPowOk = new Set();
const chains = { A: { fork: Infinity, rows: [] } };
let lastTime = 0;
async function makeChain(name, fork, tip, spacing) {
  const { client } = await C.LightClient.fromRecords(records(fork - SEED + 1, fork), { firstHeight: fork - SEED + 1, anchorHeight: fork }, { checkpoints: { [fork]: hashOf(fork) } });
  let prev = hashOf(fork), time = Number(headerOf(fork).time);
  const rows = [];
  for (let h = fork + 1; h <= tip; h++) {
    time += spacing;
    const base = { version: 1, prev, merkle: hex(createHash("sha256").update(`${name} ${h}`).digest()), time, nonce: h };
    let bits = null;
    try { client.ingest(h, { ...base, bits: 1 }); }
    catch (e) { const m = /LWMA ([0-9a-f]+)$/.exec(String(e?.message)); if (!m) throw e; bits = parseInt(m[1], 16); }
    const header = { ...base, bits };
    const hash = hex(sha256d(C.serializeHeader(header)));
    globalThis.__testPowOk.add(hash);
    client.ingest(h, header);
    rows.push({ height: h, header, hash });
    prev = hash;
  }
  lastTime = Math.max(lastTime, time);
  chains[name] = { fork, tip, rows, work: client.chainwork };
}
await makeChain("B1", SEAL_TOP - 1, SEAL_TOP + 11, 119);
await makeChain("B34", 141000, 147600, 100);
await makeChain("B33", 137000, 148000, 119);
await makeChain("B32", 133000, 148000, 119);
await makeChain("L34", 141000, 147500, 1440);
await makeChain("L33", 137000, 147500, 1440);
await makeChain("S", 141000, 146000, 60);
if (lastTime * 1000 > now) throw new Error("a generated chain ends after the fixed clock");

const rowOf = (name, h) => { const c = chains[name]; return h <= c.fork ? (has(h) ? row(h) : null) : c.rows[h - c.fork - 1] ?? null; };
const hashOn = (name, h) => rowOf(name, h)?.hash ?? null;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// The served world: `chain` answers every page (A to 146,829), `tip` is the node tip; `garbageAbove` serves a header
// that links to nothing above that height; `hold(from)` keeps a page until `release()`. `log` lists the page requests.
const net = { chain: "A", tip: SEAL_TOP, garbageAbove: Infinity, hold: () => false, held: [], log: [] };
const release = () => { for (const r of net.held.splice(0)) r(); };
const garbage = (h) => ({ height: h, header: { ...headerOf(SEAL_TOP), prev: hex(createHash("sha256").update(`garbage ${h}`).digest()) }, hash: hex(createHash("sha256").update(`g ${h}`).digest()) });
globalThis.fetch = async (url) => {
  const u = String(url);
  const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(u);
  if (m) {
    const from = Number(m[1]), n = Number(m[2]);
    net.log.push(from);
    if (net.hold(from)) await new Promise((r) => net.held.push(r));
    if (from + n - 1 > net.tip) return json({ ok: false, error: "headers unavailable" }, 502);
    const rows = [];
    for (let h = from; h < from + n; h++) { const r = h > net.garbageAbove ? garbage(h) : rowOf(net.chain, h); if (!r) return json({ ok: false }, 404); rows.push(r); }
    return json({ ok: true, from, count: n, headers: rows });
  }
  if (u.endsWith("/tip")) return json({ height: net.tip, hash: hashOn(net.chain, net.tip) });
  return json({ ok: false, err: "not found" }, 404);
};
const serve = (chain, tip, extra = {}) => Object.assign(net, { chain, tip, garbageAbove: Infinity, hold: () => false, held: [], log: [] }, extra);

const vk = await C.importKeyRaw("0a".repeat(32));
const sealKey = C.sealKeyGetter(() => vk);
const K = await sealKey();
const TABLE = { newest: SEAL_NEWEST, newestHash: hashOf(SEAL_NEWEST) };
const opts = (st, extra = {}) => ({ rpcBase: `${API}/api/rpc`, headersBase: API, store: async () => st, sealKey, unlocked: () => Promise.resolve(), ...extra });
const listOf = (st) => C.checkSeals(K, st.seals, TABLE) ?? [];
async function seeds(fn) {
  const orig = C.LightClient.fromRecords, calls = [];
  C.LightClient.fromRecords = function (recs, at, ...rest) { calls.push(at.anchorHeight); return orig.call(this, recs, at, ...rest); };
  try { return { out: await fn(), calls }; } finally { C.LightClient.fromRecords = orig; }
}
const settled = async (src) => { await until(() => src.syncProgress() === null); await tick(20); await until(() => src.syncProgress() === null); await C.flushSpvStoreWrites(); };

// A first unlocked session on A seals chunks 32 and 33; every scenario starts from a copy of that store.
const sealedA = memStore();
{
  serve("A", SEAL_TOP);
  const s = await C.liveSpvSource(opts(sealedA));
  await s.prepare(SEAL_TOP - 12);
  await tick(); await C.flushSpvStoreWrites();
}
const copyOf = (st) => { const c = memStore(); for (const [k, v] of st.chunks) c.chunks.set(k, v.slice()); c.head = st.head && { ...st.head }; c.seals = st.seals && structuredClone(st.seals); return c; };
check(`the session on A seals chunks 32 and 33 (${listOf(sealedA).map((e) => e.k).join(",")})`, listOf(sealedA).map((e) => e.k).join() === "32,33");
const below = (from) => net.log.filter((f) => f < from).length;

console.log("1. the background's bounded reseed adopts a 1-block orphan from the newest seal:");
{
  const st = copyOf(sealedA);
  serve("A", SEAL_TOP);
  const src = await C.liveSpvSource(opts(st));
  serve("B1", SEAL_TOP + 11);
  const { calls } = await seeds(async () => { src.background(); await settled(src); });
  const n = net.log.length - net.log.indexOf(topOf(33) + 1);
  check(`seeded at seal 33 (${calls.join(",")}), adopted to ${(await src.prepare(0)).verifiedTip}, the orphan replaced (${(await src.hashAt(SEAL_TOP)) === hashOn("B1", SEAL_TOP)})`,
    calls.join() === String(topOf(33)) && (await src.prepare(0)).verifiedTip === SEAL_TOP + 11 && (await src.hashAt(SEAL_TOP)) === hashOn("B1", SEAL_TOP));
  check(`  the reseed from the seal makes ${n} requests (at most ${C.BOUNDED_PAGES}), none below the seal (${below(topOf(33) + 1)})`, n > 0 && n <= C.BOUNDED_PAGES && below(topOf(33) + 1) === 0);
}

console.log("2. beyond the bound the background makes no table request; the lookup's reseed adopts:");
{
  // A pin restore over a store without a list: the walked run's tops are not known, so no seal lies within the bound.
  const st = copyOf(sealedA); st.seals = null;
  const pin = { value: null, get: async () => pin.value, set: async (p) => { pin.value = p; } };
  serve("A", SEAL_TOP);
  await C.liveSpvSource(opts(st, { sealKey: undefined, pin }));
  const src = await C.liveSpvSource(opts(st, { sealKey: undefined, pin }));
  serve("B34", 147600);
  src.background();
  await settled(src);
  const held = (await src.hashAt(SEAL_TOP)) === hashOf(SEAL_TOP);
  check(`pin ${pin.value?.tip}: the break stops the run after its first window (${net.log.join(",")}), no reseed request below it (${below(146432)}), A still held (${held})`,
    pin.value?.tip === SEAL_TOP && net.log.length > 0 && net.log.length <= 6 && below(146432) === 0 && held);
  serve("B34", 147600);
  const p = await src.prepare(147600 - 12).catch((e) => ({ error: String(e?.message ?? e) }));
  check(`  a lookup then reseeds from the table (${below(SEAL_NEWEST + PAGE + 1) > 0}) and adopts B34 (${p.verifiedTip ?? p.error})`, below(SEAL_NEWEST + PAGE + 1) > 0 && p.verifiedTip === 147600 && (await src.hashAt(141500)) === hashOn("B34", 141500));
}

console.log("3. a fork above a kept seal: the seal's tops and cached chunks stay, the replaced chain above it goes:");
{
  const st = copyOf(sealedA);
  serve("A", SEAL_TOP);
  const src = await C.liveSpvSource(opts(st));
  const h32 = 135000;
  check(`before: chunk 32 read (${(await src.hashAt(h32)) === hashOf(h32)}) and 141,500 on A`, (await src.hashAt(h32)) === hashOf(h32) && (await src.hashAt(141500)) === hashOf(141500));
  serve("B34", 147600);
  src.background();
  await settled(src);
  const n = net.log.length - net.log.indexOf(topOf(33) + 1);
  net.log.length = 0;
  const kept = await src.hashAt(h32), mid = await src.hashAt(topOf(33) - 10);
  check(`adopted B34 from seal 33 in ${n} reseed requests (at most ${C.BOUNDED_PAGES}): chunk 32 and 33 heights answer with no request (${kept === hashOf(h32) && mid === hashOf(topOf(33) - 10)}, ${net.log.length})`,
    (await src.prepare(0)).verifiedTip === 147600 && n <= C.BOUNDED_PAGES && kept === hashOf(h32) && mid === hashOf(topOf(33) - 10) && net.log.length === 0);
  let fromB = 0, total = 0;
  for (let h = 141001; h <= SEAL_TOP; h += 53) { total++; if ((await src.hashAt(h)) === hashOn("B34", h)) fromB++; }
  const list = listOf(st);
  check(`  above the fork every probed height answers B34 (${fromB} of ${total}); the list is ${list.map((e) => e.k).join(",")}, every top on B34`, fromB === total && list.map((e) => e.k).join() === "32,33,34" && list.every((e) => e.top === hashOn("B34", topOf(e.k))));
  const { out: src2, calls } = await seeds(() => C.liveSpvSource(opts(st)));
  check(`  a restart seeds at B34's seal 34 (${calls.join(",")}) and answers B34 (${(await src2.hashAt(143000)) === hashOn("B34", 143000)})`, calls[0] === topOf(34) && (await src2.hashAt(143000)) === hashOn("B34", 143000) && (await src2.hashAt(h32)) === hashOf(h32));
}

console.log("4. less work is refused through every seed; the held chain stays:");
for (const [how, chain] of [["table (a lookup, the seal does not link)", "L33"], ["seal (a lookup)", "L34"], ["the bounded reseed (background)", "L34"]]) {
  const st = copyOf(sealedA);
  serve("A", SEAL_TOP);
  const src = await C.liveSpvSource(opts(st));
  serve(chain, 147500);
  const { out, calls } = await seeds(async () => {
    if (how.startsWith("the bounded")) { src.background(); await settled(src); return "background"; }
    return src.prepare(147500 - 12).then((r) => `verified ${r.verifiedTip}`, (e) => String(e?.message ?? e));
  });
  await C.flushSpvStoreWrites();
  const stays = (await src.hashAt(SEAL_TOP)) === hashOf(SEAL_TOP) && (await src.prepare(0)).verifiedTip === SEAL_TOP && st.head.tip === SEAL_TOP;
  const seeded = how.startsWith("table") ? calls.includes(SEAL_NEWEST) : calls.includes(topOf(33)) && !calls.includes(SEAL_NEWEST);
  check(`${how}: seeded at ${calls.join(",")}; ${out.slice(0, 60)}; A kept in memory and store (${stays})`,
    seeded && stays && (how.startsWith("the bounded") || /less proof of work/.test(out)));
}

console.log("5. a chain with more work that ends below the held tip is never adopted, through any seed:");
for (const how of ["lookup", "background"]) {
  const st = copyOf(sealedA);
  serve("A", SEAL_TOP);
  const src = await C.liveSpvSource(opts(st));
  serve("S", SEAL_TOP + 11, { garbageAbove: 146000 });
  const out = how === "lookup" ? await src.prepare(SEAL_TOP - 1).then((r) => `verified ${r.verifiedTip}`, (e) => String(e?.message ?? e)) : (src.background(), await settled(src), "background");
  check(`${how}: ${out.slice(0, 70)}; A kept (${(await src.hashAt(145000)) === hashOf(145000)})`,
    (await src.hashAt(145000)) === hashOf(145000) && (await src.prepare(0)).verifiedTip === SEAL_TOP && !out.startsWith("verified"));
}

console.log("6. the bounded reseed never stands in a lookup's way:");
{
  // B33 forks below seal 33, so the background's reseed from it cannot link; a lookup that arrives meanwhile gets the
  // table reseed, as with 0.3.5, and verifies.
  const st = copyOf(sealedA);
  serve("A", SEAL_TOP);
  const src = await C.liveSpvSource(opts(st));
  let lookup = null;
  serve("B33", 148000, { hold: (from) => from > topOf(33) && from < SEAL_TOP - PAGE && !lookup });
  src.background();
  await until(() => net.held.length > 0);
  lookup = src.prepare(148000 - 12).then((r) => r.verifiedTip, (e) => String(e?.message ?? e));
  release();
  const got = await lookup;
  check(`the lookup made during the background reseed verifies B33 (${got}) from the table (${below(SEAL_NEWEST + PAGE + 1) > 0})`, got === 148000 && below(SEAL_NEWEST + PAGE + 1) > 0 && (await src.hashAt(140000)) === hashOn("B33", 140000));
}

console.log("7. a refetched sealed chunk that fails its seal: that read only, one background run, no table reseed:");
{
  // Restored at seal 33, chunk 32 lies below the client and is read from the store, which holds other bytes; its
  // refetch is B32's chunk 32, which does not walk to A's seal.
  const st = copyOf(sealedA);
  const r = st.chunks.get(32).slice(); r[84 * 900 + 40] ^= 0xff; st.chunks.set(32, r);
  serve("A", SEAL_TOP);
  const src = await C.liveSpvSource(opts(st));
  serve("B32", 148000);
  const got = await src.hashAt(134000);
  const refetch = net.log.slice();
  await settled(src);
  const after = net.log.slice(refetch.length);
  const tableOrSeal = after.filter((f) => f <= topOf(33)).length;
  check(`the read at 134,000 answers null (${got}) after refetching chunk 32 (${refetch.length} pages)`, got === null && refetch.length === 8 && refetch.every((f) => f >= 32 * CH && f <= topOf(32)));
  check(`  the run it started stops after ${after.length} requests: its break and the seal's reseed, nothing at or below seal 33 (${tableOrSeal})`,
    after.length > 0 && after.length <= 2 * 6 && tableOrSeal === 0 && after.some((f) => f === topOf(33) + 1));
  check("  the held chain still answers from A", (await src.hashAt(SEAL_TOP)) === hashOf(SEAL_TOP) && (await src.hashAt(140000)) === hashOf(140000));
  const p = await src.prepare(148000 - 12).catch((e) => ({ error: String(e?.message ?? e) }));
  check(`  a lookup then reseeds from the table and adopts B32 (${p.verifiedTip ?? p.error}); 134,000 answers B32`, p.verifiedTip === 148000 && (await src.hashAt(134000)) === hashOn("B32", 134000));
}

done("namespv-reseed-bounded");
