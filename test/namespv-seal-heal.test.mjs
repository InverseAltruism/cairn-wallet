// Invariant 1 of the sealed header store, as a property: a seal mismatch never refuses and heals without help. From
// an honest sealed store, any sequence of the store states the wallet can reach (a dropped write, a superseded
// source's write, a 0.3.4-style rewrite or truncation that leaves the list alone, a deleted chunk, an older list put
// back, a list under another vault's key or for another table, a broken head), then one restore and one lookup against
// an honest server: the lookup verifies with the honest answer at every height, and the store is healed (its list
// verifies, seals both sealable chunks, and every listed chunk's stored bytes walk to their seal).
// Real headers to 146,829 (test/helpers/spvfixture.mjs) with the table cut at 131,071, so chunks 32 and 33 seal.
// Run: npx tsx test/namespv-seal-heal.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, records, hashOf, SEAL_ANCHORS, SEAL_NEWEST, SEAL_TOP } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites } from "../src/core/namespv.ts";
import { checkSeals, sealKeyGetter, sealRecord } from "../src/core/spvseal.ts";
import { importKeyRaw } from "../src/core/keystore.ts";
import { deserializeHeader, verifyLinkedRecords } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("seal heal: a seal mismatch never refuses and heals without help (invariant 1)");
const API = "https://cairn-substrate.test";
const net = { tip: SEAL_TOP };
serveFixture(net);
const CH = 4096, SEED = 46, NEWEST_K = 31;
const TABLE = { newest: SEAL_NEWEST, newestHash: hashOf(SEAL_NEWEST) };
const topOf = (k) => k * CH + CH - 1;

// The chainwork at h counted from the light client's seed below the table's newest entry, computed here from the
// compact bits (target = mantissa * 256^(exp - 3); work = 2^256 / (target + 1), saturating at 2^128 - 1).
const MAX128 = (1n << 128n) - 1n;
const workOfBits = (bits) => {
  const exp = bits >>> 24, mant = BigInt(bits & 0xffffff);
  const target = exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
  return (1n << 256n) / (target + 1n);
};
function workAt(h) {
  let w = 0n;
  for (let x = SEAL_NEWEST - SEED + 1; x <= h; x++) w += workOfBits(Number(deserializeHeader(records(x, x)).bits));
  return w > MAX128 ? MAX128 : w;
}

const vkA = await importKeyRaw("0a".repeat(32)), vkB = await importKeyRaw("0b".repeat(32));
const sealKey = sealKeyGetter(() => vkA);
const KA = await sealKey(), KB = await sealKeyGetter(() => vkB)();
const honestTops = [32, 33].map((k) => ({ k, top: hashOf(topOf(k)), work: workAt(topOf(k)) }));
const honestList = sealRecord(KA, TABLE, honestTops);
const chunkRecs = (k, top = SEAL_TOP) => records(Math.max(k * CH, 0), Math.min(topOf(k), top));

function honestStore() {
  const st = memStore();
  for (let k = NEWEST_K; k <= 35; k++) st.chunks.set(k, chunkRecs(k));
  st.head = { v: 2, tip: SEAL_TOP, tipHash: hashOf(SEAL_TOP) };
  st.seals = structuredClone(honestList);
  return st;
}

let seed = 0x5ea1;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let x = seed; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
const ri = (n) => Math.floor(rnd() * n);
const corrupt = (recs) => { const r = recs.slice(); const i = ri(r.length / 84) * 84 + 40; r[i] ^= 0xff; return r; };

