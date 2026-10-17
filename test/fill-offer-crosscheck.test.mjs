// M-1: fclaim-lane pre-window withholding. The fill SPV scan covers [tip - 223, tip]; a primary resolver that
// withholds an older cancel or consuming fill serves the buyer's fclaim as granted, verifyFillSpv returns safe and
// the buyer pays for nothing. The wallet now reads the offer from the second resolver (clarvis) by offer id while
// the scan runs and refuses on positive evidence only (OFFER_SOURCE_CONFLICT).
//
//   1. secondSourceOfferConflict unit table (pure).
//   2. The PoC (cancel / 90% partial fill withheld ~1,400 blocks before the buy) through the REAL wallet preflight:
//      with clarvis telling the truth it is refused and nothing is submitted; with clarvis 404 it still submits
//      (the gap is open when the second source is down, and this is the red-first for the wallet change).
//   3. Acceptance (a)-(g): cancelled / higher paid / later holder refuse; agree / 404 / timeout / garbage proceed,
//      and the honest fill submits the same bytes as the 0.2.72 tree.
//   4. Latency: a slow clarvis does not lengthen the honest fill (the read runs beside the scan, never awaited).
//
// RED-FIRST: replace the secondSourceOfferConflict call in wallet.ts fclaimLanePreflight with `null` and the
// refusal rows of sections 2 and 3 go red.
// Run: node --import tsx test/fill-offer-crosscheck.test.mjs   (offline)
import { createHash } from "node:crypto";
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { secondSourceOfferConflict } from "../src/core/offerxcheck.js";
import {
  deploy, mint, offer, fclaim, resolve, verifyFillSpv, requiredFillOutputs, provenOfferTerms, parseRecord, fclaimHoldEnd,
  epochOf, TREASURY_ADDR, DEPLOY_FEE, SCORE_FILL, SCORE_CANCEL, MAX_SCAN,
} from "../src/vendor/cairnx-spv.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const PRIV = "0x" + "42".repeat(32);

console.log("1. secondSourceOfferConflict (pure)");
{
  const OID = H(1), FC = H(2), OTHER = H(3);
  const P = { id: OID, status: "open", paid: "100", delivered: "10", claimTxid: FC, claimUntilHeight: 1200 };
  const ctx = { offerId: OID, fclaimTxid: FC, ownHoldEnd: 1199 };
  const x = (second, c = ctx, primary = P) => secondSourceOfferConflict(primary, second, c);
  for (const st of ["cancelled", "filled", "expired"]) check(`status ${st} refuses`, /is /.test(x({ ...P, status: st }) ?? ""));
  check("status open, same progress, same holder: no conflict", x({ ...P }) === null);
  check("unknown status string is not evidence", x({ ...P, status: "weird" }) === null);
  check("higher paid refuses", /paid/.test(x({ ...P, paid: "101" }) ?? ""));
  check("higher delivered refuses", /delivered/.test(x({ ...P, delivered: "11" }) ?? ""));
  check("paid on a primary that omits it (0) refuses", /paid/.test(x({ ...P, paid: "1" }, ctx, { ...P, paid: undefined }) ?? ""));
  check("lower or equal paid (a lagging source) proceeds", x({ ...P, paid: "50", delivered: "10" }) === null && x({ ...P, paid: "100" }) === null);
  check("second source omitting paid is not evidence", x({ ...P, paid: undefined, delivered: undefined }) === null);
  check("malformed paid is not evidence", x({ ...P, paid: "1e9" }) === null && x({ ...P, paid: -5 }) === null);
  check("a later reservation by another fclaim refuses", /later reservation/.test(x({ ...P, claimTxid: OTHER, claimUntilHeight: 1230 }) ?? ""));
  check("an earlier holder (a source that has not seen our grant) proceeds", x({ ...P, claimTxid: OTHER, claimUntilHeight: 1150 }) === null);
  check("a different holder without a usable hold end proceeds", x({ ...P, claimTxid: OTHER, claimUntilHeight: "1230" }) === null && x({ ...P, claimTxid: OTHER, claimUntilHeight: undefined }) === null);
  check("a different holder with our hold end unknown proceeds", x({ ...P, claimTxid: OTHER, claimUntilHeight: 1230 }, { offerId: OID, fclaimTxid: FC }) === null);
  check("no claimTxid on the second source (not indexed yet) proceeds", x({ ...P, claimTxid: undefined, claimUntilHeight: undefined }) === null);
  check("holder compare ignores case", x({ ...P, claimTxid: FC.toUpperCase().replace("0X", "0x"), claimUntilHeight: 5000 }) === null);
  check("a body for a different offer id is ignored", x({ ...P, id: OTHER, status: "cancelled" }) === null);
  for (const g of [null, undefined, "cancelled", 7, [], { ok: false, error: "unknown offer" }]) check(`garbage ${JSON.stringify(g)} proceeds`, x(g) === null);
}

