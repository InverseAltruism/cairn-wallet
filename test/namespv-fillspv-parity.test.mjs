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
import { provenOfferPayto } from "../src/core/fillspv.js";
import { offer } from "../src/vendor/cairnx-spv.js";
import { buildNameClaim, proposeTx, world, source, feeOut, pick, signSighash, buildScriptSig, addrFromPriv, ctxid, vSighash, rpcTxToTx } from "./_spvrig.ts";

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

console.log(`\nnamespv-fillspv-parity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
