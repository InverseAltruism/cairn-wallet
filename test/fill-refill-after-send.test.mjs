// A fill asked again after the first was sent does not pay twice. Once a fill is sent its request's FILL_IN_PROGRESS
// hold ends, and until the first fill was mined (the reservation lane's block scan then proves it) or listed by the
// offer service (offer-id lane), the same request passed every other preflight check and was signed again from other
// coins: two payments, and the resolver keeps the second (a whole offer delivers once; a partial one is sized on what
// was left before the first). The wallet already has the first fill in its history, so the rule the owner set for partial offers
// on 2026-11-02 now covers these cases too: a refusal (FILL_ALREADY_SENT) while a fill of the same target from
// the last OWN_FILL_INDEX_WAIT_MS, not marked gone, is not seen applied. The real Wallet.fillOffer throughout; coins are
// served as the proxy's mempool-filtered /utxos?available=true serves them (a submitted transaction's coin drops out).
//   1. Offer-id CSD lane, a whole taker-bound offer: the second fill is refused, decided from the local history before
//      any proof read; a partial offer keeps its own copy (the contrast).
//   2. Reservation (fclaim) lane, two coins: the second fill is refused and no second transaction exists; the cross-
//      review found the one-coin run signed the same transaction twice, which shows no second payment.
//   3. The limits, each executed: a first fill makes the fetches it made at d562218 and signs the bytes it signed there;
//      the history read makes no fetch; a fill marked gone lets the next one sign; a fill older than the wait signs,
//      one just inside it is refused; a second reservation-lane partial fill after the first is mined signs, sized by
//      the replay (sized on the old state it is refused FILL_UNSAFE by the scan's sums bind); the token lane does not
//      consult the history and signs a second fill as before (accepted: a repeated token fill costs its network fee).
//   4. Through the real background: the second request queues (the hold ended with the first's answer), and after
//      approval the page gets the nested FILL_ALREADY_SENT and the window the text that says what to do.
//   5. A fill whose submit answer was lost (a maybe row) may be sent again as the same transaction, decided on the
//      assembled transaction; any other is refused at signing. A first submit that never reached the node leaves its
//      coin free, so the retry builds the same transaction, which is signed and sent (the node then holds one, and the
//      one history row loses its maybe mark), in both lanes and for a partial offer; one with another fee is refused. A
//      first submit the node took, whose answer was lost, leaves its coin spent, so the retry would spend the other
//      coin: refused, and the row keeps its maybe mark. A re-send of a transaction the node holds (a coin index that
//      still serves the coin) is answered SUBMIT_DUPLICATE with one row, its maybe mark cleared. Lost twice, the row
//      stays one and maybe until a definitive answer. A fill the node accepted allows nothing: refused at once.
//   6. The window counts from the last send of the transaction: a lost submit retried at minute 29 (accepted, lost
//      again, or answered SUBMIT_DUPLICATE) still refuses another fill at minute 31 and lets one sign past the wait
//      after the retry; so does a retry whose history write failed (its parked row is read folded into the stored one)
//      and a re-send of an accepted fill answered SUBMIT_DUPLICATE; a fill with no retry counts from its ts; the
//      history row keeps its ts and place.
//   RED-FIRST: on d562218 the second fill signs in 1 and 2 (two submits each, two distinct transactions in 2), and 4
//   reads ok with a second txid. Make repeatedFillRefusal answer null and 1, 2 and 4 fail; keep the history check for
//   partial offers only (the old rule) and 1 fails; drop the fclaim lane's call and 2 and 4 fail; treat every recent
//   fill as unseen on the fclaim lane and the mined case of 3 fails. On 8b534c5 every retry of 5 that signs is refused
//   "is still confirming", while the node holds no transaction in the lost cases; let repeatedFillRefusal ignore the
//   txid and those fail the same way; let it allow any txid and the taken-then-lost case of 5 signs a second payment;
//   let it allow the same txid of an accepted fill and the last case of 5 re-sends it.
// Run: npx tsx test/fill-refill-after-send.test.mjs   (offline)
import { createHash } from "node:crypto";
import { checker } from "./helpers/check.mjs";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { histKey, OWN_FILL_INDEX_WAIT_MS, TxHistory } from "../src/core/history.js";
import { repeatedFillRefusal } from "../src/core/fillpreflight.js";
import { mkCoin, txReply } from "./_coin.js";
import {
  resolve, offer as offerRecord, deploy, mint, fclaim, parseRecord, provenOfferTerms, requiredFillOutputs, requiredClaimDepth,
  epochOf, TREASURY_ADDR, V29_HEIGHT, DEPLOY_FEE, SCORE_FILL,
} from "../src/vendor/cairnx-spv.js";
import { PRIV, eventMaker, S as SELLER_F, recordAnswer, body } from "./helpers/fillworld.mjs";

const { check, done } = checker("a fill asked again after the first was sent does not pay twice:");
const T = TREASURY_ADDR.toLowerCase();
const digest = (x) => createHash("sha256").update(JSON.stringify(x ?? null)).digest("hex");
const WAIT_MIN = OWN_FILL_INDEX_WAIT_MS / 60_000;
const CONFIRMING = /your earlier fill of this offer \(0x[0-9a-f]{10}…\) was sent and is not confirmed yet, and another payment for it before then could lose some or all of what it pays/;
const AGAIN = "Try again once the earlier fill confirms";

