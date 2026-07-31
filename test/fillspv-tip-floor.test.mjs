// FILLSPV-01 (Plan 75 P75-7): the fill-SPV deadline/hold-liveness guards read io.tip(). A DEFLATED served
// tip under-states verifiedTip (prepare syncs only to the served tip), so a hold that has ACTUALLY lapsed
// reads as still live -> the fill signs -> the chain rejects it -> the payment BURNS. The fix clamps the
// REPORTED tip UP with the PoW-backed cross-session floor (floorTip from prepare): both terms are PoW
// evidence, so the max can only OVER-state (fail-closed, more refusals), never under-state, and it is NEVER
// the attacker-settable served nodeTip. This drives the REAL liveFillSpvSource + the vendored verifyFillSpv.
//
// RED-FIRST: with the clamp, a lapsed hold behind a deflated served tip is REFUSED (safe:false); removing the
// MUTATE_FILLSPV_TIP_FLOOR line reverts reportedTip to the deflated verifiedTip and the lapsed-hold fill FLIPS
// to safe:true (the burn). PAIRED HAPPY: an honest fill (no floorTip / floor <= verifiedTip) is UNCHANGED
// (reportedTip == verifiedTip, tipFloored false) and still ACCEPTS. The wallet remaps a tipFloored refusal to
// the retryable VERIFY_UNAVAILABLE copy; a genuine denial (tipFloored false) still returns FILL_UNSAFE.
//
// Run: node --import tsx test/fillspv-tip-floor.test.mjs   (offline; synthetic PoW, real signed txs)
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs } from "../src/core/cairnx.js";
import { liveFillSpvSource } from "../src/core/fillspv.js";
import { offer, fclaim, verifyFillSpv, V28_HEIGHT, FILL_TIP_MARGIN, epochOf, fclaimHoldEnd } from "../src/vendor/cairnx-spv.js";
import { proposeTx, addrFromPriv, ctxid, rpcTxToTx, merkleRoot, prevoutFor, pick } from "./_spvrig.ts";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;
const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..", "src", "core");

const H0 = V28_HEIGHT;
const V = 5_000_000;
const meKey = "0x" + "1a".repeat(32), ME = addrFromPriv(meKey).toLowerCase();
const sellerKey = "0x" + "5e".repeat(32), SELLER = addrFromPriv(sellerKey).toLowerCase();
const grantH = H0 + 3;
const E = epochOf(grantH) + 2;
const HOLD_END = fclaimHoldEnd(E);          // last L0-minable height for the fill

const offTx = proposeTx({ ...pick(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: SELLER } })), priv: sellerKey, expiresEpoch: 9e9 });
const LOID = ctxid(rpcTxToTx(offTx)).toLowerCase();
const fcTx = proposeTx({ ...pick(fclaim({ offer: LOID })), priv: meKey, expiresEpoch: E });
const FID = ctxid(rpcTxToTx(fcTx)).toLowerCase();

const FILLER = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 1, script_sig: "0x" }], outputs: [{ value: 1, script_pubkey: "0x" + "77".repeat(20) }] };
const worldOf = (placements) => { const b = new Map(); for (const { height, tx } of placements) (b.get(height) ?? b.set(height, []).get(height)).push(tx); return b; };
const blocks = worldOf([{ height: H0 + 2, tx: offTx }, { height: grantH, tx: fcTx }]);
// A synthetic SpvSource whose prepare() carries an explicit {verifiedTip, nodeTip, floorTip} so the tip-floor
// clamp is exercised (the wa-parity/fill-fclaim fillSource omits floorTip, keeping the clamp inert there).
function fillSource(tips) {
  return {
    async prepare() { return { verifiedTip: tips.verifiedTip, nodeTip: tips.nodeTip, ...(tips.floorTip !== undefined ? { floorTip: tips.floorTip } : {}) }; },
    async blockAt(height) { const txs = blocks.get(height) ?? [FILLER]; return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } })))), txs }; },
    async prevoutScriptPubkey(p) { return prevoutFor(p); },
  };
}
const runLive = (tips, src) => (src ?? liveFillSpvSource)({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(tips), hints: { offerId: LOID, fclaimTxid: FID, me: ME, offerHeight: H0 + 2 } });

console.log("FILLSPV-01 - PoW-floor clamp on the tip reported to verifyFillSpv:\n");

// ── Part A: the clamp itself, over the REAL liveFillSpvSource + verifyFillSpv. ──
// A DEFLATED served tip (HOLD_END-20) with the PoW floor carrying the true higher tip (HOLD_END+10, past the
// hold): the clamp raises the reported tip to the floor, so the deadline guard sees the hold as LAPSED.
{
  const io = await runLive({ verifiedTip: HOLD_END - 20, nodeTip: HOLD_END - 20, floorTip: HOLD_END + 10 });
  check(`the reported tip is clamped UP to the PoW floor (${await io.tip()} == ${HOLD_END + 10})`, (await io.tip()) === HOLD_END + 10);
  check("tipFloored is set (the floor overrode a lower verified tip)", io.tipFloored === true);
  const v = await verifyFillSpv(LOID, FID, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: BigInt(V) });
  // holdEnd (HOLD_END) < reportedTip (HOLD_END+10) + FILL_TIP_MARGIN -> the "would strand"/lapsed refusal fires.
  check(`the lapsed hold behind a deflated served tip is REFUSED (safe:false) (${v.reason})`, v.safe === false);
}

