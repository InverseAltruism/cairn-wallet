// The `anchors` option takes only a prefix of the release table, and the light client still enforces every release
// entry (cairn docs/Plans/86 section 3.2: no code path removes, skips or overrides a `checkpoints` entry). To give a
// real chain something to contradict, this process changes the release entry at 114,687 BEFORE namespv.ts loads,
// so the release checkpoint map pins a hash the real chain does not have there. A source built on the 20-entry
// prefix (newest 110,591) must then refuse to sync across 114,687; with only the prefix's pins it would sync on.
// Real mainnet headers, offline. Run: npx tsx test/namespv-anchor-prefix.test.mjs
import assert from "node:assert/strict";
import { serveFixture, memStore, legacyOf, hashOf, FIX_TOP, FIX_ANCHORS } from "./helpers/spvfixture.mjs";
import { SPV_ANCHORS } from "../src/core/spvanchors.ts";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

const CONTRADICTED = 114687;
SPV_ANCHORS[20] = hashOf(CONTRADICTED - 1);   // a real hash, at the wrong height
const { liveSpvSource, flushSpvStoreWrites, SPV_CHECKPOINTS } = await import("../src/core/namespv.ts");

const API = "https://cairn-substrate.test";
const net = {};
serveFixture(net);
const PREFIX = FIX_ANCHORS.slice(0, 20);
const opts = (store) => ({ rpcBase: `${API}/api/rpc`, headersBase: API, anchors: PREFIX, store: async () => store, legacy: legacyOf(new Map()) });
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e?.message ?? e); } };

console.log("an anchors prefix keeps every release pin:");

await test("setup: the release checkpoint map pins the changed hash at 114,687, and the prefix ends at 110,591", async () => {
  assert.equal(SPV_CHECKPOINTS[CONTRADICTED], hashOf(CONTRADICTED - 1));
  assert.notEqual(SPV_CHECKPOINTS[CONTRADICTED], hashOf(CONTRADICTED));
  assert.equal(PREFIX[19], hashOf(110591));
});

await test("a sync across the release entry above the prefix refuses with the checkpoint copy naming 114,687", async () => {
  net.log.length = 0;
  net.tip = FIX_TOP;
  const st = memStore();
  const src = await liveSpvSource(opts(st));
  const err = await rejects(src.prepare(FIX_TOP - 12));
  await flushSpvStoreWrites();
  assert.ok(err?.includes(`could not match the chain to its built-in checkpoints (height ${CONTRADICTED})`), err ?? "prepare did not refuse");
  assert.equal(await src.hashAt(CONTRADICTED), null, "no header at the contradicted height was adopted");
  assert.ok(!st.head || st.head.tip < CONTRADICTED, `the store holds nothing at or above ${CONTRADICTED}`);
});

await test("honest path: the same prefix source syncs and proves heights below the contradicted entry", async () => {
  net.log.length = 0;
  const src = await liveSpvSource(opts(memStore()));
  const p = await src.prepare(114000 - 12);
  assert.equal(p.verifiedTip, 114000);
  assert.equal(await src.hashAt(114000), hashOf(114000));
  assert.equal(await src.hashAt(108000), hashOf(108000));
});

console.log(`namespv-anchor-prefix: ${n} passed, 0 failed`);