// Coins as /utxos?available=true serves them: a coin a transaction the node took spends drops out (with `stale`, the
// index has not caught up and still serves it). `log` records each fetch as method and path with hex ids shortened, so a
// first fill's reads can be compared with d562218's. `mode(n)` answers the n-th submit: "ok", "lost" (a 502 from a
// node that never got it) or "ingested502" (the node took it, the answer was lost). A transaction the node already
// holds is answered 400 "already present", as the node answers it. `ingested` are the transactions the node holds.
// A submitted input (node JSON: prevout.txid as bytes) as "0x<txid>:<vout>", the key a served coin has.
const opOf = (i) => `0x${(i?.prevout?.txid ?? []).map((b) => Number(b).toString(16).padStart(2, "0")).join("")}:${i?.prevout?.vout}`;
function chainStub(coins, routes, opts = {}) {
  const spent = new Set();
  const st = { submits: [], log: [], ingested: [] };
  const norm = (u) => String(u).replace(/^https?:\/\/[^/]+/, (h) => (h.includes("clarvis") ? "clarvis:" : "")).replace(/0x[0-9a-fA-F]{40,64}/g, (h) => (h.length === 42 ? "<addr>" : "<id>"));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    st.log.push(norm(u));
    if (u.includes("/tx/submit")) {
      const tx = JSON.parse(init?.body ?? "{}").tx;
      st.submits.push(tx);
      if (st.ingested.includes(digest(tx))) return { ok: false, status: 400, json: async () => ({ ok: false, err: "already present or mempool conflict" }) };
      const mode = opts.mode?.(st.submits.length) ?? "ok";
      if (mode === "lost") return { ok: false, status: 502, json: async () => ({ error: "node unreachable" }) };
      for (const i of tx?.inputs ?? []) spent.add(opOf(i));
      st.ingested.push(digest(tx));
      if (mode === "ingested502") return { ok: false, status: 502, json: async () => ({ error: "node unreachable" }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (/\/utxos\//.test(u)) {
      const live = coins.filter((c) => opts.stale || !spent.has(`${String(c.coin.txid).toLowerCase()}:${c.coin.vout}`)).map((c) => c.coin);
      return { ok: true, status: 200, json: async () => ({ confirmed_balance: live.reduce((a, c) => a + c.value, 0), utxos: live }) };
    }
    const routed = routes(u, init);
    if (routed) return routed;
    return txReply(u, coins) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  return st;
}
const inputsOf = (tx) => (tx?.inputs ?? []).map(opOf);
const ago = (ms) => Date.now() - ms;

// ── 1. Offer-id CSD lane ───────────────────────────────────────────────────────────────────────────────
let n = 1;
const nid = () => "0x" + (0xa7000 + n++).toString(16).padStart(64, "0");
const prop = (who, rec, h, paidTo = {}) => ({ kind: "propose", id: nid(), proposer: who, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: 1, expiresEpoch: epochOf(h) + 50_000, paidTo });
const S = "0x" + "5e".repeat(20);
const W = 100_000_000n;
async function offerIdWorld(pw, opts) {
  const w = new Wallet(memoryStore());
  const { addr } = await w.importKey(PRIV, pw);
  const A = String(addr).toLowerCase();
  const h0 = V29_HEIGHT + 30_000, tipNow = h0 + 6;
  const dep = prop(S, deploy({ ticker: "NEWF", decimals: 0, supply: "1000", mint: "issuer" }), h0, { [T]: String(DEPLOY_FEE) });
  const mnt = prop(S, mint({ ticker: "NEWF", amount: "1000" }), h0 + 1);
  const mk = (rec) => prop(S, offerRecord({ ...rec, taker: A }), h0 + 2);
  const offers = new Map();
  const proofs = [];
  w.provenPaytoForTest = (offerId, _h, fills) => {
    proofs.push(offerId);
    const o = offers.get(offerId);
    const base = { payto: S, seller: S, terms: provenOfferTerms(parseRecord(o.uri, o.payloadHash), o.height), expiresEpoch: o.expiresEpoch, height: o.height };
    return fills === undefined ? base : { ...base, progress: { paid: "0", delivered: "0" } };
  };
  const newOffer = (rec) => { const o = mk(rec); offers.set(o.id, o); return o; };
  const stateOf = (o) => resolve([dep, mnt, o], tipNow).offers[o.id];
  const coins = [0, 1, 2, 3, 4].map((v) => mkCoin(300_000_000, v));
  let served = null;
  const st = chainStub(coins, (u) => {
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: tipNow }) };
    if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(served)) };
    return null;
  }, opts);
  const outsOf = (o, pay) => requiredFillOutputs(o, pay).map(({ to, value }) => ({ to, value: Number(value) }));
  return { w, A, st, proofs, newOffer, stateOf, outsOf, serve: (s) => { served = s; } };
}

const firstReads = {};
{
  const X = await offerIdWorld("refill-offerid-pw-1");
  const whole = X.newOffer({ give: { ticker: "NEWF", amount: "1" }, want: { value: W.toString() } });
  X.serve(X.stateOf(whole));   // the service has not indexed the first fill: the whole offer still reads open
  const outs = X.outsOf(X.stateOf(whole), W);
  const l0 = X.st.log.length;
  const r1 = await X.w.fillOffer({ proposalId: whole.id, outputs: outs });
  firstReads.offerId = { log: [...X.st.log.slice(l0)].sort(), tx: digest(X.st.submits.at(-1)) };
  const p0 = X.proofs.length;
  const r2 = await X.w.fillOffer({ proposalId: whole.id, outputs: outs });
  const rows = (await X.w.history()).filter((e) => e.type === "fillOffer" && String(e.target).toLowerCase() === whole.id);
  check(`1. whole offer: the first fill signs (${r1?.ok}, ${X.st.submits.length} submit)`, r1?.ok === true && X.st.submits.length === 1);
  check(`1. whole offer: the same fill again is refused (${r2?.code}), nothing submitted, one history row (${rows.length})`, r2?.ok === false && r2?.code === "FILL_ALREADY_SENT" && X.st.submits.length === 1 && rows.length === 1);
  check(`1. ...the copy says the earlier fill was sent and is not confirmed yet, and when to try again (${r2?.error})`, CONFIRMING.test(String(r2?.error)) && String(r2?.error).includes(AGAIN) && String(r2?.error).includes(`this lasts up to ${WAIT_MIN} minutes after it was sent`));
  check(`1. ...decided from the local history before any proof read (${X.proofs.length - p0} proof calls)`, X.proofs.length === p0);

  // The contrast: a partial offer keeps its copy (the amount listed as left may be too high).
  const part = X.newOffer({ give: { ticker: "NEWF", amount: "50" }, want: { value: W.toString() }, min: "10000000" });
  X.serve(X.stateOf(part));
  const q1 = await X.w.fillOffer({ proposalId: part.id, outputs: X.outsOf(X.stateOf(part), 30_000_000n) });
  const q2 = await X.w.fillOffer({ proposalId: part.id, outputs: X.outsOf(X.stateOf(part), 30_000_000n) });
  check(`1. a partial offer: the first fill signs and the second is refused with the partial copy (${q2?.code})`, q1?.ok === true && q2?.ok === false && q2?.code === "FILL_ALREADY_SENT" && /was sent and is not listed as applied by the offer service yet/.test(String(q2?.error)) && X.st.submits.length === 2);

  // 3. The history read itself makes no fetch.
  const f0 = X.st.log.length;
  const recent = await X.w.fillIo.recentOwnFills(whole.id, X.A);
  check(`3. the history read is local: ${recent.length} recent fill, ${X.st.log.length - f0} fetches`, recent.length === 1 && X.st.log.length === f0);

  // 3. Valves. The first fill marked gone (a different transaction spent its coins): the next fill signs.
  X.serve(X.stateOf(whole));
  await X.w.hist.annotate(histKey(X.w.addr()), r1.txid, { gone: true });
  const r3 = await X.w.fillOffer({ proposalId: whole.id, outputs: outs });
  check(`3. after the first fill is marked gone, the next one signs (${r3?.ok}${r3?.error ? `: ${r3.code} ${r3.error}` : ""}, ${X.st.submits.length} submits)`, r3?.ok === true && X.st.submits.length === 3);
  // That one is recent now; inside the wait it refuses, past the wait it signs.
  await X.w.hist.annotate(histKey(X.w.addr()), r3.txid, { ts: ago(OWN_FILL_INDEX_WAIT_MS - 60_000) });
  const r4 = await X.w.fillOffer({ proposalId: whole.id, outputs: outs });
  await X.w.hist.annotate(histKey(X.w.addr()), r3.txid, { ts: ago(OWN_FILL_INDEX_WAIT_MS + 1_000) });
  const r5 = await X.w.fillOffer({ proposalId: whole.id, outputs: outs });
  check(`3. a fill sent ${WAIT_MIN - 1} minutes ago still refuses (${r4?.code}); one sent past ${WAIT_MIN} minutes lets the next sign (${r5?.ok})`, r4?.ok === false && r4?.code === "FILL_ALREADY_SENT" && r5?.ok === true && X.st.submits.length === 4);
}

