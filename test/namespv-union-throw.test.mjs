// verifyNameUnion over the SpvSource seam. (1) a source's hint the chain refutes (a txid not in its verified block)
// does not take verification away from an honest name: the per-source recovery proves the honest winner. The live
// source cannot throw for a hint at or below its verified tip by the hint alone (a header there is in memory or read
// from the store or the header host, a body by its verified hash from the node, and fetchNameUnion drops a hint below
// the names floor), so a throw is a read the wallet could not make: (2) a read that keeps failing is fail-closed,
// with no server's subset in its place. (3) a record above the verified tip at or below the served tip is such a read
// too: no recovery to the lagging server's holding. (4) a server's own replay that is short inside the recovery ends
// it unverified: a server that withholds a transfer and pads past the hint cap does not verify the seller because the
// honest server's read failed. (5) a second server's hint naming an unsigned transaction, or (6) one whose signer
// does not own the coin it spends, is a record the chain refutes: the recovery still proves the honest winner.
// Paired honest paths: two agreeing clean sources verify as a strong two-source result; headers covering the record
// prove the current address. Mutations: MUTATE_SOLO_SHORT removed fails (4); MUTATE_BIND_SHORT removed fails (4)'s
// body case; every signer-bind refusal made short fails (5) and (6).
// Run: npx tsx test/namespv-union-throw.test.mjs
import assert from "node:assert/strict";
import { verifyNameUnion } from "../src/core/namespv.ts";
import { buildNameClaim, buildNameSet, buildNameXfer, addrFromPriv, proposeTx, nodeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";

const key = "0x" + "5a".repeat(32);
const OWNER = addrFromPriv(key).toLowerCase();
const TARGET = "0x" + "c3".repeat(20);
const NAME = "bob";
const claim = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: key, outputs: feeOut() });
const nset = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: key });
const { blocks, hints } = world([{ height: 33700, tx: claim }, { height: 33710, tx: nset }]);
const history = { ok: true, events: hints, resolve: { addr: TARGET, owner: OWNER, via: "nset" }, scopedReplaySufficient: true };
const PRIM = "https://cairn-substrate.com/trade/api";
const CLAR = "https://clarvis.cairn-substrate.com/trade/api";
const sources = [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLAR }];

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

// A txid that block 33,700 does not hold: the block binds and the record is refuted.
const refutedHint = { txid: "0x" + "9d".repeat(32), height: 33700, pos: 0, kind: "name" };
// Height 33750 is below the verified tip (33800), and the rig source throws for a block it holds no header for: the
// stand-in for a block read that fails.
const throwingHint = { txid: "0x" + "9d".repeat(32), height: 33750, pos: 0, kind: "name" };

await test("a source whose hint the chain refutes does not abort the union: solo recovery proves the honest winner", async () => {
  const poison = { ...history, events: [...hints, refutedHint] };
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: history, [CLAR]: poison }));
  assert.equal(r.verified, true, `expected recovery, got: ${r.reason}`);
  assert.equal(r.addr, TARGET);
  assert.equal(r.recovered, true);
  assert.equal(r.soleSource, true);
  assert.equal(r.disagree, true);
  assert.equal(r.sources, 2);
});

await test("a block read that keeps failing is fail-closed, with no server's subset in its place", async () => {
  const poison = { ...history, events: [...hints, throwingHint] };
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: poison, [CLAR]: poison }));
  assert.equal(r.verified, false);
  assert.equal(r.addr, undefined);
  assert.match(String(r.reason), /no verified header at 33750/);
});

await test("honest path: two agreeing clean sources verify, no soleSource, no recovery", async () => {
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: history, [CLAR]: history }));
  assert.equal(r.verified, true);
  assert.equal(r.addr, TARGET);
  assert.equal(r.sources, 2);
  assert.equal(r.disagree, false);
  assert.ok(!r.soleSource);
  assert.ok(!r.recovered);
});

// (3) The clause of replayName that no liveSpvSource answer reaches today (its prepare returns only once the verified
// tip covers min(node tip, record + 12)); pinned over the seam as fill-dropped-source (4) pins fillspv's twin.
const lagging = { ...history, events: hints.slice(0, 1), resolve: { addr: OWNER, owner: OWNER, via: "owner" } };
await test("a record above the verified tip at or below the served tip: no recovery to the lagging server's holding", async () => {
  const behind = { ...source(blocks, 33800), prepare: async () => ({ verifiedTip: 33705, nodeTip: 33800, tipKnown: true, servedTip: 33800 }) };
  const r = await verifyNameUnion(NAME, sources, behind, mkFetch({ [PRIM]: history, [CLAR]: lagging }));
  assert.equal(r.verified, false, `got ${r.addr === OWNER ? "the earlier holding" : r.addr} verified`);
  assert.equal(r.addr, undefined);
});

