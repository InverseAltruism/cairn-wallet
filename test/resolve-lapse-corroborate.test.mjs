// N19 (B5b, REBIND): resolveName no longer hard-refuses on a single source's SERVED `lapsed` flag.
//
// The old short-circuit fired BEFORE verifyName (the SPV union), so the Plan 70 Batch H two-source
// lapse corroboration (WALLET-LAPSE-TIP-1) hardened a verdict NOTHING consumed - the exploitable
// cheap half (one hostile/buggy primary permanently blocks sends to a healthy name by serving
// lapsed:true) stayed open while the expensive half shipped unconsumed. Now the served flag is
// CORROBORATED: chain proves the lease CURRENT -> the send proceeds on the PROVEN address (the served
// flag was a lie); the union corroborates the lapse -> refuse with confidence; union unavailable ->
// keep the fail-closed refusal with honest uncorroborated copy. A REAL lapse refuses exactly as
// before - the change only removes the FALSE refusal (the standing no-UX-regression rule).
//
// MUTATION CONTRACT: reverting the resolveName lapsed branch to the pre-B5b one-liner
// (`if (j?.lapsed) return { ok:false, ... }`) REDS case 1 (the false-lapse route-around).
//
// Run: node --import tsx test/resolve-lapse-corroborate.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;

const ADDR = "0x" + "ab".repeat(20);
const SPV_ADDR = "0x" + "5d".repeat(20);

function lapsedStub() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/cairnx/resolve/")) return { ok: true, status: 200, json: async () => ({ addr: ADDR, via: "nset", owner: ADDR, lapsed: true }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
}

async function freshWallet(verifyName) {
  const w = new Wallet(memoryStore());
  await w.create("pw-lapse-12345");
  w.verifyName = verifyName;   // instance override: isolate the corroboration wiring from the SPV machinery
  return w;
}

console.log("N19 (B5b) - served-lapse corroboration in resolveName:");

// 1. FALSE LAPSE (the N19 attack): primary serves lapsed:true, the SPV union proves the lease CURRENT.
//    The send proceeds on the PROVEN address. Pre-B5b this returned ok:false - the mutation contract.
{
  lapsedStub();
  const w = await freshWallet(async () => ({ verified: true, addr: SPV_ADDR, depth: 9, sources: 2, agreed: 2, disagree: false, scope: "full" }));
  const r = await w.resolveName("alice");
  check(`false lapse routed around: ok:true on the SPV-PROVEN address (${r.addr})`, r.ok === true && r.addr === SPV_ADDR && r.verified === true);
  check("...and the result is not marked lapsed", r.lapsed === false);
}

// 2. REAL LAPSE: the union corroborates (lapsed === true) -> confident refusal, same copy as before.
{
  lapsedStub();
  const w = await freshWallet(async () => ({ verified: false, lapsed: true, reason: "lease lapsed - refusing", scope: "full" }));
  const r = await w.resolveName("alice");
  check("corroborated lapse still refuses (no relaxation on a REAL lapse)", r.ok === false && /lease has lapsed/.test(r.error || ""));
  check("...and carries lapsed:true for the UI", r.lapsed === true);
}

// 3. UNION UNAVAILABLE: fail-closed refusal kept, with HONEST uncorroborated copy (not the confident claim).
{
  lapsedStub();
  const w = await freshWallet(async () => { throw new Error("spv offline"); });
  const r = await w.resolveName("alice");
  check("uncorroborated lapse still refuses (fail-closed)", r.ok === false);
  check("...with honest copy that the claim was NOT confirmed on-chain", /couldn't be confirmed on-chain/.test(r.error || ""));
}

// 4. Union answers but neither verifies nor corroborates (e.g. degraded single source): fail-closed, honest copy.
{
  lapsedStub();
  const w = await freshWallet(async () => ({ verified: false, reason: "only one name source reachable", scope: "as-shown" }));
  const r = await w.resolveName("alice");
  check("non-corroborating union keeps the fail-closed refusal with the uncorroborated copy", r.ok === false && /couldn't be confirmed on-chain/.test(r.error || ""));
}

globalThis.fetch = origFetch;
console.log(`\nresolve-lapse-corroborate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