// ── 2. Reservation (fclaim) lane, two coins ─────────────────────────────────────────────────────────────
// A fillworld-shaped open offer and the buyer's reservation, whole or partial; `minedFills` are attests the synthetic
// scan proves (as liveFillSpvSource would once they are mined) and the served offer reflects.
function fclaimWorld(me, base, partial) {
  const { PE, AT, token } = eventMaker(base);
  const ev = token();
  const offerEv = PE(SELLER_F, offerRecord({ give: { ticker: "TOKA", amount: "1000" }, want: { value: String(1000e8) }, ...(partial ? { min: String(100e8) } : {}) }), 115010, epochOf(115010) + 200);
  ev.push(offerEv);
  const tip = 116520, fH = 116490;
  const fc = PE(me, fclaim({ offer: offerEv.id }), fH, epochOf(fH) + 2);
  const mined = [];
  const state = () => resolve([...ev, fc, ...mined], tip);
  const primary = () => ({ ...state().offers[offerEv.id], fclaimId: fc.id, fclaimHeight: fH, fclaimExpiresEpoch: fc.expiresEpoch });
  const rec = parseRecord(offerEv.uri, offerEv.payloadHash);
  const pool = () => new Map([...ev, fc, ...mined].map((e) => [(e.kind === "propose" ? e.id : e.txid).toLowerCase(), { ...e, depth: tip - e.height + 1 }]));
  const io = () => {
    const p = pool();
    return {
      myLiveHoldsAtGrant: 0, provenTerms: provenOfferTerms(rec, offerEv.height),
      async tip() { return tip; },
      async offerEventIds() { return [...p.keys()]; },
      async provenEvent(x) { return p.get(String(x).toLowerCase()) ?? null; },
    };
  };
  const need = requiredClaimDepth(BigInt(1000e8), offerEv.height).depth;
  // The buyer's sent fill, mined `need` blocks below the tip (buried as deep as the replay asks), as the scan proves it.
  const mine = (txid, outputs) => mined.push({ ...AT(me, fc.id, SCORE_FILL, tip - need + 1, Object.fromEntries(outputs.map((o) => [o.to, String(o.value)]))), txid: String(txid).toLowerCase() });
  const outsFor = (pay) => requiredFillOutputs(primary(), pay).map(({ to, value }) => ({ to, value: Number(value) }));
  const view = { offerId: offerEv.id, fc, tip, primary, truth: () => state().offers[offerEv.id], truthLog: () => state().events };
  return { ...view, io, mine, outsFor, mined };
}
// An honest clarvis on the same chain (fillworld's truthful): the offer as the chain has it, and its record of the fclaim.
function fclaimStub(world, coins, opts) {
  return chainStub(coins, (u) => {
    if (u.includes("clarvis")) return u.includes("/cairnx/record/") ? recordAnswer({ fc: world.fc, truthLog: world.truthLog() }, world.tip) : body(world.truth())();
    if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => world.primary() };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: world.tip }) };
    return null;
  }, opts);
}
async function fclaimWallet(pw, store = memoryStore()) {
  const w = new Wallet(store);
  const { addr } = await w.importKey(PRIV, pw);
  return { w, me: String(addr).toLowerCase() };
}
{
  const { w, me } = await fclaimWallet("pw-refill-fclaim-1");
  const world = fclaimWorld(me, 9000, false);
  w.fillSpvIoForTest = () => world.io();
  const coins = [mkCoin(2_000e8, 0), mkCoin(2_000e8, 1)];
  const st = fclaimStub(world, coins);
  const outs = world.outsFor(BigInt(1000e8));
  const l0 = st.log.length;
  const c1 = await w.fillOffer({ proposalId: world.fc.id, outputs: outs });
  firstReads.fclaim = { log: [...st.log.slice(l0)].sort(), tx: digest(st.submits.at(-1)) };
  const c2 = await w.fillOffer({ proposalId: world.fc.id, outputs: outs });
  check(`2. reservation lane: the first fill signs (${c1?.ok}, inputs ${JSON.stringify(inputsOf(st.submits[0]))})`, c1?.ok === true && st.submits.length === 1);
  check(`2. reservation lane: the same fill again, with another coin free to spend, is refused (${c2?.code}) and no second transaction exists (${st.submits.length} submit)`, c2?.ok === false && c2?.code === "FILL_ALREADY_SENT" && st.submits.length === 1);
  check(`2. ...the copy says the earlier fill was sent and is not confirmed yet (${c2?.error})`, CONFIRMING.test(String(c2?.error)));
  // 3. The first fill marked gone: the next signs, from the other coin.
  await w.hist.annotate(histKey(w.addr()), c1.txid, { gone: true });
  const c3 = await w.fillOffer({ proposalId: world.fc.id, outputs: outs });
  check(`3. reservation lane: after the first fill is marked gone, the next signs from the other coin (${c3?.ok}, inputs ${JSON.stringify(inputsOf(st.submits[1]))})`, c3?.ok === true && st.submits.length === 2 && inputsOf(st.submits[1])[0] !== inputsOf(st.submits[0])[0]);
  // 3. Past the wait: signs (a coin is free again once the stub forgets the spends: give it a third).
  coins.push(mkCoin(2_000e8, 2));
  await w.hist.annotate(histKey(w.addr()), c3.txid, { ts: ago(OWN_FILL_INDEX_WAIT_MS - 60_000) });
  const c4 = await w.fillOffer({ proposalId: world.fc.id, outputs: outs });
  await w.hist.annotate(histKey(w.addr()), c3.txid, { ts: ago(OWN_FILL_INDEX_WAIT_MS + 1_000) });
  const c5 = await w.fillOffer({ proposalId: world.fc.id, outputs: outs });
  check(`3. reservation lane: a fill sent ${WAIT_MIN - 1} minutes ago refuses (${c4?.code}); past ${WAIT_MIN} minutes the next signs (${c5?.ok})`, c4?.ok === false && c4?.code === "FILL_ALREADY_SENT" && c5?.ok === true && st.submits.length === 3);
}

