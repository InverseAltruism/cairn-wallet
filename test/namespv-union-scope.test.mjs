// The two-source name union replays only the records of the name itself. Every unioned record is merkle-proven and
// signer-bound, so a source can only add real records, but a real record of ANOTHER name can still move this
// name's replay: the resolver refuses a reveal while its proposer holds MAX_PENDING_REG other reservations, so a
// source that adds the owner's other reveals and withholds their finalizes makes the owner's own reveal refuse and a
// later rival registration win. Real signed txs in synthetic PoW-verified blocks (test/_spvrig.ts), the production
// verifyNameUnion and the vendored resolver.
// Run: npx tsx test/namespv-union-scope.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { verifyNameUnion } from "../src/core/namespv.js";
import { toChainEvent } from "../src/core/spvbind.js";
import { proposeTx, attestTx, world, source, feeOut, pick, mkFetch, addrFromPriv, buildNameClaim, ctxid, rpcTxToTx, resolve, TREASURY_ADDR } from "./_spvrig.ts";
import { nameCommit, nameCommitRecord, nameFinalize, V26_HEIGHT, MAX_PENDING_REG, offer, tradeFee, makerRebate, epochOf, SCORE_FILL } from "../src/vendor/cairnx-spv.js";

const { check, done } = checker("name union: only the name's own records are replayed:");

const keyH = "0x" + "11".repeat(32), keyM = "0x" + "22".repeat(32);
const H = addrFromPriv(keyH).toLowerCase(), M = addrFromPriv(keyM).toLowerCase();
const who = (a) => (a === H ? "H" : a === M ? "M" : String(a));
const salt = (k) => String(k + 1).repeat(16);
const PRIMARY = "https://primary.example/trade/api", CLARVIS = "https://clarvis.example/trade/api";
const SOURCES = [{ label: "primary", base: PRIMARY }, { label: "clarvis", base: CLARVIS }];
const claim = (a) => ({ addr: a, owner: a, via: "owner" });
const body = (c, events, scopedReplaySufficient = true) => ({ ok: true, resolve: c, events, ...(scopedReplaySufficient === undefined ? {} : { scopedReplaySufficient }) });
const commit = (name, s, owner, priv) => proposeTx({ ...pick(nameCommitRecord({ commit: nameCommit(name, s, owner) })), priv });
const reveal = (name, s, priv) => proposeTx({ ...pick(buildNameClaim({ name, salt: s })), priv });
const finalize = (name, s, priv) => proposeTx({ ...pick(nameFinalize({ name, salt: s })), priv, outputs: feeOut() });

// ── 1. H registers three other names, then the victim name V (all four finalized); M's rival commit, reveal and
// finalize on V land 500 blocks after H's finalize, so the chain refuses them. ──
{
  const V = "zzvictim", h0 = V26_HEIGHT + 1000;
  const others = [], otherFin = [];
  for (let k = 0; k < MAX_PENDING_REG; k++) {
    const n = "zzother" + k;
    others.push({ height: h0 + k, tx: commit(n, salt(k), H, keyH) }, { height: h0 + k + 1, tx: reveal(n, salt(k), keyH) });
    otherFin.push({ height: h0 + k + 9, tx: finalize(n, salt(k), keyH) });
  }
  const sH = "9".repeat(16), sM = "8".repeat(16);
  const mine = [{ height: h0 + 12, tx: commit(V, sH, H, keyH) }, { height: h0 + 13, tx: reveal(V, sH, keyH) }, { height: h0 + 21, tx: finalize(V, sH, keyH) }];
  const rc = h0 + 521;
  const rival = [{ height: rc, tx: commit(V, sM, M, keyM) }, { height: rc + 1, tx: reveal(V, sM, keyM) }, { height: rc + 10, tx: finalize(V, sM, keyM) }];
  const placed = [...others, ...otherFin, ...mine, ...rival];
  const all = world(placed);
  const hintOf = (pl) => all.hints[placed.indexOf(pl)];
  const honest = [...mine, ...rival].map(hintOf);              // what an honest source serves for V
  const hostile = [...others, ...mine, ...rival].map(hintOf);  // real records; the other names' finalizes withheld
  const spv = source(all.blocks, rc + 40);
  const union = (p, c) => verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: p, [CLARVIS]: c }));

  const both = await union(body(claim(H), honest), body(claim(H), honest));
  check(`both sources honest: verified, owner H, no disagreement (${who(both.owner)}, disagree ${both.disagree})`, both.verified === true && both.owner === H && both.addr === H && both.disagree === false);
  const withheld = await union(body(claim(H), honest), body(claim(M), rival.map(hintOf)));
  check(`clarvis withholds H's records: still H, flagged (${who(withheld.owner)}, disagree ${withheld.disagree})`, withheld.verified === true && withheld.owner === H && withheld.disagree === true);
  const added = await union(body(claim(H), honest), body(claim(M), hostile));
  check(`clarvis adds H's other reservations without their finalizes: owner H, flagged (${who(added.owner)}, disagree ${added.disagree})`, added.verified === true && added.owner === H && added.addr === H && added.disagree === true);
  const addedP = await union(body(claim(M), hostile), body(claim(H), honest));
  check(`the configured source adds them: owner H, flagged (${who(addedP.owner)}, disagree ${addedP.disagree})`, addedP.verified === true && addedP.owner === H && addedP.disagree === true);
  const quiet = await union(body(claim(H), honest), body(claim(H), hostile, undefined));
  check(`clarvis adds them and claims H with no scope flag: owner H (${who(quiet.owner)})`, quiet.verified === true && quiet.owner === H);
}

