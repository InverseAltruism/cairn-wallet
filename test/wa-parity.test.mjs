// WA-PARITY (Plan 70 R2 / W-A defense-in-depth) — the SHARED fill-boundary corpus, SEAM 2 of 3: cairn-wallet.
//
// One canonical hostile-case corpus (test/vectors/wa-parity-corpus.json, byte-identity-checked against the
// csd-sdk home copy) is fed to all three fill-boundary seams so a wallet-vs-site (or vs cairnx-core) divergence
// can never re-open the F8 class silently. This is the WALLET adapter: it materializes each scenario as REAL
// signed cairnx txs, places them in synthetic PoW-verified blocks, and drives the wallet's OWN production seam —
// liveFillSpvSource (the tip-anchored block-body scan + prevout-ownership bind) feeding the vendored verifyFillSpv,
// exactly the code path fclaimLanePreflight runs on the shipped artifact. NO chain-free injected event set: the
// wallet re-derives the offer/grant/hold/cancel replay from block bodies it merkle-proves itself.
//
// Two families (see the corpus note):
//   • 'replay' scenarios exercise the grant/hold/completeness replay ALL THREE seams share. The wallet drives the
//     REAL liveFillSpvSource + verifyFillSpv over real signed txs and asserts safe === (expect==='accept').
//     withheld-cancel is the wallet-vs-cairnx-core DIVERGENCE the corpus locks: cairnx-core's verifyFillSpv trusts
//     its io.offerEventIds (a resolver hint list) and ACCEPTS an event withheld from it; the wallet has NO hint
//     list — offerEventIds is derived from its OWN PoW-verified block-body scan — so it FINDS the withheld cancel
//     and REFUSES. We demonstrate both halves: the real block-scan io REJECTS, and a synthetic hint-list io that
//     omits the cancel ACCEPTS (which is exactly why the block scan is load-bearing).
//   • 'terms' scenarios exercise the served-offer vs merkle-proven-offer bind that only the CALLER does. The
//     funding-tx attacks (payto-strip / payto-resign) drive the REAL provenOfferPayto over the tampered offer tx
//     and assert it fails CLOSED (null); the served-field attacks (seller-swap / spurious-min / deflated-feeBps)
//     drive the REAL fclaimLanePreflight (provenTermsMismatch + the payto/seller bind) and assert FILL_UNSAFE,
//     nothing submitted. The honest controls are NOT refused (the no-false-refusal UX red line).
//
// MUTATION GATE (load-bearing): neutralising the F8 ocancel-scan line (MUTATE_OCANCEL_SCAN) in the REAL
// fillspv.ts source makes the ocancel vanish from the replay, and the ocancel-before-grant reject FLIPS to accept
// — proving the corpus reject is enforced by that exact guard, not passing for an unrelated reason.
//
// Run: tsx test/wa-parity.test.mjs   (offline; synthetic PoW, real signed txs, no live chain)
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs } from "../src/core/cairnx.js";
import { liveFillSpvSource, provenOfferPayto, countMyOtherLiveHolds, feeBpsAt } from "../src/core/fillspv.js";
import {
  offer, fclaim, offerCancelAll, deploy, mint, verifyFillSpv, payloadHash,
  V28_HEIGHT, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, CLAIM_COOLDOWN_BLOCKS, FILL_TIP_MARGIN,
  FEE_BPS_V16, TREASURY_ADDR, DEPLOY_FEE, epochOf, fclaimHoldEnd,
} from "../src/vendor/cairnx-spv.js";
import { proposeTx, addrFromPriv, signSighash, buildScriptSig, ctxid, vSighash, merkleRoot, rpcTxToTx, prevoutFor, pick } from "./_spvrig.ts";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..", "src", "core");
const corpusPath = path.join(here, "vectors", "wa-parity-corpus.json");
const corpusRaw = readFileSync(corpusPath, "utf8");
const corpus = JSON.parse(corpusRaw);

console.log("WA-PARITY (wallet seam): the shared fill-boundary corpus driven over the REAL wallet fillspv seam\n");

// ── 0. corpus integrity: the freshness/byte-identity hash the vendored COPY must match (the I2 dead-green cure).
// The hash is over the PARSED-then-canonicalised object via the wallet's OWN vendored codec (the same payloadHash
// the wallet signs with), so a drifted copy FAILS here, never silently skips. A DIFFERENT codec would also red it.
const WA_CORPUS_SHA = "0x0a4e1072ed97b1b08877fa1968154345508e514daeba854b8da560ffec25f047";
{
  const actual = payloadHash(corpus);
  check(`corpus byte-identity: vendored payloadHash == the WA_CORPUS_SHA pin (got ${actual})`, actual === WA_CORPUS_SHA);
}