// ── 3. A second reservation-lane partial fill after the first is mined ─────────────────────────────────
{
  const { w, me } = await fclaimWallet("pw-refill-fclaim-2");
  const world = fclaimWorld(me, 9100, true);
  w.fillSpvIoForTest = () => world.io();
  const coins = [mkCoin(2_000e8, 0), mkCoin(2_000e8, 1)];
  const st = fclaimStub(world, coins);
  const first = world.outsFor(BigInt(300e8));
  const p1 = await w.fillOffer({ proposalId: world.fc.id, outputs: first });
  const staleOuts = world.outsFor(BigInt(1000e8));   // "buy the rest", sized on the state before the first fill
  const p2 = await w.fillOffer({ proposalId: world.fc.id, outputs: staleOuts });
  check(`3. partial reservation: before the first fill is mined the second is refused (${p2?.code})`, p1?.ok === true && p2?.ok === false && p2?.code === "FILL_ALREADY_SENT" && st.submits.length === 1);
  world.mine(p1.txid, first);
  const truth = world.truth();
  const p3 = await w.fillOffer({ proposalId: world.fc.id, outputs: staleOuts.map((o) => ({ ...o })) });
  check(`3. partial reservation, first fill mined (paid ${truth.paid}): a second fill sized on the old state is refused by the scan's sums bind (${p3?.code})`, truth.paid === String(300e8) && p3?.ok === false && p3?.code === "FILL_UNSAFE" && /does not match the proven fill progress/.test(String(p3?.error)) && st.submits.length === 1);
  const fresh = world.outsFor(BigInt(700e8));        // "buy the rest", sized by the replay with the first fill applied
  const p4 = await w.fillOffer({ proposalId: world.fc.id, outputs: fresh });
  check(`3. partial reservation, first fill mined: the second fill sized by the replay signs (${p4?.ok}${p4?.error ? `: ${p4.error}` : ""}), paying the ${fresh.find((o) => o.to !== T)?.value} left`, p4?.ok === true && st.submits.length === 2 && fresh.some((o) => o.value === 700e8));
}

// ── 3. The token lane is unchanged: no history read, a second fill signs as before ──────────────────────
{
  const w = new Wallet(memoryStore());
  await w.create("refill-token-pw-1");
  const OID = "0x" + "7c".repeat(32), SELLER = "0x" + "cd".repeat(20);
  w.provenPaytoForTest = () => ({ payto: SELLER, seller: SELLER, expiresEpoch: 9e15, height: 47_000, terms: { height: 47_000, feeBps: 150, value: undefined, taker: undefined, bid: undefined, giveTicker: "AAA", giveAmount: "10", giveName: undefined, wantType: "token", wantTicker: "PAY", wantAmount: "7" } });
  const offer = { id: OID, seller: SELLER, give: { ticker: "AAA", amount: "10" }, want: { ticker: "PAY", amount: "7" }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150 };
  const st = chainStub([mkCoin(100_000_002, 0), mkCoin(100_000_002, 1)], (u) => {
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 50_000 }) };
    if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => offer };
    return null;
  });
  let historyReads = 0;
  const real = w.fillIo.recentOwnFills;
  w.fillIo.recentOwnFills = (...a) => { historyReads++; return real(...a); };
  const quote = { ticker: "PAY", amount: "7", fee: "1", total: "8", giveTicker: "AAA", giveAmount: "10" };
  const t1 = await w.fillOffer({ proposalId: OID, outputs: [], score: 100, confidence: 1_000_000, fee: 5_000_000, tokenQuote: quote });
  const t2 = await w.fillOffer({ proposalId: OID, outputs: [], score: 100, confidence: 1_000_000, fee: 5_000_000, tokenQuote: quote });
  check(`3. token lane: a second token fill after the first signs as before (${t1?.ok}, ${t2?.ok}, ${st.submits.length} submits), and the history is not read (${historyReads} reads)`, t1?.ok === true && t2?.ok === true && st.submits.length === 2 && historyReads === 0);
}

// ── 3. A first fill reads and signs what it did at d562218 ──────────────────────────────────────────────
// Captured by running this file's first fills at d562218 (src/ of origin/master before this change); REFILL_CAPTURE=1
// prints them again.
const BASE = {
  offerId: { log: "b789306c41c6b1a528ad5832cdade44064a41c5ae245d407f13bfdc8dca19204", tx: "bd4556079a1722ab9c107de192210d8df45d470d2dda2adeb010aff0118df3ca" },
  fclaim: { log: "299008e6a04cbd90ff63c5a74b94f6fe57bbdcb1184d99d52f28f77a222045cc", tx: "3a902ede523fc329efcc45ad91a943923f3a0a84588b6c5ae51ef755f24c7146" },
};
if (process.env.REFILL_CAPTURE) console.log("CAPTURE " + JSON.stringify(firstReads));
for (const lane of ["offerId", "fclaim"]) {
  check(`3. ${lane} lane: a first fill makes the fetches it made at d562218 (${firstReads[lane].log.length}: ${digest(firstReads[lane].log).slice(0, 12)})`, digest(firstReads[lane].log) === BASE[lane].log);
  check(`3. ${lane} lane: a first fill submits the transaction it submitted at d562218 (${firstReads[lane].tx.slice(0, 12)})`, firstReads[lane].tx === BASE[lane].tx);
}

