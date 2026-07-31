// L4 (Plan 70 R2) — namespv/fillspv prevout-ownership AUTHORSHIP-bind parity.
//
// fillspv.ts hand-copied its prevout-ownership author bind from namespv.ts (the NSPV-SIGSUB-1 / H3 cure): the
// merkle root commits a tx BODY but NOT its scriptSig, and the sighash is secret-free, so a hostile block-body
// provider can splice in a foreign VALID signature over the same sighash to RE-ATTRIBUTE a record's author (the
// txid is unchanged, so the merkle proof still passes). Both files defeat it identically: the recovered signer
// must own the COIN the record spends (its prevout scriptPubkey == hash160(pub)). This wallet-INTERNAL fixture
// feeds the SAME hostile scriptSig-substitution to BOTH binds and asserts BOTH fail CLOSED, so the two hand-copied
// binds can never drift apart silently. Mutation-verified: removing EITHER bind line re-opens the re-attribution.
//
// (This is NOT the cross-repo WA-parity corpus; it is a wallet-internal author-bind equivalence check.)
//
// Run: tsx test/namespv-fillspv-parity.test.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { verifyName } from "../src/core/namespv.js";
import { provenOfferPayto, liveFillSpvSource, feeBpsAt } from "../src/core/fillspv.js";
import { offer, fclaim, epochOf, fclaimHoldEnd, V28_HEIGHT } from "../src/vendor/cairnx-spv.js";
import { buildNameClaim, proposeTx, world, source, feeOut, pick, signSighash, buildScriptSig, addrFromPriv, ctxid, vSighash, rpcTxToTx, merkleRoot, prevoutFor } from "./_spvrig.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..", "src", "core");

const keyA = "0x" + "a1".repeat(32);   // the honest author (owns the spent coin)
const keyB = "0x" + "b2".repeat(32);   // the attacker (foreign valid signature, does NOT own the coin)
const A = addrFromPriv(keyA).toLowerCase();
const B = addrFromPriv(keyB).toLowerCase();
const NM = "carol";
const H = 33700, TIP = 33800;

// THE shared hostile transformation: re-sign a tx's scriptSig with a FOREIGN key over the same (secret-free)
// sighash, keeping the record's prevout owner (A). ctxid is unchanged (scriptSig is stripped from the txid), so
// the merkle proof still passes — only the prevout-ownership bind stands between this and an author redirect.
const swapSig = (rpcTx, newPriv) => { const t = JSON.parse(JSON.stringify(rpcTx)); const sg = signSighash(vSighash(rpcTxToTx(rpcTx)), newPriv); t.inputs[0].script_sig = buildScriptSig(sg.sig64, sg.pub33); return t; };

console.log("L4 — namespv/fillspv prevout-ownership author-bind parity:\n");

// ── the two REAL records, each authored by A over A's own coin ──
const nameTx = proposeTx({ ...pick(buildNameClaim({ name: NM })), priv: keyA, outputs: feeOut() });
const offerTx = proposeTx({ ...pick(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000" } })), priv: keyA, expiresEpoch: 9e9 });
const offerId = ctxid(rpcTxToTx(offerTx)).toLowerCase();

// ── positive controls: the HONEST author (owns the spent coin) is accepted by BOTH binds (no over-rejection). ──
{
  const { blocks, hints } = world([{ height: H, tx: nameTx }]);
  const r = await verifyName(NM, { addr: A, owner: A }, hints, source(blocks, TIP));
  check(`namespv control: the honest name author verifies (owner A) (${r.reason ?? "verified"})`, r.verified === true && r.owner === A);
}
let honestOffer;
{
  const { blocks } = world([{ height: H, tx: offerTx }]);
  honestOffer = await provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: source(blocks, TIP), offerId, offerHeight: H });
  check(`fillspv control: the honest offer author proves (seller A) (${honestOffer?.seller})`, honestOffer !== null && honestOffer.seller === A && honestOffer.payto === A);
}

// ── THE hostile scriptSig-substitution fed to BOTH binds: each must fail CLOSED. ──
const nameSwapped = swapSig(nameTx, keyB);   // ctxid unchanged; prevout still A; scriptSig now B's valid sig
const offerSwapped = swapSig(offerTx, keyB);
let nspvReason = "", nspvVerified;
{
  const { blocks, hints } = world([{ height: H, tx: nameSwapped }]);
  const r = await verifyName(NM, { addr: B, owner: B }, hints, source(blocks, TIP));
  nspvVerified = r.verified; nspvReason = r.reason ?? "";
  check(`namespv bind: scriptSig-substituted name author is REFUSED (${nspvReason})`, r.verified === false && /own the coin|substitution/i.test(nspvReason));
}
let fillspvNull;
{
  const { blocks } = world([{ height: H, tx: offerSwapped }]);
  const r = await provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: source(blocks, TIP), offerId: ctxid(rpcTxToTx(offerSwapped)).toLowerCase(), offerHeight: H });
  fillspvNull = r === null;
  check("fillspv bind: scriptSig-substituted offer author is REFUSED (provenOfferPayto null)", r === null);
}
// PARITY: the identical hostile input is fail-closed by BOTH binds (neither attributes the record to the attacker B).
check("PARITY: the SAME scriptSig-substitution is fail-closed IDENTICALLY by both hand-copied binds", nspvVerified === false && fillspvNull === true);