// ── 1. constants bind: a silent gate/fee/epoch drift in the wallet's vendored core must RED the corpus. ──
{
  const C = corpus.consts;
  check(`V28_HEIGHT matches corpus (${V28_HEIGHT})`, V28_HEIGHT === C.V28_HEIGHT);
  check(`EPOCH_LEN matches corpus (${EPOCH_LEN})`, EPOCH_LEN === C.EPOCH_LEN);
  check("FCLAIM_MAX_EPOCH_AHEAD matches corpus", FCLAIM_MAX_EPOCH_AHEAD === C.FCLAIM_MAX_EPOCH_AHEAD);
  check("CLAIM_COOLDOWN_BLOCKS matches corpus", CLAIM_COOLDOWN_BLOCKS === C.CLAIM_COOLDOWN_BLOCKS);
  check("FILL_TIP_MARGIN matches corpus", FILL_TIP_MARGIN === C.FILL_TIP_MARGIN);
  check("FEE_BPS_V16 matches corpus", Number(FEE_BPS_V16) === C.FEE_BPS_V16);
  check("TREASURY_ADDR matches corpus (fee-leg drift guard)", String(TREASURY_ADDR).toLowerCase() === String(C.TREASURY_ADDR).toLowerCase());
}

// ── actor + id maps: each corpus actor label -> a deterministic REAL key (its address = addrFromPriv). ──
const KEY = { A: "0x" + "a1".repeat(32), B: "0x" + "b2".repeat(32), C: "0x" + "c3".repeat(32) };
const ADDR = { A: addrFromPriv(KEY.A).toLowerCase(), B: addrFromPriv(KEY.B).toLowerCase(), C: addrFromPriv(KEY.C).toLowerCase() };
const H0 = V28_HEIGHT;
const resolveHeight = (tok) => { const m = /^H0(?:\+(\d+))?$/.exec(String(tok)); if (!m) throw new Error(`bad height token ${tok}`); return H0 + (m[1] ? Number(m[1]) : 0); };
const resolveEe = (ee) => { if (ee.kind === "epochOfPlus") return epochOf(resolveHeight(ee.of)) + ee.plus; throw new Error(`bad ee ${JSON.stringify(ee)}`); };

// A synthetic SpvSource whose blocks carry a REAL merkle root (so bindBlock genuinely passes) and returns a
// filler-only block for empty heights (the fill scan iterates every height in the tip-anchored window). Identical
// shape to fill-fclaim-preflight.test.mjs's fillSource, driving the SAME liveFillSpvSource production path.
const FILLER = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 1, script_sig: "0x" }], outputs: [{ value: 1, script_pubkey: "0x" + "77".repeat(20) }] };
function fillSource(blocks, tip) {
  return {
    async prepare() { return { verifiedTip: tip, nodeTip: tip }; },
    async blockAt(height) {
      const txs = blocks.get(height) ?? [FILLER];
      return { merkle: merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } })))), txs };
    },
    async prevoutScriptPubkey(prevTxid) { return prevoutFor(prevTxid); },
  };
}
const worldOf = (placements) => { const b = new Map(); for (const { height, tx } of placements) (b.get(height) ?? b.set(height, []).get(height)).push(tx); return b; };

