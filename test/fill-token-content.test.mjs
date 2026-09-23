// W1 token-lane CONTENT bind (B7e-FIX, REBIND S-06): the wallet's TOKEN-priced fill lane must REFUSE a
// resolver-served give/want that does not match the offer's merkle-proven on-chain record, not merely warn.
//
// Before this fix, a token fill (attest CONF_TOKEN_FILL -> fillOffer, outputs:[]) routed through the LEGACY
// lane where verifyFillSpv HARD-REJECTS token wants ("CSD-priced offers only"), so both proof seams were
// UNREACHABLE and the token lane stayed resolver-trusted for give/want CONTENT: a bait-and-switch give/want
// the user clear-signs would PROCEED and submit. This mirrors the site swapguard verifyOfferContent, which
// binds want.ticker/want.amount + give from the merkle-proven record for a token want.
//
// THE HEADLINE (RED-FIRST): a token offer served with a LIED GIVE (inflated give.amount) is now REFUSED.
// Mutating the bind off (comment out provenTermsMismatch, or the want bind) makes the matching lie ACCEPT
// again, which is the load-bearing proof (recorded in the session log). An HONEST token fill still PROCEEDS.
//
// Run: node --import tsx test/fill-token-content.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;
const CONF_TOKEN_FILL = 1_000_000;

const coin = mkCoin(100_000_002);
const served = [coin];
const OID = "0x" + "7c".repeat(32);
const SELLER = "0x" + "cd".repeat(20);

// The TRUE, merkle-proven terms resolve() would materialize from the on-chain offer record: give 10 AAA for
// 7 PAY. provenPaytoForTest injects these (the live SPV path is unavailable under the stubbed fetch); the
// SERVED offer is what a hostile resolver returns, and the bind refuses whenever the two diverge.
const TRUE_PROVEN = () => ({ payto: SELLER, seller: SELLER, terms: { height: 47_000, feeBps: 150, value: undefined, taker: undefined, bid: undefined, giveTicker: "AAA", giveAmount: "10", giveName: undefined, wantType: "token" }, wantTicker: "PAY", wantAmount: "7" });
// The HONEST served offer (matches TRUE_PROVEN exactly).
const honestOffer = { id: OID, seller: SELLER, give: { ticker: "AAA", amount: "10" }, want: { ticker: "PAY", amount: "7" }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150 };

function mkStub({ offerReply }) {
  const stats = { submits: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/tx/submit")) { stats.submits.push(JSON.parse(init?.body || "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 50_000 }) };
    if (u.includes("/cairnx/offer/")) return offerReply();
    const t = txReply(u, served);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return stats;
}

async function freshWallet(pw, proven = TRUE_PROVEN) { const w = new Wallet(memoryStore()); await w.create(pw); w.provenPaytoForTest = proven; return w; }
// Fill a served token offer; the merkle-proven terms are always the HONEST ones (TRUE_PROVEN).
// The quote the approval window would DISPLAY for a served offer (0.2.71: the signer requires it).
function quoteFor(o) {
  const amt = BigInt(o?.want?.amount ?? 0), bps = BigInt(o?.feeBps ?? 150);
  const fee = (amt * bps + 9999n) / 10000n;
  return { ticker: o?.want?.ticker, amount: amt.toString(), fee: fee.toString(), total: (amt + fee).toString(), giveTicker: o?.give?.ticker, giveAmount: o?.give?.amount != null ? String(o.give.amount) : undefined, giveName: o?.give?.name };
}
async function fillServed(pw, servedOffer, proven = TRUE_PROVEN, tokenQuote = quoteFor(servedOffer)) {
  const w = await freshWallet(pw, proven);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => servedOffer }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000, tokenQuote });
  return { r, s };
}

console.log("W1 (B7e-FIX) - token-lane give/want content bind:");

