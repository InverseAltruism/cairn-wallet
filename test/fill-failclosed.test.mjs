// B1 (Plans/68 M-MKT-5 + N-1; the Plan 63 B2 flip): fillOffer preflight fails CLOSED unless the
// resolver POSITIVELY parses to a CairnX offer.
//
// Pre-0.2.57, a clean 404 (a valid L1 proposal that is NOT an open CairnX offer) and a 200 whose body
// lacks a parseable status (MITM / garbling proxy) both PROCEEDED to sign: the wallet paid, L1 moved
// the CSD, and resolve() ignored the attest — the whole payment burned. Now both refuse with the
// retryable OFFER_UNKNOWN. The 5xx/unreachable posture (VERIFY_UNAVAILABLE) and the happy path are
// pinned unchanged.
//
// MUTATION CONTRACT: the 404 and garbled-200 cases FAIL on 0.2.56 (they submit).
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { requiredFillOutputs } from "../src/core/cairnx.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : (fail++, console.error("  ✗ " + n)); if (c) console.log("  ✓ " + n); };
const origFetch = globalThis.fetch;

const w = new Wallet(memoryStore());
const { addr: A } = await w.create("super-secret-pw");
// F2-legacy: the legacy CSD lane now binds the payment recipient to the merkle-proven offer author. The success
// case's offer is honest (payto 0xce, seller 0xcd); inject the proven author so it is not falsely refused. The
// fail-closed cases (404/garbled/status-less/5xx) refuse BEFORE this bind, so they are unaffected.
w.provenPaytoForTest = () => ({ payto: "0x" + "ce".repeat(20), seller: "0x" + "cd".repeat(20), terms: { height: 47_000, feeBps: 150, value: "5000000", taker: String(A).toLowerCase(), bid: undefined } });
const coin = mkCoin(100_000_002);
const served = [coin];

function mkStub(offerReply) {
  const stats = { submits: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(1); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 50_000 }) };
    if (u.includes("/cairnx/offer/")) return offerReply();
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}

const id = "0x" + "6f".repeat(32);
const offer = {
  id, seller: "0x" + "cd".repeat(20), give: { ticker: "TKN", amount: "5" },
  want: { value: "5000000", payto: "0x" + "ce".repeat(20) },
  status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150, taker: A,
};
const outputs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));

console.log("B1 — fail-closed fill preflight:");
{
  const s = mkStub(() => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("clean 404 (proposal is not a CairnX offer) refuses with OFFER_UNKNOWN", r?.ok === false && r?.code === "OFFER_UNKNOWN");
  check("…and nothing was submitted", s.submits.length === 0);
}
{
  const s = mkStub(() => ({ ok: true, status: 200, json: async () => { throw new Error("garbled body"); } }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("garbled 200 (unparseable body) refuses with OFFER_UNKNOWN", r?.ok === false && r?.code === "OFFER_UNKNOWN");
  check("…and nothing was submitted", s.submits.length === 0);
}
{
  const s = mkStub(() => ({ ok: true, status: 200, json: async () => ({ some: "object", without: "a status" }) }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("status-less 200 refuses with OFFER_UNKNOWN", r?.ok === false && r?.code === "OFFER_UNKNOWN");
  check("…and nothing was submitted", s.submits.length === 0);
}
{
  const s = mkStub(() => ({ ok: false, status: 503, json: async () => ({}) }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("5xx keeps the VERIFY_UNAVAILABLE posture (unchanged)", r?.ok === false && r?.code === "VERIFY_UNAVAILABLE");
  check("…and nothing was submitted", s.submits.length === 0);
}
{
  const s = mkStub(() => ({ ok: true, status: 200, json: async () => offer }));
  const r = await w.fillOffer({ proposalId: id, outputs });
  check("a positively-parsed open offer still proceeds and submits (no over-refusal)", r?.ok === true && s.submits.length === 1);
}

globalThis.fetch = origFetch;
console.log(`\nfill-failclosed: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