// Materialise ONE scenario as REAL signed txs placed in blocks (the honest, on-chain-truth event set — a 'terms'
// attack lives in the SERVED offer only, which this SPV layer never sees, so the on-chain events are always honest).
function materialise(s) {
  const placements = [];
  const labelTx = {}, labelEe = {};
  const wantRec = { value: s.offer.want.value };
  if (s.offer.want.payto) wantRec.payto = ADDR[s.offer.want.payto];
  const offerBody = { give: s.offer.give, want: wantRec };
  if (s.offer.min) offerBody.min = s.offer.min;
  const offerTx = proposeTx({ ...pick(offer(offerBody)), priv: KEY[s.offer.by], expiresEpoch: 9e9 });
  const offerId = ctxid(rpcTxToTx(offerTx)).toLowerCase();
  const offerHeight = resolveHeight(s.offer.height);
  placements.push({ height: offerHeight, tx: offerTx });

  const mainEe = resolveEe(s.fclaim.ee);
  const mainFc = proposeTx({ ...pick(fclaim({ offer: offerId })), priv: KEY[s.fclaim.by], expiresEpoch: mainEe });
  labelTx[s.fclaim.id] = mainFc; labelEe[s.fclaim.id] = mainEe;
  placements.push({ height: resolveHeight(s.fclaim.height), tx: mainFc });

  let withheldOcancel = null;
  for (const e of s.extra) {
    if (e.kind === "fclaim") {
      const ee = resolveEe(e.ee);
      const tx = proposeTx({ ...pick(fclaim({ offer: offerId })), priv: KEY[e.by], expiresEpoch: ee });
      labelTx[e.id] = tx; labelEe[e.id] = ee;
      placements.push({ height: resolveHeight(e.height), tx });
    } else if (e.kind === "ocancel") {
      const tx = proposeTx({ ...pick(offerCancelAll({ ticker: e.ticker })), priv: KEY[e.by], expiresEpoch: 9e9 });
      placements.push({ height: resolveHeight(e.height), tx });
      if (e.withheld) withheldOcancel = tx;   // on-chain (in a block the wallet scan window covers), NOT hinted
    } else throw new Error(`bad extra kind ${e.kind}`);
  }

  const fillTx = labelTx[s.fill.fclaim];
  if (!fillTx) throw new Error(`fill target ${s.fill.fclaim} not materialised`);
  const fillFclaimTxid = ctxid(rpcTxToTx(fillTx)).toLowerCase();
  const fillEe = labelEe[s.fill.fclaim];
  let tip;
  if (s.fill.tip.kind === "holdEndMinus") tip = fclaimHoldEnd(fillEe) - s.fill.tip.n;
  else if (s.fill.tip.kind === "absolute") tip = resolveHeight(s.fill.tip.h);
  else throw new Error(`bad tip ${JSON.stringify(s.fill.tip)}`);
  return { blocks: worldOf(placements), offerId, offerHeight, fillFclaimTxid, me: ADDR[s.fill.me], tip, pay: s.fill.pay, withheldOcancel };
}

// Drive the REAL wallet fill-SPV seam (liveFillSpvSource over the synthetic-PoW source of real txs) + verifyFillSpv.
async function driveReplay(m) {
  const io = await liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(m.blocks, m.tip), hints: { offerId: m.offerId, fclaimTxid: m.fillFclaimTxid, me: m.me, offerHeight: m.offerHeight } });
  const opts = { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant };
  if (m.pay != null) opts.pay = BigInt(m.pay);
  const v = await verifyFillSpv(m.offerId, m.fillFclaimTxid, m.me, io, opts);
  return { io, v };
}

// ── 2. REPLAY family: drive every replay scenario through the REAL wallet seam. ──
console.log("REPLAY family (grant/hold/completeness replay over the REAL liveFillSpvSource + verifyFillSpv):");
let replayRun = 0;
for (const s of corpus.scenarios.filter((x) => x.family === "replay")) {
  const m = materialise(s);
  let v, threw = false;
  try { ({ v } = await driveReplay(m)); } catch { threw = true; }
  // A THROW is a fail-closed refusal (the preflight surfaces it as retryable VERIFY_UNAVAILABLE), i.e. NOT accept.
  const safe = !threw && v.safe === true;
  check(`[${s.name}] wallet verdict = ${s.expect} (got ${threw ? "THREW(fail-closed)" : "safe=" + v.safe + " :: " + v.reason})`, safe === (s.expect === "accept"));
  replayRun++;
}
check(`ran every replay-family scenario through the wallet seam (${replayRun})`, replayRun >= 7);

