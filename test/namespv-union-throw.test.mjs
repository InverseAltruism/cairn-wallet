// verifyNameUnion: a hint that makes the UNIONED replay throw (here a block the SPV source cannot serve)
// must not abort into the outer fail-closed catch. The union replay is caught like the solo replays, so
// per-source recovery runs and the honest source's own proof still decides. Paired honest path: two
// agreeing clean sources verify as a strong two-source result.
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

// Height 33750 is below the verified tip (33800), so replayName reaches src.blockAt, which throws for a
// block it holds no verified header for. Before the fix that throw escaped to the outer catch.
const throwingHint = { txid: "0x" + "9d".repeat(32), height: 33750, pos: 0, kind: "name" };

await test("a source whose hint throws does not abort the union: solo recovery proves the honest winner", async () => {
  const poison = { ...history, events: [...hints, throwingHint] };
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: history, [CLAR]: poison }));
  assert.equal(r.verified, true, `expected recovery, got: ${r.reason}`);
  assert.equal(r.addr, TARGET);
  assert.equal(r.recovered, true);
  assert.equal(r.soleSource, true);
  assert.equal(r.disagree, true);
  assert.equal(r.sources, 2);
});

await test("when every source's own replay throws, the result is still fail-closed", async () => {
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

console.log(`namespv-union-throw: ${n} passed, 0 failed`);
