// Shared fixture for the fclaim-lane second-source tests (fill-offer-crosscheck, fill-reservation-verdict): a
// PoC-shaped world over the vendored resolver, a fetch stub that routes clarvis to a per-test handler, and fill(),
// which runs the REAL Wallet.fillOffer preflight with a synthetic (pre-proven) SPV io.
import { createHash } from "node:crypto";
import { Wallet } from "../../src/core/wallet.js";
import { memoryStore } from "../../src/core/storage.js";
import {
  deploy, mint, offer, fclaim, resolve, requiredFillOutputs, provenOfferTerms, parseRecord, fclaimHoldEnd,
  epochOf, TREASURY_ADDR, DEPLOY_FEE, SCORE_FILL, SCORE_CANCEL,
} from "../../src/vendor/cairnx-spv.js";
import { mkCoin, txReply } from "../_coin.js";

export const H = (n) => "0x" + n.toString(16).padStart(64, "0");
export const PRIV = "0x" + "42".repeat(32);

// ── a PoC-shaped world (same heights and amounts as the security PoC), over the vendored resolver ──
export const S = "0x" + "aa".repeat(20), C = "0x" + "cc".repeat(20);
export const PAY = BigInt(1000e8);
const coin = mkCoin(2_000_00000000);

export function world(me, withheldKind) {
  let n = withheldKind === "partial" ? 1000 : withheldKind === "cancel" ? 2000 : withheldKind === "hidden-hold" ? 4000 : 3000;
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
  // A competing fclaim three blocks before ours whose hold (epoch E+1) is live at our grant and ends before ours.
  // The synthetic io below never proves it, which models a forged header extension that hides it.
  if (withheldKind === "hidden-hold") withheld.push(PE(C, fclaim({ offer: offerEv.id }), fH - 3, epochOf(fH - 3) + 1));
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
  return { offerId: offerEv.id, fc, tip, primary, truth: truth.offers[offerEv.id], truthFclaimGranted: !!truth.fclaims[fc.id], truthLog: truth.events, withheld, outputs, io, holdEnd: fclaimHoldEnd(fc.expiresEpoch) };
}

// clarvis behaviours (fetch handlers): a body, 404, a network error, a non-JSON 200, or a delayed reply that
// honours abort. fill() takes a factory w => handler so a body can be built from the world.
export function stub(w, clarvis) {
  const st = { submits: [], clarvisUrls: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { st.submits.push(init?.body); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.includes("clarvis")) { st.clarvisUrls.push(u); return clarvis(init, u); }
    if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => w.primary };
    if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: w.tip }) };
    return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
  };
  return st;
}
export const body = (b) => () => ({ ok: true, status: 200, json: async () => b });
export const always = (h) => () => h;
export const notFound = () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: "unknown offer" }) });
export const netErr = () => { throw new TypeError("fetch failed"); };
export const garbage = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } });
export const delayed = (ms, handler) => (init, u) => new Promise((res, rej) => {
  const t = setTimeout(() => { try { res(handler(init, u)); } catch (e) { rej(e); } }, ms);
  init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); });
});

// GET /cairnx/record/{txid} as the cairnx service answers it (service.ts RECORD_PATH), from the true chain's log.
export function recordAnswer(w, tipHeight = w.tip, txid = w.fc.id) {
  const id = String(txid).toLowerCase();
  const e = w.truthLog.filter((x) => String(x.id).toLowerCase() === id).at(-1);
  return e
    ? { ok: true, status: 200, json: async () => ({ txid: id, kind: e.kind, applied: e.ok, note: e.note ?? null, height: e.height, tipHeight }) }
    : { ok: false, status: 404, json: async () => ({ ok: false, error: "no resolved record for this txid (not a CairnX record, or not yet scanned)", tipHeight }) };
}
// An honest clarvis on the true chain: the offer route answers the true offer, the record route the true log.
export const truthful = (w, tipHeight = w.tip) => (_init, u) => (String(u).includes("/cairnx/record/") ? recordAnswer(w, tipHeight) : body(w.truth)());

export async function fill(kind, clarvis, scanMs = 0) {
  const w0 = new Wallet(memoryStore());
  const { addr } = await w0.importKey(PRIV, "pw-xcheck");
  const w = world(addr.toLowerCase(), kind);
  w0.fillSpvIoForTest = () => w.io(scanMs);
  const st = stub(w, clarvis(w));
  const t0 = performance.now();
  const r = await w0.fillOffer({ proposalId: w.fc.id, outputs: w.outputs });
  return { r, st, w, ms: performance.now() - t0 };
}
export const digest = (b) => (b ? createHash("sha256").update(b).digest("hex") : "");
