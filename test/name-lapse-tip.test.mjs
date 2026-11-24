// A lease-lapse verdict refuses a send only when both hold: the lease is over at a height the wallet verified (its own
// PoW-verified header tip, or the persisted floor from prior sessions), and 0.3.4's corroboration holds (two usable
// name sources, or the floor). Anything else that looks lapsed is `lapseUnconfirmed`, a caution with the last holding's
// chain-proven address: whoever answers for the tip can serve one past a live lease, and one source can withhold a
// renewal so that a live name replays as lapsed at the wallet's own tip ([W1]).
// RED-FIRST: on 2d910ab, [1], [3], [T3], [T4] and [T6] fail (no `lapseUnconfirmed`; two sources made the served tip's
// lapse a refusal). [2v], [W1] and [T7] fail on 2fd66a8 (one source at the verified tip refused there). Mutations: drop the
// source-count condition (`usable.length >= 2 ||`) from `corroborated` and [2v], [W1] fail; drop `atVerifiedHeight`
// from `confident` and [3], [T3], [T4], [T6] fail; drop `verifiedCorroborated` and [3v], [T2] fail; prefer the served
// address over `lastAddr` and [T3], [T6] fail. [W1r] and [3r] fail on 68cce65 (one reason for both branches); drop the
// floor from `corroborated` and [W2] fails. On 68cce65 [T3] and [T8a] to [T8n] fail (no `addrProven`); drop
// `!scopeInsufficient &&` from namespv.ts's `lastAddr` and [T8m], [T8n] fail.
// Run: tsx test/name-lapse-tip.test.mjs
import "./helpers/backup-host.mjs";
import { verifyNameUnion } from "../src/core/namespv.ts";
import { checker } from "./_check.ts";
import { buildNameRenew } from "../src/core/cairnx.ts";
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

// ── Case 2v: one source, no floor, the wallet's OWN verified headers past the lease end → still a CAUTION ──
{
  const r = await unionOne(NAME, CLAIM, hints, source(blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP }));
  check("[2v] one source, lease over at the wallet's verified tip: a caution (lapseUnconfirmed), not a refusal", r.verified === false && r.lapsed !== true && r.lapseUnconfirmed === true && r.lastAddr === TARGET);
}

// ── Case 3v: two sources, the wallet's own verified headers past the lease end → CONFIDENT (refused, as 0.3.4) ──
{
  const PRIM = "https://cairn-substrate.com/trade/api", CLAR = "https://clarvis.cairn-substrate.com/trade/api";
  const history = { ok: true, events: hints, resolve: CLAIM, scopedReplaySufficient: true };
  const r = await verifyNameUnion(NAME, [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLAR }], source(blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP }), mkFetch({ [PRIM]: history, [CLAR]: history }));
  check("[3v] two sources, lease over at the wallet's verified tip: refused (lapsed===true)", r.verified === false && r.lapsed === true && r.lapseUnconfirmed !== true);
}