// ── 2. The chain refused H's reveal of V: H held MAX_PENDING_REG other reservations then. A replay of V's records
// alone accepts it, so the honest source flags V scopedReplaySufficient:false; that flag keeps the union closed. ──
{
  const V = "zzcapped", h0 = V26_HEIGHT + 3000;
  const others = [];
  for (let k = 0; k < MAX_PENDING_REG; k++) {
    const n = "zzheld" + k;
    others.push({ height: h0 + k, tx: commit(n, salt(k), H, keyH) }, { height: h0 + k + 1, tx: reveal(n, salt(k), keyH) });
  }
  const sH = "7".repeat(16), sM = "6".repeat(16);
  const hV = [{ height: h0 + 4, tx: commit(V, sH, H, keyH) }, { height: h0 + 5, tx: reveal(V, sH, keyH) }, { height: h0 + 13, tx: finalize(V, sH, keyH) }];
  const mV = [{ height: h0 + 40, tx: commit(V, sM, M, keyM) }, { height: h0 + 41, tx: reveal(V, sM, keyM) }, { height: h0 + 50, tx: finalize(V, sM, keyM) }];
  const placed = [...others, ...hV, ...mV];
  const all = world(placed);
  const TIP = h0 + 90;
  // The resolver's verdicts, over the same signed txs as chain events (each signed by its own coin's owner).
  const signerOf = (pl) => (others.includes(pl) || hV.includes(pl) ? H : M);
  const evs = placed.map((pl, i) => { const t = rpcTxToTx(pl.tx); return toChainEvent(t, ctxid(t), pl.height, all.hints[i].pos, signerOf(pl)); });
  const vOnly = evs.filter((_, i) => hV.includes(placed[i]) || mV.includes(placed[i]));
  check(`the chain makes M the owner of V, a replay of V's records alone makes H (${who(resolve(evs, TIP).names[V]?.owner)} vs ${who(resolve(vOnly, TIP).names[V]?.owner)})`,
    resolve(evs, TIP).names[V]?.owner === M && resolve(vOnly, TIP).names[V]?.owner === H);
  const vHints = [...hV, ...mV].map((pl) => all.hints[placed.indexOf(pl)]);
  const spv = source(all.blocks, TIP);
  const r = await verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(M), vHints, false), [CLARVIS]: body(claim(H), vHints, true) }));
  check(`the honest source's scopedReplaySufficient:false keeps it unverified (${r.verified}: ${r.reason})`, r.verified === false && /cannot be name-scope-proven/.test(String(r.reason)));
  const rSwap = await verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(H), vHints, true), [CLARVIS]: body(claim(M), vHints, false) }));
  check(`...whichever source carries the flag (${rSwap.verified})`, rSwap.verified === false);
  const noFlag = await verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(M), vHints, undefined), [CLARVIS]: body(claim(H), vHints, undefined) }));
  check(`the flag is what refuses: without it the name-scoped replay names H (${who(noFlag.owner)})`, noFlag.verified === true && noFlag.owner === H);
}

