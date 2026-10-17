// The reseed's work rule (cairn docs/Plans/86, D-86-9 part 1): after a structural sync break the fresh light
// client replaces the held one only when its cumulative work exceeds the held chain's (`reseedAdopts`).
//
// What this file can show: the rule itself, on bigint work and on two light clients built from real mainnet
// headers through the vendored `fromRecords` and `sync` (the same work accounting production uses, on the same
// seed), and that `prepare`'s reseed calls the rule before adopting. What it cannot show: a lower-work chain
// adopted or refused end to end through `liveSpvSource`, because the only PoW-valid headers available offline
// are the one real chain, and a competing valid chain would need real work. The honest recovery cases (a page
// that breaks once, a stale stored suffix overtaken by the served chain, a corrupt or short stored suffix) run
// through `liveSpvSource` in test/namespv-store-pins.test.mjs and stay green with the rule in place.
//
// Red-first: make `reseedAdopts` return true (or compare with >=) and the equal and lower-work checks below
// fail; remove the call at the use-site (the MUTATE_RESEED_WORK line) and the use-site check fails.
// Run: npx tsx test/namespv-reseed-work.test.mjs   (offline)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LightClient, HEADER_BYTES } from "../src/vendor/cairnx-spv.js";
import { reseedAdopts, SPV_CHECKPOINTS, syncAligned } from "../src/core/namespv.ts";
import { records, row, FIX_TOP, NEWEST } from "./helpers/spvfixture.mjs";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("  ok " + name); };

console.log("the reseed work rule:");

await test("pure rule: more work adopts, equal and less keep the current chain", async () => {
  assert.equal(reseedAdopts({ chainwork: 10n }, { chainwork: 11n }), true);
  assert.equal(reseedAdopts({ chainwork: 10n }, { chainwork: 10n }), false);
  assert.equal(reseedAdopts({ chainwork: 10n }, { chainwork: 9n }), false);
  assert.equal(reseedAdopts({ chainwork: 0n }, { chainwork: 1n }), true);
});

// Two clients seeded like production (the anchor chunk's last 46 records, anchor 114,687), synced over the real
// chain with the vendored verifier, so chainwork is the vendored accounting on real headers.
const SEED = 46;
const seed = records(NEWEST - SEED + 1, NEWEST);
const pages = async (from, count) => { const out = []; for (let h = from; h < from + count; h++) out.push(row(h)); return out; };
async function clientTo(tip) {
  const { client, failed } = await LightClient.fromRecords(seed, { firstHeight: NEWEST - SEED + 1, anchorHeight: NEWEST }, { headersBatchProvider: pages, checkpoints: SPV_CHECKPOINTS });
  assert.equal(failed, undefined);
  if (tip > NEWEST) await syncAligned(client, tip);
  return client;
}
const tipOf = (lc) => lc.baseHeight + lc.chain.length - 1;

await test("real headers: the seed alone has work, and every synced header adds to it", async () => {
  const anchorOnly = await clientTo(NEWEST);
  const synced = await clientTo(FIX_TOP);
  assert.equal(tipOf(anchorOnly), NEWEST);
  assert.equal(tipOf(synced), FIX_TOP);
  assert.ok(anchorOnly.chainwork > 0n);
  assert.equal(synced.chain[0].chainwork, anchorOnly.chain[0].chainwork, "both clients start from the same seed record");
  let prev = 0n, increasing = 0;
  for (const h of synced.chain) { if (h.chainwork > prev) increasing++; prev = h.chainwork; }
  assert.equal(increasing, synced.chain.length, "chainwork is strictly increasing along the real chain");
  assert.equal(synced.chainwork, synced.chain[synced.chain.length - 1].chainwork);
});

await test("real headers: a fresh client synced further than the held one is adopted; one synced less, or the same, is not", async () => {
  const held = await clientTo(114900);
  const further = await clientTo(FIX_TOP);
  const shorter = await clientTo(114800);
  const same = await clientTo(114900);
  assert.equal(reseedAdopts(held, further), true);
  assert.equal(reseedAdopts(held, shorter), false);
  assert.equal(reseedAdopts(held, same), false);
  assert.equal(reseedAdopts(further, held), false);
});

await test("real headers: the work the honest suffix adds per block equals the anchor-era work per block within 20 percent", async () => {
  // The LWMA rule moves the target slowly, so the real suffix above 114,687 earns about one anchor-era block of
  // work per block. A forged fork decayed to the minimum difficulty earns a fraction of that per header (the
  // simulation in cairn docs/Plans/86 section 13, D-86-9), which is what the rule refuses.
  const anchorOnly = await clientTo(NEWEST);
  const synced = await clientTo(FIX_TOP);
  const perSeedBlock = Number(anchorOnly.chainwork / BigInt(SEED));
  const perSuffixBlock = Number((synced.chainwork - anchorOnly.chainwork) / BigInt(FIX_TOP - NEWEST));
  const ratio = perSuffixBlock / perSeedBlock;
  assert.ok(ratio > 0.8 && ratio < 1.2, `suffix work per block is ${ratio.toFixed(3)} of the seed's`);
  assert.equal(synced.chain.length * HEADER_BYTES, synced.toRecords(synced.baseHeight).length);
});

await test("use-site: prepare's reseed adopts the fresh client only through reseedAdopts, before `LC = fresh`", async () => {
  const src = readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8");
  const prep = src.slice(src.indexOf("async prepare(maxEventHeight"), src.indexOf("async blockAt(", src.indexOf("async prepare(maxEventHeight")));
  const guard = prep.indexOf("if (!reseedAdopts(LC, fresh)) throw lessWorkRefusal(headersBase, newest, tipOf(LC));");
  const adopt = prep.indexOf("LC = fresh;");
  const freshSync = prep.indexOf("await syncAligned(fresh, want);");
  assert.ok(guard > 0, "the reseed compares work through reseedAdopts");
  assert.ok(freshSync > 0 && guard > freshSync, "the comparison runs after the fresh client synced to `want`");
  assert.ok(adopt > guard, "the fresh client is adopted only after the comparison");
});

console.log(`namespv-reseed-work: ${n} passed, 0 failed`);
