// A worker restart with a session pin above the next sealable top. With the release table every chunk top up to its
// newest entry is a checkpoint, and the pin walk refuses a range holding one, so this case needs a table whose newest
// entry is the restore's base: the production liveSpvSource is bundled here with the table cut to its first 25 entries
// (newest 131,071, an esbuild copy; the shipped code is untouched), over the real headers to 146,829.
// - With the list current (chunks 32 and 33 sealed), the restart does no pass with every check over the walked run.
// - With chunk 33 left unsealed, the pass runs once and the list it writes carries the work counted from the bits.
// Run: npx tsx test/namespv-seal-pin-tail.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, records, hashOf, SEAL_ANCHORS, SEAL_NEWEST, SEAL_TOP } from "./helpers/spvfixture.mjs";
import { deserializeHeader } from "../src/vendor/cairnx-spv.js";

const t = checker("seal restore with a session pin above the next sealable top (table cut to 131,071)");
const root = fileURLToPath(new URL("..", import.meta.url));
const anchorsSrc = readFileSync(`${root}/src/core/spvanchors.ts`, "utf8");
const cut = anchorsSrc.replace(/export const SPV_ANCHORS: readonly string\[\] = \[[\s\S]*?\];/, (m) => {
  const entries = [...m.matchAll(/"0x[0-9a-f]{64}"/g)].map((x) => x[0]).slice(0, SEAL_ANCHORS.length);
  return `export const SPV_ANCHORS: readonly string[] = [${entries.join(", ")}];`;
});
if (cut === anchorsSrc) throw new Error("the anchor table was not cut");
const bundle = (await build({
  stdin: { contents: 'export { liveSpvSource, flushSpvStoreWrites } from "./src/core/namespv.ts"; export { sealKeyGetter, sealRecord, checkSeals } from "./src/core/spvseal.ts"; export { importKeyRaw } from "./src/core/keystore.ts"; export { LightClient } from "./src/vendor/cairnx-spv.js";', resolveDir: root, loader: "ts" },
  bundle: true, format: "esm", platform: "node", target: "es2022", write: false, logLevel: "warning",
  plugins: [{ name: "cut-table", setup(b) {
    b.onLoad({ filter: /spvanchors\.ts$/ }, () => ({ contents: cut, loader: "ts" }));
    b.onLoad({ filter: /spvnewest\.ts$/ }, () => ({ contents: `export const SPV_NEWEST_HEIGHT = ${SEAL_NEWEST};`, loader: "ts" }));
  } }],
})).outputFiles[0].text;
const C = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);

const API = "https://cairn-substrate.test";
const net = { tip: SEAL_TOP };
serveFixture(net);
const CH = 4096, SEED = 46;
const TABLE = { newest: SEAL_NEWEST, newestHash: hashOf(SEAL_NEWEST) };
const topOf = (k) => k * CH + CH - 1;
const tick = () => new Promise((r) => setTimeout(r, 5));
const workOfBits = (bits) => { const exp = bits >>> 24, mant = BigInt(bits & 0xffffff); const tg = exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3)); return (1n << 256n) / (tg + 1n); };
const workAt = (h) => { let w = 0n; for (let x = SEAL_NEWEST - SEED + 1; x <= h; x++) w += workOfBits(Number(deserializeHeader(records(x, x)).bits)); return w; };
const vk = await C.importKeyRaw("0a".repeat(32));
const sealKey = C.sealKeyGetter(() => vk);
const K = await sealKey();
const tops = [32, 33].map((k) => ({ k, top: hashOf(topOf(k)), work: workAt(topOf(k)) }));
function store(sealed) {
  const st = memStore();
  for (let k = 31; k <= 35; k++) st.chunks.set(k, records(k * CH, Math.min(topOf(k), SEAL_TOP)));
  st.head = { v: 2, tip: SEAL_TOP, tipHash: hashOf(SEAL_TOP) };
  st.seals = C.sealRecord(K, TABLE, tops.slice(0, sealed));
  return st;
}
const pinAtTip = () => { const s = { value: { v: 1, newest: SEAL_NEWEST, tip: SEAL_TOP, hash: hashOf(SEAL_TOP), work: workAt(SEAL_TOP).toString() }, get: async () => s.value, set: async (p) => { s.value = p; } }; return s; };
async function restart(st) {
  const orig = C.LightClient.fromRecords, calls = [];
  C.LightClient.fromRecords = function (recs, at, ...rest) { calls.push({ anchor: at.anchorHeight, n: recs.length / 84 }); return orig.call(this, recs, at, ...rest); };
  try {
    const src = await C.liveSpvSource({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => st, sealKey, unlocked: () => Promise.resolve(), pin: pinAtTip() });
    await src.prepare(SEAL_TOP - 12);
    await tick(); await C.flushSpvStoreWrites();
    return { src, calls };
  } finally { C.LightClient.fromRecords = orig; }
}

{
  const st = store(2);
  const { src, calls } = await restart(st);
  const passes = calls.filter((c) => c.anchor === topOf(33) && c.n > SEED);
  t.check(`list current, pin at the tip: seeded at the pin (${calls.map((c) => `${c.anchor}/${c.n}`).join(" ")}), no pass with every check over the walked run (${passes.length})`, calls.some((c) => c.anchor === SEAL_TOP && c.n === SEED) && passes.length === 0);
  t.check("  and a height in the walked run answers the honest header", (await src.hashAt(topOf(34))) === hashOf(topOf(34)) && (await src.hashAt(topOf(33) + 1)) === hashOf(topOf(33) + 1));
}
{
  const st = store(1);
  const { calls } = await restart(st);
  const got = C.checkSeals(K, st.seals, TABLE) ?? [];
  t.check(`chunk 33 unsealed, pin at the tip: one pass over the walked run (${calls.filter((c) => c.anchor === topOf(32) && c.n > SEED).length}), and the list it writes seals 33 with the work counted from the bits`,
    got.length === 2 && got[1].top === tops[1].top && got[1].work === tops[1].work);
}
t.done("namespv-seal-pin-tail");
