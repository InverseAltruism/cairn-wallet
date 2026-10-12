// The cross-offer MAX_ACTIVE_CLAIMS count past V29. At a grant height >= V29_HEIGHT the resolver counts a
// buyer's live holds on OPEN offers only, so three completed fclaim buys inside one hold window do not deny
// a fourth claim. The wallet must not count those three either, or the fourth fill is refused after its claim
// was granted. The exclusion is decided only by this wallet's own merkle-proven, prevout-bound fill that
// pays the proven offer in full; every other shape keeps the hold counted (over-count is the safe side).
//
// Every scenario also runs the vendored resolve() over the same events and asserts the safety invariant:
// the wallet never counts below the cap while the resolver denies the claim.
// Run: npx tsx test/fill-holds-v29.test.mjs
import assert from "node:assert/strict";
import { liveFillSpvSource, countMyOtherLiveHolds, myProvenFillClosedOffer } from "../src/core/fillspv.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import {
  deploy, mint, offer, fclaim, resolve, verifyFillSpv, requiredFillOutputs, paidToFromOutputs,
  V29_HEIGHT, MAX_ACTIVE_CLAIMS, SCORE_FILL, TREASURY_ADDR, DEPLOY_FEE, epochOf, fclaimHoldEnd, feeBpsAt, tradeFee,
} from "../src/vendor/cairnx-spv.js";
import { proposeTx, attestTx, addrFromPriv, ctxid, merkleRoot, rpcTxToTx, prevoutFor, pick } from "./_spvrig.ts";
import { mkCoin, txReply } from "./_coin.ts";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

const meKey = "0x" + "1a".repeat(32), sellerKey = "0x" + "5e".repeat(32), strangerKey = "0x" + "2b".repeat(32);
const ME = addrFromPriv(meKey).toLowerCase(), SELLER = addrFromPriv(sellerKey).toLowerCase();
const V = 5_000_000;
const H_BACK = 86_000, H_OFF = 87_000;               // backing and offers sit below the scan window
const H_C = V29_HEIGHT + 30, H_F = V29_HEIGHT + 40, H_G = V29_HEIGHT + 50, TIP = V29_HEIGHT + 60;
const eFor = (h) => epochOf(h) + 2;

const FILLER = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 1, script_sig: "0x" }], outputs: [{ value: 1, script_pubkey: "0x" + "77".repeat(20) }] };
function fillSource(blocks, tip) {
  return {
    async prepare() { return { verifiedTip: tip, nodeTip: tip }; },
    async blockAt(height) {
      const txs = blocks.get(height) ?? [FILLER];
      return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } })))), txs };
    },
    async prevoutScriptPubkey(prevTxid) { return prevoutFor(prevTxid); },
  };
}

// One world: placed txs (for the SPV source) plus the resolver ChainEvents for the same txs.
function makeWorld() {
  const blocks = new Map(), events = [];
  const place = (height, tx, signer) => {
    const arr = blocks.get(height) ?? blocks.set(height, []).get(height);
    const pos = arr.length; arr.push(tx);
    const t = rpcTxToTx(tx), id = ctxid(t).toLowerCase();
    const paidTo = paidToFromOutputs(t.outputs.map((o) => ({ addr: String(o.scriptPubkey).toLowerCase(), value: Number(o.value) })));
    events.push(t.app.type === "Propose"
      ? { kind: "propose", id, proposer: signer, uri: t.app.uri, payloadHash: String(t.app.payloadHash).toLowerCase(), expiresEpoch: Number(t.app.expiresEpoch), height, pos, paidTo }
      : { kind: "attest", txid: id, proposalId: String(t.app.proposalId).toLowerCase(), attester: signer, score: Number(t.app.score), confidence: Number(t.app.confidence), height, pos, paidTo });
    return id;
  };
  place(H_BACK, proposeTx({ ...pick(deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" })), priv: sellerKey, outputs: [{ to: TREASURY_ADDR, value: Number(DEPLOY_FEE) }] }), SELLER);
  place(H_BACK + 1, proposeTx({ ...pick(mint({ ticker: "AAA", amount: "1000" })), priv: sellerKey }), SELLER);
  return { blocks, events, place };
}
const offerRec = (extra = {}) => offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: SELLER }, ...extra });
const servedShape = (id, extra = {}) => ({ id, seller: SELLER, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: SELLER }, status: "open", height: H_OFF, feeBps: feeBpsAt(H_OFF), paid: "0", delivered: "0", ...extra });
// The outputs the wallet builds for a full fill of an offer (the production need-map).
const fullOutputs = (id, extra = {}) => requiredFillOutputs(servedShape(id, extra), BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));

