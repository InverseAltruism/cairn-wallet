// verifyNameUnion's per-source recovery (namespv.ts) verifies only when every source that replays alone names the same
// address (`addrs.size === 1`). It runs when the unioned replay fails, which a source can force by padding its list past
// the hint cap; without the agreed-winner rule the first source that replays alone would decide the name. Before this
// file the rule was pinned by its source text only (test/namespv-reseed-recover.test.mjs, M12).
//   1. Two sources that each replay alone to a different address (one withholds the transfer and pads past the cap):
//      not verified, whichever source is the stale one.
//   2. Paired: one source's list replays alone and the other's adds a hint that proves nothing: the recovery verifies
//      the one address, flagged as one source (soleSource) and as a disagreement.
//   RED-FIRST: widen the rule (`addrs.size >= 1`, the audit's mutation of 2026-11-19, which keeps M12's text) and 1
//   verifies the first source's address.
// Run: npx tsx test/namespv-recovery-agree.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { verifyNameUnion } from "../src/core/namespv.ts";
import { proposeTx, world, source, feeOut, pick, mkFetch, addrFromPriv, buildNameClaim, buildNameXfer } from "./_spvrig.ts";
import { nameCommit, nameCommitRecord, nameFinalize, V26_HEIGHT } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("the per-source recovery verifies only an agreed winner:");
const keyH = "0x" + "11".repeat(32), keyM = "0x" + "22".repeat(32), keyF = "0x" + "33".repeat(32);
const H = addrFromPriv(keyH).toLowerCase(), M = addrFromPriv(keyM).toLowerCase(), F = addrFromPriv(keyF).toLowerCase();
const who = (a) => (a === H ? "H" : a === M ? "M" : String(a));
const PRIMARY = "https://primary.example/trade/api", CLARVIS = "https://clarvis.example/trade/api";
const SOURCES = [{ label: "primary", base: PRIMARY }, { label: "clarvis", base: CLARVIS }];
const claim = (a) => ({ addr: a, owner: a, via: "owner" });
const body = (c, events) => ({ ok: true, resolve: c, events, scopedReplaySufficient: true });
const salt = (k) => String((k % 9) + 1).repeat(16);
const commit = (name, s, owner, priv) => proposeTx({ ...pick(nameCommitRecord({ commit: nameCommit(name, s, owner) })), priv });
const reveal = (name, s, priv) => proposeTx({ ...pick(buildNameClaim({ name, salt: s })), priv });
const finalize = (name, s, priv) => proposeTx({ ...pick(nameFinalize({ name, salt: s })), priv, outputs: feeOut() });

// H registers the name and transfers it to M; 253 unrelated commits pad a list past the 256-hint cap.
const V = "zzsplit", h0 = V26_HEIGHT + 9000, s = "9".repeat(16);
const reg = [{ height: h0, tx: commit(V, s, H, keyH) }, { height: h0 + 1, tx: reveal(V, s, keyH) }, { height: h0 + 9, tx: finalize(V, s, keyH) }];
const xfer = { height: h0 + 50, tx: proposeTx({ ...pick(buildNameXfer({ name: V, to: M })), priv: keyH }) };
const filler = [];
for (let k = 0; k < 253; k++) filler.push({ height: h0 + 60, tx: commit("zzfil" + k, salt(k), F, keyF) });
const placed = [...reg, xfer, ...filler], all = world(placed), TIP = h0 + 90;
const hint = (pl) => all.hints[placed.indexOf(pl)];
const stale = [...reg, ...filler].map(hint), full = [...reg, xfer].map(hint);
const spv = source(all.blocks, TIP);
check(`setup: the stale list has ${stale.length} hints, the honest one ${full.length}, their union ${new Set([...stale, ...full].map((x) => x.txid)).size} (over the cap of 256)`,
  stale.length === 256 && new Set([...stale, ...full].map((x) => x.txid)).size === 257);

// 1. Two solo replays, two addresses: no winner.
{
  const r = await verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(H), stale), [CLARVIS]: body(claim(M), full) }));
  check(`1. the configured source withholds the transfer and pads past the cap, clarvis is honest: not verified (${r.verified}, ${who(r.addr)})`, r.verified === false && r.addr === undefined);
  const swap = await verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(M), full), [CLARVIS]: body(claim(H), stale) }));
  check(`1. ...whichever source is the stale one (${swap.verified}, ${who(swap.addr)})`, swap.verified === false && swap.addr === undefined);
}

// 2. Paired: one solo replay, one address: the recovery verifies it and says only one source proved it.
{
  const junk = { txid: "0x" + "ab".repeat(32), height: 999_999, pos: 0 };
  const r = await verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(M), full), [CLARVIS]: body(claim(M), [...full, junk]) }));
  check(`2. honest: a source whose list adds an unprovable hint drops out; the other's own replay verifies M (${r.verified}, ${who(r.addr)}, soleSource ${r.soleSource}, recovered ${r.recovered}, disagree ${r.disagree})`,
    r.verified === true && r.addr === M && r.soleSource === true && r.recovered === true && r.disagree === true);
}
done("namespv-recovery-agree");
