// Plan 85 7.3a (E1-E4 card findings, UX-1): the approval card says what the request does.
//
//   (1) UX-1: the first-time / poisoning warning names what the address receives. A name record moves no
//       CSD, so it must not say "Payments are irreversible".
//       RED-FIRST: make sendWarnings ignore `kind` (always the payment tail) and 1b, 1c fail.
//   (2) A CSD-paid fill card shows the asset the listing gives, and on the reservation (claim) lane it names
//       the listing behind the attested id. RED-FIRST: drop fillFillView(current) in approve.ts and 2a, 2b fail.
//       The card also shows when the listed offer expires, in blocks after the tip, and says the wallet will refuse
//       only when it will (1f, 2d). RED-FIRST: drop the expiry line from fillViewHtml and 1f, 2d fail; drop the tip
//       read in fillFillView and 2d fails.
//   (3) A request whose debit exceeds the spendable balance (a pending spend still holds coins) keeps
//       Approve disabled with the reason, and a forced click is refused.
//       RED-FIRST: drop the balShort block in fillBalance and 3a, 3b fail.
//   (4) The same in the real window for an nset: RED-FIRST: pass bare strings to sendWarnings in approve.ts
//       and 4a fails.
// PAIRED HONEST PATHS: 1a (a payment still warns as before), 2c (a direct fill shows no reservation
// line), 3c (a covered request arms Approve after the click-through delay).
//
// Run: node --import tsx test/approve-card-honesty.test.mjs   (offline)
import assert from "node:assert/strict";
import { sendWarnings, fillViewHtml, tokenQuoteHtml } from "../src/popup/clearsign.ts";
import { fillOfferView, tokenFillQuote } from "../src/core/cairnxview.ts";
import { buildNameSet, CAIRNX_DOMAIN } from "../src/core/cairnx.ts";
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.error("  ✗ " + name + "\n    " + String(e?.message || e).split("\n")[0]); } };
const ME = "0x" + "ab".repeat(20);
const EXT = "0x" + "31".repeat(20);
const SELLER = "0x" + "30".repeat(20);
const LIST = "0x" + "a1".repeat(32), RES = "0x" + "b2".repeat(32);

console.log("1. UX-1: op-aware first-time warning (pure)");
t("1a honest: a payment recipient still warns that payments are irreversible", () => {
  const w = sendWarnings([EXT], [], [ME]).join(" ");
  assert.match(w, /First time sending to/); assert.match(w, /Payments are irreversible/);
});
t("1b a name pointed at a new address does not say payments are irreversible", () => {
  const w = sendWarnings([{ to: EXT, kind: "name-point" }], [], [ME]).join(" ");
  assert.match(w, /First time pointing a name at/); assert.doesNotMatch(w, /[Pp]ayments are irreversible/);
});
t("1c a name-transfer look-alike keeps the poisoning flag with name wording", () => {
  const near = EXT.slice(0, 10) + "99" + EXT.slice(12);
  const w = sendWarnings([{ to: near, kind: "name-transfer" }], [EXT], [ME]).join(" ");
  assert.match(w, /Possible address-poisoning/); assert.match(w, /The new owner controls the name/); assert.doesNotMatch(w, /[Pp]ayments are irreversible/);
});
t("1d the wallet's own address is not a first-time recipient", () => {
  assert.deepEqual(sendWarnings([{ to: ME, kind: "name-point" }], [], [ME]), []);
});
t("1e fillViewHtml names the listing on the reservation lane and the asset with both scales", () => {
  const html = fillViewHtml({ ok: true, offerId: LIST, giveTicker: "CAIRN", giveAmount: "18401371902", giveDecimals: 8 }, RES);
  assert.match(html, new RegExp(`<dt>Listing</dt><dd><code>${LIST}</code></dd>`)); assert.match(html, /184\.01371902 CAIRN = 18401371902 base units/);
});

t("1f the card says the wallet will refuse a fill only when it will", () => {
  // An offer anchored at 120,000 with expiresEpoch 4,000 expires at 120,030; its last live block is 120,029 and the
  // chain accepts a fill through it. At tip 120,000 (inside epoch 4,000) the expiry block is 30 blocks away and a fill
  // can still be mined in 29 of them.
  const at = (tip) => fillViewHtml({ ok: true, offerId: LIST, giveTicker: "CAIRN", giveAmount: "1", expiresAt: 120_030 }, LIST, tip);
  assert.match(at(120_000), /Offer expires at block 120,030, 30 blocks after the current tip \(~1 h\)/); assert.doesNotMatch(at(120_000), /refuse/);
  assert.match(at(120_020), /10 blocks after the current tip \(~20 min\)/);
  assert.match(at(120_025), /Offer expires at block 120,030, 5 blocks after the current tip \(~10 min\)/); assert.doesNotMatch(at(120_025), /refuse/);
  assert.match(at(120_026), /Offer expires at block 120,030, 4 blocks after the current tip <span class="err">\(too close to be mined in time: the wallet will refuse this fill\)<\/span>/);
  assert.match(at(120_029), /Offer expires at block 120,030, the next block <span class="err">\(the wallet will refuse this fill\)<\/span>/);
  assert.match(at(120_030), /Offer expired at block 120,030 <span class="err">\(the wallet will refuse this fill\)<\/span>/);
});