// ── 3. withheld-cancel DIVERGENCE lock: prove the wallet's block scan is what catches it, not a hint list. ──
// The wallet io (real block scan) REJECTS; a hint-list io that OMITS the cancel from offerEventIds (the exact
// completeness gap cairnx-core cannot close) ACCEPTS — so if the wallet ever regressed to trusting a hint list,
// this seam would go green where it must be red. Directly locks the wallet-vs-cairnx-core split the fixture exists for.
console.log("\nwithheld-cancel divergence (block scan vs resolver hint list):");
{
  const s = corpus.scenarios.find((x) => x.name === "withheld-cancel");
  const m = materialise(s);
  const cancelId = ctxid(rpcTxToTx(m.withheldOcancel)).toLowerCase();
  check("sanity: withheld-cancel materialised an on-chain ocancel", typeof cancelId === "string" && cancelId.length === 66);
  const realIo = await liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(m.blocks, m.tip), hints: { offerId: m.offerId, fclaimTxid: m.fillFclaimTxid, me: m.me, offerHeight: m.offerHeight } });
  const realIds = await realIo.offerEventIds();
  check("the wallet's OWN block-body scan FOUND the withheld cancel (it is in offerEventIds, no hint list consulted)", realIds.map((x) => String(x).toLowerCase()).includes(cancelId));
  const vReal = await verifyFillSpv(m.offerId, m.fillFclaimTxid, m.me, realIo, { myLiveHoldsAtGrant: realIo.myLiveHoldsAtGrant });
  check(`the wallet REJECTS the withheld-cancel fill (safe:false) (${vReal.reason})`, vReal.safe === false);
  // a resolver-hint-list io that OMITS the cancel from offerEventIds (cairnx-core's trust model) would ACCEPT.
  const hintListIo = { ...realIo, async offerEventIds() { return realIds.filter((x) => String(x).toLowerCase() !== cancelId); } };
  const vHint = await verifyFillSpv(m.offerId, m.fillFclaimTxid, m.me, hintListIo, { myLiveHoldsAtGrant: realIo.myLiveHoldsAtGrant });
  check("a hint-list io that hides the cancel ACCEPTS — proving the wallet's independent block scan is load-bearing", vHint.safe === true);
}

// ── 4. TERMS family ─────────────────────────────────────────────────────────────────────────────────────────
// Shared terms-drive scaffolding (fclaim-lane, mirroring fill-fclaim-preflight.test.mjs's F2 pattern). The
// on-chain offer is honest; each scenario tampers ONE field of the resolver-SERVED offer object.
const ATT = "0x" + "a7".repeat(20);           // the attacker's redirect address
const S = ADDR.A;                             // the honest seller (proven author)
const V = 500000000;                          // corpus want.value for the terms offers
const OID = "0x" + "0f".repeat(32);           // the fclaim-lane offer id
const fcH = "0x" + "fa".repeat(32);           // the buyer's granted fclaim
const E = epochOf(H0 + 3) + 2;
const HOLD_END = fclaimHoldEnd(E);
const PE = (i, built, height, proposer, ee, pos = 0, paidTo = {}) => ({ kind: "propose", id: i, proposer, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const baseFor = () => [
  PE("0x" + "01".repeat(32), deploy({ ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" }), H0, S, 9e9, 0, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
  PE("0x" + "02".repeat(32), mint({ ticker: "AAA", amount: "1000" }), H0 + 1, S, 9e9),
  PE(OID, offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: S } }), H0 + 2, S, 9e9),
];
const fcFor = (txid, offerId, height, holder) => PE(txid, fclaim({ offer: offerId }), height, holder, E);
const idOf = (e) => (e.kind === "propose" ? e.id : e.txid).toLowerCase();
// The proven io — the fee/rebate terms + payment recipients derived from the PROVEN offer event, exactly as
// liveFillSpvSource proves them (anchored to real SPV by the payto-strip control below, which asserts the REAL
// provenOfferPayto yields the identical {height, feeBps, value, min} for the same honest offer).
function makeIo(events, tip, me, fillFclaimHeight) {
  const offerEv = events.find((e) => idOf(e) === OID.toLowerCase());
  let seller = String(offerEv?.proposer ?? "").toLowerCase(), payto = seller, orec = {};
  try { orec = JSON.parse(offerEv.uri); if (orec?.want?.payto) payto = String(orec.want.payto).toLowerCase(); } catch {}
  return {
    myLiveHoldsAtGrant: countMyOtherLiveHolds(events, OID, me, fillFclaimHeight),
    provenPayto: payto, provenSeller: seller,
    provenTerms: { height: Number(offerEv?.height), feeBps: feeBpsAt(Number(offerEv?.height)), value: orec?.want?.value !== undefined ? String(orec.want.value) : undefined, taker: orec?.taker !== undefined ? String(orec.taker).toLowerCase() : undefined, bid: orec?.bid !== undefined ? String(orec.bid).toLowerCase() : undefined, min: orec?.min !== undefined ? String(orec.min) : undefined },
    async tip() { return tip; },
    async offerEventIds() { return events.map(idOf); },
    async provenEvent(x) { const e = events.find((y) => idOf(y) === String(x).toLowerCase()); return e ? { ...e, depth: tip - e.height + 1 } : null; },
  };
}
const servedOffer = (extra = {}) => ({ id: OID, seller: S, give: { ticker: "AAA", amount: "10" }, want: { value: String(V), payto: S }, status: "open", height: H0 + 2, feeBps: 150, fclaimId: fcH, fclaimHeight: H0 + 3, fclaimExpiresEpoch: E, ...extra });
const coin = mkCoin(2_000_000_002);   // covers a whole 5 CSD fill (corpus want.value) + fee + rebate + change
const servedCoins = [coin];
function mkStub({ offerReply, clarvisReply = () => ({ ok: false, status: 404, json: async () => ({}) }), tip = 50_000 }) {
  const stats = { submits: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(1); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("clarvis") && u.includes("/cairnx/offer/")) return clarvisReply();
    if (u.includes("/cairnx/offer/")) return offerReply();
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: tip }) };
    const t = txReply(u, servedCoins);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}
