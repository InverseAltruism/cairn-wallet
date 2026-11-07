// A partial fill's card shows what the payment buys, not the listing's whole give. The card reads the listing from the
// offer service (fillOfferView) and computes the delivery of the request's payment to the listing's payee with the
// vendored previewFill over it, labelled as computed from the listing, with the whole listing on its own row. No read
// beyond the one the card already makes; the signed bind is the preflight's. Through fillViewHtml, fillOfferView over
// a stubbed read, and the REAL approve.ts on helpers/approve-dom.mjs (the production call shape).
//   red before: the card said "You receive 100 NEWF (as listed by the offer service)" for a 0.1 CSD payment, and still
//   did when the partial listing's answer lacked a field the figure needs (feeBps); it now says the figure could not
//   be calculated.
//   honest: a whole listing and a name listing keep their line.
// Run: npx tsx test/fill-card-receive.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { fillViewHtml } from "../src/popup/clearsign.js";
import { fillOfferView } from "../src/core/cairnxview.js";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";

const { check, done } = checker("fill card: what a partial payment receives:");
const OID = "0x" + "0f".repeat(32), PAYTO = "0x" + "5e".repeat(20), T = "0x" + "77".repeat(20);
const served = (extra = {}) => ({ id: OID, seller: PAYTO, status: "open", give: { ticker: "NEWF", amount: "100" }, want: { value: "100000000", payto: PAYTO }, feeBps: 150, height: 118_002, expiresEpoch: 9_000_000, taker: "0x" + "ab".repeat(20), ...extra });
const view = async (o) => fillOfferView({ addr: () => "0x" + "ab".repeat(20), tradeGet: async (p) => p.startsWith("/cairnx/offer/") ? { ok: true, status: 200, json: async () => o }
  : p.startsWith("/cairnx/token/") ? { ok: true, status: 200, json: async () => ({ ticker: "NEWF", decimals: 0 }) } : { ok: false, status: 404, json: async () => ({}) } }, OID);
const outs = (pay) => [{ to: PAYTO, value: pay }, { to: T, value: 150_000 }];

const partial = await view(served({ min: "10000000", paid: "30000000", delivered: "30" }));
check("fillOfferView carries the listing's fields for the card", partial.ok === true && partial.listing?.min === "10000000" && partial.listing?.paid === "30000000" && partial.listing?.want.payto === PAYTO);
let html = fillViewHtml(partial, OID, undefined, outs(10_000_000));
check(`a 0.1 CSD payment on a partial listing shows about 10 NEWF, computed from the listing (${html.replace(/<[^>]+>/g, "")})`,
  /You receive/.test(html) && /about <b>10 NEWF/.test(html) && /computed from the offer service's listing/.test(html) && !/100 NEWF[^<]*<\/b> <span class="dim">\(as listed/.test(html));
check("...and the whole listing on its own row", /Whole listing/.test(html) && /100 NEWF/.test(html) && /1 CSD/.test(html));
html = fillViewHtml(partial, OID, undefined, outs(1_000_000));
check(`a payment below the listing's minimum shows that it receives nothing (${html.replace(/<[^>]+>/g, "")})`, /receives nothing: the payment is below what the listing accepts/.test(html));
html = fillViewHtml(partial, OID, undefined, outs(70_000_000));
check("the rest of the listing (0.7 CSD) shows the 70 NEWF it buys", /about <b>70 NEWF/.test(html));

// The same partial listing, fresh (100 NEWF for 1 CSD, minimum 0.1 CSD), served without feeBps: no estimate, and the
// whole give is not presented as what the 0.1 CSD payment receives.
const { feeBps: _fee, ...noFee } = served({ min: "10000000" });
const partialNoFee = await view(noFee);
html = fillViewHtml(partialNoFee, OID, undefined, outs(10_000_000));
check(`a partial listing served without feeBps says the receipt could not be calculated (${html.replace(/<[^>]+>/g, "")})`,
  partialNoFee.ok === true && partialNoFee.listing === undefined && /Could not calculate what this payment receives/.test(html) && !/You receive/.test(html) && /Whole listing/.test(html));

const whole = await view(served());
html = fillViewHtml(whole, OID, undefined, outs(100_000_000));
check("honest: a whole listing keeps \"as listed by the offer service\" with its full give", /<b>100 NEWF[^<]*<\/b> <span class="dim">\(as listed by the offer service\)/.test(html) && !/Whole listing/.test(html));
const name = await view(served({ give: { name: "alice" } }));
html = fillViewHtml(name, OID, undefined, outs(100_000_000));
check("honest: a name listing keeps its line", /<b>alice\.csd<\/b> <span class="dim">\(as listed by the offer service\)/.test(html));

// The approval window passes the request's outputs to the card.
const ME = "0x" + "ab".repeat(20);
const state = { pending: [{ id: "f1", method: "fillOffer", origin: "https://dapp.example", params: { proposalId: OID, outputs: outs(10_000_000), fee: 1_000_000 } }] };
const { registry } = mountApproveWindow({
  status: () => ({ unlocked: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
  pending: () => state.pending, balance: () => ({ confirmed: 5_000_00000000 }), history: () => [],
  fillOfferView: () => partial, tokenFillQuote: () => null, tokenDisplayMeta: () => ({}), sealedClaims: () => [], tip: () => 118_010, epoch: () => 3_933, tipFloor: () => 0,
  resolve: () => ({ done: true, ok: true }), unlock: () => true,
});
await loadApprove();
await flush(); await sleep(50); await flush();
const card = registry.get("fill-view")?.innerHTML ?? "";
check(`the approval window's card shows the computed figure for the request's payment (${card.replace(/<[^>]+>/g, "").slice(0, 120)})`, /about <b>10 NEWF/.test(card));

done("fill-card-receive");