// ── MUTATION: removing EITHER prevout-ownership bind line re-opens the author redirect (each bind is load-bearing). ──
console.log("\nMUTATION (each hand-copied bind is the sole rejecter):");
async function withMutant(file, marker, run) {
  const src = path.join(coreDir, file);
  const lines = readFileSync(src, "utf8").split("\n");
  const kept = lines.filter((l) => !l.includes(marker));
  if (kept.length !== lines.length - 1) throw new Error(`marker ${marker} must match exactly one line in ${file} (matched ${lines.length - kept.length})`);
  const tmp = path.join(coreDir, `__parity_mutant_${file.replace(/\W/g, "_")}_${Date.now()}.ts`);
  writeFileSync(tmp, kept.join("\n"));
  try { return await run(await import(pathToFileURL(tmp).href)); }
  finally { unlinkSync(tmp); }
}
{
  const { blocks, hints } = world([{ height: H, tx: nameSwapped }]);
  const r = await withMutant("namespv.ts", "MUTATE_NSPV_PREVOUT_BIND", (mod) => mod.verifyName(NM, { addr: B, owner: B }, hints, source(blocks, TIP)));
  check("MUTATION[namespv bind removed]: the substituted author is now ATTRIBUTED to attacker B (name verifies) — bind is load-bearing", r.verified === true && r.owner === B);
}
{
  const { blocks } = world([{ height: H, tx: offerSwapped }]);
  const oid = ctxid(rpcTxToTx(offerSwapped)).toLowerCase();
  const r = await withMutant("fillspv.ts", "MUTATE_FILLSPV_PREVOUT_BIND", (mod) => mod.provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: source(blocks, TIP), offerId: oid, offerHeight: H }));
  check("MUTATION[fillspv bind removed]: the substituted author now PROVES as attacker B (provenOfferPayto non-null) — bind is load-bearing", r !== null && r.seller === B);
}

// ── MPB-1 (Plan 75 P75-7): mutation coverage for the merkle-proven-value PRODUCERS. The sole producers of
// every value the fill binds against — provenOfferPayto (legacy lane) and liveFillSpvSource (fclaim lane) —
// had coverage only for the prevout bind (#1 MUTATE_FILLSPV_PREVOUT_BIND, above). Output-pin, non-vacuous:
// drive each producer over a KNOWN synthetic offer and pin the returned fields against baked ground truth;
// removing any producer marker fails the producer closed (null / throw), reding that field's pin. Acceptance:
// 8 producer mutations (1 above + 7 here) all observed RED, the un-mutated baseline pins all pass.
console.log("\nMPB-1 (producer mutation coverage: provenOfferPayto + liveFillSpvSource):");

