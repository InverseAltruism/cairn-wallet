// Behaviour tests for three approval-window guards in src/popup/approve.ts, driven through the REAL module
// (helpers/approve-dom.mjs). Each was pinned only by source text or by nothing, so deleting it left the
// suite green.
//
// (1) render() disables both buttons the moment a NEW request is detected, before the pre-paint reads.
//     Otherwise a click during those reads (up to 2.5 s) resolves the new request while the previous
//     request's paint is still on screen.
//     RED-FIRST: delete the `disableButtons();` call in render() and (1a) fails.
//     PAIRED HONEST PATH: (1b) once the paint lands and the 700 ms floor passes, Approve resolves the new
//     request with (id, true, signer).
// (2) resolve() awaits the name-gate verdict at the click and refuses a BLOCKING one without consuming the
//     request. The gate fails open while its fetch is in flight (Approve arms at 700 ms; the fetch is bounded
//     at 6 s), so this click-time check is the only thing between that click and the signer.
//     RED-FIRST: delete the `if (g?.block) { msg(...); return; }` line in resolve() and (2a) fails.
//     PAIRED HONEST PATH: (2b) Reject still resolves the refused request; (2c) a warn-only verdict lets the
//     same click through to the signer.
// (3) armButtons keeps Approve disabled for a token-debiting fill whose preview is not `ready`. Waiting for
//     the preview promise covers a quote that never answers; this latch covers one that failed.
//     RED-FIRST: drop `|| tokenNotReady(current)` from armButtons and (3a) fails.
//     PAIRED HONEST PATH: (3b) a quote that answers arms Approve and reaches the signer; (3c) one that
//     answers after the 700 ms floor arms Approve when it lands (drop the `tokenPainted` wait from armButtons
//     and (3c) fails: the arm runs at 700 ms while the preview is loading and nothing re-arms it).
//     resolve() repeats the check at the click, so an Approve left live over a preview that is not `ready`
//     (by any path that re-enables the button) still reaches no signer.
//     RED-FIRST: delete the `if (approve && tokenNotReady(current))` line in resolve() and (3d) fails.
//     PAIRED HONEST PATH: (3b) a painted quote approves with the displayed quote.
// (4) The re-enable after a paint waits for the 700 ms floor AND for the send-warning fill, so a slow history
//     read cannot leave Approve live over an unpainted address-poisoning warning; and the timer starts after
//     the paint, never during the pre-paint reads.
//     RED-FIRST: drop `Promise.resolve(warnPainted)` from armButtons' wait and (4a) fails; set the 700 ms
//     floor to 0 and (1b) "still disabled right after the paint" fails; call armButtons() in place of the
//     early disableButtons() and (1a) "still disabled 800 ms into the reads" fails.
//     PAIRED HONEST PATH: (4b) the warning lands, then Approve arms.
// (5) A paint that throws resets renderedId so the next poll repaints the request; otherwise it stays
//     disabled and unresolvable for good.
//     RED-FIRST: delete the `renderedId = null` in render()'s catch and (5) fails.
//
// Run: node --import tsx test/approve-guards-dom.test.mjs   (offline)
import { buildNameRenew, CAIRNX_DOMAIN, TREASURY_ADDR } from "../src/core/cairnx.js";
import { bid } from "../src/vendor/cairnx-spv.js";
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";

const { check, done } = checker("approval-window guards (real approve.ts):");

const ME = "0x" + "ab".repeat(20);
const RCPT = "0x" + "31".repeat(20);
const state = { pending: [], tradeApi: "" };
const resolves = [];
let epochGate = null;          // when set, the pre-paint `epoch` read waits on this promise
let quote = null;              // tokenFillQuote answer
const handlers = {
  status: () => ({ unlocked: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME, tradeApi: state.tradeApi }),
  pending: () => structuredClone(state.pending),   // the real port clones every reply
  balance: () => ({ confirmed: 100_00000000 }),
  history: () => [],
  sealedClaims: () => [],
  tokenFillQuote: () => quote,
  tip: () => 65_000,
  epoch: () => epochGate ?? 2_166,
  tipFloor: () => 0,
  tokenDisplayMeta: () => ({}),
  resolve: (...a) => { resolves.push(a); return { done: true, ok: true, txid: "0x" + "ee".repeat(32) }; },
};
const { registry } = mountApproveWindow(handlers);