{
  // Both fill reads carry the listed offer's expiry block: epoch 3,910 anchored at 117,000 expires at 117,330.
  const listed = { id: LIST, status: "open", seller: SELLER, give: { ticker: "CAIRN", amount: "1" }, want: { ticker: "USDX", amount: "100" }, feeBps: 150, expiresEpoch: 3_910, height: 117_000 };
  const io = { addr: () => ME, tradeGet: async (path) => path.startsWith("/cairnx/offer/") ? { ok: true, status: 200, json: async () => listed } : { ok: false, status: 404, json: async () => ({}) } };
  const view = await fillOfferView(io, LIST), quote = await tokenFillQuote(io, LIST);
  t("1g the fill view and the token quote carry the listed offer's expiry block", () => {
    assert.equal(view.expiresAt, 117_330); assert.equal(quote.expiresAt, 117_330);
    assert.match(tokenQuoteHtml(quote, 117_000), /Offer expires at block 117,330, 330 blocks after the current tip \(~11 h\)/);
  });
}

// ── the real approval window ──────────────────────────────────────────────────────────────────────────
const { byId, registry, El } = installFakeDom();
for (const id of ["view-locked", "view-req", "req", "msg", "btn-approve", "btn-reject", "btn-unlock", "unlock-pw", "ap-origin", "ap-ask", "ap-signer"]) registry.set(id, new El(id));
const state = { pending: [], balance: 100e8, resolves: 0, views: 0 };
const h = {
  status: () => ({ unlocked: true, accounts: [{ label: "A1", addr: ME }], active: 0, addr: ME, tradeApi: "https://x/trade/api" }),
  pending: () => state.pending,
  balance: () => ({ confirmed: state.balance }),
  history: () => [],
  sealedClaims: () => [],
  tip: () => 117_000, epoch: () => 3_900, tipFloor: () => 0,
  fillOfferView: (id) => { state.views++; return { ok: true, offerId: LIST, giveTicker: "CAIRN", giveAmount: "18401371902", giveDecimals: 8, expiresAt: 117_330, _id: id }; },
  resolve: () => { state.resolves++; return { ok: true, txid: "0x" + "ee".repeat(32) }; },
};
installBridge(h);
globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ owner: ME, addr: EXT, pending: false }) });
let tick = null;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn) => { tick = fn; return 0; };
const fillReq = (id, proposalId) => ({ id, method: "fillOffer", origin: "https://cairn-substrate.com", params: { proposalId, score: 100, confidence: 100, fee: 5_000_000, outputs: [{ to: SELLER, value: 223024798 }, { to: "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016", value: 2955594 }] } });
state.pending = [fillReq("f1", RES)];
await import("../src/popup/approve.ts");
globalThis.setInterval = realSetInterval;
await flush();
await new Promise((r) => setTimeout(r, 800)); await flush();

console.log("2. CSD-paid fill card");
t("2a the card shows the asset the listing gives", () => {
  const v = byId("fill-view");
  assert.ok(v && !v.hidden); assert.match(v.innerHTML, /<dt>You receive<\/dt><dd><b>184\.01371902 CAIRN = 18401371902 base units<\/b> <span class="dim">\(as listed by the offer service\)<\/span>/);
});
t("2b on the reservation lane the card names the listing", () => {
  assert.match(byId("fill-view").innerHTML, new RegExp(`<dt>Listing</dt><dd><code>${LIST}</code></dd>`));
});
t("2d the card shows when the listed offer expires, from the tip", () => {
  assert.match(byId("fill-view").innerHTML, /Offer expires at block 117,330, 330 blocks after the current tip \(~11 h\)/);
});
t("3c honest: a covered request arms Approve after the click-through delay", () => {
  assert.equal(byId("btn-approve").disabled, false);
});

state.balance = 174_000_000;              // 1.74 CSD spendable while a pending finalize holds the 8 CSD coin
state.pending = [fillReq("f2", LIST)];
await tick(); await flush();
await new Promise((r) => setTimeout(r, 800)); await flush();
t("2c honest: a direct fill shows the asset and no reservation line", () => {
  assert.match(byId("fill-view").innerHTML, /<dt>You receive<\/dt>/); assert.doesNotMatch(byId("fill-view").innerHTML, /<dt>Listing<\/dt>/);
});
console.log("3. negative balance after a pending spend");
t("3a Approve stays disabled with the reason on the card", () => {
  assert.equal(byId("btn-approve").disabled, true);
  assert.match(byId("req").innerHTML, /spendable balance does not cover this request/);
});
byId("btn-approve").disabled = false;     // a click that lands anyway (forced DOM click) is refused
for (const fn of byId("btn-approve")._listeners.click || []) await fn();
await flush();
t("3b a forced click is refused and nothing is resolved", () => {
  assert.equal(state.resolves, 0); assert.match(byId("msg").textContent, /does not cover this request/);
});

console.log("4. UX-1 in the window: an nset to a new address");
state.balance = 100e8;
const nset = buildNameSet({ name: "alice", addr: EXT });
state.pending = [{ id: "n1", method: "propose", origin: "https://cairn-substrate.com", params: { domain: CAIRNX_DOMAIN, payloadHash: nset.payloadHash, uri: nset.uri, expiresEpoch: 3_950, fee: 25_000_000 } }];
await tick(); await flush();
await new Promise((r) => setTimeout(r, 800)); await flush();
t("4a the warning says where sends to the name will go, not that payments are irreversible", () => {
  const w = byId("send-warn");
  assert.ok(w && !w.hidden); assert.match(w.innerHTML, /First time pointing a name at/); assert.doesNotMatch(w.innerHTML, /[Pp]ayments are irreversible/);
});

console.log(`\napprove-card-honesty: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