async function freshWallet(pw) { const w = new Wallet(memoryStore()); await w.create(pw); return w; }
// Drive the REAL fclaim-lane preflight (provenTermsMismatch + the payto/seller bind) with a tampered served offer.
async function driveTermsFclaim(pw, served, outsFrom) {
  const w = await freshWallet(pw);
  const outs = requiredFillOutputs(outsFrom ?? served, BigInt(V)).map(({ to, value }) => ({ to, value: Number(value) }));
  w.fillSpvIoForTest = (oid, fc, me) => makeIo([...baseFor(), fcFor(fcH, OID, H0 + 3, me)], HOLD_END - 5, me, H0 + 3);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => served }) });
  const r = await w.fillOffer({ proposalId: fcH, outputs: outs });
  return { r, submits: s.submits.length };
}

console.log("\nTERMS family (served-offer vs merkle-proven-offer bind):");

// 4a. payto-strip / payto-resign: the FUNDING-tx attacks — drive the REAL provenOfferPayto over the tampered offer
//     tx and assert it fails CLOSED (null). The corpus offer is payto-LESS (recipient = the proven prevout owner A).
const swapSig = (rpcTx, newPriv) => { const t = JSON.parse(JSON.stringify(rpcTx)); const sg = signSighash(vSighash(rpcTxToTx(rpcTx)), newPriv); t.inputs[0].script_sig = buildScriptSig(sg.sig64, sg.pub33); return t; };
{
  const paytoLess = proposeTx({ ...pick(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(V) } })), priv: KEY.A, expiresEpoch: 9e9 });
  const plOid = ctxid(rpcTxToTx(paytoLess)).toLowerCase();
  const runPop = (src, oid) => provenOfferPayto({ rpcBase: "http://x", headersBase: "http://x", spvSource: src, offerId: oid, offerHeight: H0 + 2 });
  // honest control (no over-refusal) + real-SPV anchor: the proven terms equal what makeIo reflects.
  const honest = await runPop(fillSource(worldOf([{ height: H0 + 2, tx: paytoLess }]), H0 + 10), plOid);
  check(`terms honest-control: provenOfferPayto proves the payto-less offer's author = seller A (no false-refuse) (${honest?.seller})`,
    honest !== null && honest.seller === ADDR.A && honest.payto === ADDR.A && honest.terms.height === H0 + 2 && honest.terms.feeBps === 150 && honest.terms.value === String(V) && honest.terms.min === undefined);
  // payto-strip: strip the scriptSig -> recoverSigner null -> null (fail-closed; the wallet then refuses retryably).
  const stripped = JSON.parse(JSON.stringify(paytoLess)); stripped.inputs[0].script_sig = "0x";
  const rStrip = await runPop(fillSource(worldOf([{ height: H0 + 2, tx: stripped }]), H0 + 10), ctxid(rpcTxToTx(stripped)).toLowerCase());
  check("[payto-strip] a stripped funding scriptSig fails CLOSED (provenOfferPayto null; served attacker payto never bound)", rStrip === null);
  // payto-resign: re-sign with a throwaway key (recoverAttester = attacker == served proposer) but prevout stays A.
  const resigned = swapSig(paytoLess, KEY.C);
  const rResign = await runPop(fillSource(worldOf([{ height: H0 + 2, tx: resigned }]), H0 + 10), ctxid(rpcTxToTx(resigned)).toLowerCase());
  check("[payto-resign] a re-signed funding tx (prevout still A) fails CLOSED (provenOfferPayto null; recipient bound to prevout OWNER, not scriptSig)", rResign === null);
}

