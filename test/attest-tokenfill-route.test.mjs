// W4 (B5d, REBIND): a token-fill-confidence attest is the fill path stripped of its preflight.
//
// node.attest and node.fillOffer funnel into the same assembleValueTx with a byte-identical App=Attest
// expression, so an attest(score, confidence=CONF_TOKEN_FILL) with outputs:[] is byte-identical ON-CHAIN
// to the token fill (W1) while running strictly LESS validation - it skipped the fail-closed
// OFFER_UNKNOWN gate that exists precisely to stop paying into a proposal the resolver will never settle,
// and it skipped captureSigner. wallet.attest now routes on the ARTIFACT SHAPE: confidence ===
// CONF_TOKEN_FILL dispatches through fillOffer (preflight + signer capture + a truthful fillOffer history
// entry). A board-support attest (confidence 70/80) is untouched.
//
// MUTATION CONTRACT: removing the route (attest always calls node.attest) REDS the OFFER_UNKNOWN case.
//
// Run: node --import tsx test/attest-tokenfill-route.test.mjs   (offline)
import { Wallet } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { mkCoin, txReply } from "./_coin.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const origFetch = globalThis.fetch;
const CONF_TOKEN_FILL = 1_000_000;

const coin = mkCoin(100_000_002);
const served = [coin];
const OID = "0x" + "7a".repeat(32);
const SELLER = "0x" + "cd".repeat(20);

function mkStub({ offerReply }) {
  const stats = { submits: [], attests: [] };
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

async function freshWallet(pw) { const w = new Wallet(memoryStore()); await w.create(pw); return w; }

// An open TOKEN-want offer (the token fill lane; outputs:[] because the buyer routes no on-chain value).
const tokenOffer = { id: OID, seller: SELLER, give: { ticker: "AAA", amount: "10" }, want: { ticker: "PAY", amount: "7" }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150 };

console.log("W4 (B5d) - token-fill-confidence attest routes through the gated fill path:");

// 1. THE HEADLINE (mutation contract): attest(confidence=CONF_TOKEN_FILL) on a proposal the resolver
//    does NOT know (clean 404) is REFUSED with OFFER_UNKNOWN, never signed. The bare-attest path had no
//    such gate - it would have paid into an unsettleable proposal.
{
  const w = await freshWallet("pw-unknown-12345");
  const s = mkStub({ offerReply: () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000 });
  check(`token-fill attest on an unknown proposal is REFUSED with OFFER_UNKNOWN (${r?.code})`, r?.ok === false && r?.code === "OFFER_UNKNOWN");
  check("...and nothing was submitted (no pay-into-unsettleable)", s.submits.length === 0);
}

// 2. A token-fill attest on a genuine open token offer PROCEEDS and submits (no over-refusal), and files
//    a truthful fillOffer-shaped history entry.
{
  const w = await freshWallet("pw-open-12345");
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => tokenOffer }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000 });
  check(`honest token-fill attest PROCEEDS and submits (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
  const h = await w.history();
  check("...and files a fillOffer history entry (truthful shape, not 'support')", h.length === 1 && h[0].type === "fillOffer");
}

// 3. A non-open offer is REFUSED (the status gate the bare attest also skipped).
{
  const w = await freshWallet("pw-filled-12345");
  const s = mkStub({ offerReply: () => ({ ok: true, status: 200, json: async () => ({ ...tokenOffer, status: "filled" }) }) });
  const r = await w.attest({ proposalId: OID, score: 100, confidence: CONF_TOKEN_FILL, fee: 5_000_000 });
  check(`token-fill attest on a FILLED offer is refused (${r?.code})`, r?.ok === false && s.submits.length === 0);
}

// 4. A BOARD-SUPPORT attest (confidence 80) is UNTOUCHED: it still routes to the plain attest, submits,
//    and files a 'support' entry - no offer fetch required, no over-refusal.
{
  const w = await freshWallet("pw-support-12345");
  const s = mkStub({ offerReply: () => ({ ok: false, status: 404, json: async () => ({}) }) }); // no offer exists; must not matter
  const r = await w.attest({ proposalId: OID, score: 80, confidence: 80, fee: 5_000_000 });
  check(`board-support attest (confidence 80) still submits, unrouted (${r?.error ?? "ok"})`, r?.ok === true && s.submits.length === 1);
  const h = await w.history();
  check("...and files a 'support' history entry", h.length === 1 && h[0].type === "support");
}

globalThis.fetch = origFetch;
console.log(`\nattest-tokenfill-route: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