// ── 4. Through the real background: what the page and the user are told ────────────────────────────────
{
  const mem = new Map();
  const ignore = () => undefined;
  const chrome = {
    runtime: { id: "cairnwallettestid", lastError: undefined, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { chrome.listener = fn; } }, onConnect: { addListener: ignore }, onInstalled: { addListener: ignore } },
    storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
    alarms: { create: ignore, onAlarm: { addListener: ignore } },
    action: { setBadgeText: ignore },
    windows: { create: (_o, cb) => cb?.({ id: 77 }), update: ignore, onRemoved: { addListener: ignore } },
  };
  globalThis.chrome = chrome;
  globalThis.__CAIRN_TEST__ = true;
  await import("../src/background.ts");
  const bg = globalThis.__cairnBgWallet;
  const page = { id: "cairnwallettestid", url: "chrome-extension://x/approve.html", tab: { id: 1 } };
  const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, page, res));
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const me = String((await popup("import", PRIV, "pw-refill-bg")).result.addr).toLowerCase();
  const world = fclaimWorld(me, 9200, false);
  bg.fillSpvIoForTest = () => world.io();
  const st = fclaimStub(world, [mkCoin(2_000e8, 0), mkCoin(2_000e8, 1)]);
  const params = { proposalId: world.fc.id, outputs: world.outsFor(BigInt(1000e8)), fee: 5_000_000 };
  const ask = () => { const out = { reply: undefined }; chrome.listener({ kind: "dapp", method: "fillOffer", params }, { origin: "https://dapp.example", url: "https://dapp.example/", tab: { id: 2 } }, (r) => { out.reply = r; }); return out; };
  const a = ask(); await settle();
  const qa = (await popup("pending")).result;
  const oa = (await popup("resolve", qa.at(-1)?.id, true, me)).result; await settle();
  check(`4. the first request is approved and signed; its page gets the txid (${a.reply?.result?.txid?.slice(0, 12)})`, oa?.ok === true && a.reply?.ok === true && /^0x[0-9a-f]{64}$/.test(String(a.reply?.result?.txid)) && st.submits.length === 1);
  const b = ask(); await settle();
  const qb = (await popup("pending")).result;
  check("4. the hold ended with the first answer: the second request queues", b.reply === undefined && qb.length === 1);
  const ob = (await popup("resolve", qb.at(-1)?.id, true, me)).result; await settle();
  check(`4. approved, the page gets the nested FILL_ALREADY_SENT (${JSON.stringify(b.reply?.result?.code)}) and nothing is sent (${st.submits.length} submit)`, b.reply?.ok === true && b.reply?.result?.ok === false && b.reply?.result?.code === "FILL_ALREADY_SENT" && st.submits.length === 1);
  check(`4. the window gets the code and the text that says what to do (${ob?.code}: ${ob?.error})`, ob?.ok === false && ob?.code === "FILL_ALREADY_SENT" && CONFIRMING.test(String(ob?.error)) && String(ob?.error).includes(AGAIN));
}

