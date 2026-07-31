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
  check("[C] NS-1 happy-path: a clean union (no recovery) is NOT flagged soleSource (strong 2-source badge unchanged)", !r.soleSource);
}

// [B] clarvis (the 2nd source) is COMPROMISED and poisons the union with one bogus hint above the tip.
// M12 (B5e) CHANGE (was: hard VETO -> caution): a single poisoning source can no longer DoS-downgrade a
// name the honest source independently PROVES. The union replay fails on the junk hint, then per-source
// recovery replays the HONEST primary's own complete history to the true on-chain winner and honors it as
// a single-source result. The poisoner is not trusted: disagree is flagged (the badge stays cautious). The
// green never comes from the poisoner's claim - it is the primary's OWN SPV proof of the real chain state.
{
  const poison = { ok: true, events: [...hints, { txid: "0x" + "ab".repeat(32), height: 999999, pos: 0, kind: "name" }], resolve: { addr: ATTACKER, owner: EVIL, via: "nset" } };
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: evilHistory, [CLAR]: poison }));
  console.log("[B] clarvis poisons the union: verified=%s addr=%s sources=%s disagree=%s", r.verified, r.addr, r.sources, r.disagree);
  check("[B] M12: the honest source's proof RECOVERS the true on-chain winner (no DoS-downgrade)", r.verified === true && r.addr === ATTACKER);
  check("[B] M12: a poisoning 2nd source is FLAGGED (disagree), never a silent green", r.disagree === true);
  check("[B] NS-1: a lone-source recovery is flagged soleSource (badge stops asserting multi-source verified)", r.soleSource === true);
}

// [B2] the REAL defense M12 must preserve: the poisoner's CLAIMED (unproven) address must NEVER win. The
// recovered winner is the HONEST source's own SPV proof, never a served claim. Here clarvis poisons AND
// lies that the owner is RIVAL (a never-registered address); recovery routes to the primary's proven
// ATTACKER, and flags disagree - it does NOT hand the send to the poisoner's RIVAL claim.
{
  const RIVAL = "0x" + "d1".repeat(20);   // never registered on-chain; only the poisoner CLAIMS it
  const poisonLie = { ok: true, events: [...hints, { txid: "0x" + "ac".repeat(32), height: 999999, pos: 0, kind: "name" }], resolve: { addr: RIVAL, owner: RIVAL, via: "nset" } };
  const r = await verifyNameUnion(NAME, sources, source(blocks, 33800), mkFetch({ [PRIM]: evilHistory, [CLAR]: poisonLie }));
  console.log("[B2] poisoner lies addr=RIVAL: verified=%s addr=%s disagree=%s", r.verified, r.addr, r.disagree);
  check("[B2] the recovered winner is the PROVEN addr, never the poisoner's served claim", r.addr === ATTACKER && r.addr !== RIVAL);
  check("[B2] and the poisoner's disagreement is flagged", r.verified === true && r.disagree === true);
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

// [E] NS-1 (HIGH residual): a HOSTILE LONE survivor. The name's FULL history repoints alice -> FINAL, but the
// honest primary poisons its OWN hints (a junk above-tip hint) so its solo replay fails, while the hostile
// clarvis serves a CLEAN but STALE subset (omitting the later nset) that solo-replays to the older ATTACKER.
// With the honest source out, the lone hostile source ALONE decides the send target. NS-1 keeps verified:true
// + the PROVEN winner (never dropping to the resolver-served addr = the B5e single-source DoS/trust regression)
// but FLAGS soleSource so the badge stops asserting multi-source "chain-verified". This closes NOTHING: the
// send still goes to the lone source's chosen (stale) address -- mitigation by disclosure, the recorded residual.
{
  const FINAL = "0x" + "f0".repeat(20);   // the TRUE current target the FULL history proves
  const laterNset = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: FINAL })), priv: keyEvil });
  const w2 = world([{ height: 33700, tx: evilClaim }, { height: 33710, tx: evilNset }, { height: 33720, tx: laterNset }]);
  const primHints = [...w2.hints, { txid: "0x" + "ba".repeat(32), height: 999999, pos: 0, kind: "name" }];   // primary poisons its OWN hints
  const primPoison = { ok: true, events: primHints, resolve: { addr: FINAL, owner: EVIL, via: "nset" } };
  const clarStale = { ok: true, events: w2.hints.slice(0, 2), resolve: { addr: ATTACKER, owner: EVIL, via: "nset" }, scopedReplaySufficient: true };   // clean but STALE subset
  const r = await verifyNameUnion(NAME, sources, source(w2.blocks, 33800), mkFetch({ [PRIM]: primPoison, [CLAR]: clarStale }));
  console.log("[E] hostile lone survivor: verified=%s addr=%s soleSource=%s disagree=%s", r.verified, r.addr, r.soleSource, r.disagree);
  check("[E] NS-1: the lone hostile survivor decides the target (addr = stale ATTACKER, not the true FINAL)", r.verified === true && r.addr === ATTACKER && r.addr !== FINAL);
  check("[E] NS-1: and the lone-source recovery is FLAGGED soleSource (the send still goes there — recorded residual)", r.soleSource === true);
}

done("name2-union");
