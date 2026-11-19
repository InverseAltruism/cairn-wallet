// A request the window could not paint, which comes back to the head of the queue after another request's paint, is
// disabled and shown as one the wallet could not show again: the other request's card, labels and live buttons never
// stand for it. The REAL src/popup/approve.ts on helpers/approve-dom.mjs, its queue served directly, in the production
// order of a reservation fill (background.ts requeueFront): the fill is approved and leaves the queue while its
// preflight runs, the request behind it (an attest whose proposalId the window cannot read; the background refuses it
// before the queue, test/request-shape-fuzz.test.mjs, so this is the window's own second line) is at the head and is
// shown as unpaintable, the fill comes back at the front for its confirm step and is answered "Sign anyway".
//   1. The fill paints and arms.
//   2. While the fill is in flight the attest is shown as one the wallet could not show: Approve off, Reject live.
//   3. The fill's confirm step paints over it: "Sign anyway" and "Cancel", both live.
//   4. After "Sign anyway" the attest is the head again: it is shown as one the wallet could not show, with Approve off
//      and labelled Approve, Reject live and labelled Reject.
//   5. Approve enabled over that card by anything at all still resolves nothing (approve.ts resolve()); Reject
//      answers the attest.
//   RED-FIRST: on 8b534c5 step 4 shows the fill's card, "Sign anyway" and "Cancel" both live, for the attest (the
//   per-request flag kept disableButtons() and the repaint off); keep `unpaintableShown` set across another request's
//   paint and 4 fails the same way; drop the unpaintableShown check in resolve() and 5 approves the attest.
// Run: npx tsx test/approve-paint-throw-requeue-dom.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";

const { check, done } = checker("an unpaintable request back at the head is shown as such again:");
const ME = "0x" + "ab".repeat(20);
const FC = "0x" + "f1".repeat(32);
const state = { pending: [] };
const resolved = [];
const fill = { id: "b1", method: "fillOffer", origin: "https://honest.example", params: { proposalId: FC, outputs: [{ to: "0x" + "aa".repeat(20), value: 25e8 }], fee: 5_000_000 } };
const hostile = { id: "h1", method: "attest", origin: "https://hostile.example", params: { proposalId: { toString: 1 }, score: 100, confidence: 100 } };
let fillCalls = 0;
const handlers = {
  status: () => ({ unlocked: true, hasVault: true, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME }),
  pending: () => state.pending,
  balance: () => ({ confirmed: 5_000_00000000 }),
  history: () => [],
  tokenDisplayMeta: () => ({}), sealedClaims: () => [], tip: () => 140_000, epoch: () => 4_666, tipFloor: () => 0,
  fillOfferView: () => null,
  resolve: async (id, approve, _signer, _quote, ack) => {
    resolved.push([id, approve, ack ? "ack" : ""]);
    if (id === "b1" && approve && ++fillCalls === 1) {
      // off the queue while the preflight runs, then back at the front for the confirm step
      state.pending = state.pending.filter((r) => r.id !== id);
      await sleep(1500);
      state.pending = [fill, ...state.pending];
      return { done: false, ok: false, code: "RESERVATION_UNCONFIRMED", error: "confirm", unconfirmed: { fclaimTxid: FC, fclaimHeight: 139_990, tipHeight: 140_020 } };
    }
    state.pending = state.pending.filter((r) => r.id !== id);
    return approve ? { done: true, ok: true, txid: "0x" + "77".repeat(32) } : { done: true, ok: false, code: "USER_REJECTED" };
  },
};
const { registry } = mountApproveWindow(handlers);
process.on("unhandledRejection", () => { /* the attest's paint throws on every attempt, as intended */ });
const approve = () => registry.get("btn-approve"), reject = () => registry.get("btn-reject");
const card = () => {
  const h = registry.get("req").innerHTML;
  return /could not show this request/.test(h) ? "could-not-show" : /Fill offer/.test(h) ? "fill" : "other";
};
const view = () => ({ origin: registry.get("ap-origin").textContent, card: card(), approve: [approve().disabled, approve().textContent], reject: [reject().disabled, reject().textContent] });
const settle = async (tick) => { for (let i = 0; i < 3; i++) { await tick().catch(() => undefined); await flush(); } await sleep(900); await flush(); };

state.pending = [fill, hostile];
const tick = await loadApprove();
await flush(); await sleep(900); await flush();
let v = view();
check(`1. the fill paints and arms (${JSON.stringify(v)})`, v.origin === "https://honest.example" && v.card === "fill" && v.approve[0] === false && v.reject[0] === false);

approve()._listeners.click(); await flush();
await tick().catch(() => undefined); await flush(); await sleep(900); await flush();
v = view();
check(`2. fill in flight: the attest is shown as unpaintable, Approve off, Reject live (${JSON.stringify(v)})`,
  v.origin === "https://hostile.example" && v.card === "could-not-show" && v.approve[0] === true && v.reject[0] === false);

await sleep(800); await flush(); await tick().catch(() => undefined); await flush(); await sleep(900); await flush();
v = view();
check(`3. the fill's confirm step paints: Sign anyway and Cancel, both live (${JSON.stringify(v)})`,
  v.origin === "https://honest.example" && v.card === "fill" && v.approve[0] === false && v.approve[1] === "Sign anyway" && v.reject[0] === false && v.reject[1] === "Cancel");

approve()._listeners.click(); await flush(); await sleep(50); await flush();
check(`3. Sign anyway answers the fill with the acknowledgement (${JSON.stringify(resolved)})`, resolved.length === 2 && resolved[1][0] === "b1" && resolved[1][1] === true && resolved[1][2] === "ack");
await settle(tick);
v = view();
check(`4. the attest is the head again and is shown as unpaintable, not under the fill's card (${JSON.stringify(v)})`, v.origin === "https://hostile.example" && v.card === "could-not-show");
check(`4. Approve is off and labelled Approve; Reject is live and labelled Reject (${JSON.stringify(v)})`,
  v.approve[0] === true && v.approve[1] === "Approve" && v.reject[0] === false && v.reject[1] === "Reject");

// The button state is the first line; resolve() is the second, so Approve is enabled here by hand.
approve().disabled = false;
approve()._listeners.click(); await flush(); await sleep(50); await flush();
check(`5. a click on an enabled Approve over the card resolves nothing (${JSON.stringify(resolved)})`, resolved.length === 2);
reject()._listeners.click(); await flush(); await sleep(50); await flush();
check(`5. Reject answers the attest (${JSON.stringify(resolved)})`, resolved.length === 3 && resolved[2][0] === "h1" && resolved[2][1] === false);
done("approve-paint-throw-requeue-dom");
