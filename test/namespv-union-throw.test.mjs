// verifyNameUnion over the SpvSource seam. (1) a source's hint the chain refutes (a txid not in its verified block)
// does not take verification away from an honest name: the per-source recovery proves the honest winner. The live
// source cannot throw for a hint at or below its verified tip by the hint alone (a header there is in memory or read
// from the store or the header host, a body by its verified hash from the node, and fetchNameUnion drops a hint below
// the names floor), so a throw is a read the wallet could not make: (2) a read that keeps failing is fail-closed,
// with no server's subset in its place. (3) a record above the verified tip at or below the served tip is such a read
// too: no recovery to the lagging server's holding. Paired honest paths: two agreeing clean sources verify as a
// strong two-source result; headers covering the record prove the current address.
// Run: npx tsx test/namespv-union-throw.test.mjs
import assert from "node:assert/strict";
import { verifyNameUnion } from "../src/core/namespv.ts";
import { buildNameClaim, buildNameSet, addrFromPriv, proposeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";

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

console.log(`namespv-union-throw: ${n} passed, 0 failed`);
