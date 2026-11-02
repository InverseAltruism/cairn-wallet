// The offer-id CSD lane sizes a partial fill against the running state the chain proves, not the served one
// (NEWF4's cases for M1-V5-01). A taker-bound partial CSD offer (give 100 NEWF, want 1 CSD, min 0.1 CSD, taker = this
// wallet's account). The real Wallet.fillOffer; the one seam is provenPaytoForTest, which answers as provenOfferPayto
// does: the proven offer terms and, for the fills the served offer lists, the running state the vendored resolver
// replays from the chain's events (test/fill-offer-progress.test.mjs proves that part over real signed blocks).
//   A. the account's own earlier fill is on chain but not indexed yet (served paid 0): a retryable refusal, where the
//      wallet signed "buy the rest" and the resolver kept the 30,450,000 surplus; after OWN_FILL_INDEX_WAIT_MS the own
//      history no longer refuses (the availability valve, run last);
//   B. indexed: buying exactly what is left signs, and the proof was asked for the one listed fill;
//   C. outputs sized past what is left refuse (the resolver would clamp them and keep the surplus);
//   D. a fee leg one unit short still refuses;
//   E. a served state ahead of the chain (a listed fill that does not prove, or a paid its fills do not reach) refuses;
//   F. the first fill of a fresh partial offer signs with no fill to prove; G. a whole offer asks for no fills.
// Run: npx tsx test/fill-taker-partial.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { OWN_FILL_INDEX_WAIT_MS } from "../src/core/history.js";
import { mkCoin, txReply } from "./_coin.js";
import { resolve, offer as offerRecord, deploy, mint, parseRecord, provenOfferTerms, requiredFillOutputs, tradeFee, epochOf, TREASURY_ADDR, FEE_BPS_V16, V29_HEIGHT, DEPLOY_FEE } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("offer-id lane: a partial fill is sized against its proven running state:");
let nextId = 1;
const nid = () => "0x" + (0xf4000 + nextId++).toString(16).padStart(64, "0");
const prop = (who, rec, h, paidTo = {}) => ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: 1, expiresEpoch: epochOf(h) + 50_000, paidTo });
const att = (who, proposalId, h, paidTo, txid = nid()) => ({ kind: "attest", txid, proposalId, attester: who, score: 100, confidence: 0, height: h, pos: 1, paidTo });
const T = TREASURY_ADDR.toLowerCase();
const S = "0x" + "5e".repeat(20);
const W = 100_000_000n, MIN = 10_000_000n, GIVE = 100n;

const w = new Wallet(memoryStore());
const { addr } = await w.create("taker-partial-pw-123");
const A = String(addr).toLowerCase();
const h0 = V29_HEIGHT + 30_000;
const tipNow = h0 + 6;
const dep = prop(S, deploy({ ticker: "NEWF", decimals: 0, supply: GIVE.toString(), mint: "issuer" }), h0, { [T]: String(DEPLOY_FEE) });
const mnt = prop(S, mint({ ticker: "NEWF", amount: GIVE.toString() }), h0 + 1);
const off = prop(S, offerRecord({ give: { ticker: "NEWF", amount: GIVE.toString() }, want: { value: W.toString() }, min: MIN.toString(), taker: A }), h0 + 2);
const whole = prop(S, offerRecord({ give: { ticker: "NEWF", amount: "1" }, want: { value: W.toString() }, taker: A }), h0 + 2);
const stateOf = (o, extra = []) => resolve([dep, mnt, o, ...extra], tipNow).offers[o.id];

// The chain's events for the proof seam; it replays only the fills the served offer lists, as provenOfferPayto does.
let chain = [];
const seen = [];
w.provenPaytoForTest = (offerId, offerHeight, fills) => {
  seen.push(fills === undefined ? null : fills.map((f) => f.txid));
  const o = [off, whole].find((x) => x.id === offerId);
  const base = { payto: S, seller: S, terms: provenOfferTerms(parseRecord(o.uri, o.payloadHash), o.height), expiresEpoch: o.expiresEpoch, height: o.height };
  if (fills === undefined) return base;
  const evs = [];
  for (const f of fills) {
    const ev = chain.find((e) => e.kind === "attest" && e.txid === String(f.txid).toLowerCase());
    if (!ev) return { ...base, progress: { kind: "missing", unproven: `listed fill ${f.txid.slice(0, 12)}… is not in block ${f.height}` } };
    if (ev.proposalId !== o.id) return { ...base, progress: { kind: "not-this-offer", unproven: `listed fill ${f.txid.slice(0, 12)}… is not a fill of this offer` } };
    evs.push(ev);
  }
  const st = stateOf(o, evs);
  return { ...base, progress: { paid: st.paid ?? "0", delivered: st.delivered ?? "0" } };
};
const coin = mkCoin(500_000_000);
let served = null;
const submits = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: tipNow }) };
  if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(served)) };
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
const outsOf = (o, pay) => requiredFillOutputs(o, pay).map(({ to, value }) => ({ to, value: Number(value) }));
const fillWith = async (o, outputs) => { const before = submits.length; const r = await w.fillOffer({ proposalId: o.id, outputs }); return { r, submitted: submits.length - before }; };