// ── 5. A lost submit's retry: the same transaction is sent again, another one is refused ────────────────
// The rule itself: allowed (null) only for the very transaction of an unseen fill whose submit answer was lost.
{
  const TX1 = "0x" + "ab".repeat(32), TX2 = "0x" + "cd".repeat(32);
  const lost = [{ txid: TX1, maybe: true }], sent = [{ txid: TX1, maybe: false }];
  for (const [label, unseen, txid, allowed] of [
    ["no unseen fill, any transaction", [], TX2, true],
    ["the lost fill's own transaction", lost, TX1, true],
    ["the lost fill's own transaction in another spelling", lost, TX1.slice(2).toUpperCase(), true],
    ["another transaction while a fill is lost", lost, TX2, false],
    ["no transaction assembled yet", lost, null, false],
    ["an accepted fill's own transaction", sent, TX1, false],
    ["the lost one of a lost and an accepted fill", [...sent.map((f) => ({ ...f, txid: TX2 })), ...lost], TX1, true],
  ]) {
    const r = repeatedFillRefusal(unseen, "confirming", txid);
    check(`5. the rule: ${label}: ${r === null ? "allowed" : r.code}`, allowed ? r === null : r?.code === "FILL_ALREADY_SENT");
  }
}
// `rows` are the account's fill rows of the target; `maybe` the rows still marked as possibly in flight.
const fillRows = async (w, target) => (await w.history()).filter((e) => e.type === "fillOffer" && String(e.target).toLowerCase() === String(target).toLowerCase());
const rowsText = (rows) => JSON.stringify(rows.map((e) => ({ txid: String(e.txid).slice(0, 10), maybe: !!e.maybe })));
async function fclaimRetry(pw, base, opts, store) {
  const { w, me } = await fclaimWallet(pw, store);
  const world = fclaimWorld(me, base, false);
  w.fillSpvIoForTest = () => world.io();
  const st = fclaimStub(world, [mkCoin(2_000e8, 0), mkCoin(2_000e8, 1)], opts);
  const outs = world.outsFor(BigInt(1000e8));
  const ask = (extra = {}) => w.fillOffer({ proposalId: world.fc.id, outputs: outs, ...extra });
  return { w, world, st, ask };
}
{
  // The first submit never reached the node: its coin is still free, so the retry selects it and builds the same
  // transaction. It is signed and sent; the node holds one; the one history row loses its maybe mark. A retry with
  // another fee, from the same coin, is another transaction and is refused at signing.
  const R = await fclaimRetry("pw-refill-lost-1", 9300, { mode: (n) => (n === 1 ? "lost" : "ok") });
  const r1 = await R.ask();
  const before = await fillRows(R.w, R.world.fc.id);
  const rFee = await R.ask({ fee: 6_000_000 });
  check(`5. reservation lane, the first submit lost (${r1?.code}, rows ${rowsText(before)}): a retry with another fee is refused (${rFee?.code}) with nothing sent (${R.st.submits.length} submit)`,
    r1?.code === "SUBMIT_MAYBE_INFLIGHT" && before.length === 1 && before[0].maybe === true && rFee?.ok === false && rFee?.code === "FILL_ALREADY_SENT" && CONFIRMING.test(String(rFee?.error)) && R.st.submits.length === 1);
  const r2 = await R.ask();
  const after = await fillRows(R.w, R.world.fc.id);
  check(`5. ...the same request again signs (${r2?.ok}${r2?.error ? `: ${r2.code} ${r2.error}` : ""}): the same transaction (txid ${String(r2?.txid).slice(0, 12)} = ${String(r1?.txid).slice(0, 12)}, identical bytes ${digest(R.st.submits[0]) === digest(R.st.submits[1])}), and the node holds ${R.st.ingested.length}`,
    r2?.ok === true && r2?.txid === r1?.txid && R.st.submits.length === 2 && digest(R.st.submits[0]) === digest(R.st.submits[1]) && R.st.ingested.length === 1);
  check(`5. ...one history row, its maybe mark cleared by the definitive answer (${rowsText(after)})`, after.length === 1 && after[0].txid === r1?.txid && !after[0].maybe);
  const r3 = await R.ask();
  check(`5. ...asked once more, now that the node accepted it, refused at once (${r3?.code}), nothing more sent (${R.st.submits.length})`, r3?.ok === false && r3?.code === "FILL_ALREADY_SENT" && R.st.submits.length === 2);
}
{
  // The first submit was taken by the node and its answer lost: its coin drops out, the retry would spend the other
  // coin, a second payment. Refused before signing.
  const R = await fclaimRetry("pw-refill-lost-2", 9400, { mode: (n) => (n === 1 ? "ingested502" : "ok") });
  const r1 = await R.ask();
  const r2 = await R.ask();
  const rows = await fillRows(R.w, R.world.fc.id);
  check(`5. reservation lane, the first submit taken and its answer lost (${r1?.code}), another coin free: the retry is refused (${r2?.code}) and nothing is signed (${R.st.submits.length} submit, the node holds ${R.st.ingested.length})`,
    r1?.code === "SUBMIT_MAYBE_INFLIGHT" && r2?.ok === false && r2?.code === "FILL_ALREADY_SENT" && R.st.submits.length === 1 && R.st.ingested.length === 1);
  check(`5. ...the copy states only what the wallet knows: sent, not confirmed, and this would be another transaction (${r2?.error})`, CONFIRMING.test(String(r2?.error)) && String(r2?.error).includes(AGAIN));
  check(`5. ...the row keeps its maybe mark (${rowsText(rows)})`, rows.length === 1 && rows[0].maybe === true);
}
{
  // The node took it, the answer was lost, and the coin index still serves the coin: the retry builds the same
  // transaction, which the node answers "already present". Nothing new is paid; the row loses its maybe mark.
  const R = await fclaimRetry("pw-refill-lost-3", 9500, { mode: (n) => (n === 1 ? "ingested502" : "ok"), stale: true });
  const r1 = await R.ask();
  const r2 = await R.ask();
  const rows = await fillRows(R.w, R.world.fc.id);
  check(`5. reservation lane, a re-send of a transaction the node holds: answered ${r2?.code} with its txid (${r2?.txid === r1?.txid}), the node holds ${R.st.ingested.length}`, r2?.ok === false && r2?.code === "SUBMIT_DUPLICATE" && r2?.txid === r1?.txid && R.st.submits.length === 2 && digest(R.st.submits[0]) === digest(R.st.submits[1]) && R.st.ingested.length === 1);
  check(`5. ...one row, maybe cleared (${rowsText(rows)})`, rows.length === 1 && rows[0].txid === r1?.txid && !rows[0].maybe);
}
{
  // Lost twice, then sent: one row throughout, marked maybe until the definitive answer.
  const R = await fclaimRetry("pw-refill-lost-4", 9600, { mode: (n) => (n <= 2 ? "lost" : "ok") });
  const r1 = await R.ask();
  const r2 = await R.ask();
  const mid = await fillRows(R.w, R.world.fc.id);
  const r3 = await R.ask();
  const end = await fillRows(R.w, R.world.fc.id);
  check(`5. reservation lane, lost twice (${r1?.code}, ${r2?.code}): one row still marked maybe (${rowsText(mid)}); the third try signs the same transaction (${r3?.ok}) and the row is cleared (${rowsText(end)})`,
    r1?.code === "SUBMIT_MAYBE_INFLIGHT" && r2?.code === "SUBMIT_MAYBE_INFLIGHT" && r2?.txid === r1?.txid && mid.length === 1 && mid[0].maybe === true
    && r3?.ok === true && r3?.txid === r1?.txid && end.length === 1 && !end[0].maybe && R.st.ingested.length === 1);
}
{
  // A fill the node accepted (definitive row) asked again while the coin index still serves its coin: the retry could
  // build the same transaction, but the node holds it, so the rule allows nothing and refuses in the preflight.
  const R = await fclaimRetry("pw-refill-lost-5", 9700, { stale: true });
  const r1 = await R.ask();
  const r2 = await R.ask();
  const rows = await fillRows(R.w, R.world.fc.id);
  check(`5. reservation lane, a fill the node accepted, asked again with its coin still served: refused (${r2?.code}), nothing re-sent (${R.st.submits.length} submit), one row, not marked maybe (${rowsText(rows)})`,
    r1?.ok === true && r2?.ok === false && r2?.code === "FILL_ALREADY_SENT" && R.st.submits.length === 1 && rows.length === 1 && !rows[0].maybe);
}
{
  // The offer-id lane, a whole and a partial offer: a lost submit's retry is the same transaction and is sent.
  const X = await offerIdWorld("refill-offerid-lost", { mode: (n) => (n === 1 || n === 3 ? "lost" : "ok") });
  const whole = X.newOffer({ give: { ticker: "NEWF", amount: "1" }, want: { value: W.toString() } });
  X.serve(X.stateOf(whole));
  const outs = X.outsOf(X.stateOf(whole), W);
  const a1 = await X.w.fillOffer({ proposalId: whole.id, outputs: outs });
  const a2 = await X.w.fillOffer({ proposalId: whole.id, outputs: outs });
  const rowsA = await fillRows(X.w, whole.id);
  check(`5. offer-id lane, whole offer, the first submit lost (${a1?.code}): the retry signs the same transaction (${a2?.ok}, ${a2?.txid === a1?.txid}), the node holds ${X.st.ingested.length}, one row cleared (${rowsText(rowsA)})`,
    a1?.code === "SUBMIT_MAYBE_INFLIGHT" && a2?.ok === true && a2?.txid === a1?.txid && X.st.ingested.length === 1 && rowsA.length === 1 && !rowsA[0].maybe);
  const part = X.newOffer({ give: { ticker: "NEWF", amount: "50" }, want: { value: W.toString() }, min: "10000000" });
  X.serve(X.stateOf(part));
  const pouts = X.outsOf(X.stateOf(part), 30_000_000n);
  const b1 = await X.w.fillOffer({ proposalId: part.id, outputs: pouts });
  const b2 = await X.w.fillOffer({ proposalId: part.id, outputs: pouts });
  const rowsB = await fillRows(X.w, part.id);
  check(`5. offer-id lane, partial offer, the first submit lost (${b1?.code}): the retry signs the same transaction (${b2?.ok}, ${b2?.txid === b1?.txid}), the node holds ${X.st.ingested.length}, one row cleared (${rowsText(rowsB)})`,
    b1?.code === "SUBMIT_MAYBE_INFLIGHT" && b2?.ok === true && b2?.txid === b1?.txid && X.st.ingested.length === 2 && rowsB.length === 1 && !rowsB[0].maybe);
}

