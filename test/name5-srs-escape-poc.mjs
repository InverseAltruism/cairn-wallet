// NAME-5 regression test — the scopedReplaySufficient:false escape hatch on verifyNameUnion. A hostile
// PRIMARY that serves resolve.addr=ATTACKER AND flags scopedReplaySufficient:false must NOT yield a green
// "verified": the union fails CLOSED, discarding even the SPV-proven address (the wallet then shows a
// caution, never a verified attacker target). Converted 2026-07-06 from an exit-0 PoC into an ASSERTING
// regression — it FAILS LOUD if SRS:false ever re-greens. Run: tsx test/name5-srs-escape-poc.mjs
import { verifyNameUnion } from "../src/core/namespv.ts";
import { checker } from "./_check.ts";
import { buildNameClaim, buildNameSet, addrFromPriv, proposeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";

const { check, done } = checker("NAME-5 scopedReplaySufficient:false escape hatch:");

const keyHonest = "0x" + "11".repeat(32);
const HONEST_OWNER = addrFromPriv(keyHonest).toLowerCase();
const HONEST_ADDR = "0x" + "cd".repeat(20);   // the address the real owner nset to (the legit recipient)
const ATTACKER = "0x" + "ee".repeat(20);      // the address the hostile primary wants funds to go to

// World: the HONEST owner registered `bob` and nset it to HONEST_ADDR. Plain, non-fill, fully scope-provable.
const NAME = "bob";
const reg = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyHonest, outputs: feeOut() });
const nset = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: HONEST_ADDR })), priv: keyHonest });
const { blocks, hints } = world([{ height: 33700, tx: reg }, { height: 33710, tx: nset }]);

const PRIM = "https://cairn-substrate.com/trade/api";
const CLAR = "https://clarvis.cairn-substrate.com/trade/api";
const sources = [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLAR }];
const src = source(blocks, 33800);

// BASELINE: both sources honest → strong verified to HONEST_ADDR.
{
  const honest = { ok: true, events: hints, resolve: { addr: HONEST_ADDR, owner: HONEST_OWNER, via: "nset" }, scopedReplaySufficient: true };
  const r = await verifyNameUnion(NAME, sources, src, mkFetch({ [PRIM]: honest, [CLAR]: honest }));
  console.log("[BASELINE both honest]     verified=%s addr=%s disagree=%s", r.verified, r.addr, r.disagree);
  check("[BASELINE] both honest → verified to the real address", r.verified === true && r.addr === HONEST_ADDR && r.disagree === false);
}

// FABRICATION (control): a hostile primary serves a FAKE resolve.addr=ATTACKER but TRUE events + SRS:true.
// The union's addr cross-check catches it → routes to the SPV-proven HONEST_ADDR and flags disagree.
{
  const evilAddr = { ok: true, events: hints, resolve: { addr: ATTACKER, owner: HONEST_OWNER, via: "nset" }, scopedReplaySufficient: true };
  const honest = { ok: true, events: hints, resolve: { addr: HONEST_ADDR, owner: HONEST_OWNER, via: "nset" }, scopedReplaySufficient: true };
  const r = await verifyNameUnion(NAME, sources, src, mkFetch({ [PRIM]: evilAddr, [CLAR]: honest }));
  console.log("[FAB primary, SRS:true]    verified=%s addr=%s disagree=%s", r.verified, r.addr, r.disagree);
  check("[FAB] anti-fabrication routes to the PROVEN addr, not the attacker's", r.verified === true && r.addr === HONEST_ADDR && r.addr !== ATTACKER && r.disagree === true);
}

// ATTACK: the hostile primary serves resolve.addr=ATTACKER AND flags scopedReplaySufficient:false. The escape
// hatch (servedInsufficient) fires BEFORE the addr cross-check → verifyNameUnion fails CLOSED; the SPV-proven
// address is DISCARDED and NO attacker address is surfaced as verified.
{
  const evilSRS = { ok: true, events: hints, resolve: { addr: ATTACKER, owner: HONEST_OWNER, via: "nset" }, scopedReplaySufficient: false };
  const honest = { ok: true, events: hints, resolve: { addr: HONEST_ADDR, owner: HONEST_OWNER, via: "nset" }, scopedReplaySufficient: true };
  const r = await verifyNameUnion(NAME, sources, src, mkFetch({ [PRIM]: evilSRS, [CLAR]: honest }));
  console.log("[ATTACK primary SRS:false] verified=%s viaFill=%s addr=%s reason=%j", r.verified, r.viaFill, r.addr, r.reason);
  check("[ATTACK] SRS:false ⇒ NOT verified (fail-closed; no green badge)", r.verified === false);
  check("[ATTACK] the attacker address is NOT surfaced as a verified send target", r.addr !== ATTACKER && !r.addr);
}

done("name5-srs");
