// 0.2.70 hint-set confirm (advisor 2.4): skip merkle/prevout only on a clean cached union
// when sorted (txid,height) pairs match, no source served lapsed:true, header hashes are
// unchanged, and the short TTL / tip-epoch bound still holds. Recompute disagree/sources
// from the fresh claims. Never cache/skip M12 recovered / soleSource (pinned at the write site).
import { evaluateHintSetSkip, hintPairsEqual, sortHintPairs, HINTSET_TTL_MS } from "../src/core/namecache.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const okA = async (n, fn) => { try { ok(n, await fn()); } catch (e) { fail++; console.log("  ✗", n, "\n      ", e.stack || e.message); } };

const PAIRS = sortHintPairs([{ txid: "0xAA", height: 10 }, { txid: "0xbb", height: 12 }]);
const HASHES = { 10: "0xhash10", 12: "0xhash12" };
const cache = {
  name: "alice", pairs: PAIRS, hashes: HASHES, addr: "0x" + "ab".repeat(20),
  owner: "0x" + "ab".repeat(20), via: "nset", depth: 8, ts: 1_000_000, epoch: 100,
};
const claims = [{ addr: cache.addr }, { addr: cache.addr }];
const hashAt = async (h) => HASHES[h] ?? null;

console.log("evaluateHintSetSkip (advisor 2.4):");

await okA("clean set + hashes + epoch + TTL → skip", async () => {
  const v = await evaluateHintSetSkip({ cache, pairs: PAIRS, claims, conflict: false, existenceDisagree: false, now: cache.ts + 1_000, epoch: 100, hashAt });
  return v.skip === true && v.sources === 2 && v.disagree === false;
});

await okA("recomputes disagree from a fresh claim mismatch even on skip", async () => {
  const v = await evaluateHintSetSkip({
    cache, pairs: PAIRS,
    claims: [{ addr: cache.addr }, { addr: "0x" + "ee".repeat(20) }],
    conflict: false, existenceDisagree: false, now: cache.ts + 1_000, epoch: 100, hashAt,
  });
  return v.skip === true && v.disagree === true && v.sources === 2;
});

await okA("sorted (txid,height) compare is order-insensitive", async () => {
  const shuffled = sortHintPairs([{ txid: "0xbb", height: 12 }, { txid: "0xAA", height: 10 }]);
  return hintPairsEqual(PAIRS, shuffled);
});

await okA("hint-set change refuses skip (re-point / new event)", async () => {
  const v = await evaluateHintSetSkip({
    cache, pairs: sortHintPairs([...PAIRS, { txid: "0xcc", height: 13 }]),
    claims, conflict: false, existenceDisagree: false, now: cache.ts + 1_000, epoch: 100, hashAt,
  });
  return v.skip === false && v.reason === "hint-set";
});

await okA("served lapsed:true refuses skip (full verify must see the lease)", async () => {
  const v = await evaluateHintSetSkip({
    cache, pairs: PAIRS, claims: [{ addr: cache.addr, lapsed: true }, { addr: cache.addr }],
    conflict: false, existenceDisagree: false, now: cache.ts + 1_000, epoch: 100, hashAt,
  });
  return v.skip === false && v.reason === "lapsed";
});

await okA("header-hash change refuses skip", async () => {
  const v = await evaluateHintSetSkip({
    cache, pairs: PAIRS, claims, conflict: false, existenceDisagree: false,
    now: cache.ts + 1_000, epoch: 100, hashAt: async (h) => h === 12 ? "0xOTHER" : HASHES[h],
  });
  return v.skip === false && v.reason === "header-hash";
});

await okA("TTL expiry refuses skip (long-open review card)", async () => {
  const v = await evaluateHintSetSkip({
    cache, pairs: PAIRS, claims, conflict: false, existenceDisagree: false,
    now: cache.ts + HINTSET_TTL_MS + 1, epoch: 100, hashAt,
  });
  return v.skip === false && v.reason === "ttl";
});

await okA("tip-epoch change refuses skip (lapse crossing)", async () => {
  const v = await evaluateHintSetSkip({
    cache, pairs: PAIRS, claims, conflict: false, existenceDisagree: false,
    now: cache.ts + 1_000, epoch: 101, hashAt,
  });
  return v.skip === false && v.reason === "epoch";
});

await okA("missing tip epoch refuses skip", async () => {
  const v = await evaluateHintSetSkip({
    cache, pairs: PAIRS, claims, conflict: false, existenceDisagree: false,
    now: cache.ts + 1_000, epoch: null, hashAt,
  });
  return v.skip === false && v.reason === "no tip epoch";
});

await okA("no hashAt seam refuses skip (cannot prove headers unchanged)", async () => {
  const v = await evaluateHintSetSkip({
    cache, pairs: PAIRS, claims, conflict: false, existenceDisagree: false,
    now: cache.ts + 1_000, epoch: 100,
  });
  return v.skip === false && v.reason === "no hashAt";
});

console.log("Wallet.confirmName skip (no merkle on the cheap path):");
{
  const TARGET = "0x" + "ab".repeat(20);
  const origFetch = globalThis.fetch;
  const merkleHits = { n: 0 };
  const w = new Wallet(memoryStore());
  await w.create("pw-hintset-confirm");
  w.nameHintCacheForTest().set("alice", { ...cache, addr: TARGET, ts: Date.now(), epoch: Math.floor(33800 / 30) });
  w.nameSpvForTest = {
    prepare: async () => ({ verifiedTip: 33800, nodeTip: 33800 }),
    blockAt: async () => { merkleHits.n++; throw new Error("merkle must not run on skip"); },
    prevoutScriptPubkey: async () => { merkleHits.n++; throw new Error("prevout must not run on skip"); },
    hashAt: async (h) => HASHES[h] ?? null,
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 33800 }) };
    if (u.includes("/cairnx/name-history/")) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, events: PAIRS, resolve: { addr: TARGET, owner: TARGET, via: "nset" } }),
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  try {
    const r = await w.confirmName("alice");
    ok("confirmName skip returns the cached proven addr (verified)", r.ok === true && r.addr === TARGET && r.verified === true);
    ok("confirmName skip did not touch merkle/prevout", merkleHits.n === 0);
    ok("confirmName skip recomputes sources from the fresh histories", r.sources === 2);
  } finally { globalThis.fetch = origFetch; }
}

console.log("write-site pins (never cache M12 / soleSource):");
const walletSrc = readFileSync(new URL("../src/core/wallet.ts", import.meta.url), "utf8");
ok("rememberHintSet refuses recovered (M12)", /res\.recovered/.test(walletSrc) && /rememberHintSet/.test(walletSrc));
ok("rememberHintSet refuses soleSource", /res\.soleSource/.test(walletSrc));
ok("verifyName fail-softs rememberHintSet (own try/catch; cache throw cannot downgrade a green verify)",
  /try\s*\{\s*await this\.rememberHintSet\(nm, res\);\s*\}\s*catch/.test(walletSrc));
ok("verifyNameUnion marks M12 recovered:true", /recovered: true/.test(readFileSync(new URL("../src/core/namespv.ts", import.meta.url), "utf8")));
ok("popup confirm path calls confirmName (not resolveName)", /call\("confirmName"/.test(readFileSync(new URL("../src/popup/popup.ts", import.meta.url), "utf8")));

console.log(`\nhintset-confirm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
