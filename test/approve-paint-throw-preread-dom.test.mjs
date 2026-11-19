// A request whose pre-paint reads throw does not hold the window either. The REAL src/popup/approve.ts on
// helpers/approve-dom.mjs, its queue served directly as test/approve-paint-throw-dom.test.mjs serves it: a propose whose
// domain is { "toString": 1 } at the head (String() throws on it in the reads render() makes before it paints: the
// CairnX ticker read), an honest send from another site behind it. The background refuses such a propose before the
// queue (test/request-shape-prequeue.test.mjs); this is the window's second line, which SECURITY.md and
// docs/ARCHITECTURE.md state for any request the window fails to draw.
//   1. The head request is shown as one the wallet could not show: Approve stays off, Reject arms after the floor.
//   2. Reject answers it USER_REJECTED, and the honest request behind it is painted and arms as any request does.
//   3. A throw in a read that describe() does not repeat: an attest of score 0 whose cancel read (attestTarget) comes
//      back with a proposer String() throws on. The worker validates that answer, so no page reaches this; it pins
//      that the read's throw itself reaches the fallback, not only a field the paint reads again.
//   RED-FIRST: with the pre-paint reads outside render()'s try (39c8bcd), the card stays empty, both buttons stay off,
//   a click on Reject resolves nothing and the honest request is never shown. Drop the rethrow inside the paint's try
//   and 1 and 2 stay green (describe() throws on the same domain) while 3 paints the attest with Approve live.
// Run: npx tsx test/approve-paint-throw-preread-dom.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";

const { check, done } = checker("a request whose pre-paint reads throw does not hold the window:");
const ME = "0x" + "ab".repeat(20);
const state = { pending: [] };
const resolved = [];
const handlers = {
  status: () => ({ unlocked: true, hasVault: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
  pending: () => state.pending,
  balance: () => ({ confirmed: 5_000_00000000 }),
  history: () => [],
  tokenDisplayMeta: () => ({}), sealedClaims: () => [], tip: () => 140_000, epoch: () => 4_666, tipFloor: () => 0,
  attestTarget: () => ({ ok: true, kind: "offer", proposer: { toString: 1 } }),
  resolve: (id, approve) => { resolved.push([id, approve]); state.pending = state.pending.filter((r) => r.id !== id); return { done: true, ok: approve, code: approve ? undefined : "USER_REJECTED" }; },
};
const { registry } = mountApproveWindow(handlers);
const hostile = { id: "h1", method: "propose", origin: "https://hostile.example", params: { domain: { toString: 1 }, payloadHash: "0x" + "ab".repeat(32), uri: "data:,hi", expiresEpoch: 9_000 } };
const honest = { id: "g1", method: "send", origin: "https://honest.example", params: { to: "0x" + "aa".repeat(20), amount: 1e8, fee: 1_000_000 } };

process.on("unhandledRejection", () => undefined);   // the first render throws, as a paint throw does
state.pending = [hostile, honest];
const tick = await loadApprove();
const approve = () => registry.get("btn-approve"), reject = () => registry.get("btn-reject");

// 1. Shown as unpaintable; Reject after the floor; Approve off.
await flush(); await sleep(100); await flush();
check(`1. inside the floor both buttons are off (approve ${approve().disabled}, reject ${reject().disabled})`, approve().disabled === true && reject().disabled === true);
await sleep(750); await flush();
const html = registry.get("req").innerHTML;
check(`1. the request says the wallet could not show it and cannot approve it (${html.slice(0, 60)})`, /could not show this request, so it cannot be approved/.test(html));
check(`1. the header names the site that sent it (${registry.get("ap-origin").textContent})`, registry.get("ap-origin").textContent === "https://hostile.example");
check("1. it says another request waits behind it", /Request 1 of 2/.test(html));
check(`1. after the floor Reject is live and Approve stays off (approve ${approve().disabled}, reject ${reject().disabled})`, approve().disabled === true && reject().disabled === false);
let thrown = 0;
for (let i = 0; i < 2; i++) { await tick().catch(() => { thrown++; }); await flush(); }
check(`1. poll ticks retry the reads (${thrown} threw) and keep Reject live, Approve off`, thrown === 2 && reject().disabled === false && approve().disabled === true);
approve()._listeners.click(); await flush(); await sleep(20); await flush();
check(`1. a click on Approve resolves nothing (${JSON.stringify(resolved)})`, resolved.length === 0);

// 2. Reject answers it; the honest request behind it paints and arms.
reject()._listeners.click(); await flush(); await sleep(20); await flush();
check(`2. Reject answers the request it was shown with (${JSON.stringify(resolved)})`, resolved.length === 1 && resolved[0][0] === "h1" && resolved[0][1] === false);
await tick(); await flush(); await sleep(800); await flush();
check(`2. the honest request behind it is painted (${registry.get("ap-origin").textContent})`, registry.get("ap-origin").textContent === "https://honest.example" && /Send CSD/.test(registry.get("req").innerHTML));
check(`2. and arms as any request does (approve ${approve().disabled}, reject ${reject().disabled})`, approve().disabled === false && reject().disabled === false);
approve()._listeners.click(); await flush(); await sleep(20); await flush();
check(`2. Approve on the honest request approves it (${JSON.stringify(resolved)})`, resolved.length === 2 && resolved[1][0] === "g1" && resolved[1][1] === true);

// 3. A throw in a read the paint does not repeat.
state.pending = [{ id: "a1", method: "attest", origin: "https://other.example", params: { proposalId: "0x" + "c1".repeat(32), score: 0, confidence: 100, fee: 5_000_000 } }];
await tick().catch(() => undefined); await flush(); await sleep(800); await flush();
check(`3. an attest whose cancel read throws is shown as one the wallet could not show (${registry.get("ap-origin").textContent})`, registry.get("ap-origin").textContent === "https://other.example" && /could not show this request, so it cannot be approved/.test(registry.get("req").innerHTML));
check(`3. ...Approve off, Reject live (approve ${approve().disabled}, reject ${reject().disabled})`, approve().disabled === true && reject().disabled === false);
done("approve-paint-throw-preread-dom");