// Build the four-buys scenario. `fills` maps the index of an earlier buy (0..2) to how it was filled.
// Each proposeTx spends a fresh prevout, so identical records still get distinct txids.
function fourBuys({ count = 3, fills = { 0: "full", 1: "full", 2: "full" }, grantAt = H_G, cAt = H_C, fAt = H_F, minOn = [], fillFirst = false } = {}) {
  const w = makeWorld();
  const offerIds = Array.from({ length: count }, (_, i) => w.place(H_OFF, proposeTx({ ...pick(offerRec(minOn.includes(i) ? { min: "1000000" } : {})), priv: sellerKey, expiresEpoch: 9e9 }), SELLER));
  const mainOffer = w.place(H_OFF, proposeTx({ ...pick(offerRec()), priv: sellerKey, expiresEpoch: 9e9 }), SELLER);
  const claimTxs = offerIds.map((oid) => proposeTx({ ...pick(fclaim({ offer: oid })), priv: meKey, expiresEpoch: eFor(cAt) }));
  const claims = claimTxs.map((t) => ctxid(rpcTxToTx(t)).toLowerCase());
  if (!fillFirst) claimTxs.forEach((t) => w.place(cAt, t, ME));
  offerIds.forEach((oid, i) => {
    const how = fills[i];
    if (!how) return;
    const extra = minOn.includes(i) ? { min: "1000000" } : {};
    const outs = how === "partial" ? [{ to: SELLER, value: 1_000_000 }, { to: TREASURY_ADDR, value: Number(requiredFillOutputs(servedShape(oid, extra), 1_000_000n).find((o) => o.to === TREASURY_ADDR.toLowerCase())?.value ?? 0n) }]
      : how === "nofee" ? fullOutputs(oid, extra).filter((o) => o.to !== TREASURY_ADDR.toLowerCase())
      : fullOutputs(oid, extra);
    const key = how === "stranger" ? strangerKey : meKey;
    w.place(fAt, attestTx({ proposalId: claims[i], score: how === "notfill" ? 0 : SCORE_FILL, priv: key, outputs: outs }), addrFromPriv(key).toLowerCase());
  });
  if (fillFirst) claimTxs.forEach((t) => w.place(cAt, t, ME));
  const fourth = w.place(grantAt, proposeTx({ ...pick(fclaim({ offer: mainOffer })), priv: meKey, expiresEpoch: eFor(grantAt) }), ME);
  return { ...w, offerIds, mainOffer, claims, fourth };
}

const heightsOf = (s, lie = {}) => async (id) => (id in lie ? lie[id] : (s.offerIds.includes(id) || id === s.mainOffer ? H_OFF : null));
const live = (s, opts = {}) => liveFillSpvSource({
  rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(s.blocks, opts.tip ?? TIP),
  hints: { offerId: s.mainOffer, fclaimTxid: s.fourth, me: ME, offerHeight: H_OFF },
  ...(opts.noLookup ? {} : { offerHeightOf: opts.offerHeightOf ?? heightsOf(s) }),
});
const resolverGranted = (s, tip = TIP) => resolve(s.events, tip).fclaims[s.fourth] !== undefined;
// The Rule B invariant: the wallet's count is below the cap only where the resolver granted the claim.
const assertNotBelowResolver = (count, s, tip) => assert.ok(count >= MAX_ACTIVE_CLAIMS || resolverGranted(s, tip), `wallet count ${count} is below the cap while the resolver denied the claim`);

console.log("P74-29: past V29 the cross-offer hold count skips offers this wallet provably filled:");

await test("the vendored V29 gate is the activation height the plan names", async () => {
  assert.equal(V29_HEIGHT, 88_000);
});

