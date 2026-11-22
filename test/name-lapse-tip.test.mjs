// A lease-lapse verdict refuses a send only when the lease is over at a height the wallet verified: its own
// PoW-verified header tip, or the persisted floor from prior sessions (a tip it trusted before). Expired only at the
// served tip, the verdict is `lapseUnconfirmed`, a caution with the last holding's chain-proven address: whoever
// answers for the tip (both default hosts have one operator) can serve one past a live lease. Two name sources do
// not settle it, since neither serves the tip.
// RED-FIRST: on the commit before this one, [1], [2v], [3], [T3], [T4] and [T6] fail (no `lapseUnconfirmed`, two
// sources made the served tip's lapse a refusal, the wallet's own headers did not count). Mutations: put
// `usable.length >= 2 ||` back in verifyNameUnion's `confident` and [3], [T3], [T4], [T6] fail; drop `verifiedCorroborated` from
// it and [2v] fails; prefer the served address over `lastAddr` and [T3],
// [T6] fail; judge the lapse at the served tip again (`expiredAt(lapseTip)`) and [1], [3], [4] fail.
// Run: tsx test/name-lapse-tip.test.mjs
import { verifyNameUnion } from "../src/core/namespv.ts";
import { checker } from "./_check.ts";
import { buildNameClaim, buildNameSet, addrFromPriv, proposeTx, world, source, feeOut, pick, mkFetch } from "./_spvrig.ts";

// D2 (2026-09-12): the single-source verifyName twin was deleted; the single-source lapse cases now
// drive verifyNameUnion with ONE source: the union's lone-usable-source lapse handling IS the
// production single-source posture (caution unless floor-corroborated).
const SRC1 = [{ label: "primary", base: "https://primary.example/trade/api" }];
const unionOne = (nm, claim, evHints, src) =>
  verifyNameUnion(nm, SRC1, src, mkFetch({ [SRC1[0].base]: { ok: true, resolve: claim, events: evHints } }));

const { check, done } = checker("WALLET-LAPSE-TIP-1 (lease-lapse single-source tip):");

const keyA = "0x" + "11".repeat(32);
const A = addrFromPriv(keyA).toLowerCase();
const TARGET = "0x" + "cd".repeat(20);
const NAME = "alice";

// alice.csd: claim @33700, nset→TARGET @33710. claim epoch=floor(33700/30)=1123; lapses at height >~318090.
const claimTx = proposeTx({ ...pick(buildNameClaim({ name: NAME })), priv: keyA, outputs: feeOut() });
const nsetTx = proposeTx({ ...pick(buildNameSet({ name: NAME, addr: TARGET })), priv: keyA });
const { blocks, hints } = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }]);

const CLAIM = { addr: TARGET, owner: A, via: "nset" };
const REAL_TIP = 320_000;   // honest chain tip: alice.csd lease lapsed long ago
const VERIFIED = 33_722;    // the PoW-verified tip in production is always ~maxEventHeight+CONF_BUFFER

// production-shaped source: verifiedTip pinned near the records, nodeTip = the (untrusted) reported tip.
const srcNoFloor = (nodeTip) => source(blocks, nodeTip, { verifiedTip: VERIFIED, nodeTip });
const srcWithFloor = (nodeTip, floorTip) => source(blocks, nodeTip, { verifiedTip: VERIFIED, nodeTip, floorTip });

// ── Case 1: SINGLE-source lapse, no floor corroboration → CAUTION (not a confident lapse) ──
{
  const r = await unionOne(NAME, CLAIM, hints, srcNoFloor(REAL_TIP));
  console.log("[1] single-source, no floor: verified=%s lapsed=%s reason=%j", r.verified, r.lapsed, r.reason);
  check("[1] single-source lapse DEGRADES TO CAUTION (verified=false, lapsed !== true)", r.verified === false && r.lapsed !== true);
  check("[1] it is an unconfirmed lapse on the proven address", r.lapseUnconfirmed === true && r.lastAddr === TARGET);
}

