// An adoption across sealed chunks, with two valid chains above the table. Chain A: the real headers to 146,829. Chain
// B: forks from A at 131,700 (inside sealed chunk 32), 119 s a block to 160,000, with the bits the vendored light client
// computes (LWMA), so it carries more work. The production liveSpvSource runs from test/helpers/cuttable.mjs: the table
// cut to 131,071 (no release checkpoint under any seal top) and proof of work accepted for B's listed hashes, in that
// test bundle only. A source restored at seal 33 on A adopts B; the list it writes and a restart over it must be B's.
// Run: npx tsx test/namespv-seal-two-chains.test.mjs   (offline)
import { createHash } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { cutTableBundle } from "./helpers/cuttable.mjs";
import { memStore, records, hashOf, headerOf, has, row, SEAL_NEWEST, SEAL_TOP } from "./helpers/spvfixture.mjs";

const { check, done } = checker("an adoption across sealed chunks: the list and a restart follow the adopted chain");
const C = await cutTableBundle('export { liveSpvSource, flushSpvStoreWrites } from "./src/core/namespv.ts"; export { sealKeyGetter, checkSeals } from "./src/core/spvseal.ts"; export { importKeyRaw } from "./src/core/keystore.ts"; export { LightClient, serializeHeader } from "./src/vendor/cairnx-spv.js";', { powList: true });

const CH = 4096, SEED = 46, FORK = 131700, B_TIP = 160000;
const API = "https://cairn-substrate.test";
const topOf = (k) => k * CH + CH - 1;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

// The clock is fixed a day after B's tip, so B's timestamps are not in the future whenever this runs.
const forkTime = Number(headerOf(FORK).time);
const now = (forkTime + (B_TIP - FORK) * 119 + 86400) * 1000;
Date.now = () => now;

globalThis.__testPowOk = new Set();
const B = [];
{
  const { client } = await C.LightClient.fromRecords(records(FORK - SEED + 1, FORK), { firstHeight: FORK - SEED + 1, anchorHeight: FORK }, { checkpoints: { [FORK]: hashOf(FORK) } });
  let prev = hashOf(FORK), time = forkTime;
  for (let h = FORK + 1; h <= B_TIP; h++) {
    time += 119;
    const base = { version: 1, prev, merkle: hex(createHash("sha256").update(`chain B ${h}`).digest()), time, nonce: h };
    let bits = null;
    try { client.ingest(h, { ...base, bits: 1 }); }
    catch (e) { const m = /LWMA ([0-9a-f]+)$/.exec(String(e?.message)); if (!m) throw e; bits = parseInt(m[1], 16); }
    const header = { ...base, bits };
    const hash = hex(sha256d(C.serializeHeader(header)));
    globalThis.__testPowOk.add(hash);
    client.ingest(h, header);
    B.push({ height: h, header, hash });
    prev = hash;
  }
}
const rowOf = (chain, h) => (chain === "A" || h <= FORK ? (has(h) ? row(h) : null) : B[h - FORK - 1] ?? null);
const hashOn = (chain, h) => rowOf(chain, h)?.hash ?? null;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// `chainFor(from)` picks the chain a page is served from; `tip` is the node tip.
const net = { tip: SEAL_TOP, chainFor: () => "A" };
globalThis.fetch = async (url) => {
  const u = String(url);
  const m = /\/api\/headers\/(\d+)\/(\d+)$/.exec(u);
  if (m) {
    const from = Number(m[1]), n = Number(m[2]);
    if (from + n - 1 > net.tip) return json({ ok: false, error: "headers unavailable" }, 502);
    const rows = [];
    for (let h = from; h < from + n; h++) { const r = rowOf(net.chainFor(from), h); if (!r) return json({ ok: false }, 404); rows.push(r); }
    return json({ ok: true, from, count: n, headers: rows });
  }
  if (u.endsWith("/tip")) return json({ height: net.tip, hash: hashOn(net.chainFor(net.tip), net.tip) });
  return json({ ok: false, err: "not found" }, 404);
};