await test("four buys: three proven full fills no longer count, the fourth fill verifies (red before the fix)", async () => {
  const s = fourBuys();
  assert.equal(resolverGranted(s), true, "fixture: the resolver grants the fourth claim");
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 0);
  const v = await verifyFillSpv(s.mainOffer, s.fourth, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant });
  assert.equal(v.safe, true, v.reason);
});

await test("honest path: three unfilled holds are still counted and the fourth is refused", async () => {
  const s = fourBuys({ fills: {} });
  assert.equal(resolverGranted(s), false, "fixture: the resolver denies on the cap");
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 3);
  const v = await verifyFillSpv(s.mainOffer, s.fourth, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant });
  assert.equal(v.safe, false);
  assert.match(v.reason, /max active claims/);
});

await test("a hold on an offer this wallet did not fill still counts", async () => {
  const s = fourBuys({ fills: { 0: "full", 1: "full" } });
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 1);
  assertNotBelowResolver(io.myLiveHoldsAtGrant, s);
});

await test("a partial fill leaves its offer open, so its hold still counts", async () => {
  const one = fourBuys({ fills: { 0: "partial", 1: "full", 2: "full" }, minOn: [0] });
  const io1 = await live(one);
  assert.equal(io1.myLiveHoldsAtGrant, 1);
  const all = fourBuys({ fills: { 0: "partial", 1: "partial", 2: "partial" }, minOn: [0, 1, 2] });
  assert.equal(resolverGranted(all), false, "fixture: three partly filled offers stay open, the resolver denies");
  const io3 = await live(all);
  assert.equal(io3.myLiveHoldsAtGrant, 3);
});

await test("a full payment on a partial-lane offer closes it, so its hold is skipped", async () => {
  const s = fourBuys({ minOn: [0, 1, 2] });
  assert.equal(resolverGranted(s), true, "fixture: full payments complete the partial-lane offers");
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 0);
});

await test("a fill that misses the fee leg is rejected by the resolver, so its hold still counts", async () => {
  const s = fourBuys({ fills: { 0: "nofee", 1: "nofee", 2: "nofee" } });
  assert.equal(resolverGranted(s), false, "fixture: the rejected fills leave all three offers open");
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 3);
  const mixed = fourBuys({ fills: { 0: "nofee", 1: "full", 2: "full" } });
  assert.equal((await live(mixed)).myLiveHoldsAtGrant, 1);
});

await test("a fill signed by someone else on my claim does not exclude it", async () => {
  const s = fourBuys({ fills: { 0: "stranger", 1: "stranger", 2: "stranger" } });
  assert.equal(resolverGranted(s), false, "fixture: a non-holder's fill is rejected, the offers stay open");
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 3);
});

await test("attests by someone else that name my claims cause no prevout read and no resolver lookup", async () => {
  const s = fourBuys({ fills: { 0: "stranger", 1: "stranger", 2: "stranger" } });
  const planted = new Set(s.events.filter((e) => e.kind === "attest").map((e) => e.txid));
  const plantedPrevouts = new Set([...s.blocks.values()].flat()
    .filter((tx) => planted.has(ctxid(rpcTxToTx(tx)).toLowerCase())).map((tx) => String(tx.inputs[0].prev_txid).toLowerCase()));
  assert.equal(plantedPrevouts.size, 3, "fixture: three planted attests");
  const base = fillSource(s.blocks, TIP), read = [];
  let lookups = 0;
  const io = await liveFillSpvSource({
    rpcBase: "http://x", headersBase: "http://x",
    spvSource: { ...base, prevoutScriptPubkey: async (t, v) => { read.push(String(t).toLowerCase()); return base.prevoutScriptPubkey(t, v); } },
    hints: { offerId: s.mainOffer, fclaimTxid: s.fourth, me: ME, offerHeight: H_OFF },
    offerHeightOf: async (id) => { lookups++; return heightsOf(s)(id); },
  });
  assert.equal(io.myLiveHoldsAtGrant, 3);
  assert.equal(read.filter((t) => plantedPrevouts.has(t)).length, 0, "a planted attest's coin was read");
  assert.equal(lookups, 0);
});