// ── Case 2: SINGLE-source lapse, but the PERSISTED FLOOR is also past expiry → CONFIDENT lapse ──
{
  const r = await unionOne(NAME, CLAIM, hints, srcWithFloor(REAL_TIP, REAL_TIP));
  console.log("[2] single-source, floor corroborates: verified=%s lapsed=%s reason=%j", r.verified, r.lapsed, r.reason);
  check("[2] a floor-corroborated lapse is CONFIDENT (verified=false, lapsed===true)", r.verified === false && r.lapsed === true);
  check("[2] the confident-lapse reason refuses the send", /lapsed[\s\S]*refusing|refusing[\s\S]*lapsed/i.test(r.reason || ""));
}

// ── Case 2v: one source, no floor, but the wallet's OWN verified headers reach past the lease end → CONFIDENT ──
{
  const r = await unionOne(NAME, CLAIM, hints, source(blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP }));
  check("[2v] a lapse at the wallet's own verified tip refuses (lapsed===true), with one source and no floor", r.verified === false && r.lapsed === true && r.lapseUnconfirmed !== true);
}

// ── Case 3: TWO sources both serve the events, the served tip is past the lease, the headers are not → CAUTION ──
{
  const PRIM = "https://cairn-substrate.com/trade/api";
  const CLAR = "https://clarvis.cairn-substrate.com/trade/api";
  const sources = [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLAR }];
  const history = { ok: true, events: hints, resolve: { addr: TARGET, owner: A, via: "nset" }, scopedReplaySufficient: true };
  const r = await verifyNameUnion(NAME, sources, srcNoFloor(REAL_TIP), mkFetch({ [PRIM]: history, [CLAR]: history }));
  console.log("[3] two sources, served tip past the lease: verified=%s lapsed=%s unconfirmed=%s sources=%s", r.verified, r.lapsed, r.lapseUnconfirmed, r.sources);
  check("[3] two sources do not make a served-tip lapse a refusal: unconfirmed, on the proven address", r.verified === false && r.lapsed !== true && r.lapseUnconfirmed === true && r.lastAddr === TARGET && r.sources === 2);
}

// ── Case 4: only ONE usable union source (clarvis network-blocked) + no floor → CAUTION ──
{
  const PRIM = "https://cairn-substrate.com/trade/api";
  const CLAR = "https://clarvis.cairn-substrate.com/trade/api";
  const sources = [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLAR }];
  const history = { ok: true, events: hints, resolve: { addr: TARGET, owner: A, via: "nset" }, scopedReplaySufficient: true };
  const r = await verifyNameUnion(NAME, sources, srcNoFloor(REAL_TIP), mkFetch({ [PRIM]: history, [CLAR]: "throw" }));
  console.log("[4] one usable source, lapse: verified=%s lapsed=%s sources=%s", r.verified, r.lapsed, r.sources);
  check("[4] a lone usable source with an uncorroborated lapse DEGRADES TO CAUTION (lapsed !== true, sources===1)", r.verified === false && r.lapsed !== true && r.sources === 1);
}

// ── Control: a NON-lapsed name (deflated/low tip) still verifies clean; the caution path does not over-warn ──
{
  const r = await unionOne(NAME, CLAIM, hints, srcNoFloor(VERIFIED)); // nodeTip == verifiedTip → not yet lapsed
  console.log("[C] not-yet-lapsed control: verified=%s addr=%s", r.verified, r.addr);
  check("[C] a name that is NOT lapsed verifies clean (no spurious lapse caution)", r.verified === true && r.addr === TARGET && r.lapsed !== true);
}