// ── a PoC-shaped world (same heights and amounts as the security PoC), over the vendored resolver ──
const S = "0x" + "aa".repeat(20), C = "0x" + "cc".repeat(20);
const PAY = BigInt(1000e8);
const coin = mkCoin(2_000_00000000);

function world(me, withheldKind) {
  let n = withheldKind === "partial" ? 1000 : withheldKind === "cancel" ? 2000 : 3000;
  const id = () => H(++n);
  const PE = (who, built, h, E, paidTo = {}) => ({ kind: "propose", id: id(), proposer: who, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch: E ?? epochOf(h) + 5000, height: h, pos: 1, paidTo });
  const AT = (who, pid, score, h, paidTo = {}) => ({ kind: "attest", txid: id(), proposalId: pid, attester: who, score, confidence: 0, height: h, pos: 2, paidTo });
  const ev = [
    PE(S, deploy({ ticker: "TOKA", decimals: 0, supply: "1000000", mint: "issuer" }), 115000, undefined, { [TREASURY_ADDR]: String(DEPLOY_FEE) }),
    PE(S, mint({ ticker: "TOKA", amount: "1000000" }), 115001),
  ];
  const offerEv = PE(S, offer({ give: { ticker: "TOKA", amount: "1000" }, want: { value: String(1000e8) }, ...(withheldKind === "partial" ? { min: String(100e8) } : {}) }), 115010, epochOf(115010) + 200);
  ev.push(offerEv);
  const withheld = [];
  if (withheldKind === "cancel") withheld.push(AT(S, offerEv.id, SCORE_CANCEL, 115100));
  if (withheldKind === "partial") {
    const fcC = PE(C, fclaim({ offer: offerEv.id }), 115100, epochOf(115100) + 1);
    const outs = requiredFillOutputs(resolve([...ev, fcC], 115110).offers[offerEv.id], BigInt(900e8));
    withheld.push(fcC, AT(C, fcC.id, SCORE_FILL, 115110, Object.fromEntries(outs.map((o) => [o.to, o.value.toString()]))));
  }
  const tip = 116520, fH = 116490;
  const fc = PE(me, fclaim({ offer: offerEv.id }), fH, epochOf(fH) + 2);
  const shown = resolve([...ev, fc], tip), truth = resolve([...ev, ...withheld, fc], tip);
  // The primary's D2 alias answer for GET /cairnx/offer/{fclaimTxid} (cairnx service.ts), built from the withheld view.
  const primary = { ...shown.offers[offerEv.id], fclaimId: fc.id, fclaimHeight: fH, fclaimExpiresEpoch: fc.expiresEpoch };
  const outputs = requiredFillOutputs(primary, PAY).map(({ to, value }) => ({ to, value: Number(value) }));
  const pool = new Map([...ev, fc].map((e) => [(e.kind === "propose" ? e.id : e.txid).toLowerCase(), { ...e, depth: tip - e.height + 1 }]));
  const rec = parseRecord(offerEv.uri, offerEv.payloadHash);
  // The scan sees only in-window events: the withheld ones sit ~1,400 blocks below tip - (MAX_SCAN + 89).
  const io = (scanMs = 0) => ({
    myLiveHoldsAtGrant: 0, provenTerms: provenOfferTerms(rec, offerEv.height),
    async tip() { return tip; },
    async offerEventIds() { if (scanMs) await new Promise((r) => setTimeout(r, scanMs)); return [...pool.keys()]; },
    async provenEvent(x) { return pool.get(String(x).toLowerCase()) ?? null; },
  });
  return { offerId: offerEv.id, fc, tip, primary, truth: truth.offers[offerEv.id], truthFclaimGranted: !!truth.fclaims[fc.id], withheld, outputs, io, holdEnd: fclaimHoldEnd(fc.expiresEpoch) };
}