// #2-#5 (provenOfferPayto): a TOKEN offer with an explicit want.payto (payto != author) so payto/seller are
// distinct pinnable values, plus feeBps + wantTicker/wantAmount. Each marker's removal nulls the producer.
{
  const PAYTO = "0x" + "d0".repeat(20);
  const tokOfferTx = proposeTx({ ...pick(offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "USDX", amount: "7", payto: PAYTO } })), priv: keyA, expiresEpoch: 9e9 });
  const tokOid = ctxid(rpcTxToTx(tokOfferTx)).toLowerCase();
  const { blocks } = world([{ height: H, tx: tokOfferTx }]);
  const drive = (mod) => (mod ?? { provenOfferPayto }).provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: source(blocks, TIP), offerId: tokOid, offerHeight: H }).catch(() => null);
  const base = await drive();
  check(`MPB-1 baseline: provenOfferPayto over the known token offer pins its fields (payto ${base?.payto === PAYTO}, feeBps ${base?.terms?.feeBps})`,
    base !== null && base.payto === PAYTO && base.seller === A && base.terms.feeBps === 150 && base.wantTicker === "USDX" && base.wantAmount === "7");
  const cases = [
    ["MUTATE_PROVEN_PAYTO_DERIVE", "payto", PAYTO, (r) => r?.payto],
    ["MUTATE_PROVEN_TERMS_HEIGHT", "terms.feeBps", 150, (r) => r?.terms?.feeBps],
    ["MUTATE_PROVEN_WANT_TICKER", "wantTicker", "USDX", (r) => r?.wantTicker],
    ["MUTATE_PROVEN_WANT_AMOUNT", "wantAmount", "7", (r) => r?.wantAmount],
  ];
  for (const [marker, field, expect, get] of cases) {
    const mutated = await withMutant("fillspv.ts", marker, (mod) => drive(mod));
    check(`MPB-1 MUT[${marker}]: the ${field} pin REDS (baseline ${JSON.stringify(expect)}, mutant ${JSON.stringify(get(mutated))})`, get(mutated) !== expect);
  }
}

// #6-#8 (liveFillSpvSource): the fclaim lane's proven producers, driven over a fill-style source (FILLER for
// empty heights, since liveFillSpvSource scans the whole tip-anchored window). offer with want.payto != author.
{
  const H0 = V28_HEIGHT;
  const meKey = "0x" + "3f".repeat(32), MEL = addrFromPriv(meKey).toLowerCase();
  const sK = "0x" + "7a".repeat(32), SL = addrFromPriv(sK).toLowerCase();
  const PAYTO2 = "0x" + "e1".repeat(20);
  const offTx = proposeTx({ ...pick(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: PAYTO2 } })), priv: sK, expiresEpoch: 9e9 });
  const loid = ctxid(rpcTxToTx(offTx)).toLowerCase();
  const E = epochOf(H0 + 3) + 2;
  const fcTx = proposeTx({ ...pick(fclaim({ offer: loid })), priv: meKey, expiresEpoch: E });
  const fid = ctxid(rpcTxToTx(fcTx)).toLowerCase();
  const FILLER = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 1, script_sig: "0x" }], outputs: [{ value: 1, script_pubkey: "0x" + "77".repeat(20) }] };
  const worldOf = (ps) => { const b = new Map(); for (const { height, tx } of ps) (b.get(height) ?? b.set(height, []).get(height)).push(tx); return b; };
  const blocks = worldOf([{ height: H0 + 2, tx: offTx }, { height: H0 + 3, tx: fcTx }]);
  const TIP2 = fclaimHoldEnd(E) - 5;
  const fillSource = (tip) => ({
    async prepare() { return { verifiedTip: tip, nodeTip: tip }; },
    async blockAt(height) { const txs = blocks.get(height) ?? [FILLER]; return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } })))), txs }; },
    async prevoutScriptPubkey(p) { return prevoutFor(p); },
  });
  const drive = (mod) => (mod ?? { liveFillSpvSource }).liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(TIP2), hints: { offerId: loid, fclaimTxid: fid, me: MEL, offerHeight: H0 + 2 } });
  const base = await drive();
  const EFEE = feeBpsAt(H0 + 2);
  check(`MPB-1 baseline: liveFillSpvSource pins provenSeller/provenPayto/provenTerms.feeBps (seller ${base.provenSeller === SL}, payto ${base.provenPayto === PAYTO2})`,
    base.provenSeller === SL && base.provenPayto === PAYTO2 && base.provenTerms.feeBps === EFEE);
  const cases = [
    ["MUTATE_LIVE_PROVEN_SELLER", "provenSeller", SL, (r) => r?.provenSeller],
    ["MUTATE_LIVE_PROVEN_PAYTO", "provenPayto", PAYTO2, (r) => r?.provenPayto],
    ["MUTATE_LIVE_PROVEN_TERMS", "provenTerms.feeBps", EFEE, (r) => r?.provenTerms?.feeBps],
  ];
  for (const [marker, field, expect, get] of cases) {
    let mutated = null;
    await withMutant("fillspv.ts", marker, async (mod) => { try { mutated = await drive(mod); } catch { mutated = null; } });
    check(`MPB-1 MUT[${marker}]: the ${field} pin REDS (baseline ${JSON.stringify(expect)}, mutant ${JSON.stringify(get(mutated))})`, get(mutated) !== expect);
  }
}

console.log(`\nnamespv-fillspv-parity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