// The name service behind the nrenew/nset/nfinalize gate. Its real fetch is bounded at 6 s.
let nameRecord = null;         // null: a clean 404, the "not registered" verdict that BLOCKS
let fetchDelayMs = 0;
globalThis.fetch = async (url) => {
  if (!/\/cairnx\/name\//.test(String(url))) throw new Error("unexpected fetch: " + url);
  if (fetchDelayMs) await sleep(fetchDelayMs);
  return nameRecord == null ? { status: 404, ok: false, json: async () => null } : { status: 200, ok: true, json: async () => nameRecord };
};

const approveBtn = () => registry.get("btn-approve");
const click = (id) => registry.get(id)._listeners.click();
const settle = async (ms = 800) => { await sleep(ms); await flush(); };   // 800 ms: just past the 700 ms re-enable floor

// Production call shapes: a dApp send; the Sunrise quick buy (a cairnx:v1 bid propose with expiresEpoch,
// which makes render() read epoch/tip/tipFloor before painting); the /names site's nrenew propose; a
// token-priced fill attest.
const sendReq = (id, to = RCPT) => ({ id, method: "send", origin: "https://dapp.example", params: { to, amount: 1_00000000, fee: 1_000_000 } });
const BID = bid({ give: { value: "5000000000" }, want: { ticker: "CAIRN", amount: "463852873290" } });
const bidReq = (id) => ({ id, method: "propose", origin: "https://cairn-substrate.com",
  params: { domain: CAIRNX_DOMAIN, uri: BID.uri, payloadHash: BID.payloadHash, expiresEpoch: 2_300, fee: 25_000_000 } });
const RENEW = buildNameRenew({ name: "satoshi" });
const nrenewReq = (id) => ({ id, method: "propose", origin: "https://cairn-substrate.com",
  params: { domain: CAIRNX_DOMAIN, uri: RENEW.uri, payloadHash: RENEW.payloadHash, fee: 1_000_000, outputs: [{ to: TREASURY_ADDR, value: 100_000_000 }] } });
const tokenReq = (id) => ({ id, method: "attest", origin: "https://dapp.example", params: { proposalId: "0x" + "aa".repeat(32), score: 100, confidence: 1_000_000 } });

state.pending = [sendReq("a1")];
const tick = await loadApprove();
await flush(); await settle();
check("setup: the first request is painted and Approve is armed", approveBtn().disabled === false);

// ── (1) the immediate disable on a new request ─────────────────────────────────────────────────────────
console.log("\n(1) a new request disables both buttons before its pre-paint reads");
let releaseEpoch;
epochGate = new Promise((r) => { releaseEpoch = r; });
state.pending = [bidReq("b1")];
const painting = tick();
await flush();
check("(1a) while the new request's pre-paint read is pending, Approve is disabled", approveBtn().disabled === true);
check("(1a) ...and Reject is disabled", registry.get("btn-reject").disabled === true);
click("btn-approve");
await flush();
check("(1a) a click in that window reaches no signer", resolves.length === 0);
check("(1a) the screen still shows the previous request (the window this guard closes)", /0x3131/.test(registry.get("req").innerHTML));
await settle();
check("(1a) still disabled 800 ms into the reads (the re-enable timer has not started)", approveBtn().disabled === true && registry.get("btn-reject").disabled === true);
releaseEpoch(2_166); epochGate = null;
await painting; await flush();
check("(1b) still disabled right after the paint (the 700 ms floor)", approveBtn().disabled === true);
await settle();
check("(1b) paired: after the paint and the 700 ms floor, Approve is armed for the new request", approveBtn().disabled === false);
click("btn-approve");
await flush(); await settle(50);
check("(1b) paired: Approve resolves the new request with (id, true, signer)",
  resolves.length === 1 && resolves[0][0] === "b1" && resolves[0][1] === true && resolves[0][2] === ME);

// ── (2) the click-time refusal of a blocking name-gate verdict ───────────────────────────────────────────
console.log("\n(2) a click that races the name gate is refused when the verdict blocks");
state.tradeApi = "https://cairn-substrate.com/trade/api";
nameRecord = null;             // 404: the name is not registered, the renewal fee would burn
fetchDelayMs = 1500;           // lands after the 700 ms arm
resolves.length = 0;
state.pending = [nrenewReq("g1")];
await tick(); await flush(); await settle();
check("(2) setup: Approve is armed while the verdict is still in flight (fail-open by design)", approveBtn().disabled === false);
click("btn-approve");
await settle(1000);            // the verdict lands while resolve() awaits it
check("(2a) the click is refused: nothing reaches the signer", resolves.length === 0);
check("(2a) the refusal shows the gate's reason", /not registered/.test(registry.get("msg").textContent) && registry.get("msg").className === "msg err");
check("(2a) the request is not consumed: its view is still shown", registry.get("view-req").hidden === false);
click("btn-reject");
await flush(); await settle(50);
check("(2b) paired: Reject still resolves the refused request as a rejection",
  resolves.length === 1 && resolves[0][0] === "g1" && resolves[0][1] === false);

nameRecord = { name: "satoshi", owner: ME, pending: true };   // warn only: the renewal is a no-op on a reservation
resolves.length = 0;
state.pending = [nrenewReq("g2")];
await tick(); await flush(); await settle();
click("btn-approve");
await settle(1000);
check("(2c) paired: a warn-only verdict lets the same click through to the signer",
  resolves.length === 1 && resolves[0][0] === "g2" && resolves[0][1] === true && resolves[0][2] === ME);
fetchDelayMs = 0;

// ── (3) the token-preview latch ─────────────────────────────────────────────────────────────────────────
console.log("\n(3) a token fill whose preview failed keeps Approve disabled");
quote = { ok: false, error: "quote unavailable" };
resolves.length = 0;
state.pending = [tokenReq("t1")];
await tick(); await flush();
await settle(5000);            // three failed attempts, 1.5 s apart, then the preview settles as `error`
check("(3a) setup: the failed preview is shown as a caution", registry.get("token-sim")?.hidden === false && registry.get("token-sim").innerHTML.length > 0);
check("(3a) Approve stays disabled once the failed preview settles", approveBtn().disabled === true);
check("(3a) ...and Reject is available", registry.get("btn-reject").disabled === false);
click("btn-approve");
await flush();
check("(3a) a click reaches no signer", resolves.length === 0);
approveBtn().disabled = false;   // Approve live over the failed preview: only the click-time check is left
click("btn-approve");
await flush(); await settle(50);
check("(3d) a click on Approve over a failed preview reaches no signer", resolves.length === 0);
check("(3d) ...and says the token amount is not shown", /token amount is not shown yet/.test(registry.get("msg").textContent) && registry.get("msg").className === "msg err");
check("(3d) the request is not consumed: its view is still shown", registry.get("view-req").hidden === false);

quote = { ok: true, ticker: "PAY", amount: "7", fee: "1", total: "8", giveTicker: "AAA", giveAmount: "10" };
state.pending = [tokenReq("t2")];
await tick(); await flush(); await settle();
check("(3b) paired: a quote that answers arms Approve", approveBtn().disabled === false);
click("btn-approve");
await flush(); await settle(50);
check("(3b) paired: Approve reaches the signer with the displayed quote",
  resolves.length === 1 && resolves[0][0] === "t2" && resolves[0][1] === true && resolves[0][3]?.total === "8");

const readyQuote = quote;
handlers.tokenFillQuote = () => sleep(1200).then(() => readyQuote);   // answers after the 700 ms floor
state.pending = [tokenReq("t3")];
await tick(); await flush(); await settle();
check("(3c) paired: a slow quote keeps Approve disabled while it loads", approveBtn().disabled === true);
await settle(600);
check("(3c) paired: and Approve arms when the slow quote lands", approveBtn().disabled === false);
handlers.tokenFillQuote = () => quote;

// ── (4) the arm waits for the send-warning fill ──────────────────────────────────────────────────────────
console.log("\n(4) Approve is not armed over an unpainted send warning");
let releaseHistory;
handlers.history = () => new Promise((r) => { releaseHistory = r; });
resolves.length = 0;
state.pending = [sendReq("w1")];
await tick(); await flush(); await settle();
check("(4a) the history read is still pending 800 ms after the paint, and Approve stays disabled", typeof releaseHistory === "function" && approveBtn().disabled === true);
releaseHistory([]);
await flush(); await settle(50);
check("(4b) paired: the first-time-recipient warning lands", /First time sending to/.test(registry.get("send-warn")?.innerHTML || ""));
check("(4b) paired: then Approve arms", approveBtn().disabled === false);
handlers.history = () => [];

// ── (5) a paint that throws is retried on the next poll ──────────────────────────────────────────────────
console.log("\n(5) a throwing paint leaves the request retryable");
const reqEl = registry.get("req");
Object.defineProperty(reqEl, "innerHTML", { configurable: true, get() { return ""; }, set() { throw new Error("paint failed"); } });
state.pending = [sendReq("p1", "0x" + "52".repeat(20))];
const thrown = await tick().then(() => null, (e) => e);
delete reqEl.innerHTML;                                      // the next paint succeeds
check("(5) setup: the first paint threw", thrown?.message === "paint failed");
await tick(); await flush(); await settle();
check("(5) the next poll repaints the same request", /0x5252/.test(registry.get("req").innerHTML));
check("(5) and arms it", approveBtn().disabled === false);
click("btn-approve");
await flush(); await settle(50);
check("(5) paired: Approve resolves it", resolves.length === 1 && resolves[0][0] === "p1" && resolves[0][1] === true);

done("approve-guards-dom");