// 1. CONTROL: an HONEST token fill (served == proven) PROCEEDS and submits (the over-refusal gate).
{
  const { r, s } = await fillServed("pw-honest-12345", honestOffer);
  check(`honest token fill PROCEEDS and submits (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
}

// 2. HEADLINE: a LIED GIVE (served give.amount inflated 10 -> 999, proven stays 10) is REFUSED, nothing signed.
{
  const lied = { ...honestOffer, give: { ticker: "AAA", amount: "999" } };
  const { r, s } = await fillServed("pw-giveamt-12345", lied);
  check(`LIED give.amount (999 vs proven 10) is REFUSED with FILL_UNSAFE (${r?.code})`, r?.ok === false && r?.code === "FILL_UNSAFE");
  check("...and nothing was submitted (no bait-and-switch delivery)", s.submits.length === 0);
}

// 3. a LIED GIVE TICKER (served give.ticker BBB vs proven AAA) is REFUSED.
{
  const lied = { ...honestOffer, give: { ticker: "BBB", amount: "10" } };
  const { r, s } = await fillServed("pw-givetick-12345", lied);
  check(`LIED give.ticker (BBB vs proven AAA) is REFUSED (${r?.code})`, r?.ok === false && r?.code === "FILL_UNSAFE" && s.submits.length === 0);
}

// 4. a LIED WANT AMOUNT (served want.amount 1 vs proven 7 - understating your cost) is REFUSED. This leg is
//    NOT covered by bindOfferTerms (it binds only the want TYPE); the explicit want.ticker/want.amount bind
//    catches it, mirroring the site.
{
  const lied = { ...honestOffer, want: { ticker: "PAY", amount: "1" } };
  const { r, s } = await fillServed("pw-wantamt-12345", lied);
  check(`LIED want.amount (1 vs proven 7) is REFUSED with FILL_UNSAFE (${r?.code})`, r?.ok === false && r?.code === "FILL_UNSAFE");
  check("...and nothing was submitted (no understated cost)", s.submits.length === 0);
}

// 5. a LIED WANT TICKER (served want.ticker CSD-TOKEN vs proven PAY - a different token to pay) is REFUSED.
{
  const lied = { ...honestOffer, want: { ticker: "OTHER", amount: "7" } };
  const { r, s } = await fillServed("pw-wanttick-12345", lied);
  check(`LIED want.ticker (OTHER vs proven PAY) is REFUSED (${r?.code})`, r?.ok === false && r?.code === "FILL_UNSAFE" && s.submits.length === 0);
}

// 6. WANT-TYPE lie: the proven offer is actually CSD-priced (wantType csd, no want.ticker) but the resolver
//    serves it as a token offer. The symmetric want-type leg refuses (understating a CSD payment as a token
//    swap). Proven terms carry value + wantType csd; served pretends token.
{
  const csdProven = () => ({ payto: SELLER, seller: SELLER, terms: { height: 47_000, feeBps: 150, value: "5000000", taker: undefined, bid: undefined, giveTicker: "AAA", giveAmount: "10", giveName: undefined, wantType: "csd" }, wantTicker: undefined, wantAmount: undefined });
  const { r, s } = await fillServed("pw-wanttype-12345", honestOffer, csdProven);
  check(`proven-CSD offer served as token is REFUSED (want-type leg) (${r?.code})`, r?.ok === false && r?.code === "FILL_UNSAFE" && s.submits.length === 0);
}

// 7. UNPROVABLE (the SPV source could not merkle-prove the offer): fail CLOSED-RETRYABLE (VERIFY_UNAVAILABLE),
//    NOT a hard decline and NOT a proceed. proven -> null.
{
  const { r, s } = await fillServed("pw-unprov-12345", honestOffer, () => null);
  check(`unprovable token offer fails closed-retryable VERIFY_UNAVAILABLE (${r?.code})`, r?.ok === false && r?.code === "VERIFY_UNAVAILABLE" && s.submits.length === 0);
}

// 8. RT-W2 — the REVIEWED-quote bind. The review card's debit quote was a live resolver read,
//    unbound; a resolver answering LOW at review and honest at click debited the larger proven
//    amount behind the low card. The displayed quote is now threaded to the preflight and must
//    equal the proven want. RED-FIRST: case 8a submits on pre-fix code (the quote was not bound).
{
  // 8a. HEADLINE: the card showed 5 PAY; the chain proves 7 PAY → REFUSED, nothing signed.
  const w = await freshWallet("pw-w2-low-12345", TRUE_PROVEN);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => honestOffer }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000, tokenQuote: { ticker: "PAY", amount: "5", fee: "0", total: "5" } });
  check("RT-W2: a review quote BELOW the proven want is REFUSED (bait-and-switch closed)", r?.ok === false && r?.code === "FILL_UNSAFE" && /changed between review and signing/.test(r?.error ?? ""));
  check("RT-W2: …and nothing was submitted", s.submits.length === 0);
}
{
  // 8b. a swapped TICKER in the review quote is refused too
  const w = await freshWallet("pw-w2-tick-12345", TRUE_PROVEN);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => honestOffer }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000, tokenQuote: { ticker: "AAA", amount: "7", fee: "0", total: "7" } });
  check("RT-W2: a review quote with the wrong ticker is REFUSED", r?.ok === false && r?.code === "FILL_UNSAFE" && s.submits.length === 0);
}
{
  // 8c. a quote MATCHING the proven want proceeds (the honest path is not over-refused)
  const w = await freshWallet("pw-w2-ok-12345", TRUE_PROVEN);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => honestOffer }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000, tokenQuote: { ticker: "PAY", amount: "7", fee: "1", total: "8" } });
  check("RT-W2: a matching review quote PROCEEDS (honest path)", r?.ok === true && s.submits.length === 1);
}
{
  // 8d. 0.2.71 (CX-15, deliberate change): NO reviewed quote is REVIEW_REQUIRED. Before 0.2.71 the
  //     signer proceeded on a failed or slow preview, so the user could sign a debit never shown.
  const { r, s } = await fillServed("pw-w2-none-12345", honestOffer, TRUE_PROVEN, null);
  check("0.2.71 red-first: no reviewed quote is REVIEW_REQUIRED and nothing is signed", r?.ok === false && r?.code === "REVIEW_REQUIRED" && s.submits.length === 0);
}
{
  // 8g. 0.2.71 (CX-15): an unchanged ask with an UNDERSTATED fee (served feeBps 0 at review) is refused:
  //     the proven terms debit 7 + 1 = 8, the card showed 7 + 0 = 7.
  const w = await freshWallet("pw-w2-fee-12345", TRUE_PROVEN);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => honestOffer }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000, tokenQuote: { ticker: "PAY", amount: "7", fee: "0", total: "7" } });
  check("0.2.71 red-first: same ask, understated fee/total is REFUSED", r?.ok === false && r?.code === "FILL_UNSAFE" && /fee of 0 and a total of 7/.test(r?.error ?? "") && s.submits.length === 0);
}
{
  // 8e. 0.2.70: a review give that does not match the proven give is REFUSED.
  const w = await freshWallet("pw-w2-give-12345", TRUE_PROVEN);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => honestOffer }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000, tokenQuote: { ticker: "PAY", amount: "7", fee: "1", total: "8", giveTicker: "BBB", giveAmount: "10" } });
  check("0.2.70: a review give TICKER that does not match proven is REFUSED", r?.ok === false && r?.code === "FILL_UNSAFE" && /receive changed/.test(r?.error ?? "") && s.submits.length === 0);
}
{
  const w = await freshWallet("pw-w2-giveok-12345", TRUE_PROVEN);
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => honestOffer }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000, tokenQuote: { ticker: "PAY", amount: "7", fee: "1", total: "8", giveTicker: "AAA", giveAmount: "10" } });
  check("0.2.70: a matching review give PROCEEDS (honest path)", r?.ok === true && s.submits.length === 1);
}

// 0.2.70 Fable nit: tokenFillQuote must treat served give.amount null/undefined as absent.
// String(null) === "null" is a present string; the vendor give-leg then refuses an honest fill.
{
  const w = await freshWallet("pw-quote-null-12345");
  mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => ({ ...honestOffer, give: { ticker: "AAA", amount: null } }) }) });
  const q = await w.tokenFillQuote(OID);
  check("0.2.70: tokenFillQuote treats served give.amount:null as absent (not the string \"null\")",
    q.ok === true && q.giveTicker === "AAA" && q.giveAmount === undefined);
}
{
  const w = await freshWallet("pw-quote-zero-12345");
  mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => ({ ...honestOffer, give: { ticker: "AAA", amount: 0 } }) }) });
  const q = await w.tokenFillQuote(OID);
  check("0.2.70: tokenFillQuote still String()s a real give.amount of 0",
    q.ok === true && q.giveAmount === "0");
}

// Review D-2: the preview reads each token it shows by ticker, never the whole token list.
{
  const w = await freshWallet("pw-quote-meta-12345");
  const seen = [];
  mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => ({ ...honestOffer, give: { ticker: "AAA", amount: "10" } }) }) });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url); seen.push(u);
    const m = u.match(/\/cairnx\/token\/([A-Z0-9]+)$/);
    if (m) return { ok: true, status: 200, json: async () => ({ ticker: m[1], decimals: 2, deployId: "0x" + "cd".repeat(32) }) };
    return inner(url, init);
  };
  const q = await w.tokenFillQuote(OID);
  check("review D-2: decimals and deploy ids come from per-ticker reads (paired: still shown)",
    q.ok === true && q.wantDecimals === 2 && q.giveDecimals === 2 && q.giveDeployId === "0x" + "cd".repeat(32));
  check("review D-2: the full /cairnx/tokens list is never requested for a preview", !seen.some((u) => /\/cairnx\/tokens(\?|$)/.test(u)));
}

globalThis.fetch = origFetch;
console.log(`\nfill-token-content: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
