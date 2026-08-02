// W1 (AW-4) + W2 (AW-3): DOM-BEHAVIOR gates for the clear-signing window (src/popup/approve.ts).
//
// Both defects are invisible to a source-only pass, and a source-only pass DID miss them once:
// approve-clickthrough-guard.test.mjs pins render()'s ORDERING and argues that "adding jsdom for one
// function is over-engineering". That argument holds for ordering. It does not hold for these two, whose
// entire failure mode is which ELEMENT a write lands in after the innerHTML rebuild has swapped it. So
// this file drives the REAL module against a ~60-line element registry (no jsdom, no browser) and asserts
// on the rendered DOM, which is the only instrument that can see either bug.
//
// W1 (AW-4, FUNDS): render() returns early while locked and nulls renderedId; `status` is in
// READ_ONLY_METHODS precisely so the 1.2s poll does not defer the idle auto-lock. So an approval left open
// across an auto-lock repaints on unlock and rebuilds $("req").innerHTML, which DESTROYS #send-warn,
// #token-sim and #reveal-preview (they live inside describe()'s HTML). The once-per-id latches never
// reset, so nothing refills: the request stays approvable with the address-poisoning warning and the
// first-time-recipient warning silently ABSENT.
//   RED-FIRST: delete the `balForId = warnForId = tokenSimForId = revealForId = null;` line in render()
//   and case (1b) goes red (#send-warn present but EMPTY after the unlock repaint).
//   PAIRED HAPPY-PATH: case (2), exactly one balance call and one history call per painted request, and
//   ZERO added by the 1.2s poll (resetting the latches on the tick instead would refetch both twice a
//   second per open approval window, which is why the reset site is the rebuild and nowhere else).
//
// W2 (AW-3, FUNDS): fillBalance resolves `document.getElementById("cost")` AFTER its await with no
// renderedId guard, so a SUPERSEDED request's in-flight balance fetch writes its cost line and
// balance-after into the money row of the request now on screen.
//   RED-FIRST: delete the guard in fillBalance and case (3) goes red (A's 500 CSD balance repaints over
//   B's 900 CSD row).
//   PAIRED HAPPY-PATH: case (4), a single request renders the exact same balance-after string as before.
//
// Run: node --import tsx test/approve-repaint-dom.test.mjs   (offline)
import { costLine, debitOf, fmtBalance } from "../src/popup/clearsign.js";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };

// ── the element registry (a DOM only to the extent approve.ts uses one) ────────────────────────────────
// The one behavior that matters: assigning innerHTML REPLACES the subtree, so every id inside the old
// markup stops being reachable through getElementById and every id inside the new markup starts being
// reachable as a FRESH element. That is exactly the swap both defects hinge on.
const registry = new Map();
const TAG_WITH_ID = /<[a-zA-Z][^>]*\sid="([^"]+)"[^>]*>/g;
class El {
  constructor(id) { this.id = id; this._html = ""; this.textContent = ""; this.className = ""; this.hidden = false; this.disabled = false; this._kids = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    for (const k of this._kids) if (registry.get(k)?._parent === this) registry.delete(k);
    this._kids = [];
    this._html = String(v);
    this._adopt(this._html);
  }
  _adopt(html) {
    for (const m of String(html).matchAll(TAG_WITH_ID)) {
      const el = new El(m[1]);
      el._parent = this;
      el.hidden = /\shidden(\s|>|=)/.test(m[0]);
      registry.set(m[1], el);
      this._kids.push(m[1]);
    }
  }
  insertAdjacentHTML(_pos, html) { this._html += String(html); this._adopt(html); }
  addEventListener() { /* the buttons' listeners are not under test here */ }
}
for (const id of ["view-locked", "view-req", "req", "msg", "btn-approve", "btn-reject", "btn-unlock", "unlock-pw"]) registry.set(id, new El(id));
globalThis.document = { getElementById: (id) => registry.get(id) ?? null };
let closes = 0;
globalThis.window = { close: () => { closes++; } };

// ── the background message bridge ──────────────────────────────────────────────────────────────────────
const ME = "0x" + "ab".repeat(20);
const RCPT_A = "0x" + "31".repeat(20);
const RCPT_B = "0x" + "52".repeat(20);
const counts = { balance: 0, history: 0 };
const state = { unlocked: true, pending: [] };
let nextBalance = 100_00000000;
let holdNextBalance = false, releaseHeldBalance = null;
const handlers = {
  status: () => ({ unlocked: state.unlocked, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME, tradeApi: "" }),
  pending: () => state.pending,
  balance: () => {
    counts.balance++;
    if (holdNextBalance) { holdNextBalance = false; return new Promise((res) => { releaseHeldBalance = (b) => res(b); }); }
    return { confirmed: nextBalance };
  },
  history: () => { counts.history++; return []; },
  sealedClaims: () => [],
  tokenFillQuote: () => null,
  tip: () => 65_000,
  epoch: () => 2_166,
  tipFloor: () => 0,
  resolve: () => ({ ok: true }),
  unlock: () => true,
};
globalThis.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage(m, cb) {
      // async delivery, exactly like the real port: every filler's write lands on a later turn.
      Promise.resolve().then(async () => {
        const h = handlers[m.method];
        if (!h) return cb({ ok: false, error: "no such popup method: " + m.method });
        try { cb({ ok: true, result: await h(...(m.args || [])) }); } catch (e) { cb({ ok: false, error: String(e?.message || e) }); }
      });
    },
  },
};

