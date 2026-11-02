// provenOfferPayto with `fills` proves a partial offer's running state on the offer-id lane: the offer record and each
// fill the offer service lists are merkle-proven at their heights and bound to the coins their signers spent, then
// replayed through the vendored resolver over the proven offer. Real signed txs in synthetic PoW-verified blocks
// (test/_spvrig.ts). Cost: one block bind per listed fill's block beside the offer's, counted here.
//   - no listed fill: paid 0, and no read beyond the offer's block;
//   - one or two listed fills: their paid and delivered, one more block read each;
//   - a listed fill that is not in its block, is another offer's, or does not bind to its coin: unproven;
//   - without `fills` (a whole offer) nothing changes: no progress, the offer's block only.
// Run: npx tsx test/fill-offer-progress.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { provenOfferPayto } from "../src/core/fillspv.js";
import { offer, tradeFee, feeBpsAt, V29_HEIGHT, TREASURY_ADDR } from "../src/vendor/cairnx-spv.js";
import { proposeTx, attestTx, world, source, pick, addrFromPriv, ctxid, rpcTxToTx, signSighash, buildScriptSig, vSighash } from "./_spvrig.ts";

const { check, done } = checker("offer-id lane: a partial offer's running state from its proven fills:");
const keyS = "0x" + "51".repeat(32), keyA = "0x" + "52".repeat(32), keyX = "0x" + "53".repeat(32);
const S = addrFromPriv(keyS).toLowerCase(), A = addrFromPriv(keyA).toLowerCase();
const idOf = (t) => ctxid(rpcTxToTx(t)).toLowerCase();
const h0 = V29_HEIGHT + 30_000;
const W = 100_000_000n, MIN = 10_000_000n;
const off = proposeTx({ ...pick(offer({ give: { ticker: "NEWF", amount: "100" }, want: { value: W.toString() }, min: MIN.toString(), taker: A })), priv: keyS, expiresEpoch: 9e9 });
const other = proposeTx({ ...pick(offer({ give: { ticker: "NEWF", amount: "100" }, want: { value: W.toString() }, min: MIN.toString(), taker: A })), priv: keyS, expiresEpoch: 9e9 + 1 });
const oid = idOf(off), otherId = idOf(other);
const fee = (x) => Number(tradeFee(x, feeBpsAt(h0)));
const fill = (x, proposalId = oid) => attestTx({ proposalId, score: 100, confidence: 0, priv: keyA, outputs: [{ to: S, value: Number(x) }, { to: TREASURY_ADDR, value: fee(x) }] });
const f1 = fill(30_000_000n), f2 = fill(20_000_000n), fOther = fill(30_000_000n, otherId);
// a scriptSig swapped for a foreign valid signature over the same sighash: same txid, author no longer the coin owner
const swapped = (() => { const t = JSON.parse(JSON.stringify(f2)); const sg = signSighash(vSighash(rpcTxToTx(t)), keyX); t.inputs[0].script_sig = buildScriptSig(sg.sig64, sg.pub33); return t; })();
const placed = [{ height: h0, tx: off }, { height: h0, tx: other }, { height: h0 + 2, tx: f1 }, { height: h0 + 4, tx: f2 }, { height: h0 + 5, tx: fOther }];
const w = world(placed);
const swappedWorld = world([{ height: h0, tx: off }, { height: h0 + 2, tx: f1 }, { height: h0 + 4, tx: swapped }]);
const TIP = h0 + 10;
function run(blocks, fills) {
  const base = source(blocks, TIP);
  let reads = 0;
  const spv = { ...base, async blockAt(h) { reads++; return base.blockAt(h); } };
  return provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: spv, offerId: oid, offerHeight: h0, ...(fills ? { fills } : {}) }).then((r) => ({ r, reads }));
}
const entry = (t, h) => ({ txid: idOf(t), height: h });

let { r, reads } = await run(w.blocks, undefined);
check(`a whole offer (no fills asked): the offer proves with one block read and carries no progress (${reads})`, r && r.seller === S && !("progress" in r) && reads === 1);
({ r, reads } = await run(w.blocks, []));
check(`no listed fill: paid 0, delivered 0, still one block read (${JSON.stringify(r?.progress)}, ${reads})`, r?.progress?.paid === "0" && r?.progress?.delivered === "0" && reads === 1);
({ r, reads } = await run(w.blocks, [entry(f1, h0 + 2)]));
check(`one listed fill: paid 30,000,000, delivered 30, one more block read (${JSON.stringify(r?.progress)}, ${reads})`, r?.progress?.paid === "30000000" && r?.progress?.delivered === "30" && reads === 2);
({ r, reads } = await run(w.blocks, [entry(f1, h0 + 2), entry(f2, h0 + 4)]));
check(`two listed fills: paid 50,000,000, delivered 50, two more block reads (${JSON.stringify(r?.progress)}, ${reads})`, r?.progress?.paid === "50000000" && r?.progress?.delivered === "50" && reads === 3);
({ r } = await run(w.blocks, [entry(f1, h0 + 4)]));   // block h0+4 holds f2, not f1
check(`a listed fill not in the block it is listed at: unproven (${JSON.stringify(r?.progress)})`, typeof r?.progress?.unproven === "string" && /not in block/.test(r.progress.unproven));
({ r } = await run(w.blocks, [entry(fOther, h0 + 5)]));
check(`a listed fill of another offer: unproven (${JSON.stringify(r?.progress)})`, typeof r?.progress?.unproven === "string" && /not a fill of this offer/.test(r.progress.unproven));
({ r } = await run(swappedWorld.blocks, [entry(f1, h0 + 2), entry(swapped, h0 + 4)]));
check(`a listed fill whose signature is not the coin owner's: unproven (${JSON.stringify(r?.progress)})`, typeof r?.progress?.unproven === "string" && /could not be bound/.test(r.progress.unproven));

done("fill-offer-progress");
