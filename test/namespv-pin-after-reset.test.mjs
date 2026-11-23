// A reset while the old vault's header source is still restoring: that source writes no session pin afterwards, so the
// next vault's first restore cannot walk to a pin the old vault's seal vouched for. The store holds chain X from 141,000
// in chunk 34 (real links, times and LWMA bits; proof of work only for its last 64 headers) and a list under vault A's
// key that seals it: the party SECURITY.md names, who held the unlocked vault and can still write the profile. The real
// Wallet and liveSpvSource run from test/helpers/cuttable.mjs (the table cut to 131,071, proof of work accepted for
// X's listed hashes, in that test bundle only). Beside it, the honest path: vault B's own pin is written and used.
// Run: npx tsx test/namespv-pin-after-reset.test.mjs   (offline)
import { createHash } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { cutTableBundle } from "./helpers/cuttable.mjs";
import { serveFixture, memStore, records, hashOf, headerOf, SEAL_NEWEST } from "./helpers/spvfixture.mjs";

const { check, done } = checker("the session pin after a reset belongs to the next vault only");
const C = await cutTableBundle('export { liveSpvSource, flushSpvStoreWrites } from "./src/core/namespv.ts"; export { sealRecord, checkSeals } from "./src/core/spvseal.ts"; export { LightClient, serializeHeader } from "./src/vendor/cairnx-spv.js"; export { Wallet } from "./src/core/wallet.ts"; export { memoryStore } from "./src/core/storage.ts";', { powList: true });

const CH = 4096, SEED = 46, HB = 84, FX = 141000, X_TIP = 143359, MINED = 64;
const API = "https://cairn-substrate.test";
const topOf = (k) => k * CH + CH - 1;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

globalThis.__testPowOk = new Set();
const X = [];
{
  const { client } = await C.LightClient.fromRecords(records(FX - SEED + 1, FX), { firstHeight: FX - SEED + 1, anchorHeight: FX }, { checkpoints: { [FX]: hashOf(FX) } });
  let prev = hashOf(FX), time = Number(headerOf(FX).time);
  for (let h = FX + 1; h <= X_TIP; h++) {
    time += 119;
    const base = { version: 1, prev, merkle: hex(createHash("sha256").update(`chain X ${h}`).digest()), time, nonce: h };
    let bits = null;
    try { client.ingest(h, { ...base, bits: 1 }); }
    catch (e) { const m = /LWMA ([0-9a-f]+)$/.exec(String(e?.message)); if (!m) throw e; bits = parseInt(m[1], 16); }
    const header = { ...base, bits };
    const hash = hex(sha256d(C.serializeHeader(header)));
    globalThis.__testPowOk.add(hash);
    client.ingest(h, header);
    X.push({ header, hash });
    prev = hash;
  }
  for (const [i, r] of X.entries()) if (FX + 1 + i <= X_TIP - MINED) globalThis.__testPowOk.delete(r.hash);
}
const xHash = (h) => X[h - FX - 1].hash;
const xRecords = (from, to) => { const out = new Uint8Array((to - from + 1) * HB); for (let h = from; h <= to; h++) out.set(h <= FX ? records(h, h) : C.serializeHeader(X[h - FX - 1].header), (h - from) * HB); return out; };
const workOfBits = (bits) => { const exp = bits >>> 24, mant = BigInt(bits & 0xffffff); const tg = exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3)); return (1n << 256n) / (tg + 1n); };
const honestWork = (h) => { let w = 0n; for (let x = SEAL_NEWEST - SEED + 1; x <= h; x++) w += workOfBits(headerOf(x).bits); return w; };

const net = { tip: X_TIP };
serveFixture(net);   // the header source serves the real chain throughout
const TABLE = { newest: SEAL_NEWEST, newestHash: hashOf(SEAL_NEWEST) };
const H = 141500;
const which = (got) => (got === null ? "none" : got === xHash(H) ? "X" : got === hashOf(H) ? "real" : "other");