await test("a non-fill attest on my claim, even fully paid, does not exclude it", async () => {
  const s = fourBuys({ fills: { 0: "notfill", 1: "notfill", 2: "notfill" } });
  assert.equal(resolverGranted(s), false, "fixture: a score-0 attest on an fclaim is a no-op");
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 3);
});

await test("a served offer height that does not prove the offer excludes nothing", async () => {
  const s = fourBuys();
  const lie = Object.fromEntries(s.offerIds.map((id) => [id, H_OFF + 1]));
  const io = await live(s, { offerHeightOf: heightsOf(s, lie) });
  assert.equal(io.myLiveHoldsAtGrant, 3);
  const throwing = await live(s, { offerHeightOf: async () => { throw new Error("resolver down"); } });
  assert.equal(throwing.myLiveHoldsAtGrant, 3);
  const none = await live(s, { noLookup: true });
  assert.equal(none.myLiveHoldsAtGrant, 3);
  const notFound = await live(s, { offerHeightOf: async () => null });   // the primary 404s the other offer
  assert.equal(notFound.myLiveHoldsAtGrant, 3);
});

await test("below V29 the resolver still counts filled offers, so nothing is excluded", async () => {
  const shift = 200;
  const s = fourBuys({ cAt: H_C - shift, fAt: H_F - shift, grantAt: H_G - shift });
  assert.equal(resolverGranted(s, TIP - shift), false, "fixture: pre-V29 the resolver denies");
  const io = await live(s, { tip: TIP - shift });
  assert.equal(io.myLiveHoldsAtGrant, 3);
});

await test("a fill mined in the grant block is not trusted to precede the grant", async () => {
  const s = fourBuys({ fAt: H_G });
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 3);
});

await test("a fill mined before its fclaim does not count (the resolver ignores it)", async () => {
  const s = fourBuys({ cAt: H_F, fAt: H_C, fillFirst: true });
  assert.equal(resolverGranted(s), false, "fixture: the early attests are no-ops, the resolver denies");
  const io = await live(s);
  assert.equal(io.myLiveHoldsAtGrant, 3);
});

await test("the predicate binds the fill to this fclaim and the proof to this offer", async () => {
  const s = fourBuys();
  const ev = (id) => { const e = s.events.find((x) => (x.kind === "propose" ? x.id : x.txid) === id); return { ...e, depth: TIP - e.height + 1 }; };
  const fillOf = (i) => s.events.find((x) => x.kind === "attest" && x.proposalId === s.claims[i]);
  const c0 = { id: s.claims[0], height: H_C, offer: s.offerIds[0] };
  const f0 = { ...fillOf(0), depth: 1 }, f1 = { ...fillOf(1), depth: 1 };
  assert.equal(myProvenFillClosedOffer(f0, c0, ev(s.offerIds[0]), ME, H_G), true);
  assert.equal(myProvenFillClosedOffer(f1, c0, ev(s.offerIds[0]), ME, H_G), false, "a fill on another fclaim");
  assert.equal(myProvenFillClosedOffer(f0, c0, ev(s.offerIds[1]), ME, H_G), false, "a proof of another offer");
  assert.equal(myProvenFillClosedOffer(null, c0, ev(s.offerIds[0]), ME, H_G), false);
  const st = fourBuys({ fills: { 0: "stranger" } });
  const strangerFill = { ...st.events.find((x) => x.kind === "attest" && x.proposalId === st.claims[0]), depth: 1 };
  const sc0 = { id: st.claims[0], height: H_C, offer: st.offerIds[0] };
  const stEv = { ...st.events.find((x) => x.kind === "propose" && x.id === st.offerIds[0]), depth: 1 };
  assert.equal(myProvenFillClosedOffer(strangerFill, sc0, stEv, ME, H_G), false, "a fill signed by someone else");
  assert.equal(myProvenFillClosedOffer(f0, c0, null, ME, H_G), false);
  const tokenWant = offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: SELLER } });
  const tokenEv = { ...ev(s.offerIds[0]), uri: tokenWant.uri, payloadHash: tokenWant.payloadHash };
  assert.equal(myProvenFillClosedOffer(f0, c0, tokenEv, ME, H_G), false, "a token-priced offer has no CSD fill to prove");
});

