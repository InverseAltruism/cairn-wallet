// A request the approval window cannot paint does not hold the window. The REAL src/popup/approve.ts on
// helpers/approve-dom.mjs, its queue served directly: a send whose outputs hold null at the head (describe() throws on
// it), an honest send from another site behind it. The background refuses such a request before the queue
// (test/send-fill-prequeue.test.mjs); this is the window's own second line for any request whose paint throws.
//   1. The head request is shown as one the wallet could not show: Approve stays off and Reject arms after the 700 ms
//      floor. Each poll still retries the paint (test/approve-guards-dom.test.mjs (5) pins that a paint that fails
//      once paints on the next tick); a retry that fails again keeps Reject live and does not restart the floor.
//   2. A raise while it is shown leaves Approve off (Reject only rejects the request on screen); a click on Approve
//      does nothing.
//   3. Reject answers it USER_REJECTED, and the honest request behind it is painted and arms as any request does.
//   RED-FIRST: on d562218 the head request never paints, both buttons stay off, a click on Reject does nothing and the
//   honest request is never shown (the audit's zz-audit-paint-throw-dom). Let armButtons ignore `unpaintable` and 1
//   and 2 fail on Approve; disable both buttons on every retry and 1 fails on Reject.
// Run: npx tsx test/approve-paint-throw-dom.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { APPROVE_REARM } from "../src/approve-window.ts";

const { check, done } = checker("a request the window cannot paint does not hold the window:");
const ME = "0x" + "ab".repeat(20);
const state = { pending: [] };
const resolved = [];
const handlers = {
  status: () => ({ unlocked: true, hasVault: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
  pending: () => state.pending,
  balance: () => ({ confirmed: 5_000_00000000 }),
  history: () => [],
  tokenDisplayMeta: () => ({}), sealedClaims: () => [], tip: () => 140_000, epoch: () => 4_666, tipFloor: () => 0,
  resolve: (id, approve) => { resolved.push([id, approve]); state.pending = state.pending.filter((r) => r.id !== id); return { done: true, ok: approve, code: approve ? undefined : "USER_REJECTED" }; },
};
const { registry, deliver } = mountApproveWindow(handlers);
const hostile = { id: "h1", method: "send", origin: "https://hostile.example", params: { outputs: [null], fee: 1_000_000 } };
const honest = { id: "g1", method: "send", origin: "https://honest.example", params: { to: "0x" + "aa".repeat(20), amount: 1e8, fee: 1_000_000 } };

let unhandled = 0;
process.on("unhandledRejection", () => { unhandled++; });   // the first render's paint throws, as it did before
state.pending = [hostile, honest];
const tick = await loadApprove();
const approve = () => registry.get("btn-approve"), reject = () => registry.get("btn-reject");

// 1. Shown as unpaintable; Reject after the floor; Approve off; the poll leaves it alone.
await flush(); await sleep(100); await flush();
check(`1. inside the floor both buttons are off (approve ${approve().disabled}, reject ${reject().disabled})`, approve().disabled === true && reject().disabled === true);
await sleep(750); await flush();
const html = registry.get("req").innerHTML;
check("1. the request says the wallet could not show it and cannot approve it", /could not show this request, so it cannot be approved/.test(html));
check(`1. the header names the site that sent it (${registry.get("ap-origin").textContent})`, registry.get("ap-origin").textContent === "https://hostile.example");
check("1. it says another request waits behind it", /Request 1 of 2/.test(html));
check(`1. after the floor Reject is live and Approve stays off (approve ${approve().disabled}, reject ${reject().disabled})`, approve().disabled === true && reject().disabled === false);
// Every write that turns Reject off during the retries is counted.
const rj = reject();
let rjOff = rj.disabled, offDuringRetry = 0;
Object.defineProperty(rj, "disabled", { configurable: true, get: () => rjOff, set: (x) => { if (x) offDuringRetry++; rjOff = x; } });
let thrown = 0;
for (let i = 0; i < 3; i++) { await tick().catch(() => { thrown++; }); await flush(); }
delete rj.disabled; rj.disabled = rjOff;
check(`1. three poll ticks retry the paint (${thrown} threw) and keep Reject live throughout (off during a retry: ${offDuringRetry}), Approve off`, thrown === 3 && offDuringRetry === 0 && reject().disabled === false && approve().disabled === true);
check("1. the card still says the request could not be shown", /could not show this request, so it cannot be approved/.test(registry.get("req").innerHTML));

// 2. A raise leaves Approve off; a click on Approve does nothing.
const answer = deliver({ kind: APPROVE_REARM }, { id: "cairnwallettestid" });
await flush(); await sleep(750); await flush();
check(`2. a raise is answered (${JSON.stringify(answer)}) and leaves Approve off (approve ${approve().disabled}, reject ${reject().disabled})`, answer?.value?.ok === true && approve().disabled === true && reject().disabled === false);
approve()._listeners.click(); await flush(); await sleep(20); await flush();
check(`2. a click on Approve resolves nothing (${JSON.stringify(resolved)})`, resolved.length === 0);

// 3. Reject answers it; the honest request behind it paints and arms.
reject()._listeners.click(); await flush(); await sleep(20); await flush();
check(`3. Reject answers the request it was shown with (${JSON.stringify(resolved)})`, resolved.length === 1 && resolved[0][0] === "h1" && resolved[0][1] === false);
await tick(); await flush(); await sleep(800); await flush();
check(`3. the honest request behind it is painted (${registry.get("ap-origin").textContent})`, registry.get("ap-origin").textContent === "https://honest.example" && /Send CSD/.test(registry.get("req").innerHTML));
check(`3. and arms as any request does (approve ${approve().disabled}, reject ${reject().disabled})`, approve().disabled === false && reject().disabled === false);
approve()._listeners.click(); await flush(); await sleep(20); await flush();
check(`3. Approve on the honest request approves it (${JSON.stringify(resolved)})`, resolved.length === 2 && resolved[1][0] === "g1" && resolved[1][1] === true);
done("approve-paint-throw-dom");