// F. the first fill of the fresh offer (30%): no fill listed, none to prove; it signs and is in the history.
served = stateOf(off);
let { r, submitted } = await fillWith(off, outsOf(served, 30_000_000n));
check(`F. the first fill of a fresh partial offer signs (${r?.ok}, ${submitted} submit), with no fill to prove (${JSON.stringify(seen.at(-1))})`, r?.ok === true && submitted === 1 && JSON.stringify(seen.at(-1)) === "[]");
const t1 = String((await w.history()).find((e) => e.type === "fillOffer")?.txid ?? "").toLowerCase();
const fill1 = att(A, off.id, h0 + 4, { [S]: "30000000", [T]: tradeFee(30_000_000n, FEE_BPS_V16).toString() }, t1);
chain = [fill1];
const stale = stateOf(off);                 // the resolver one block behind fill 1
const honest = stateOf(off, [fill1]);       // indexed
check("setup: fill 1 is on chain (paid 30,000,000), the stale served state says 0", honest.paid === "30000000" && stale.paid === "0" && /^0x[0-9a-f]{64}$/.test(t1));

served = stale;
let proofs = seen.length;
({ r, submitted } = await fillWith(off, outsOf(stale, W)));
check(`A. own fill not indexed yet: a retryable refusal, nothing sent (${r?.code}: ${r?.error})`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE" && /is not listed as applied by the offer service yet/.test(String(r?.error)) && submitted === 0);
check(`A. ...decided from the local history before any proof read (${seen.length - proofs} proof calls)`, seen.length === proofs);

served = honest;
({ r, submitted } = await fillWith(off, outsOf(stale, W)));
check(`C. outputs sized past what is left refuse (${r?.code}: ${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /more than this offer has left/.test(String(r?.error)) && submitted === 0);
const short = outsOf(honest, W - 30_000_000n).map((o) => (o.to === T ? { ...o, value: o.value - 1 } : o));
({ r, submitted } = await fillWith(off, short));
check(`D. a fee leg one unit short refuses (${r?.code})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /underpaid/.test(String(r?.error)) && submitted === 0);

const ghost = "0x" + "9e".repeat(32);
served = { ...honest, paid: "60000000", delivered: "60", fills: [...honest.fills, { buyer: A, txid: ghost, height: h0 + 5, paid: "30000000", fee: "450000" }] };
({ r, submitted } = await fillWith(off, outsOf(served, W - 60_000_000n)));
check(`E. a listed fill not in the block it is listed at refuses retryably: an honest reorg can move it before the service re-reads (${r?.code}: ${r?.error})`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE" && /couldn't find this offer's earlier fill/.test(String(r?.error)) && submitted === 0);
const foreignFill = att(A, whole.id, h0 + 5, { [S]: "30000000", [T]: "450000" });
chain = [fill1, foreignFill];
served = { ...honest, paid: "60000000", delivered: "60", fills: [...honest.fills, { buyer: A, txid: foreignFill.txid, height: h0 + 5, paid: "30000000", fee: "450000" }] };
({ r, submitted } = await fillWith(off, outsOf(served, W - 60_000_000n)));
check(`E. a listed fill that is another offer's refuses as unsafe (${r?.code}: ${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /fill list for this offer does not match the chain/.test(String(r?.error)) && submitted === 0);
chain = [fill1];
served = { ...honest, paid: "60000000", delivered: "60" };
({ r, submitted } = await fillWith(off, outsOf(served, W - 60_000_000n)));
check(`E. a served paid its proven fills do not reach refuses (${r?.code}: ${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE" && /does not match its proven fills/.test(String(r?.error)) && submitted === 0);

// B after C to E (it signs, and its own fill is then unindexed for the rest of this file).
served = honest;
({ r, submitted } = await fillWith(off, outsOf(honest, W - 30_000_000n)));
check(`B. indexed: exactly what is left signs (${r?.ok}, ${submitted} submit), the proof asked for the one listed fill (${JSON.stringify(seen.at(-1))})`, r?.ok === true && submitted === 1 && JSON.stringify(seen.at(-1)) === JSON.stringify([t1]));
// The fill B signed is not listed yet; with fill 1 listed, refusing must not first bind fill 1's block (k-1 reads).
proofs = seen.length;
({ r, submitted } = await fillWith(off, outsOf(honest, 10_000_000n)));
check(`A. a later own fill not yet listed beside a listed one refuses before the listed fill is proven (${r?.code}, ${seen.length - proofs} proof calls)`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE" && seen.length === proofs && submitted === 0);

served = stateOf(whole);
({ r, submitted } = await fillWith(whole, outsOf(served, W)));
check(`G. a whole taker-bound offer signs as before and asks for no fills (${r?.ok}, ${JSON.stringify(seen.at(-1))})`, r?.ok === true && submitted === 1 && seen.at(-1) === null);

// A, last (it signs a fill of its own): past OWN_FILL_INDEX_WAIT_MS an unlisted own fill no longer refuses, so a fill
// that never landed cannot block the offer for good; the served state then sizes the fill, as before this check.
served = stale;
const realNow = Date.now;
Date.now = () => realNow() + OWN_FILL_INDEX_WAIT_MS + 60_000;
({ r, submitted } = await fillWith(off, outsOf(stale, W)));
Date.now = realNow;
check(`A. after the wait the own history no longer refuses (the valve) (${r?.ok})`, r?.ok === true && submitted === 1);

done("fill-taker-partial");