await test("the pure counter skips only the fclaim txids it is handed", async () => {
  const s = fourBuys({ fills: {} });
  const held = s.events.filter((e) => e.kind === "propose" && s.claims.includes(e.id));
  assert.equal(countMyOtherLiveHolds(held, s.mainOffer, ME, H_G), 3);
  assert.equal(countMyOtherLiveHolds(held, s.mainOffer, ME, H_G, new Set([s.claims[0]])), 2);
});

await test("production wiring: the wallet's fill source looks the offer height up on its resolver", async () => {
  const s = fourBuys();
  const w = new Wallet(memoryStore());
  w.nameSpvForTest = fillSource(s.blocks, TIP);
  const asked = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url), m = u.match(/\/cairnx\/offer\/(0x[0-9a-f]{64})$/);
    if (m) { asked.push(m[1]); return { ok: true, status: 200, json: async () => servedShape(m[1], { status: "filled" }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const io = await w["makeFillSpvIo"](s.mainOffer, s.fourth, ME, H_OFF);
    assert.equal(io.myLiveHoldsAtGrant, 0);
    assert.deepEqual([...asked].sort(), [...s.offerIds].sort());
  } finally { globalThis.fetch = origFetch; }
});

await test("below the cap nothing is looked up: two other holds cost no resolver read", async () => {
  const s = fourBuys({ count: 2, fills: { 0: "full", 1: "full" } });
  let calls = 0;
  const io = await live(s, { offerHeightOf: async (id) => { calls++; return heightsOf(s)(id); } });
  assert.equal(io.myLiveHoldsAtGrant, 2);
  assert.equal(calls, 0);
});

// Second-review scenarios: same rig, one hold per call so each world can differ.
const placeOffer = (w, extra = {}) => w.place(H_OFF, proposeTx({ ...pick(offerRec(extra)), priv: sellerKey, expiresEpoch: 9e9 }), SELLER);
const claimOn = (w, oid, h, key = meKey) => w.place(h, proposeTx({ ...pick(fclaim({ offer: oid })), priv: key, expiresEpoch: eFor(h) }), addrFromPriv(key).toLowerCase());
const fillOn = (w, cid, h, outputs, key = meKey) => w.place(h, attestTx({ proposalId: cid, score: SCORE_FILL, priv: key, outputs }), addrFromPriv(key).toLowerCase());
const outsAt = (id, pay, extra = {}) => requiredFillOutputs(servedShape(id, extra), BigInt(pay)).map(({ to, value }) => ({ to, value: Number(value) }));
const liveAt = (s, tip, offerHeightOf) => liveFillSpvSource({
  rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(s.blocks, tip),
  hints: { offerId: s.mainOffer, fclaimTxid: s.fourth, me: ME, offerHeight: H_OFF },
  offerHeightOf: offerHeightOf ?? (async (id) => (s.others.includes(id) ? H_OFF : null)),
});
// three other offers, my claims at hC, my full fills at hF, the fourth claim at hG
function threeFilled(hC, hF, hG) {
  const w = makeWorld();
  const others = [placeOffer(w), placeOffer(w), placeOffer(w)];
  const mainOffer = placeOffer(w);
  const claims = others.map((o) => claimOn(w, o, hC));
  claims.forEach((c, i) => fillOn(w, c, hF, outsAt(others[i], V)));
  return { ...w, others, mainOffer, fourth: claimOn(w, mainOffer, hG) };
}

await test("tail fill: an offer I closed with a partial-lane remainder fill still counts (over-count)", async () => {
  const w = makeWorld();
  const others = [placeOffer(w, { min: "1000000" }), placeOffer(w), placeOffer(w)];
  const mainOffer = placeOffer(w);
  const claims = others.map((o) => claimOn(w, o, H_C));
  fillOn(w, claims[0], H_F, outsAt(others[0], 1_000_000, { min: "1000000" }));
  const rem = 4_000_000;
  fillOn(w, claims[0], H_F + 1, [{ to: SELLER, value: rem }, { to: TREASURY_ADDR, value: Number(tradeFee(BigInt(rem), feeBpsAt(H_OFF))) }]);
  fillOn(w, claims[1], H_F, outsAt(others[1], V));
  fillOn(w, claims[2], H_F, outsAt(others[2], V));
  const s = { ...w, others, mainOffer, fourth: claimOn(w, mainOffer, H_G) };
  assert.equal(resolve(s.events, TIP).offers[others[0]].status, "filled", "fixture: the remainder fill completed offer 0");
  assert.equal(resolverGranted(s), true);
  const io = await liveAt(s, TIP);
  assertNotBelowResolver(io.myLiveHoldsAtGrant, s);
  assert.equal(io.myLiveHoldsAtGrant, 1);
});

await test("two of my fclaims on one offer: a denied one I paid is skipped, the granted one still counts", async () => {
  const tip = V29_HEIGHT + 140;
  const w = makeWorld();
  const O = placeOffer(w), A = placeOffer(w), B = placeOffer(w);
  const mainOffer = placeOffer(w);
  claimOn(w, O, V29_HEIGHT + 30, strangerKey);
  const C1 = claimOn(w, O, V29_HEIGHT + 100);
  claimOn(w, A, V29_HEIGHT + 100); claimOn(w, B, V29_HEIGHT + 100);
  const C2 = claimOn(w, O, V29_HEIGHT + 115);
  fillOn(w, C1, V29_HEIGHT + 120, outsAt(O, V));
  const s = { ...w, others: [O, A, B], mainOffer, fourth: claimOn(w, mainOffer, V29_HEIGHT + 130) };
  const st = resolve(s.events, tip);
  assert.equal(st.fclaims[C1], undefined, "fixture: C1 denied");
  assert.notEqual(st.fclaims[C2], undefined, "fixture: C2 granted");
  assert.equal(st.offers[O].status, "open", "fixture: the fill on the denied claim left O open");
  assert.equal(resolverGranted(s, tip), false);
  const io = await liveAt(s, tip);
  assertNotBelowResolver(io.myLiveHoldsAtGrant, s, tip);
  assert.equal(io.myLiveHoldsAtGrant, 3);
  assert.equal((await verifyFillSpv(s.mainOffer, s.fourth, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant })).safe, false);
});