// ── 3. The same flag holds when the union replay fails and each source is replayed alone. A source padding its hints
// past MAX_HINTS (V's records plus real filler commits) makes the union refuse; the per-source recovery must not then
// drop the honest source for its own false flag and let the padding source alone verify. Paired: with both sources
// sufficient the recovery still verifies as before. ──
{
  const keyF = "0x" + "33".repeat(32), F = addrFromPriv(keyF).toLowerCase();
  const V = "zzpadded", h0 = V26_HEIGHT + 5000;
  const others = [];
  for (let k = 0; k < MAX_PENDING_REG; k++) {
    const n = "zzpend" + k;
    others.push({ height: h0 + k, tx: commit(n, salt(k), H, keyH) }, { height: h0 + k + 1, tx: reveal(n, salt(k), keyH) });
  }
  const sH = "5".repeat(16), sM = "4".repeat(16);
  const hV = [{ height: h0 + 4, tx: commit(V, sH, H, keyH) }, { height: h0 + 5, tx: reveal(V, sH, keyH) }, { height: h0 + 13, tx: finalize(V, sH, keyH) }];
  const mV = [{ height: h0 + 40, tx: commit(V, sM, M, keyM) }, { height: h0 + 41, tx: reveal(V, sM, keyM) }, { height: h0 + 50, tx: finalize(V, sM, keyM) }];
  const filler = [];
  for (let k = 0; k < 253; k++) filler.push({ height: h0 + 60, tx: commit("zzfill" + k, salt(k % 9), F, keyF) });
  const placed = [...others, ...hV, ...mV, ...filler];
  const all = world(placed);
  const hint = (pl) => all.hints[placed.indexOf(pl)];
  const spv = source(all.blocks, h0 + 90);
  const honestV = [...hV, ...mV].map(hint), padded = [...hV, ...filler].map(hint);
  check(`setup: the padding source serves 256 hints, the union ${honestV.length + 253} (over MAX_HINTS)`, padded.length === 256 && new Set([...honestV, ...padded].map((x) => x.txid)).size > 256);
  const r = await verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: body(claim(M), honestV, false), [CLARVIS]: body(claim(H), padded, true) }));
  check(`a union over the cap with the honest source's scopedReplaySufficient:false stays unverified (${r.verified}: ${r.reason})`,
    r.verified === false && /cannot be name-scope-proven/.test(String(r.reason)));
  // honest pair: a name the chain gives H (no other reservations of H in its history), both sources sufficient
  const W = "zzplain", w0 = h0 + 200;
  const hW = [{ height: w0, tx: commit(W, sH, H, keyH) }, { height: w0 + 1, tx: reveal(W, sH, keyH) }, { height: w0 + 9, tx: finalize(W, sH, keyH) }];
  const extra = [0, 1].map((k) => ({ height: w0 + 21, tx: commit("zzextra" + k, salt(k), F, keyF) }));
  const placed2 = [...hW, ...filler.map((f) => ({ ...f, height: w0 + 20 })), ...extra];
  const all2 = world(placed2);
  const hW2 = all2.hints.slice(0, 3), pad2 = all2.hints.slice(3, 256), extra2 = all2.hints.slice(256);
  // each source alone is within the cap (5 and 256 hints), their union is not (258)
  const r2 = await verifyNameUnion(W, SOURCES, source(all2.blocks, w0 + 60), mkFetch({ [PRIMARY]: body(claim(H), [...hW2, ...extra2], true), [CLARVIS]: body(claim(H), [...hW2, ...pad2], true) }));
  check(`honest: both sources sufficient, a union over the cap still recovers H from each source alone (${who(r2.owner)}, recovered ${r2.recovered}, soleSource ${r2.soleSource})`, r2.verified === true && r2.owner === H && r2.recovered === true && r2.soleSource === false);
}