// ── 6. The window counts from the last time the wallet sent the transaction ─────────────────────────────
// A first submit lost at minute 0 and retried at minute 29 puts the transaction in the mempool at minute 29; the row's
// `ts` stays at minute 0. Measured from `ts`, at minute 31 another payment for the target was signed while the retry
// was one minute old. The clock is moved with Date.now, which stamps the history rows and the rule's window.
// RED-FIRST: with recentFillsOf reading `ts` alone, the three "minute 31" checks sign a second fill (3 submits).
const realNow = Date.now;
const MIN = 60_000;
async function atMinutes(t0, m, fn) {
  Date.now = () => t0 + m * MIN;
  try { return await fn(); } finally { Date.now = realNow; }
}
const sixFee = { fee: 6_000_000 };   // another transaction of the same request: another payment for the target
for (const [base, label, opts, retryCode] of [
  [9800, "the retry accepted", { mode: (n) => (n === 1 ? "lost" : "ok") }, undefined],
  [9900, "the retry's answer lost again, the node took it", { mode: (n) => (n === 1 ? "lost" : n === 2 ? "ingested502" : "ok") }, "SUBMIT_MAYBE_INFLIGHT"],
  [10000, "the retry answered already present", { mode: (n) => (n === 1 ? "ingested502" : "ok"), stale: true }, "SUBMIT_DUPLICATE"],
]) {
  const R = await fclaimRetry(`pw-refill-window-${base}`, base, opts);
  const t0 = realNow();
  const r1 = await atMinutes(t0, 0, () => R.ask());
  const r2 = await atMinutes(t0, 29, () => R.ask());
  const retried = retryCode === undefined ? r2?.ok === true : r2?.ok === false && r2?.code === retryCode;
  const rows = await fillRows(R.w, R.world.fc.id);
  check(`6. ${label}: first submit lost at minute 0 (${r1?.code}), the same transaction sent again at minute 29 (${r2?.ok ? "ok" : r2?.code}, same txid ${r2?.txid === r1?.txid}); one row, its ts still minute 0 (${rows.length}, ${rows[0]?.ts === t0})`,
    r1?.ok === false && r1?.code === "SUBMIT_MAYBE_INFLIGHT" && retried && r2?.txid === r1?.txid && R.st.submits.length === 2 && rows.length === 1 && rows[0].ts === t0);
  const r3 = await atMinutes(t0, 31, () => R.ask(sixFee));
  check(`6. ${label}: at minute 31 another fill of the target is refused (${r3?.ok ? "signed" : r3?.code}), nothing more sent (${R.st.submits.length} submits)`,
    r3?.ok === false && r3?.code === "FILL_ALREADY_SENT" && CONFIRMING.test(String(r3?.error)) && R.st.submits.length === 2);
  if (retryCode === undefined) {
    // The valve still holds: past 30 minutes after the retry, the row still unseen, another fill signs.
    const r4 = await atMinutes(t0, 29 + WAIT_MIN + 1, () => R.ask(sixFee));
    const still = await fillRows(R.w, R.world.fc.id);
    check(`6. ${label}: at minute ${29 + WAIT_MIN + 1}, past the wait after the retry with the row still unseen (${rowsText(still)}), another fill signs (${r4?.ok}${r4?.error ? `: ${r4.code} ${r4.error}` : ""}, ${R.st.submits.length} submits)`,
      r4?.ok === true && R.st.submits.length === 3);
  }
}
{
  // The retry is accepted at minute 29 and its history write fails once: the row is parked in memory while the stored
  // row keeps its minute-0 time and its maybe mark. history() reads the stored row with its parked twin folded in, as
  // the drain will write it, so at minute 31 another fill is refused.
  // RED-FIRST: with historyOf hiding a parked twin behind its stored row, the minute-31 fill signs (3 submits).
  const base = memoryStore();
  let failHist = 0;
  const store = { ...base, async set(k, v) { if (failHist > 0 && String(k).startsWith("txHistory:")) { failHist--; throw new Error("storage write failed"); } return base.set(k, v); } };
  const R = await fclaimRetry("pw-refill-window-parked", 10200, { mode: (n) => (n === 1 ? "lost" : "ok") }, store);
  const t0 = realNow();
  const r1 = await atMinutes(t0, 0, () => R.ask());
  failHist = 1;
  const r2 = await atMinutes(t0, 29, () => R.ask());
  const k = histKey(R.w.addr());
  const stored = (await store.get(k)).filter((e) => e.type === "fillOffer");
  const parked = R.w.hist.pendingHist.filter((p) => p.k === k);
  const read = await fillRows(R.w, R.world.fc.id);
  check(`6. a retry whose history write failed: accepted at minute 29 (${r2?.ok}, same txid ${r2?.txid === r1?.txid}), parked (${parked.length}) while the stored row keeps minute 0 and its maybe mark (${stored[0]?.ts === t0}, ${stored[0]?.maybe})`,
    r1?.code === "SUBMIT_MAYBE_INFLIGHT" && r2?.ok === true && r2?.txid === r1?.txid && failHist === 0 && parked.length === 1 && stored.length === 1 && stored[0].ts === t0 && stored[0].maybe === true && stored[0].resent === undefined);
  check(`6. ...history() reads one row with the parked send time and the definitive answer (${read.length}, resent ${read[0]?.resent === t0 + 29 * MIN}, maybe ${!!read[0]?.maybe}), the stored row unchanged`,
    read.length === 1 && read[0].ts === t0 && read[0].resent === t0 + 29 * MIN && !read[0].maybe && (await store.get(k)).find((e) => e.txid === r1?.txid)?.resent === undefined);
  const r3 = await atMinutes(t0, 31, () => R.ask(sixFee));
  check(`6. ...at minute 31 another fill of the target is refused (${r3?.ok ? "signed" : r3?.code}), nothing more sent (${R.st.submits.length} submits)`,
    r3?.ok === false && r3?.code === "FILL_ALREADY_SENT" && R.st.submits.length === 2);
  // The read is what the drain writes: after the next history write the stored row equals the row read before it.
  await atMinutes(t0, 32, () => R.w.hist.maybeRecord(k, { ok: true, txid: "0x" + "e9".repeat(32) }, { type: "send" }));
  await R.w.hist.histChain;
  const drained = (await store.get(k)).find((e) => e.txid === r1?.txid);
  check(`6. ...after the drain the stored row is the row history() read (resent ${drained?.resent === read[0].resent}, maybe ${!!drained?.maybe}, ts ${drained?.ts === t0}, ${R.w.hist.pendingHist.length} parked)`,
    drained?.resent === read[0].resent && !drained?.maybe && drained?.ts === t0 && R.w.hist.pendingHist.length === 0);
}
{
  // A fill the node accepted, sent again at minute 31 (the same transaction: the coin index still serves its coin) and
  // answered SUBMIT_DUPLICATE: a transaction spending those coins is pending now, so the row's time moves to minute 31
  // although it carried no maybe mark, and another payment at minute 32 is refused.
  // RED-FIRST: with clearMaybe matching only rows marked maybe, the minute-32 fill signs (3 submits).
  const R = await fclaimRetry("pw-refill-window-dup-accepted", 10300, { stale: true });
  const t0 = realNow();
  const r1 = await atMinutes(t0, 0, () => R.ask());
  const r2 = await atMinutes(t0, 31, () => R.ask());
  const rows = await fillRows(R.w, R.world.fc.id);
  check(`6. an accepted fill sent again at minute 31: answered ${r2?.code} (same txid ${r2?.txid === r1?.txid}), one row with resent at minute 31 (${rows.length}, ${rows[0]?.resent === t0 + 31 * MIN})`,
    r1?.ok === true && r2?.ok === false && r2?.code === "SUBMIT_DUPLICATE" && r2?.txid === r1?.txid && rows.length === 1 && rows[0].ts === t0 && rows[0].resent === t0 + 31 * MIN);
  const r3 = await atMinutes(t0, 32, () => R.ask(sixFee));
  check(`6. ...at minute 32 another fill of the target is refused (${r3?.ok ? "signed" : r3?.code}), nothing more sent (${R.st.submits.length} submits)`,
    r3?.ok === false && r3?.code === "FILL_ALREADY_SENT" && R.st.submits.length === 2);
}
{
  // A first fill with no retry: the window counts from its ts, as before.
  const R = await fclaimRetry("pw-refill-window-plain", 10100);
  const t0 = realNow();
  const r1 = await atMinutes(t0, 0, () => R.ask());
  const r2 = await atMinutes(t0, WAIT_MIN - 1, () => R.ask(sixFee));
  const r3 = await atMinutes(t0, WAIT_MIN + 1, () => R.ask(sixFee));
  check(`6. no retry: sent at minute 0 (${r1?.ok}); another fill at minute ${WAIT_MIN - 1} is refused (${r2?.code}), at minute ${WAIT_MIN + 1} it signs (${r3?.ok}, ${R.st.submits.length} submits)`,
    r1?.ok === true && r2?.ok === false && r2?.code === "FILL_ALREADY_SENT" && r3?.ok === true && R.st.submits.length === 2);
}
{
  // The history row itself: a later record of the same txid keeps its ts, its position and a consolidate's confirmed
  // latch, and stores when it was sent again; recentFillsOf counts the later time.
  const store = memoryStore();
  const ADDR = "0x" + "a1".repeat(20), K = histKey(ADDR), OFFER = "0x" + "0f".repeat(32);
  const h = new TxHistory(store, { unlocked: () => true, wiped: () => false, addr: () => ADDR, rpc: () => "http://127.0.0.1:1" });
  const TA = "0x" + "aa".repeat(32), TB = "0x" + "bb".repeat(32), TC = "0x" + "cc".repeat(32);
  const t0 = realNow();
  const fill = { type: "fillOffer", target: OFFER };
  await atMinutes(t0, 0, () => h.maybeRecord(K, { ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TA }, fill));
  await atMinutes(t0, 1, () => h.maybeRecord(K, { ok: true, txid: TC }, { type: "consolidate", amount: 5, fee: 1 }));
  await h.annotate(K, TC, { confirmed: true });
  await atMinutes(t0, 2, () => h.maybeRecord(K, { ok: true, txid: TB }, { type: "send" }));
  await atMinutes(t0, 29, () => h.maybeRecord(K, { ok: true, txid: TA }, fill));
  await atMinutes(t0, 30, () => h.maybeRecord(K, { ok: true, txid: TC }, { type: "consolidate", amount: 5, fee: 1 }));
  const rows = await store.get(K);
  const a = rows.find((e) => e.txid === TA), c = rows.find((e) => e.txid === TC);
  check(`6. history: the retried row keeps its position (${rows.map((e) => e.txid.slice(2, 4)).join(",")}), its ts (${a?.ts === t0}), loses its maybe mark (${!a?.maybe}) and stores the retry time (${a?.resent === t0 + 29 * MIN})`,
    rows.length === 3 && rows.map((e) => e.txid).join() === [TB, TC, TA].join() && a.ts === t0 && !a.maybe && a.resent === t0 + 29 * MIN);
  check(`6. history: a re-recorded consolidate keeps its ts and its confirmed latch (${c?.ts === t0 + MIN}, ${c?.confirmed})`, c?.ts === t0 + MIN && c?.confirmed === true);
  const inWin = await h.recentFillsOf(ADDR, OFFER, t0 + 28 * MIN), outWin = await h.recentFillsOf(ADDR, OFFER, t0 + 29 * MIN + 1);
  check(`6. history: recentFillsOf counts the retry time (since minute 28: ${inWin.length} row; since just after minute 29: ${outWin.length})`, inWin.length === 1 && outWin.length === 0);
  // An older record of the same txid (a parked twin drained late) does not move the time back.
  await atMinutes(t0, 5, () => h.maybeRecord(K, { ok: true, txid: TA }, fill));
  check(`6. history: an older record of the row does not move its time back (${(await store.get(K)).find((e) => e.txid === TA)?.resent === t0 + 29 * MIN})`, (await store.get(K)).find((e) => e.txid === TA)?.resent === t0 + 29 * MIN);
}
{
  // SUBMIT_DUPLICATE on a stored maybe row, and on a parked row that is the only copy (recorded while locked).
  const store = memoryStore();
  const ADDR = "0x" + "a2".repeat(20), K = histKey(ADDR), OFFER = "0x" + "1f".repeat(32);
  let unlocked = true;
  const h = new TxHistory(store, { unlocked: () => unlocked, wiped: () => false, addr: () => ADDR, rpc: () => "http://127.0.0.1:1" });
  const TS = "0x" + "d1".repeat(32), TP = "0x" + "d2".repeat(32);
  const fill = { type: "fillOffer", target: OFFER };
  const t0 = realNow();
  await atMinutes(t0, 0, () => h.maybeRecord(K, { ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TS }, fill));
  unlocked = false;
  await atMinutes(t0, 0, () => h.maybeRecord(K, { ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: TP }, fill));
  unlocked = true;
  await atMinutes(t0, 29, () => h.maybeRecord(K, { ok: false, code: "SUBMIT_DUPLICATE", txid: TS }, fill));
  await atMinutes(t0, 29, () => h.maybeRecord(K, { ok: false, code: "SUBMIT_DUPLICATE", txid: TP }, fill));
  const stored = await store.get(K), parked = h.pendingHist.filter((p) => p.entry.txid === TP);
  const s = stored.find((e) => e.txid === TS);
  check(`6. history: a duplicate answer clears the stored row's maybe mark and stores the time (${!s?.maybe}, ${s?.ts === t0}, ${s?.resent === t0 + 29 * MIN})`, stored.length === 1 && !s.maybe && s.ts === t0 && s.resent === t0 + 29 * MIN);
  check(`6. history: ...and on a parked row that is the only copy (${parked.length} parked, ${parked[0]?.entry.resent === t0 + 29 * MIN})`, parked.length === 1 && !parked[0].entry.maybe && parked[0].entry.ts === t0 && parked[0].entry.resent === t0 + 29 * MIN);
  const recent = await h.recentFillsOf(ADDR, OFFER, t0 + 28 * MIN);
  check(`6. history: both count inside the window from the duplicate answer (${recent.length} rows)`, recent.length === 2);
}
done("fill-refill-after-send");
