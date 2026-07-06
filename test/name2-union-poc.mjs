// NAME-2 regression test — attacks on the clarvis UNION (verifyNameUnion), over REAL signed txs + synthetic
// PoW blocks (shared _spvrig). Converted 2026-07-06 from an exit-0 PoC into an ASSERTING regression of the
// FIXED behavior: the union routes to the SPV-proven on-chain winner; a poisoned 2nd-source hint VETOes
// (fail-closed); a network-blocked 2nd source degrades to single-source; identical bases de-dup. It now
// FAILS LOUD if any of those properties regress. Run: tsx test/name2-union-poc.mjs
import { verifyNameUnion } from "../src/core/namespv.ts";
import { checker } from "./_check.ts";
import { buildNameClaim, buildNameSet, addrFromPriv, proposeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";

const { check, done } = checker("NAME-2 union attacks (verifyNameUnion against REAL signed records):");

const keyEvil = "0x" + "77".repeat(32);
const EVIL = addrFromPriv(keyEvil).toLowerCase();
const ATTACKER = "0x" + "ee".repeat(20);   // attacker payout addr (also the real on-chain nset target here)

// World: the ATTACKER actually registered + nset `alice`→ATTACKER on-chain (real, signed, mined, fee-paid).
const NAME = "alice";
const evilClaim = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyEvil, outputs: feeOut() });
const evilNset = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: ATTACKER })), priv: keyEvil });
const { blocks, hints } = world([{ height: 33700, tx: evilClaim }, { height: 33710, tx: evilNset }]);
const evilHistory = { ok: true, events: hints, resolve: { addr: ATTACKER, owner: EVIL, via: "nset" }, scopedReplaySufficient: true };
const PRIM = "https://cairn-substrate.com/trade/api";
const CLAR = "https://clarvis.cairn-substrate.com/trade/api";
const sources = [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLAR }];

// [C] one apex/CDN serves the SAME records from BOTH hostnames (fake "2 independent sources"). The union
// still routes to the SPV-PROVEN on-chain owner (ATTACKER genuinely registered it in this world); the only
// documented residual is that identical-content-across-distinct-hosts is not flagged as non-independent.
{
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: evilHistory, [CLAR]: evilHistory }));
  console.log("[C] identical apex records on both hosts: verified=%s addr=%s sources=%s disagree=%s", r.verified, r.addr, r.sources, r.disagree);
  check("[C] union routes to the SPV-proven on-chain owner (never an unproven addr)", r.verified === true && r.addr === ATTACKER && r.sources === 2 && r.disagree === false);
}

// [B] clarvis (the 2nd source) is COMPROMISED and poisons the union with one bogus hint above the tip. A
// 2nd-source compromise alone must VETO verification (fail-closed DoS downgrade) — the core regression guard.
{
  const poison = { ok: true, events: [...hints, { txid: "0x" + "ab".repeat(32), height: 999999, pos: 0, kind: "name" }], resolve: { addr: ATTACKER, owner: EVIL, via: "nset" } };
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: evilHistory, [CLAR]: poison }));
  console.log("[B] clarvis injects a bogus hint (h=999999): verified=%s reason=%j", r.verified, r.reason);
  check("[B] a poisoned 2nd-source hint (above the verified tip) VETOes verification (fail-closed)", r.verified === false);
}

// [A] clarvis blocked at the network layer (distinct SNI). fetch throws → the union degrades to single-source
// verified (caution badge), still routing to the proven addr — never a silent hard failure.
{
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: evilHistory, [CLAR]: "throw" }));
  console.log("[A] clarvis network-blocked: verified=%s addr=%s sources=%s", r.verified, r.addr, r.sources);
  check("[A] a network-blocked 2nd source degrades to single-source verified (fail-soft)", r.verified === true && r.addr === ATTACKER && r.sources === 1);
}

// [D] both sources point at the SAME base (a user / setApi collapse): de-dup must collapse the union to one.
{
  const r = await verifyNameUnion(NAME, [{ label: "primary", base: CLAR }, { label: "clarvis", base: CLAR }], source(blocks, 33800), mkFetch({ [CLAR]: evilHistory }));
  console.log("[D] both sources same base: sources=%s", r.sources);
  check("[D] identical bases de-dup to a single source (no phantom independence)", r.sources === 1);
}

done("name2-union");