// ── The table, through resolveName on the production call shape: wallet.verifyName -> names.ts verifyName ->
// verifyNameUnion over the primary and clarvis sources, the served resolve answer first. ──
{
  const { resolveName, verifyName } = await import("../src/core/names.ts");
  const { CLARVIS_TRADE_API } = await import("../src/core/endpoints.ts");
  const PRIM = "https://cairn-substrate.com/trade/api";
  const ATTACKER = "0x" + "ee".repeat(20);
  const origFetch = globalThis.fetch;
  // Both hosts answer alike: the served resolve record and the name history of the same events.
  const run = async ({ served, spv }) => {
    const history = { ok: true, events: hints, resolve: { addr: served.addr, owner: A, via: "nset", lapsed: served.lapsed }, scopedReplaySufficient: true };
    const f = mkFetch({ [PRIM]: history, [CLARVIS_TRADE_API]: history });
    globalThis.fetch = (url, init) => String(url).includes("/cairnx/resolve/") ? Promise.resolve({ ok: true, status: 200, json: async () => served }) : f(url, init);
    const io = {
      tradeGet: (path) => globalThis.fetch(PRIM + path), tip: async () => spv.nodeTip, spvSource: async () => spv,
      tradeApi: () => PRIM, spvGen: () => 0, nameHints: () => new Map(), verifyName: (nm) => verifyName(io, nm),
    };
    try { return await resolveName(io, NAME); } finally { globalThis.fetch = origFetch; }
  };
  const LIVE_TIP = 40_000;   // below the lease end
  // (T1) live name, honest servers: unchanged, verified, no caution.
  let r = await run({ served: { addr: TARGET, owner: A, via: "nset" }, spv: source(blocks, LIVE_TIP, { verifiedTip: LIVE_TIP, nodeTip: LIVE_TIP }) });
  check(`[T1] live name, honest servers: verified on TARGET, no caution (${r.addr})`, r.ok === true && r.verified === true && r.addr === TARGET && r.lapseUnconfirmed !== true);
  // (T2) lapsed by the wallet's own headers: the refusal as today (with and without the served flag).
  r = await run({ served: { addr: TARGET, owner: A, via: "nset", lapsed: true }, spv: source(blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP }) });
  const r5b = await run({ served: { addr: TARGET, owner: A, via: "nset" }, spv: source(blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP }) });
  check("[T2] lapsed by the wallet's own headers: refused, both with the served flag and without it", r.ok === false && r.lapsed === true && r5b.ok === false && r5b.lapsed === true);
  // (T3) a forged tip past a live lease, the served flag set and the served address the attacker's: a caution, and the
  //      send goes to the address the name's own verified records give, not the served one.
  r = await run({ served: { addr: ATTACKER, owner: A, via: "nset", lapsed: true }, spv: srcNoFloor(REAL_TIP) });
  check(`[T3] forged tip, served lapsed + another address: caution on the proven address (${r.addr})`, r.ok === true && r.lapseUnconfirmed === true && r.verified === false && r.addr === TARGET);
  // (T4) a newer tip the wallet has not verified, no served flag (also an honest lapse with headers trailing): caution.
  r = await run({ served: { addr: TARGET, owner: A, via: "nset" }, spv: srcNoFloor(REAL_TIP) });
  check("[T4] a served tip past the lease, no flag: caution on the proven address", r.ok === true && r.lapseUnconfirmed === true && r.verified === false && r.addr === TARGET);
  // (T5) the persisted floor past the lease: the refusal as today.
  r = await run({ served: { addr: TARGET, owner: A, via: "nset", lapsed: true }, spv: srcWithFloor(REAL_TIP, REAL_TIP) });
  check("[T5] the floor past the lease: refused", r.ok === false && r.lapsed === true);
  // (T6) the confirm-time re-check of (T3) returns the same address, so the caution's Confirm signs what was reviewed.
  const { reresolveUnchanged } = await import("../src/popup/clearsign.ts");
  r = await run({ served: { addr: ATTACKER, owner: A, via: "nset", lapsed: true }, spv: srcNoFloor(REAL_TIP) });
  check("[T6] the confirm-time re-check of the caution passes on the reviewed address and refuses another", reresolveUnchanged(TARGET, r, false) === true && reresolveUnchanged(ATTACKER, r, false) === false);
}

done("name-lapse-tip");