// clarvis behaviours (fetch handlers): a body, 404, a network error, a non-JSON 200, or a delayed reply that
// honours abort. fill() takes a factory w => handler so a body can be built from the world.
function stub(w, clarvis) {
  const st = { submits: [], clarvisUrls: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { st.submits.push(init?.body); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("clarvis")) { st.clarvisUrls.push(u); return clarvis(init); }
    if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => w.primary };
    if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: w.tip }) };
    return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  return st;
}
const body = (b) => () => ({ ok: true, status: 200, json: async () => b });
const always = (h) => () => h;
const notFound = () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: "unknown offer" }) });
const netErr = () => { throw new TypeError("fetch failed"); };
const garbage = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } });
const delayed = (ms, handler) => (init) => new Promise((res, rej) => {
  const t = setTimeout(() => { try { res(handler(init)); } catch (e) { rej(e); } }, ms);
  init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); });
});

async function fill(kind, clarvis, scanMs = 0) {
  const w0 = new Wallet(memoryStore());
  const { addr } = await w0.importKey(PRIV, "pw-xcheck");
  const w = world(addr.toLowerCase(), kind);
  w0.fillSpvIoForTest = () => w.io(scanMs);
  const st = stub(w, clarvis(w));
  const t0 = performance.now();
  const r = await w0.fillOffer({ proposalId: w.fc.id, outputs: w.outputs });
  return { r, st, w, ms: performance.now() - t0 };
}
const digest = (b) => (b ? createHash("sha256").update(b).digest("hex") : "");
// Submit body of the honest fill below, captured on the unmodified 0.2.72 tree (origin/master 5945710) with the
// same key, world and coin. That tree makes no clarvis request on this lane.
const DIGEST_0272 = "7bab37e2d90cb06be538cb11f31c6829831801a23a2c6c22cba7d8a712397c11";

console.log("\n2. the security PoC through the real wallet preflight");
for (const kind of ["cancel", "partial"]) {
  const label = kind === "cancel" ? "A: pre-window CANCEL withheld" : "B: pre-window 90% PARTIAL FILL withheld";
  const probe = world("0x" + "bb".repeat(20), kind);
  check(`${label}: the withheld events sit below the scan window (${probe.withheld.map((e) => e.height)} < ${probe.tip - (MAX_SCAN + 89)})`,
    probe.withheld.every((e) => e.height < probe.tip - (MAX_SCAN + 89)));
  const truthy = kind === "cancel" ? probe.truth.status === "cancelled" : probe.truth.status === "open" && probe.truth.paid === String(900e8);
  check(`${label}: truth is ${kind === "cancel" ? "cancelled" : "paid 900 CSD"}; the primary serves open with nothing paid`, truthy && probe.primary.status === "open" && (probe.primary.paid ?? "0") === "0");
  const v = await verifyFillSpv(probe.offerId, probe.fc.id, "0x" + "bb".repeat(20), probe.io(), { myLiveHoldsAtGrant: 0, pay: PAY, sums: Object.fromEntries(requiredFillOutputs(probe.primary, PAY).map((o) => [o.to, o.value])) });
  check(`${label}: verifyFillSpv alone says safe (the gap is real in the vendored boundary)`, v.safe === true);
  const down = await fill(kind, always(notFound));
  check(`${label}: clarvis 404 -> the wallet still submits (gap open while the second source is down) (${down.r?.error ?? "ok"})`, down.r?.ok === true && down.st.submits.length === 1);
  const told = await fill(kind, (w) => body(w.truth));
  check(`${label}: clarvis tells the truth -> REFUSED with OFFER_SOURCE_CONFLICT (${told.r?.error})`, told.r?.ok === false && told.r?.code === "OFFER_SOURCE_CONFLICT");
  check(`${label}: ...nothing submitted`, told.st.submits.length === 0);
  check(`${label}: ...clarvis was asked by OFFER id`, told.st.clarvisUrls.length === 1 && told.st.clarvisUrls[0].endsWith(`/cairnx/offer/${told.w.offerId}`));
}