await test("a fill in the same block as its fclaim keeps the hold counted, in either order", async () => {
  for (const order of ["claim-then-fill", "fill-then-claim"]) {
    const w = makeWorld();
    const others = [placeOffer(w), placeOffer(w), placeOffer(w)];
    const mainOffer = placeOffer(w);
    const claimTxs = others.map((o) => proposeTx({ ...pick(fclaim({ offer: o })), priv: meKey, expiresEpoch: eFor(H_C) }));
    const claims = claimTxs.map((t) => ctxid(rpcTxToTx(t)).toLowerCase());
    const placeClaims = () => claimTxs.forEach((t) => w.place(H_C, t, ME));
    const placeFills = () => claims.forEach((c, i) => fillOn(w, c, H_C, outsAt(others[i], V)));
    if (order === "claim-then-fill") { placeClaims(); placeFills(); } else { placeFills(); placeClaims(); }
    const s = { ...w, others, mainOffer, fourth: claimOn(w, mainOffer, H_G) };
    assert.equal(resolverGranted(s), true, `fixture: ${order}`);
    const io = await liveAt(s, TIP);
    assert.equal(io.myLiveHoldsAtGrant, 3, order);
  }
});

await test("V29 boundary: a grant exactly at V29 skips my filled holds, one block earlier it does not", async () => {
  const at = threeFilled(V29_HEIGHT - 20, V29_HEIGHT - 10, V29_HEIGHT);
  assert.equal(resolverGranted(at, V29_HEIGHT + 10), true, "fixture: at V29 the resolver grants");
  assert.equal((await liveAt(at, V29_HEIGHT + 10)).myLiveHoldsAtGrant, 0);
  const before = threeFilled(V29_HEIGHT - 21, V29_HEIGHT - 11, V29_HEIGHT - 1);
  assert.equal(resolverGranted(before, V29_HEIGHT + 9), false, "fixture: at V29 - 1 the resolver denies");
  assert.equal((await liveAt(before, V29_HEIGHT + 9)).myLiveHoldsAtGrant, 3);
});