const vk = await C.importKeyRaw("0a".repeat(32));
const sealKey = C.sealKeyGetter(() => vk);
const K = await sealKey();
const TABLE = { newest: SEAL_NEWEST, newestHash: hashOf(SEAL_NEWEST) };
const opts = (st) => ({ rpcBase: `${API}/api/rpc`, headersBase: API, store: async () => st, sealKey, unlocked: () => Promise.resolve() });
const listOf = (st) => C.checkSeals(K, st.seals, TABLE) ?? [];
const onChain = (list, chain) => list.filter((e) => e.top === hashOn(chain, topOf(e.k))).length;
async function seeds(fn) {
  const orig = C.LightClient.fromRecords, calls = [];
  C.LightClient.fromRecords = function (recs, at, ...rest) { calls.push(at.anchorHeight); return orig.call(this, recs, at, ...rest); };
  try { return { out: await fn(), calls }; } finally { C.LightClient.fromRecords = orig; }
}
// Every 37th height from the fork to A's tip, by the chain whose header answers.
async function probe(src) {
  const out = { A: 0, B: 0, none: 0, n: 0 };
  for (let h = FORK + 1; h <= SEAL_TOP; h += 37) {
    out.n++;
    const got = await src.hashAt(h);
    if (got === null) out.none++; else if (got === hashOn("B", h)) out.B++; else if (got === hashOn("A", h)) out.A++;
  }
  return out;
}

// A first unlocked session on A seals chunks 32 and 33.
const st = memStore();
{
  const s = await C.liveSpvSource(opts(st));
  await s.prepare(SEAL_TOP - 12);
  await tick(); await C.flushSpvStoreWrites();
}
const onA = listOf(st);
check(`the session on A seals chunks 32 and 33 on A (${onA.map((e) => e.k).join(",")})`, onA.length === 2 && onChain(onA, "A") === 2);

// A restore seeded at seal 33, then the node serves B: the sync breaks below the held tip, the reseed adopts B.
const { out: src, calls: c1 } = await seeds(() => C.liveSpvSource(opts(st)));
net.chainFor = () => "B"; net.tip = B_TIP;
const p = await src.prepare(B_TIP - 12).catch((e) => ({ error: String(e?.message ?? e) }));
await tick(); await C.flushSpvStoreWrites();
const l1 = listOf(st);
check(`restored at seal 33 (${c1.join(",")}), the prepare adopts B (${p.verifiedTip ?? p.error})`, c1[0] === topOf(33) && p.verifiedTip === B_TIP);
check(`  the list written after the adoption seals only B's tops (${l1.length} entries, ${onChain(l1, "B")} on B, ${onChain(l1, "A")} on A)`, l1.length === 6 && onChain(l1, "B") === 6);
const a1 = await probe(src);
check(`  every probed height from the fork to A's tip answers B (${JSON.stringify(a1)})`, a1.n === 409 && a1.B === a1.n);

// A restart over that store seeds on the list, so every entry below its seed is taken on the MAC.
const { out: src2, calls: c2 } = await seeds(() => C.liveSpvSource(opts(st)));
await tick(); await C.flushSpvStoreWrites();
const l2 = listOf(st);
const a2 = await probe(src2);
check(`a restart seeds at B's seal 37 (${c2.join(",")}) and answers B at every probed height (${JSON.stringify(a2)})`, c2[0] === topOf(37) && a2.B === a2.n && onChain(l2, "B") === l2.length && l2.length === 6);
// A header source that answers the pages of chunks 32 to 34 from the replaced chain.
net.chainFor = (from) => (from <= topOf(34) ? "A" : "B");
const a3 = await probe(src2);
net.chainFor = () => "B";
check(`  with chunks 32 to 34 served from A, no probed height answers A (${JSON.stringify(a3)})`, a3.A === 0 && a3.B === a3.n);

done("namespv-seal-two-chains");
