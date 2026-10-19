// After a session-pin restore, a reseed must refuse a served fork whose work at the node tip is below the held
// chain's work counted from the anchor seed (D-86-9). That refusal comes from the reseedAdopts site marked
// MUTATE_RESEED_WORK reading heldWork(), not LC.chainwork: here the held chain's extra work sits in the pin's
// `work` (the walked part below the pin seed), which only heldWork() carries, so the two readings differ.
// Red with `reseedAdopts(LC, fresh)` at that site; the honest path (a production pin adopts at want) passes.
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, legacyOf, records, hashOf, headerOf, forge, rehash, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";
import { liveSpvSource, flushSpvStoreWrites, syncAligned, SPV_CHECKPOINTS } from "../src/core/namespv.ts";
import { LightClient } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("namespv-pin-reseed-lesswork: a reseed after a pin restore refuses a lower-work fork at the node tip");
const API = "https://cairn-substrate.test";
const net = {};
serveFixture(net);
const SEED = 46;
const reset = (tip = FIX_TOP) => { net.log.length = 0; net.tip = tip; net.tamper = undefined; };
function slot(initial = null) {
  const s = { value: initial, sets: 0, get: async () => s.value, set: async (p) => { s.sets++; s.value = p; } };
  return s;
}
function opts(store, pin) {
  const kv = new Map();
  return { rpcBase: `${API}/api/rpc`, headersBase: API, anchors: FIX_ANCHORS, store: async () => store, legacy: legacyOf(kv),
    floor: { get: async () => 0, set: async () => {} }, ...(pin ? { pin } : {}) };
}
async function workAt(tip) {
  const pages = async (from, count) => { const out = []; for (let h = from; h < from + count; h++) out.push({ header: headerOf(h), hash: hashOf(h) }); return out; };
  const { client } = await LightClient.fromRecords(records(NEWEST - SEED + 1, NEWEST), { firstHeight: NEWEST - SEED + 1, anchorHeight: NEWEST }, { headersBatchProvider: pages, checkpoints: SPV_CHECKPOINTS });
  await syncAligned(client, tip);
  return client.chainwork;
}
async function firstSession(tip) {
  reset(tip);
  const st = memStore(), pin = slot();
  await (await liveSpvSource(opts(st, pin))).prepare(tip - 12);
  await flushSpvStoreWrites();
  return { st, pin };
}
// Store and pin end at 115,000; the served page breaks once at 115,001; want is 115,050; node tip 115,199.
async function reseedAfterPin(pinWork) {
  const { st, pin } = await firstSession(115000);
  if (pinWork !== undefined) pin.value = { ...pin.value, work: pinWork.toString() };
  reset(FIX_TOP);
  let broken = false;
  net.tamper = (from, rows) => {
    if (broken || !rows.some((r) => r.height === 115001)) return rows;
    broken = true;
    return rows.map((r) => (r.height === 115001 ? rehash(forge(r)) : r));
  };
  const src = await liveSpvSource(opts(st, pin));
  const p = await src.prepare(115050 - 12).then((x) => ({ ok: true, ...x }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
  await flushSpvStoreWrites();
  return { p, src, st, pin, log: [...net.log] };
}

console.log("1. the held chain (walked part inflated through the pin's work) has more work than the fork at the node tip: refused, held chain kept");
{
  const held = await workAt(115000), atTip = await workAt(FIX_TOP);
  const inflated = held * 2n; // > the fork's work at the node tip (558 blocks vs 359): see check text
  check(`setup: inflated held work ${inflated} > fork work at the node tip ${atTip}`, inflated > atTip);
  const { p, src, st, pin, log } = await reseedAfterPin(inflated);
  check(`prepare refuses with the less-work refusal (${(p.error ?? "resolved " + p.verifiedTip).slice(0, 90)}); requests ${log.join(" ")}`, p.ok === false && /less proof of work/.test(p.error) && log.join(" ") === "115001/50 114688/363 114688/512");
  check("  the held chain stays: hashAt(115,000) is the stored tip and nothing above it is answered", (await src.hashAt(115000)) === hashOf(115000) && (await src.hashAt(115001)) === null);
  check("  the store and the pin are unchanged", st.head?.tip === 115000 && pin.value?.tip === 115000 && pin.value.hash === hashOf(115000));
}

console.log("2. honest path (production pin): the same break with the real pin work adopts the served chain at want");
{
  const { p, src, pin, log } = await reseedAfterPin(undefined);
  check(`adopted at want (${p.verifiedTip}; ${log.join(" ")})`, p.ok === true && p.verifiedTip === 115050 && log.join(" ") === "115001/50 114688/363" && (await src.hashAt(115050)) === hashOf(115050));
  check("  the new pin is the adopted tip with the work from the anchor seed", pin.value?.tip === 115050 && BigInt(pin.value.work) === await workAt(115050));
}

done("namespv-pin-reseed-lesswork");