// ── Case W: the withheld renewal. The owner renewed at 300,000 (in grace, so the lease runs past 320,000); the record is
//    in its block on the chain, and a lone source serves the history without it. ──
{
  const renewTx = proposeTx({ ...pick(buildNameRenew({ name: NAME })), priv: keyA, outputs: feeOut() });
  const w = world([{ height: 33700, tx: claimTx }, { height: 33710, tx: nsetTx }, { height: 300_000, tx: renewTx }]);
  const withheld = w.hints.filter((h) => h.height !== 300_000);
  const atTip = source(w.blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP });
  const honest = await unionOne(NAME, CLAIM, w.hints, atTip);
  check(`[W0] honest: with the renewal served the name is live at ${REAL_TIP} (verified ${honest.verified})`, honest.verified === true && honest.addr === TARGET);
  const r = await unionOne(NAME, CLAIM, withheld, atTip);
  check("[W1] one source withholding the renewal, lease over at the wallet's verified tip: a caution on the proven address, not a refusal", r.verified === false && r.lapsed !== true && r.lapseUnconfirmed === true && r.lastAddr === TARGET);
  check(`[W1r] its reason names the one source, not the served tip (${r.reason})`, /only one name source/.test(r.reason) && !/served tip/.test(r.reason));
  // The predicate is 0.3.4's, F || (V && U): with the floor kept from earlier sessions past the old lease end, one
  // source that withholds the renewal still makes the refusal (SECURITY.md, README.md say so).
  const r2 = await unionOne(NAME, CLAIM, withheld, source(w.blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP, floorTip: REAL_TIP }));
  check("[W2] the kept floor past the old lease end and one source withholding the renewal: refused, as in 0.3.4", r2.verified === false && r2.lapsed === true && r2.lapseUnconfirmed !== true);
  const r2h = await unionOne(NAME, CLAIM, w.hints, source(w.blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP, floorTip: REAL_TIP }));
  check("[W2h] honest: the same floor with the renewal served verifies the live name", r2h.verified === true && r2h.addr === TARGET);
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
  check(`[3r] its reason names the served tip (${r.reason})`, /below the served tip, above the headers the wallet verified/.test(r.reason));
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
  // `prim` and `clar` replace a host's name-history answer (a body, "throw" or { __status }).
  const run = async ({ served, spv, clarvis = true, prim, clar }) => {
    const history = { ok: true, events: hints, resolve: { addr: served.addr, owner: A, via: "nset", lapsed: served.lapsed }, scopedReplaySufficient: true };
    const f = mkFetch({ [PRIM]: prim ?? history, [CLARVIS_TRADE_API]: clar ?? (clarvis ? history : "throw") });
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
  check(`[T3] forged tip, served lapsed + another address: caution on the proven address (${r.addr})`, r.ok === true && r.lapseUnconfirmed === true && r.verified === false && r.addr === TARGET && r.addrProven === true);
  // (T4) a newer tip the wallet has not verified, no served flag (also an honest lapse with headers trailing): caution.
  r = await run({ served: { addr: TARGET, owner: A, via: "nset" }, spv: srcNoFloor(REAL_TIP) });
  check("[T4] a served tip past the lease, no flag: caution on the proven address", r.ok === true && r.lapseUnconfirmed === true && r.verified === false && r.addr === TARGET);
  // (T7) one source (clarvis unreachable), lease over at the wallet's verified tip: the caution, as 0.3.4 had it.
  r = await run({ served: { addr: TARGET, owner: A, via: "nset", lapsed: true }, spv: source(blocks, REAL_TIP, { verifiedTip: REAL_TIP, nodeTip: REAL_TIP }), clarvis: false });
  check("[T7] one source, lease over at the verified tip: caution (ok, lapseUnconfirmed) on the proven address", r.ok === true && r.lapseUnconfirmed === true && r.addr === TARGET);
  // (T5) the persisted floor past the lease: the refusal as today.
  r = await run({ served: { addr: TARGET, owner: A, via: "nset", lapsed: true }, spv: srcWithFloor(REAL_TIP, REAL_TIP) });
  check("[T5] the floor past the lease: refused", r.ok === false && r.lapsed === true);
  // (T6) the confirm-time re-check of (T3) returns the same address, so the caution's Confirm signs what was reviewed. The
  //      review showed the caution, so the snapshot carries it (popup-send.ts `lapseShown`).
  const { reresolveUnchanged } = await import("../src/popup/clearsign.ts");
  r = await run({ served: { addr: ATTACKER, owner: A, via: "nset", lapsed: true }, spv: srcNoFloor(REAL_TIP) });
  check("[T6] the confirm-time re-check of the caution passes on the reviewed address and refuses another", reresolveUnchanged(TARGET, r, false, r.lapseUnconfirmed === true) === true && reresolveUnchanged(ATTACKER, r, false, r.lapseUnconfirmed === true) === false);
  // (T8) the served `lapsed` flag with an address the wallet did not prove: the served address stays (the replay may be
  //      stale where a source says so), and `addrProven` is false, so the review shows [A9] with [A4], not [A4] alone.
  const insufficient = { ok: true, events: hints, resolve: { addr: ATTACKER, owner: A, via: "nset", lapsed: true }, scopedReplaySufficient: false };
  const live = () => source(blocks, LIVE_TIP, { verifiedTip: LIVE_TIP, nodeTip: LIVE_TIP });
  r = await run({ served: { addr: ATTACKER, owner: A, via: "nset", lapsed: true }, spv: live(), prim: insufficient });
  check(`[T8a] a hostile primary: its own address, lapsed, its history flagged insufficient: the served address, not proven (${r.addr}, ${r.addrProven})`, r.ok === true && r.lapseUnconfirmed === true && r.addr === ATTACKER && r.addrProven === false);
  r = await run({ served: { addr: ATTACKER, owner: A, via: "nset", lapsed: true }, spv: srcNoFloor(REAL_TIP), prim: insufficient, clar: insufficient });
  check(`[T8b] the same with a forged tip past the lease and both sources flagging: the served address, not proven (${r.addr})`, r.ok === true && r.lapseUnconfirmed === true && r.addr === ATTACKER && r.addrProven === false);
  r = await run({ served: { addr: ATTACKER, owner: A, via: "nset", lapsed: true }, spv: live(), prim: { __status: 404 }, clar: { __status: 404 } });
  check(`[T8d] both histories 404, served lapsed: the served address, not proven (${r.addr})`, r.ok === true && r.lapseUnconfirmed === true && r.addr === ATTACKER && r.addrProven === false);
  r = await run({ served: { addr: ATTACKER, owner: A, via: "nset", lapsed: true }, spv: live(), prim: "throw", clar: "throw" });
  check(`[T8e] both histories down, served lapsed: the served address, not proven (${r.addr})`, r.ok === true && r.lapseUnconfirmed === true && r.addr === ATTACKER && r.addrProven === false);
  // (T8m) the served tip past the lease while one source flags the replay insufficient: no proven last holding
  //       (namespv.ts drops `lastAddr` there), so the served address goes under [A9] with [A4].
  const histTarget = { ok: true, events: hints, resolve: { addr: ATTACKER, owner: A, via: "nset" }, scopedReplaySufficient: true };
  const v = await verifyNameUnion(NAME, [{ label: "primary", base: PRIM }, { label: "clarvis", base: CLARVIS_TRADE_API }], srcNoFloor(REAL_TIP), mkFetch({ [PRIM]: { ...histTarget, scopedReplaySufficient: false }, [CLARVIS_TRADE_API]: histTarget }));
  check(`[T8m] a source flagging the replay insufficient leaves no lastAddr on an unconfirmed lapse (${v.lastAddr})`, v.lapseUnconfirmed === true && v.lastAddr === undefined);
  r = await run({ served: { addr: ATTACKER, owner: A, via: "nset" }, spv: srcNoFloor(REAL_TIP), prim: { ...histTarget, scopedReplaySufficient: false }, clar: histTarget });
  check(`[T8n] through resolveName: the served address, not proven (${r.addr}, ${r.addrProven})`, r.ok === true && r.lapseUnconfirmed === true && r.addr === ATTACKER && r.addrProven === false);
}

done("name-lapse-tip");
