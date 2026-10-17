// SPV-5 (cairn docs/Plans/86 section 4.9, section 6 case 18): when the node tip cannot be read, prepare() syncs
// nothing and says so (tipKnown: false), instead of asking /api/headers for heights up to MAX_SAFE_INTEGER + 12.
// A name proof below the verified tip still verifies; the fclaim fill lane, which needs burial to the chain tip,
// refuses. Each is paired with the working tip read on the same call shape. Real mainnet headers, offline.
// Run: npx tsx test/spv-unknown-tip.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serveFixture, memStore, legacyOf, FIX_TOP, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";
import { liveSpvSource, verifyNameUnion } from "../src/core/namespv.ts";
import { liveFillSpvSource } from "../src/core/fillspv.ts";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

const API = "https://cairn-substrate.test";
const RPC = `${API}/api/rpc`;
const net = {};
serveFixture(net);
const NAME = JSON.parse(readFileSync(new URL("./fixtures/name-cairn-30224.json", import.meta.url), "utf8"));
net.blocks = new Map([[NAME.block.height, NAME.block]]);
net.txs = new Map([[NAME.prevout.txid, NAME.prevout]]);
const nameFetch = async (url) => String(url).endsWith("/cairnx/name-history/cairn") ? Response.json(NAME.history) : new Response("{}", { status: 404 });
const opts = () => ({ rpcBase: RPC, headersBase: API, anchors: FIX_ANCHORS, store: async () => memStore(), legacy: legacyOf(new Map()) });
const reset = (tipDown) => { net.log.length = 0; net.tip = FIX_TOP; net.tipDown = tipDown; };
const above = () => net.log.filter((p) => Number(p.split("/")[0]) > NEWEST);
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e?.message ?? e); } };
const fillHints = { offerId: "0x" + "11".repeat(32), fclaimTxid: "0x" + "22".repeat(32), me: "0x" + "33".repeat(20), offerHeight: 108000 };
const TIP_REFUSAL = /node tip could not be read/;

console.log("SPV-5: an unknown node tip:");

await test("prepare(MAX_SAFE_INTEGER) with the tip unreadable syncs nothing and reports tipKnown false", async () => {
  reset(true);
  const src = await liveSpvSource(opts());
  net.log.length = 0;
  const p = await src.prepare(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(net.log, [], "no /api/headers request");
  assert.equal(p.verifiedTip, NEWEST);
  assert.equal(p.tipKnown, false);
  assert.equal(p.nodeTip, 0, "no floor yet, and no served tip");
});

await test("honest path: with the tip readable, prepare(MAX_SAFE_INTEGER) syncs to the node tip", async () => {
  reset(false);
  const src = await liveSpvSource(opts());
  net.log.length = 0;
  const p = await src.prepare(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(net.log, ["114688/512"]);
  assert.equal(p.verifiedTip, FIX_TOP);
  assert.equal(p.tipKnown, true);
  assert.equal(p.nodeTip, FIX_TOP);
});

await test("a name whose record is below the verified tip still verifies with the tip unreadable, with no sync", async () => {
  reset(true);
  const v = await verifyNameUnion("cairn", [{ label: "cairn", base: `${API}/trade/api` }], await liveSpvSource(opts()), nameFetch);
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.addr, NAME.history.resolve.addr);
  assert.deepEqual(above(), []);
});

await test("the fclaim fill lane refuses with the tip unreadable, before any scan or sync", async () => {
  reset(true);
  const live = await liveSpvSource(opts());
  net.log.length = 0;
  const err = await rejects(liveFillSpvSource({ rpcBase: RPC, headersBase: API, spvSource: live, hints: fillHints }));
  assert.match(err ?? "", TIP_REFUSAL);
  assert.deepEqual(net.log, []);
});

await test("honest path: with the tip readable the fill lane syncs to the tip and gets past the tip check", async () => {
  reset(false);
  const live = await liveSpvSource(opts());
  net.log.length = 0;
  const err = await rejects(liveFillSpvSource({ rpcBase: RPC, headersBase: API, spvSource: live, hints: fillHints }));
  assert.deepEqual(net.log, ["114688/512"], "the suffix to the node tip was synced");
  assert.ok(err !== null && !TIP_REFUSAL.test(err), `the refusal is the scan's, not the tip's: ${err}`);
});

console.log(`spv-unknown-tip: ${n} passed, 0 failed`);