console.log("\n3. acceptance (a)-(g)");
{
  const a = await fill("cancel", (w) => body({ ...w.primary, status: "cancelled" }));
  check(`(a) second source shows the offer cancelled: refused, nothing submitted (${a.r?.code})`, a.r?.code === "OFFER_SOURCE_CONFLICT" && a.st.submits.length === 0);
  const b = await fill(null, (w) => body({ ...w.primary, paid: String(100e8), delivered: "100" }));
  check(`(b) second source shows higher paid progress: refused, nothing submitted (${b.r?.code})`, b.r?.code === "OFFER_SOURCE_CONFLICT" && b.st.submits.length === 0);
  const c = await fill(null, (w) => body({ ...w.primary, claimTxid: H(0xdead), claimUntilHeight: w.holdEnd + 1 + 30 }));
  check(`(c) second source shows a later claim holder: refused, nothing submitted (${c.r?.code})`, c.r?.code === "OFFER_SOURCE_CONFLICT" && c.st.submits.length === 0);
  const cLag = await fill(null, (w) => body({ ...w.primary, claimTxid: H(0xbeef), claimUntilHeight: 116400 }));
  check(`(c, paired) second source still shows the PREVIOUS holder (lagging): proceeds (${cLag.r?.error ?? "ok"})`, cLag.r?.ok === true && cLag.st.submits.length === 1);

  const d = await fill(null, (w) => body(w.truth));
  check(`(d) both sources agree the offer is open: the fill submits (${d.r?.error ?? "ok"})`, d.r?.ok === true && d.st.submits.length === 1);
  check(`(d) ...with the same bytes as the 0.2.72 tree (sha256 ${digest(d.st.submits[0]).slice(0, 12)})`, digest(d.st.submits[0]) === DIGEST_0272);
  for (const [tag, cl] of [["(e) 404", always(notFound)], ["(f) timeout", always(delayed(30_000, notFound))], ["(g) garbage body", always(garbage)], ["(g) network error", always(netErr)], ["(g) error envelope", always(body({ ok: false, error: "unknown offer" }))]]) {
    const x = await fill(null, cl);
    check(`${tag}: the fill proceeds with the same bytes (${x.r?.error ?? "ok"})`, x.r?.ok === true && x.st.submits.length === 1 && digest(x.st.submits[0]) === DIGEST_0272);
  }
}

console.log("\n4. latency: the second-source read never lengthens the honest fill");
{
  // The scan is simulated at 300 ms. Median of 5 runs each: clarvis instant 404 vs clarvis that answers after 3 s.
  const runs = async (cl) => { const t = []; for (let i = 0; i < 5; i++) t.push((await fill(null, cl, 300)).ms); return t.sort((x, y) => x - y)[2]; };
  const fast = await runs(always(notFound));
  const slow = await runs(always(delayed(3000, notFound)));
  console.log(`    honest fill wall-clock, median of 5: clarvis instant ${fast.toFixed(1)} ms, clarvis 3,000 ms ${slow.toFixed(1)} ms`);
  check(`a 3 s clarvis adds under 50 ms to a 300 ms scan (instant ${fast.toFixed(1)} ms, slow ${slow.toFixed(1)} ms)`, slow - fast < 50 && slow < 1000);
  const inScan = await fill("cancel", (w) => delayed(100, body(w.truth)), 300);
  check(`a truthful clarvis that answers within the scan (100 ms < 300 ms) is used: refused (${inScan.r?.code})`, inScan.r?.code === "OFFER_SOURCE_CONFLICT");
  const late = await fill("cancel", (w) => delayed(1000, body(w.truth)), 300);
  check(`a truthful clarvis that answers after the scan is not waited for: proceeds (stated limit) (${late.r?.error ?? "ok"})`, late.r?.ok === true);
}

console.log(`\nfill-offer-crosscheck: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