await test("a denied fclaim of mine on an offer a stranger filled still counts (over-count)", async () => {
  const tip = V29_HEIGHT + 140;
  const w = makeWorld();
  const O = placeOffer(w), A = placeOffer(w), B = placeOffer(w);
  const mainOffer = placeOffer(w);
  fillOn(w, claimOn(w, O, V29_HEIGHT + 30, strangerKey), V29_HEIGHT + 40, outsAt(O, V), strangerKey);
  claimOn(w, O, V29_HEIGHT + 100); claimOn(w, A, V29_HEIGHT + 100); claimOn(w, B, V29_HEIGHT + 100);
  const s = { ...w, others: [O, A, B], mainOffer, fourth: claimOn(w, mainOffer, V29_HEIGHT + 130) };
  assert.equal(resolverGranted(s, tip), true);
  const io = await liveAt(s, tip);
  assertNotBelowResolver(io.myLiveHoldsAtGrant, s, tip);
  assert.equal(io.myLiveHoldsAtGrant, 3);
});

// End to end through w.fillOffer: the wallet holds the buyer key, builds its own fill source (nameSpvForTest
// stands in for the light client), looks the other offers up through its own tradeGet, and fclaimLanePreflight
// runs verifyFillSpv with production's pay and sums.
async function fillEndToEnd(s) {
  const w = new Wallet(memoryStore());
  assert.equal((await w.importKey(meKey, "pw-four-buys-123")).addr.toLowerCase(), ME);
  w.nameSpvForTest = fillSource(s.blocks, TIP);
  const coin = mkCoin(100_000_002);
  const alias = { ...servedShape(s.mainOffer), fclaimId: s.fourth, fclaimHeight: H_G, fclaimExpiresEpoch: eFor(H_G) };
  const outputs = fullOutputs(s.mainOffer);
  const seen = { submits: [], primaryOtherLookups: [] };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { seen.submits.push(JSON.parse(init?.body || "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    const m = u.match(/\/cairnx\/offer\/(0x[0-9a-f]{64})$/);
    if (m && u.includes("clarvis")) return { ok: false, status: 404, json: async () => ({}) };
    if (m && m[1] === s.fourth) return { ok: true, status: 200, json: async () => alias };
    if (m && s.offerIds.includes(m[1])) { seen.primaryOtherLookups.push(m[1]); return { ok: true, status: 200, json: async () => servedShape(m[1], { status: "filled" }) }; }
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: TIP }) };
    const t = txReply(u, [coin]);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try { return { r: await w.fillOffer({ proposalId: s.fourth, outputs }), outputs, ...seen }; }
  finally { globalThis.fetch = origFetch; }
}

await test("end to end: the fourth buy after three proven fills is signed and submitted", async () => {
  const world = fourBuys();
  const { r, outputs, submits, primaryOtherLookups } = await fillEndToEnd(world);
  assert.equal(r?.ok, true, `${r?.code}: ${r?.error}`);
  assert.equal(submits.length, 1);
  assert.deepEqual([...primaryOtherLookups].sort(), [...world.offerIds].sort());
  const hex = (bytes) => "0x" + bytes.map((x) => x.toString(16).padStart(2, "0")).join("");
  const tx = submits[0].tx;
  assert.equal(hex(tx.app.Attest.proposal_id), world.fourth, "the attest names the fourth fclaim");
  assert.equal(tx.app.Attest.score, SCORE_FILL);
  const paid = new Map();
  for (const o of tx.outputs) { const k = hex(o.script_pubkey); paid.set(k, (paid.get(k) ?? 0) + Number(o.value)); }
  for (const { to, value } of outputs) assert.equal(paid.get(to), value, `submitted tx pays ${to} exactly ${value}`);
});

await test("end to end: three unfilled holds still refuse the fourth buy, nothing submitted", async () => {
  const { r, submits } = await fillEndToEnd(fourBuys({ fills: {} }));
  assert.equal(r?.ok, false);
  assert.equal(r?.code, "FILL_UNSAFE");
  assert.match(String(r?.error), /max active claims/);
  assert.equal(submits.length, 0);
});

console.log(`fill-holds-v29: ${n} passed, 0 failed`);
