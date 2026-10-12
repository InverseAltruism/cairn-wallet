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
import { liveFillSpvSource, countMyOtherLiveHolds, myProvenFillClosedOffer, V29_GATE } from "../src/core/fillspv.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import {
  deploy, mint, offer, fclaim, resolve, verifyFillSpv, requiredFillOutputs, paidToFromOutputs,
  V29_HEIGHT, MAX_ACTIVE_CLAIMS, SCORE_FILL, TREASURY_ADDR, DEPLOY_FEE, epochOf, fclaimHoldEnd, feeBpsAt,
} from "../src/vendor/cairnx-spv.js";
import { proposeTx, attestTx, addrFromPriv, ctxid, merkleRoot, rpcTxToTx, prevoutFor, pick } from "./_spvrig.ts";

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

await test("the V29 gate is the vendored constant (a missing export would disable the exclusion)", async () => {
  assert.equal(V29_GATE, V29_HEIGHT);
  assert.equal(V29_GATE, 88_000);
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

console.log(`fill-holds-v29: ${n} passed, 0 failed`);