// 4b. seller-swap / spurious-min / deflated-feeBps: the SERVED-FIELD attacks — drive the REAL fclaimLanePreflight.
{
  const honest = await driveTermsFclaim("wa-terms-honest", servedOffer());
  check(`terms honest-control: an untampered served offer is NOT refused and submits (${honest.r?.error ?? "ok"})`, honest.r?.ok === true && honest.submits === 1);
}
{
  // seller-swap: offer.seller -> attacker (rebate leg); want.payto stays honest. Bound to the proven author -> REFUSE.
  const r = await driveTermsFclaim("wa-seller-swap", servedOffer({ seller: ATT }));
  check(`[seller-swap] a swapped served seller (rebate leg) is REFUSED (proven author A != attacker) (${r.r?.error})`, r.r?.ok === false && r.r?.code === "FILL_UNSAFE" && r.submits === 0);
}
{
  // spurious-min: a min ADDED to a whole-fill offer flips previewFill to the partial branch (rebate 0). min bound -> REFUSE.
  const r = await driveTermsFclaim("wa-spurious-min", servedOffer({ min: "100000000" }), servedOffer());
  check(`[spurious-min-whole-fill] a spurious served min is REFUSED (maker-rebate-drop burn averted) (${r.r?.error})`, r.r?.ok === false && r.r?.code === "FILL_UNSAFE" && /fee\/rebate terms/.test(r.r?.error ?? "") && r.submits === 0);
}
{
  // deflated-feeBps: served feeBps=0 for a >= V16 offer (proven feeBpsAt(H0+2)=150). feeBps bound -> REFUSE.
  const served = servedOffer({ feeBps: 0 });
  const r = await driveTermsFclaim("wa-deflated-fee", served, served);
  check(`[deflated-feeBps] a deflated served feeBps (0 vs proven 150) is REFUSED (pay-without-delivery burn averted) (${r.r?.error})`, r.r?.ok === false && r.r?.code === "FILL_UNSAFE" && /fee\/rebate terms/.test(r.r?.error ?? "") && r.submits === 0);
}

// ── 5. MUTATION GATE (load-bearing): neutralise the F8 ocancel-scan line in the REAL fillspv.ts source and confirm
// the ocancel-before-grant corpus reject FLIPS to accept — proving the corpus reject rides that exact guard. ──
console.log("\nMUTATION GATE (the corpus reject is enforced by the real guard, not an unrelated reason):");
const FILLSPV_SRC = path.join(coreDir, "fillspv.ts");
async function withFillspvMutant(marker, run) {
  const lines = readFileSync(FILLSPV_SRC, "utf8").split("\n");
  const kept = lines.filter((l) => !l.includes(marker));
  if (kept.length !== lines.length - 1) throw new Error(`marker ${marker} must match exactly one line (matched ${lines.length - kept.length})`);
  const tmp = path.join(coreDir, `__waparity_mutant_fillspv_${Date.now()}.ts`);
  writeFileSync(tmp, kept.join("\n"));
  try { return await run(await import(pathToFileURL(tmp).href)); }
  finally { unlinkSync(tmp); }
}
{
  const s = corpus.scenarios.find((x) => x.name === "ocancel-before-grant");
  const m = materialise(s);
  const { v: vReal } = await driveReplay(m);
  check("baseline: the REAL wallet seam REJECTS ocancel-before-grant (the guard is live)", vReal.safe === false);
  const flipped = await withFillspvMutant("MUTATE_OCANCEL_SCAN", async (mod) => {
    const io = await mod.liveFillSpvSource({ rpcBase: "http://x", headersBase: "http://x", spvSource: fillSource(m.blocks, m.tip), hints: { offerId: m.offerId, fclaimTxid: m.fillFclaimTxid, me: m.me, offerHeight: m.offerHeight } });
    const opts = { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant };
    if (m.pay != null) opts.pay = BigInt(m.pay);
    return (await verifyFillSpv(m.offerId, m.fillFclaimTxid, m.me, io, opts)).safe;
  });
  check("MUTATION[MUTATE_OCANCEL_SCAN removed]: ocancel-before-grant FLIPS to accept (the ocancel scan is the sole rejecter)", flipped === true);
}

globalThis.fetch = origFetch;
console.log(`\nwa-parity (wallet seam): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