// RED-FIRST mutation: removing the clamp line reverts the reported tip to the deflated verifiedTip, and the
// lapsed-hold fill FLIPS to safe:true (the exact burn the clamp prevents) — proving the clamp is the sole fix.
const FILLSPV_SRC = path.join(coreDir, "fillspv.ts");
async function withFillspvMutant(marker, run) {
  const lines = readFileSync(FILLSPV_SRC, "utf8").split("\n");
  const kept = lines.filter((l) => !l.includes(marker));
  if (kept.length !== lines.length - 1) throw new Error(`marker ${marker} must match exactly one line (matched ${lines.length - kept.length})`);
  const tmp = path.join(coreDir, `__tipfloor_mutant_${Date.now()}.ts`);
  writeFileSync(tmp, kept.join("\n"));
  try { return await run(await import(pathToFileURL(tmp).href)); }
  finally { unlinkSync(tmp); }
}
{
  const flipped = await withFillspvMutant("MUTATE_FILLSPV_TIP_FLOOR", async (mod) => {
    const io = await runLive({ verifiedTip: HOLD_END - 20, nodeTip: HOLD_END - 20, floorTip: HOLD_END + 10 }, mod.liveFillSpvSource);
    const reported = await io.tip();
    const v = await verifyFillSpv(LOID, FID, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: BigInt(V) });
    return { reported, safe: v.safe };
  });
  check(`MUTATION: reportedTip reverts to the deflated verifiedTip (${flipped.reported} == ${HOLD_END - 20})`, flipped.reported === HOLD_END - 20);
  check("MUTATION: the lapsed-hold fill FLIPS to safe:true (the burn the clamp prevents)", flipped.safe === true);
}

// ── PAIRED HAPPY: an honest fill (NO floorTip, so floor <= verifiedTip) is UNCHANGED and still ACCEPTS. ──
{
  const io = await runLive({ verifiedTip: HOLD_END - 5, nodeTip: HOLD_END - 5 });   // no floorTip -> floorTip = 0
  check(`honest: reportedTip == verifiedTip (no clamp) (${await io.tip()} == ${HOLD_END - 5})`, (await io.tip()) === HOLD_END - 5 && io.tipFloored === false);
  const v = await verifyFillSpv(LOID, FID, ME, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant, pay: BigInt(V) });
  check(`honest: the in-window fill is ACCEPTED (safe) (${v.reason ?? "safe"})`, v.safe === true);
}
{
  // an at-tip floor <= verifiedTip is also a no-op (reportedTip == verifiedTip, tipFloored false).
  const io = await runLive({ verifiedTip: HOLD_END - 5, nodeTip: HOLD_END - 5, floorTip: HOLD_END - 50 });
  check("honest: a floor BELOW verifiedTip does not clamp (tipFloored false)", (await io.tip()) === HOLD_END - 5 && io.tipFloored === false);
}

// ── Part B: the wallet-lane copy remap. A tipFloored refusal becomes retryable VERIFY_UNAVAILABLE; a genuine
// denial (tipFloored false) still returns FILL_UNSAFE. Driven through the REAL w.fillOffer via fillSpvIoForTest. ──
const coin = mkCoin(100_000_002);
const served = [coin];
const servedOffer = { id: LOID, seller: SELLER, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: SELLER }, status: "open", height: H0 + 2, feeBps: 150, fclaimId: FID, fclaimHeight: grantH, fclaimExpiresEpoch: E };
const outputs = requiredFillOutputs(servedOffer, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
function mkStub() {
  const stats = { submits: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(JSON.parse(init?.body || "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("clarvis") && u.includes("/cairnx/offer/")) return { ok: false, status: 404, json: async () => ({}) };
    if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => servedOffer };
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 50_000 }) };
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}
async function freshWallet(pw) { const w = new Wallet(memoryStore()); await w.create(pw); return w; }
{
  // the tip-floored (lapsed-behind-deflation) io -> the wallet returns the retryable VERIFY_UNAVAILABLE copy.
  const io = await runLive({ verifiedTip: HOLD_END - 20, nodeTip: HOLD_END - 20, floorTip: HOLD_END + 10 });
  const w = await freshWallet("pw-tipfloored-123");
  w.fillSpvIoForTest = () => io;
  const s = mkStub();
  const r = await w.fillOffer({ proposalId: FID, outputs });
  check(`wallet: a tipFloored refusal is remapped to retryable VERIFY_UNAVAILABLE (${r?.error})`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE" && /could not confirm this reservation/i.test(String(r?.error)));
  check("...and nothing was submitted", s.submits.length === 0);
}
{
  // control: a GENUINE denial with tipFloored FALSE still returns the definitive FILL_UNSAFE reason (no remap).
  // Build a real safe:false io (a lapsed hold, but at a HONEST tip past the hold, tipFloored false).
  const io = await runLive({ verifiedTip: HOLD_END + 10, nodeTip: HOLD_END + 10 });   // honest tip past the hold -> genuinely lapsed, NOT floored
  check("control io is a genuine denial with tipFloored false", io.tipFloored === false);
  const w = await freshWallet("pw-genuine-deny-123");
  w.fillSpvIoForTest = () => io;
  const s = mkStub();
  const r = await w.fillOffer({ proposalId: FID, outputs });
  check(`wallet: a genuine denial (tipFloored false) still returns FILL_UNSAFE (${r?.error})`, r?.ok === false && r?.code === "FILL_UNSAFE");
  check("...and nothing was submitted", s.submits.length === 0);
}

globalThis.fetch = origFetch;
console.log(`\nfillspv-tip-floor: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