// ── 4. The same holds for a name sold through a fill. H sells V to M through a taker-bound CSD offer, so the chain
// owner is M and the replay marks the name viaFill, which the success path refuses. A source that serves H's
// registration, withholds the offer and the fill and pads with real filler commits makes the union refuse at
// MAX_HINTS; the per-source recovery must refuse as the success path does instead of dropping the honest source for
// its viaFill replay and letting the padding source alone verify H. ──
{
  const keyF = "0x" + "33".repeat(32), F = addrFromPriv(keyF).toLowerCase();
  const V = "zzsold", price = 50_000_000n, h0 = 35_000;
  const reg = { height: 33_700, tx: proposeTx({ ...pick(buildNameClaim({ name: V })), priv: keyH, outputs: feeOut() }) };
  const off = { height: h0, tx: proposeTx({ ...pick(offer({ give: { name: V }, want: { value: String(price), payto: H }, taker: M })), priv: keyH, expiresEpoch: epochOf(h0) + 50 }) };
  const fill = { height: h0 + 10, tx: attestTx({ proposalId: ctxid(rpcTxToTx(off.tx)).toLowerCase(), score: SCORE_FILL, confidence: 100, priv: keyM,
    outputs: [{ to: H, value: Number(price + makerRebate(price)) }, { to: TREASURY_ADDR, value: Number(tradeFee(price, 150)) }] }) };
  const filler = [];
  for (let k = 0; k < 255; k++) filler.push({ height: h0 + 30, tx: commit("zzpad" + k, salt(k % 9), F, keyF) });
  const core = [reg, off, fill];
  const placed = [...core, ...filler];
  const all = world(placed);
  const TIP = h0 + 60;
  const hint = (pl) => all.hints[placed.indexOf(pl)];
  const evs = core.map((pl) => { const t = rpcTxToTx(pl.tx); return toChainEvent(t, ctxid(t), pl.height, hint(pl).pos, pl === fill ? M : H); });
  const chainRec = resolve(evs, TIP).names[V];
  check(`the chain makes M the owner of V through a fill (${who(chainRec?.owner)}, viaFill ${chainRec?.viaFill})`, chainRec?.owner === M && chainRec?.viaFill === true);
  const honest = core.map(hint), padded = [hint(reg), ...filler.map(hint)];
  check(`setup: the padding source serves 256 hints, the union ${new Set([...honest, ...padded].map((x) => x.txid)).size} (over MAX_HINTS)`,
    padded.length === 256 && new Set([...honest, ...padded].map((x) => x.txid)).size > 256);
  const spv = source(all.blocks, TIP);
  const union = (p, c) => verifyNameUnion(V, SOURCES, spv, mkFetch({ [PRIMARY]: p, [CLARVIS]: c }));
  const both = await union(body(claim(M), honest), body(claim(M), honest));
  check(`both sources honest: not verified, the viaFill caution (${both.verified}, viaFill ${both.viaFill})`, both.verified === false && both.viaFill === true);
  const noPad = await union(body(claim(M), honest), body(claim(H), [hint(reg)]));
  check(`clarvis withholds the sale without padding: not verified, viaFill (${noPad.verified}, ${who(noPad.addr)}, viaFill ${noPad.viaFill})`, noPad.verified === false && noPad.viaFill === true);
  const r = await union(body(claim(M), honest), body(claim(H), padded));
  check(`clarvis pads past the cap and withholds the sale: the success path's viaFill refusal (${r.verified}, ${who(r.addr)}, viaFill ${r.viaFill}, recovered ${r.recovered})`,
    r.verified === false && r.viaFill === true && r.reason === both.reason);
  const rSwap = await union(body(claim(H), padded), body(claim(M), honest));
  check(`...whichever source pads (${rSwap.verified}, viaFill ${rSwap.viaFill})`, rSwap.verified === false && rSwap.viaFill === true);
  // honest sources over the cap together (each within it): the same caution as the success path, not a hint-count error
  const over = await union(body(claim(M), [...honest, ...filler.slice(0, 200).map(hint)]), body(claim(M), [...honest, ...filler.slice(200).map(hint)]));
  check(`honest: both sources over the cap together get the success path's viaFill caution (${over.verified}, viaFill ${over.viaFill})`,
    over.verified === false && over.viaFill === true && over.reason === both.reason);
}

done("namespv-union-scope");
