// An endpoint change while a name verification or a confirm is in flight, through the Wallet's real SPV singleton
// and setters (only the builder is synthetic: spvBuildForTest returns a source per API endpoint). Source A (the
// first API) holds the name's signed records; source B (the API set mid-flight) does not, so a full verification
// against B is not green. The hint-set cache lets confirmName skip the merkle and prevout reads, so it must hold
// only results verified under the current endpoints.
//   RED-FIRST: drop the `gen !== this.spvGen` check in rememberHintSet and (1) caches A's result after the
//   switch; drop it in tryConfirmHintSet and (2) confirms green from A's cache with no read against B; drop the
//   cache clear in endpointChanged and (4) does the same after a change made with nothing in flight.
//   PAIRED HONEST PATH: (3) no settings change: the cache is written and confirmName uses it (zero block reads).
// Run: npx tsx test/spv-endpoint-race.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { checker } from "./helpers/check.mjs";
import { buildNameClaim, buildNameSet, addrFromPriv, ctxid, rpcTxToTx, proposeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";

const { check, done } = checker("SPV endpoint change during a name verification or confirm:");

const PRIMARY = "https://cairn-substrate.com/trade/api";
const CLARVIS = "https://clarvis.cairn-substrate.com/trade/api";
const RPC = "https://cairn-substrate.com/api/rpc";
const API_A = "https://cairn-substrate.com", API_B = "https://api2.cairn-substrate.test";
const key = "0x" + "11".repeat(32), OWNER = addrFromPriv(key).toLowerCase(), TARGET = "0x" + "cd".repeat(20);
const NM = "carol";
const claim = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: key, outputs: feeOut() });
const nset = proposeTx({ ...pick(buildNameSet({ name: NM, addr: TARGET })), priv: key });
const { blocks } = world([{ height: 33700, tx: claim }, { height: 33710, tx: nset }]);
const H = (tx, h) => ({ txid: ctxid(rpcTxToTx(tx)), height: h, pos: 0 });
const history = { ok: true, resolve: { addr: TARGET, owner: OWNER, via: "nset" }, events: [H(claim, 33700), H(nset, 33710)] };
const resolved = { addr: TARGET, owner: OWNER, via: "nset" };
// The resolvers' /cairnx/resolve answer (untrusted, the address to verify), their name histories, and the tip.
const serve = () => mkFetch({ [`${PRIMARY}/cairnx/resolve/`]: resolved, [PRIMARY]: history, [CLARVIS]: history, [RPC]: { height: 33800 } });
const hashOf = (h) => "0x" + h.toString(16).padStart(64, "0");

// One synthetic source per API endpoint. Both report the same header hashes, so only the generation check can
// tell a cache entry made under A from one made under B. `gate` holds A's next block read.
function harness() {
  const reads = { A: 0, B: 0 };
  let gate = null;
  const make = (tag, chain) => {
    const s = source(chain, 33800);
    return { ...s, hashAt: async (h) => hashOf(h), async blockAt(h) { reads[tag]++; if (tag === "A" && gate) await gate; return s.blockAt(h); } };
  };
  const w = new Wallet(memoryStore());
  w.spvBuildForTest = async (opts) => (opts.headersBase === API_B ? make("B", new Map()) : make("A", blocks));
  return { w, reads, hold() { let r; gate = new Promise((res) => { r = res; }); return () => { gate = null; r(); }; } };
}
const origFetch = globalThis.fetch;
globalThis.fetch = serve();

try {
  {
    console.log("(1) verifyName on A, setApi(B) while A awaits a block read:");
    const { w, reads, hold } = harness();
    await w.create("pw-spv-race-1");
    const release = hold();
    const pending = w.verifyName(NM);
    while (reads.A === 0) await new Promise((r) => setTimeout(r, 1));
    await w.setApi(API_B);
    release();
    const r = await pending;
    check("(1) A's own result is still returned to its caller (verified on A)", r.verified === true && r.addr === TARGET);
    check("(1) the superseded verification wrote no hint-set entry", !w.nameHintCacheForTest().has(NM));
    const c = await w.confirmName(NM);
    check(`(1) confirmName under B is not green (verified=${c.verified})`, c.verified !== true);
    check("(1) and it read B's blocks (a full verification ran)", reads.B > 0);
  }
  {
    console.log("(2) a cache made under A, setApi(B) while confirmName reads the name history:");
    const { w, reads } = harness();
    await w.create("pw-spv-race-2");
    const v = await w.verifyName(NM);
    check("(2) setup: verified on A and cached", v.verified === true && w.nameHintCacheForTest().has(NM));
    let switched = false;
    globalThis.fetch = async (url, init) => {
      if (!switched && String(url).includes("/cairnx/name-history/")) { switched = true; await w.setApi(API_B); }
      return serve()(url, init);
    };
    const c = await w.confirmName(NM);
    check("(2) the switch happened inside confirmName", switched);
    check(`(2) confirmName does not answer green from A's cache (verified=${c.verified})`, c.verified !== true);
    check("(2) it fell through to a full verification against B", reads.B > 0);
    globalThis.fetch = serve();
  }
  {
    console.log("(4) a cache made under A, then setApi(B) with nothing in flight:");
    const { w, reads } = harness();
    await w.create("pw-spv-race-4");
    await w.verifyName(NM);
    check("(4) setup: cached under A", w.nameHintCacheForTest().has(NM));
    await w.setApi(API_B);
    check("(4) the endpoint change clears the cache", !w.nameHintCacheForTest().has(NM));
    const c = await w.confirmName(NM);
    check(`(4) confirmName under B is not green (verified=${c.verified})`, c.verified !== true && reads.B > 0);
  }
  {
    console.log("(3) honest path, no settings change:");
    const { w, reads } = harness();
    await w.create("pw-spv-race-3");
    const v = await w.verifyName(NM);
    check("(3) verified and cached", v.verified === true && w.nameHintCacheForTest().has(NM));
    const before = reads.A;
    const c = await w.confirmName(NM);
    check("(3) confirmName answers green from the cache", c.ok === true && c.verified === true && c.addr === TARGET);
    check("(3) with zero block reads", reads.A === before && reads.B === 0);
    await w.setApi(API_A);
    check("(3) an unchanged API keeps the cache", w.nameHintCacheForTest().has(NM));
  }
} finally { globalThis.fetch = origFetch; }

done("spv-endpoint-race");
