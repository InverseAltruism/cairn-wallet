// provenOfferPayto with `fills` proves a partial offer's running state on the offer-id lane: the offer record and each
// fill the offer service lists are merkle-proven at their heights and bound to the coins their signers spent, then
// replayed through the vendored resolver over the proven offer. Real signed txs in synthetic PoW-verified blocks
// (test/_spvrig.ts). Cost: one block bind per listed fill's block beside the offer's, counted here.
//   - no listed fill: paid 0, and no read beyond the offer's block;
//   - one or two listed fills: their paid and delivered, one more block read each;
//   - a listed fill that is not in its block (kind "missing": an honest reorg can do that), is another offer's
//     ("not-this-offer") or does not bind to its coin ("unbound"): unproven;
//   - without `fills` (a whole offer) nothing changes: no progress, the offer's block only;
//   - through the real Wallet.fillOffer: a listed fill whose spent coin cannot be read is missing evidence, a
//     retryable VERIFY_UNAVAILABLE, and the retry signs; a listed fill not signed by its coin's owner is FILL_UNSAFE.
// Run: npx tsx test/fill-offer-progress.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { provenOfferPayto } from "../src/core/fillspv.js";
import { toChainEvent } from "../src/core/spvbind.js";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";
import { offer, deploy, mint, resolve, requiredFillOutputs, tradeFee, feeBpsAt, epochOf, V29_HEIGHT, TREASURY_ADDR, DEPLOY_FEE } from "../src/vendor/cairnx-spv.js";
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
check(`a listed fill not in the block it is listed at: unproven (${JSON.stringify(r?.progress)})`, r?.progress?.kind === "missing" && typeof r?.progress?.unproven === "string" && /not in block/.test(r.progress.unproven));
({ r } = await run(w.blocks, [entry(fOther, h0 + 5)]));
check(`a listed fill of another offer: unproven (${JSON.stringify(r?.progress)})`, r?.progress?.kind === "not-this-offer" && typeof r?.progress?.unproven === "string" && /not a fill of this offer/.test(r.progress.unproven));
({ r } = await run(swappedWorld.blocks, [entry(f1, h0 + 2), entry(swapped, h0 + 4)]));
check(`a listed fill whose signature is not the coin owner's: unproven (${JSON.stringify(r?.progress)})`, r?.progress?.kind === "unbound" && typeof r?.progress?.unproven === "string" && /could not be bound/.test(r.progress.unproven));

// ── Through the real Wallet.fillOffer and provenOfferPayto, the account being A (the offer's taker). The offer service
// lists A's earlier fill f1 honestly; the wallet buys what is left. ──
{
  const T = TREASURY_ADDR.toLowerCase();
  const synth = (rec, h, paidTo = {}) => ({ kind: "propose", id: "0x" + (0xd0000 + h).toString(16).padStart(64, "0"), proposer: S, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: 0, expiresEpoch: epochOf(h) + 50_000, paidTo });
  const backing = [synth(deploy({ ticker: "NEWF", decimals: 0, supply: "100", mint: "issuer" }), h0 - 2, { [T]: String(DEPLOY_FEE) }), synth(mint({ ticker: "NEWF", amount: "100" }), h0 - 1)];
  // The offer service's state: the resolver over the backing and the placed records, as its scanner reads them.
  const servedOf = (wd, pl, signers) => {
    const evs = pl.map((p, i) => { const t = rpcTxToTx(p.tx); return toChainEvent(t, ctxid(t), p.height, wd.hints[i].pos, signers[i]); });
    return resolve([...backing, ...evs], TIP).offers[oid];
  };
  const coin = mkCoin(500_000_000);
  let served = null;
  const submits = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: TIP }) };
    if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(served)) };
    return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  const walletA = async (blocks, failOnce) => {
    const wal = new Wallet(memoryStore());
    const { addr } = await wal.importKey(keyA, "fill-progress-pw-123");
    const base = source(blocks, TIP);
    // the read of each coin in `failOnce` fails the first time (a timeout, a node without the old tx), as the live
    // reader's null does
    wal.nameSpvForTest = { ...base, async prevoutScriptPubkey(t, v) { return failOnce.delete(String(t).toLowerCase()) ? null : base.prevoutScriptPubkey(t, v); } };
    return { wal, addr: String(addr).toLowerCase() };
  };
  const buyRest = async (wal) => {
    const before = submits.length;
    const outputs = requiredFillOutputs(served, W - BigInt(served.paid)).map(({ to, value }) => ({ to, value: Number(value) }));
    const r = await wal.fillOffer({ proposalId: oid, outputs });
    return { r, submitted: submits.length - before };
  };
  try {
    const pl = [{ height: h0, tx: off }, { height: h0 + 2, tx: f1 }];
    const wd = world(pl);
    served = servedOf(wd, pl, [S, A]);
    const { wal, addr } = await walletA(wd.blocks, new Set([String(f1.inputs[0].prev_txid).toLowerCase()]));
    check(`setup: the account is the taker, the service lists f1 and 70,000,000 left (${addr === A}, ${served?.fills?.length}, paid ${served?.paid})`, addr === A && served?.fills?.length === 1 && served?.paid === "30000000");
    let { r, submitted } = await buyRest(wal);
    check(`the coin an authentic listed fill spends cannot be read: retryable, nothing sent (${r?.code}: ${r?.error})`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE" && submitted === 0);
    ({ r, submitted } = await buyRest(wal));
    check(`the retry with the read working signs what is left (${r?.ok} ${r?.code ?? ""}, ${submitted} submit)`, r?.ok === true && submitted === 1);
    const plX = [{ height: h0, tx: off }, { height: h0 + 2, tx: f1 }, { height: h0 + 4, tx: swapped }];
    const wdX = world(plX);
    served = servedOf(wdX, plX, [S, A, A]);
    const { wal: walX } = await walletA(wdX.blocks, new Set());
    ({ r, submitted } = await buyRest(walX));
    check(`a listed fill not signed by its coin's owner still refuses as unsafe (${r?.code}: ${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /fill list for this offer does not match the chain/.test(String(r?.error)) && submitted === 0);
  } finally { globalThis.fetch = origFetch; }
}

done("fill-offer-progress");
