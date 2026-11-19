// The offer-id CSD lane binds the served offer terms to the merkle-proven offer (fillpreflight.ts csdLanePreflight, its
// provenTermsMismatch call). On this lane nothing else checks them: the need-map is computed from the served offer, so
// a served fee rate of 0 asks for no protocol-fee output, and a served give is what the card shows. The real
// Wallet.fillOffer on a taker-bound whole offer; the one seam is provenPaytoForTest, which answers as provenOfferPayto
// does with the proven terms of the offer's record.
//   1. A served fee rate, give amount, give ticker or want value that differs from the record refuses FILL_UNSAFE with
//      the terms-bind text and nothing submitted, though the outputs pay everything the served offer asks.
//   2. Paired: the honest served offer signs.
//   RED-FIRST: make the call `if (false)` and every row of 1 signs (the fee-rate row with no protocol-fee output, which
//   the chain needs: the audit's demonstration of 2026-11-19); before this file one assertion turned red under that
//   mutation, by its code only.
// Run: npx tsx test/fill-offerid-terms-bind.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";
import { PRIV } from "./helpers/fillworld.mjs";
import { resolve, offer as offerRecord, deploy, mint, parseRecord, provenOfferTerms, requiredFillOutputs, epochOf, TREASURY_ADDR, V29_HEIGHT, DEPLOY_FEE } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("offer-id CSD lane: the served terms are bound to the proven offer:");
const T = TREASURY_ADDR.toLowerCase(), S = "0x" + "5e".repeat(20), W = 100_000_000n;
let n = 1;
const nid = () => "0x" + (0xb8000 + n++).toString(16).padStart(64, "0");
const prop = (who, rec, h, paidTo = {}) => ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: 1, expiresEpoch: epochOf(h) + 50_000, paidTo });

const w = new Wallet(memoryStore());
const { addr } = await w.importKey(PRIV, "pw-offerid-terms");
const A = String(addr).toLowerCase();
const h0 = V29_HEIGHT + 30_000, tipNow = h0 + 6;
const dep = prop(S, deploy({ ticker: "NEWF", decimals: 0, supply: "100", mint: "issuer" }), h0, { [T]: String(DEPLOY_FEE) });
const mnt = prop(S, mint({ ticker: "NEWF", amount: "100" }), h0 + 1);
const offers = new Map();
w.provenPaytoForTest = (offerId) => {
  const o = offers.get(offerId);
  return { payto: S, seller: S, terms: provenOfferTerms(parseRecord(o.uri, o.payloadHash), o.height), expiresEpoch: o.expiresEpoch, height: o.height };
};
const newOffer = () => { const o = prop(S, offerRecord({ give: { ticker: "NEWF", amount: "1" }, want: { value: W.toString() }, taker: A }), h0 + 2); offers.set(o.id, o); return o; };
const coin = mkCoin(500_000_000);
let served = null;
const submits = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: tipNow }) };
  if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(served)) };
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
const BIND = /the offer's fee\/rebate terms do not match its on-chain record/;

// 1. Each lie on its own offer (a refused fill records nothing, so the rows are independent).
for (const [field, patch] of [
  ["feeBps 0 (proven 150)", (o) => ({ ...o, feeBps: 0 })],
  ["give.amount 2 (proven 1)", (o) => ({ ...o, give: { ...o.give, amount: "2" } })],
  ["give.ticker OTHR (proven NEWF)", (o) => ({ ...o, give: { ...o.give, ticker: "OTHR" } })],
  ["want.value doubled", (o) => ({ ...o, want: { ...o.want, value: (W * 2n).toString() } })],
]) {
  const o = newOffer();
  served = patch(resolve([dep, mnt, o], tipNow).offers[o.id]);
  const outs = requiredFillOutputs(served, BigInt(served.want.value)).map(({ to, value }) => ({ to, value: Number(value) }));
  const s0 = submits.length;
  const r = await w.fillOffer({ proposalId: o.id, outputs: outs });
  check(`1. served ${field}: refused FILL_UNSAFE by the terms bind, nothing submitted (${r?.code}: ${String(r?.error).slice(0, 80)})`, r?.ok === false && r?.code === "FILL_UNSAFE" && BIND.test(String(r?.error)) && submits.length === s0);
}

// 2. Paired: the honest served offer signs, paying the protocol fee the record asks for.
{
  const o = newOffer();
  served = resolve([dep, mnt, o], tipNow).offers[o.id];
  const outs = requiredFillOutputs(served, W).map(({ to, value }) => ({ to, value: Number(value) }));
  const s0 = submits.length;
  const r = await w.fillOffer({ proposalId: o.id, outputs: outs });
  check(`2. honest: the served offer equal to its record signs (${r?.ok}${r?.error ? `: ${r.error}` : ""}), with a protocol-fee output (${outs.some((x) => x.to === T)})`, r?.ok === true && submits.length === s0 + 1 && outs.some((x) => x.to === T));
}
done("fill-offerid-terms-bind");