// The store states a wallet can reach, each by its cause.
const OPS = {
  "dropped chunk write": (st) => { const k = 32 + ri(4); st.chunks.delete(k); },
  "dropped tail write (older tip)": (st) => { const tip = topOf(33) + 1 + ri(SEAL_TOP - topOf(33)); for (const k of [...st.chunks.keys()]) if (k > Math.floor(tip / CH)) st.chunks.delete(k); st.chunks.set(Math.floor(tip / CH), chunkRecs(Math.floor(tip / CH), tip)); },
  "superseded source's older write": (st) => { const tip = topOf(32) + 1 + ri(topOf(34) - topOf(32)); for (const k of [...st.chunks.keys()]) if (k > Math.floor(tip / CH)) st.chunks.delete(k); st.chunks.set(Math.floor(tip / CH), chunkRecs(Math.floor(tip / CH), tip)); st.head = { v: 2, tip, tipHash: hashOf(tip) }; st.seals = ri(2) ? { ...structuredClone(honestList), list: honestList.list.slice(0, ri(2)) } : st.seals; },
  "0.3.4 rewrite of sealed chunks with other bytes": (st) => { for (let k = 32 + ri(2); k <= 35; k++) if (st.chunks.has(k)) st.chunks.set(k, corrupt(st.chunks.get(k))); },
  "0.3.4 truncation into the sealed run": (st) => { const k = 32 + ri(2); for (const x of [...st.chunks.keys()]) if (x > k) st.chunks.delete(x); st.chunks.set(k, chunkRecs(k, k * CH + ri(CH - 1))); },
  "deleted chunk": (st) => { st.chunks.delete(32 + ri(4)); },
  "older list put back": (st) => { st.seals = { ...structuredClone(honestList), list: honestList.list.slice(0, ri(2)) }; },
  "list under another vault's key": (st) => { st.seals = sealRecord(KB, TABLE, honestTops); },
  "list for another table": (st) => { st.seals = { ...structuredClone(honestList), newest: SEAL_NEWEST + CH }; },
  "list naming a chunk with other bytes": (st) => { st.seals = sealRecord(KA, TABLE, [honestTops[0], { k: 33, top: "0x" + "ee".repeat(32), work: honestTops[1].work }]); },
  "no list": (st) => { st.seals = null; },
  "broken head": (st) => { st.head = { v: 2, tip: SEAL_TOP + 999, tipHash: "0x" + "cd".repeat(32) }; },
};
const names = Object.keys(OPS);
const SAMPLE = [SEAL_NEWEST + 1, topOf(32) - 100, topOf(32), topOf(32) + 1, topOf(33) - 1, topOf(33), topOf(34), SEAL_TOP - 12, SEAL_TOP];

// Healed: the stored list verifies under the wallet's key, seals chunks 32 and 33 with the honest tops, and each
// listed chunk's stored bytes walk from the previous top to its own.
function healed(st) {
  const got = KA && checkSeals(KA, st.seals, TABLE);
  if (!got || got.length !== 2 || got.some((e, i) => e.top !== honestTops[i].top || e.work !== honestTops[i].work)) return false;
  return got.every((e, i) => {
    const recs = st.chunks.get(e.k);
    try { verifyLinkedRecords(recs, { firstHeight: e.k * CH, prevHash: i ? got[i - 1].top : TABLE.newestHash, lastHash: e.top, lastHeight: topOf(e.k) }); return true; }
    catch { return false; }
  });
}

const RUNS = 36;
let refused = 0, wrong = 0, unhealed = 0;
const failures = [];
for (let n = 0; n < RUNS; n++) {
  const st = honestStore();
  const steps = Array.from({ length: 1 + ri(3) }, () => names[ri(names.length)]);
  for (const s of steps) OPS[s](st);
  net.log.length = 0;
  try {
    const src = await liveSpvSource({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: SEAL_ANCHORS, store: async () => st, sealKey, unlocked: () => Promise.resolve() });
    const p = await src.prepare(SEAL_TOP - 12);
    const bad = [];
    for (const h of SAMPLE) if ((await src.hashAt(h)) !== hashOf(h)) bad.push(h);
    if (p.verifiedTip !== SEAL_TOP || bad.length) { wrong++; failures.push(`${steps.join(" + ")}: verified to ${p.verifiedTip}, wrong at ${bad.join(",") || "none"}`); }
    await flushSpvStoreWrites();
    if (!healed(st)) { unhealed++; failures.push(`${steps.join(" + ")}: not healed`); }
  } catch (e) {
    refused++;
    failures.push(`${steps.join(" + ")}: refused (${String(e?.message ?? e).slice(0, 120)})`);
  }
}
for (const f of failures.slice(0, 6)) console.log(`    ${f}`);
check(`property: ${RUNS} store states end with no refusal (${refused})`, refused === 0);
check(`property: every lookup answers the honest header at every sampled height (${wrong} wrong)`, wrong === 0);
check(`property: every store is healed after one restore and one lookup (${unhealed} not)`, unhealed === 0);

done();