await test("honest: headers covering the record prove the current address, the lagging server flagged", async () => {
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: history, [CLAR]: lagging }));
  assert.equal(r.verified, true);
  assert.equal(r.addr, TARGET);
  assert.equal(r.disagree, true);
  assert.ok(!r.soleSource);
});

// (4) The padding world of namespv-union-scope cases 3 and 4: the seller claims "pad" and transfers it; one server
// withholds the transfer and pads its list to 256 hints with real records about other names, so the union (257) is
// refused at the cap, a failure that is not short, and the recovery runs while the transfer's block cannot be read.
{
  const keyS = "0x" + "5b".repeat(32), keyF = "0x" + "6b".repeat(32), SELLER = addrFromPriv(keyS).toLowerCase(), BUYER = "0x" + "c4".repeat(20);
  const pClaim = proposeTx({ ...pick(buildNameClaim({ name: "pad" })), priv: keyS, outputs: feeOut() });
  const pXfer = proposeTx({ ...pick(buildNameXfer({ name: "pad", to: BUYER })), priv: keyS });
  const filler = [];
  for (let k = 0; k < 255; k++) filler.push({ height: 33720, tx: proposeTx({ ...pick(buildNameClaim({ name: "zzpad" + k })), priv: keyF, outputs: feeOut() }) });
  const pw = world([{ height: 33700, tx: pClaim }, { height: 33710, tx: pXfer }, ...filler]);
  const honest = { ok: true, events: pw.hints.slice(0, 2), resolve: { addr: BUYER, owner: BUYER, via: "owner" }, scopedReplaySufficient: true };
  const padded = { ok: true, events: [pw.hints[0], ...pw.hints.slice(2)], resolve: { addr: SELLER, owner: SELLER, via: "owner" }, scopedReplaySufficient: true };
  const fine = source(pw.blocks, 33800);
  const unread = { ...fine, blockAt: async (h) => { if (h === 33710) throw new Error("GET /block -> HTTP 429"); return fine.blockAt(h); } };
  await test("a server's own replay that is short ends the recovery: the padding server does not verify the seller", async () => {
    const r = await verifyNameUnion("pad", sources, unread, mkFetch({ [PRIM]: honest, [CLAR]: padded }));
    assert.equal(r.verified, false, `got ${r.addr === SELLER ? "the seller" : r.addr} verified`);
    assert.equal(r.addr, undefined);
  });
  await test("the same when the transfer's block body does not bind to its header: the seller is not verified", async () => {
    const r = await verifyNameUnion("pad", sources, source(pw.blocks, 33800, { tamperMerkle: 33710 }), mkFetch({ [PRIM]: honest, [CLAR]: padded }));
    assert.equal(r.verified, false, `got ${r.addr === SELLER ? "the seller" : r.addr} verified`);
    assert.equal(r.addr, undefined);
  });
}

// (5), (6) A second server's hint at a real transaction the chain refutes as a name record.
{
  const signed = proposeTx({ ...pick(buildNameClaim({ name: "zzother" })), priv: key, outputs: feeOut() });
  const { txid: _t, ...body } = signed;
  const unsigned = nodeTx({ ...body, inputs: [{ ...body.inputs[0], script_sig: "0x" }] });
  const notOwner = proposeTx({ ...pick(buildNameClaim({ name: "zzother2" })), priv: key, outputs: feeOut(), prevScriptPubkey: "0x" + "d1".repeat(20) });
  const rw = world([{ height: 33700, tx: claim }, { height: 33710, tx: nset }, { height: 33720, tx: unsigned }, { height: 33730, tx: notOwner }]);
  const good = { ...history, events: rw.hints.slice(0, 2) };
  for (const [label, bad] of [["an unsigned transaction", rw.hints[2]], ["a transaction whose signer does not own the coin", rw.hints[3]]]) {
    await test(`a second server's hint naming ${label}: the recovery still proves the honest winner`, async () => {
      const r = await verifyNameUnion(NAME, sources, source(rw.blocks, 33800), mkFetch({ [PRIM]: good, [CLAR]: { ...good, events: [...good.events, bad] } }));
      assert.equal(r.verified, true, `expected recovery, got: ${r.reason}`);
      assert.equal(r.addr, TARGET);
      assert.equal(r.soleSource, true);
    });
  }
}

console.log(`namespv-union-throw: ${n} passed, 0 failed`);
