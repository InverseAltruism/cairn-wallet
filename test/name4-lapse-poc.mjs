// NAME-4 regression test: tip-deflation vs lease-lapse in the SPV name verifier. The synthetic SpvSource
// feeds replayName an explicit (verifiedTip, nodeTip); lapse is driven by max(verifiedTip, nodeTip),
// fail-closed. Converted 2026-07-06 from an exit-0 PoC into an ASSERTING regression. The LOUD guard: given
// the HONEST tip a genuinely-lapsed lease is REFUSED (verified=false). The deflated-tip case documents the
// single-source residual that the liveSpvSource monotonic floor (NAME-4) defends — replayName itself
// trusts the nodeTip it is handed. Run: tsx test/name4-lapse-poc.mjs
import { verifyName } from "../src/core/namespv.ts";
import { checker } from "./_check.ts";
import { buildNameClaim, buildNameSet, addrFromPriv, proposeTx, world, source, feeOut, pick } from "./_spvrig.ts";

const { check, done } = checker("NAME-4 tip-deflation vs lease-lapse:");

const keyA = "0x" + "11".repeat(32);
const A = addrFromPriv(keyA).toLowerCase();
const TARGET = "0x" + "cd".repeat(20);
const NAME = "alice";

const claimTx = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyA, outputs: feeOut() });
const nsetTx = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyA });
const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);

// verifiedTip is ALWAYS ~maxEventHeight+CONF_BUFFER in production (the wallet never syncs further), so the
// only knob that can detect lapse is the UNTRUSTED nodeTip. Model verifiedTip pinned near the records
// (33722) and vary nodeTip. claim epoch=floor(33700/30)=1123; paidThrough≈1123+8760; lapses at height>~318090.
const src = (nodeTip) => source(blocks, nodeTip, { verifiedTip: 33722, nodeTip });
const REAL_TIP = 320000;   // honest chain tip — alice.csd lease lapsed LONG ago
const DEFLATED = 33722;    // hostile/MITM tip == verifiedTip (cannot go below it; cold-start floor=0)

const honest = await verifyName(NAME, { addr: TARGET, owner: A, via: "nset" }, hints, src(REAL_TIP));
const attack = await verifyName(NAME, { addr: TARGET, owner: A, via: "nset" }, hints, src(DEFLATED));
console.log("HONEST tip (lapsed):  verified=%s reason=%s", honest.verified, honest.reason);
console.log("DEFLATED tip (MITM):  verified=%s addr=%s via=%s", attack.verified, attack.addr, attack.via);

// WALLET-LAPSE-TIP-1 (Plan 70 R2): a SINGLE-source lapse with no floor corroboration now DEGRADES TO CAUTION
// (verified=false, lapsed !== true, "may have lapsed") instead of a confident refusal — a fresh-install + MITM
// inflating the tip must not assert a false confident lapse. Still fail-closed (verified stays false), and the
// confident-lapse + two-source cases are pinned in test/name-lapse-tip.test.mjs.
check("HONEST tip single-source: a genuine lapse DEGRADES TO CAUTION (verified=false, not a confident lapse)", honest.verified === false && honest.lapsed !== true && /lapsed/i.test(honest.reason || ""));
check("DEFLATED tip: documented single-source residual (the floor lives in liveSpvSource, not replayName)", attack.verified === true && attack.addr === TARGET);

done("name4-lapse");