const session = C.memoryStore();
const w = new C.Wallet(C.memoryStore(), session);
// The profile's header store, shared across the reset as the IndexedDB store is.
const st = memStore();
for (const k of [31, 32, 33]) st.chunks.set(k, records(k * CH, topOf(k)));
st.chunks.set(34, xRecords(34 * CH, X_TIP));
st.head = { v: 2, tip: X_TIP, tipHash: xHash(X_TIP) };
let gate = null, atGate = null;
const seeded = [];
w.spvBuildForTest = (o) => {
  const id = seeded.length + 1;
  seeded.push([]);
  // Source 1's read of its seed chunk waits (a slow store read), so its restore is in flight across the reset.
  const own = id === 1 ? { ...st, getChunk: async (k) => { if (k === 34 && atGate) { const go = atGate; atGate = null; go(); await gate; } return st.getChunk(k); } } : st;
  return C.liveSpvSource({ ...o, rpcBase: `${API}/api/rpc`, headersBase: API, store: async () => own, legacy: undefined });
};
const orig = C.LightClient.fromRecords;
C.LightClient.fromRecords = function (recs, at, ...rest) { seeded.at(-1)?.push(`${at.anchorHeight}/${recs.length / HB}`); return orig.call(this, recs, at, ...rest); };

await w.create("correct horse battery");
st.seals = C.sealRecord(await w.sealKey(), TABLE, [
  { k: 32, top: hashOf(topOf(32)), work: honestWork(topOf(32)) },
  { k: 33, top: hashOf(topOf(33)), work: honestWork(topOf(33)) },
  { k: 34, top: xHash(X_TIP), work: honestWork(topOf(33)) * 2n },
]);
let open;
gate = new Promise((r) => { open = r; });
const arrived = new Promise((r) => { atGate = r; });
const pA = w.spvSource();
await arrived;                                  // vault A's restore has proven the list and is reading its seed chunk
await w.reset();
const pinAtReset = await session.get("spvPin");
await w.create("another battery staple");
open();
const srcA = await pA;
await tick(); await C.flushSpvStoreWrites();
const late = await session.get("spvPin");
check(`vault A's source finishes its restore on its seal (${seeded[0].join(" ")}) after the reset and writes no pin (${pinAtReset ?? "none"} at the reset, ${late ? `a pin at ${late.tip}` : "none"} after)`,
  seeded[0][0] === `${X_TIP}/${SEED}` && (await srcA.hashAt(H)) === xHash(H) && pinAtReset == null && late == null);

const srcB = await w.spvSource();
const atFirst = which(await srcB.hashAt(H));
check(`vault B's first restore seeds at the table (${seeded[1].join(" ")}) and does not answer X at ${H} (${atFirst})`, seeded.length === 2 && seeded[1][0]?.startsWith(`${SEAL_NEWEST}/`) && atFirst !== "X");
const p = await srcB.prepare(X_TIP - 12);
await tick(); await C.flushSpvStoreWrites();
check(`  after its sync it answers the real chain (${which(await srcB.hashAt(H))}, verified to ${p.verifiedTip})`, p.verifiedTip === X_TIP && (await srcB.hashAt(H)) === hashOf(H));

// The honest path: vault B's own pin is written, and the next source of B (an endpoint change) seeds at it.
const pinB = await session.get("spvPin");
check(`vault B's sync writes its own pin (${pinB ? `at ${pinB.tip}, ${pinB.hash === hashOf(pinB.tip) ? "real" : "other"}` : "none"})`, pinB?.tip === X_TIP && pinB.hash === hashOf(X_TIP));
await w.setApi("https://cairn-substrate.test/other");
const srcB2 = await w.spvSource();
check(`  and B's next source seeds at that pin (${seeded[2]?.join(" ")}) and answers the real chain (${which(await srcB2.hashAt(H))})`,
  seeded.length === 3 && seeded[2].includes(`${X_TIP}/${SEED}`) && !seeded[2].some((c) => c.startsWith(`${SEAL_NEWEST}/`)) && (await srcB2.hashAt(H)) === hashOf(H));
C.LightClient.fromRecords = orig;

done("namespv-pin-after-reset");