// setInterval is captured, not scheduled: `tick()` IS the 1.2s poll, driven deterministically.
let tick = null;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn) => { tick = fn; return 0; };

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const sendReq = (id, to, amount) => ({ id, method: "send", origin: "https://dapp.example", params: { to, amount, fee: 1_000_000 } });

console.log("W1 (AW-4) + W2 (AW-3) - approval-window repaint behavior:\n");

// ── 1. W1: an approval left open across an idle auto-lock ──────────────────────────────────────────────
const REQ_A = sendReq("a1", RCPT_A, 1_00000000);
state.pending = [REQ_A];
await import("../src/popup/approve.js");   // module load fires the first render()
globalThis.setInterval = realSetInterval;
await flush();
check("the poll callback was captured (setInterval(render, 1200))", typeof tick === "function");

const warnBefore = registry.get("send-warn");
check("(1a) baseline: a send approval paints its first-time / address-poisoning warning into #send-warn",
  !!warnBefore && warnBefore.innerHTML.length > 0 && warnBefore.hidden === false);
check("(1a) ...and the warning is the real one (first-time recipient)", /First time sending to/.test(warnBefore?.innerHTML || ""));

state.unlocked = false;            // the idle auto-lock fires while the approval is open
await tick(); await flush();
check("(1b) while locked the request view is hidden and no repaint happened", registry.get("view-req").hidden === true);

state.unlocked = true;             // the user unlocks; the poll repaints
await tick(); await flush();
const warnAfter = registry.get("send-warn");
check("(1b) W1: after the unlock repaint #send-warn is a NEW element (the rebuild destroyed the old one)",
  !!warnAfter && warnAfter !== warnBefore);
check("(1b) W1: and it is REPOPULATED (pre-fix it stays empty and the request is approvable with no warning)",
  !!warnAfter && warnAfter.innerHTML.length > 0 && warnAfter.hidden === false);
check("(1b) W1: the repopulated warning is the real one, not a placeholder", /First time sending to/.test(warnAfter?.innerHTML || ""));
check("(1b) the money row was refilled too (#cost carries a balance-after)", /balance:/.test(registry.get("cost")?.textContent || ""));

// ── 2. W1 PAIRED HAPPY-PATH: no lock in between, and the 1.2s poll costs nothing ───────────────────────
console.log("\nPAIRED HAPPY-PATH (W1): the poll must add zero fetches");
counts.balance = 0; counts.history = 0;
nextBalance = 250_00000000;
state.pending = [sendReq("a2", RCPT_A, 2_00000000)];
await tick(); await flush();
check("(2) a normal send approval fires EXACTLY ONE balance call", counts.balance === 1);
check("(2) ...and EXACTLY ONE history call", counts.history === 1);
for (let i = 0; i < 9; i++) { await tick(); await flush(3); }   // 9 ticks = ~10.8s at the 1.2s interval
check("(2) 9 poll ticks (about 10.8s of the 1.2s poll) add ZERO balance calls", counts.balance === 1);
check("(2) ...and ZERO history calls (the latches are reset at the rebuild, never on the tick)", counts.history === 1);

// ── 3. W2: a superseded request's late balance fetch must not repaint the request now on screen ────────
console.log("\nW2 (AW-3): a superseded fetch must not repaint the live money row");
const A = sendReq("w2a", RCPT_A, 3_00000000);
const B = sendReq("w2b", RCPT_B, 7_00000000);
state.pending = [A, B];
holdNextBalance = true;
await tick(); await flush();
check("(3) setup: A is painted and A's balance fetch is still in flight", typeof releaseHeldBalance === "function" && registry.get("cost") != null);

state.pending = [B];               // the user resolves A; B comes forward
nextBalance = 900_00000000;
await tick(); await flush();
const costAfterB = registry.get("cost").textContent;
check("(3) setup: B's money row is filled from B's own balance (900 CSD)", /balance: 900/.test(costAfterB));

releaseHeldBalance({ confirmed: 500_00000000 });   // A's fetch finally lands
await flush();
const costFinal = registry.get("cost").textContent;
check("(3) W2: A's superseded balance write does NOT change B's money row", costFinal === costAfterB);
check("(3) W2: B's numbers are still on screen and A's 500 CSD never appears", /balance: 900/.test(costFinal) && !/balance: 500/.test(costFinal));

// ── 4. W2 PAIRED HAPPY-PATH: the single-request render is byte-identical to today ──────────────────────
console.log("\nPAIRED HAPPY-PATH (W2): a single request still fills its balance-after exactly");
const S = sendReq("w2h", RCPT_A, 2_00000000);
state.pending = [S];
nextBalance = 1234_00000000;
await tick(); await flush();
const expected = `${costLine(S)}  balance: ${fmtBalance(nextBalance)} → ~${fmtBalance(nextBalance - debitOf(S))} CSD`;
check(`(4) the rendered money row is exactly the pre-fix string (${JSON.stringify(registry.get("cost").textContent)})`,
  registry.get("cost").textContent === expected);
check("(4) the window was never closed during any of this", closes === 0);

console.log(`\napprove-repaint-dom: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
