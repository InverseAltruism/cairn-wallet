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
// W8 (AW-4, the FIFTH latch, FEE BURN): armNfinalizeGate's verdict note is written with
// insertAdjacentHTML into $("req") — the very element the rebuild destroys — and its latch (nfinForId) is
// NOT in W1's reset line. So the nfinalize/nrenew/nset fee-burn warning ("this name is a pending
// reservation … the fee burned") was still silently lost across an idle auto-lock and unlock, inside W1's
// own stated rule. The fix re-attaches the ALREADY-SETTLED verdict; it must NOT re-arm the gate, because
// re-arming re-runs the 6s name fetch on every repaint AND clears nfinBlocked, which would let armButtons'
// 700ms timer RE-ENABLE Approve on a request the gate had already BLOCKED.
//   RED-FIRST: delete the `if (nfinSettled) paintNfinNote(nfinSettled);` re-attach in armNfinalizeGate and
//   case (5b) goes red (the gate note is gone after the unlock repaint).
//   PAIRED HAPPY-PATH, three, because this fix is mostly about what it must NOT do: case (6) a BLOCKED
//   nrenew still has Approve disabled after the repaint's own 700ms re-enable timer; case (5c)/(6c) the
//   repaint fires ZERO new gate fetches; case (7) an ungated request is unchanged and inherits no note.
//
// Run: node --import tsx test/approve-repaint-dom.test.mjs   (offline)
import { costLine, debitOf, fmtBalance } from "../src/popup/clearsign.js";
import { buildNameRenew, CAIRNX_DOMAIN, TREASURY_ADDR } from "../src/core/cairnx.js";

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
let tradeApi = "";   // set for the W8 section; the gate is the only reader and it returns early before this on a `send`
let nextBalance = 100_00000000;
let holdNextBalance = false, releaseHeldBalance = null;
const handlers = {
  status: () => ({ unlocked: state.unlocked, accounts: [{ label: "Main", addr: ME }], active: 0, addr: ME, tradeApi }),
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

// The name-service fetch behind the nfinalize/nrenew/nset approve gate (W8). It is the gate's ONLY
// network call, so counting it is how "the repaint fires zero new gate fetches" is asserted.
let nameFetches = 0;
let nameRecord = null;      // null → a clean 404 (the definitive "no such name" the gate BLOCKS on)
let fetchDelayMs = 0;       // a REAL gate fetch is bounded at 6s, i.e. far slower than armButtons' 700ms
globalThis.fetch = async (url) => {
  nameFetches++;
  if (!/\/cairnx\/name\//.test(String(url))) throw new Error("unexpected fetch: " + url);
  if (fetchDelayMs) await new Promise((r) => setTimeout(r, fetchDelayMs));
  return nameRecord == null
    ? { status: 404, ok: false, json: async () => null }
    : { status: 200, ok: true, json: async () => nameRecord };
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

// ── 5. W8: the nrenew/nfinalize/nset gate note across an idle auto-lock ────────────────────────────────
// Production's exact call shape for this lane: the /names site raises a `propose` on the cairnx:v1 domain
// carrying the canonical record + its payload hash and the treasury fee output. The record here is built
// by the wallet's own builder, so the uri/payloadHash pair is the one the resolver would accept.
console.log("\nW8 (AW-4, the fifth latch): the fee-burn gate note across a lock and unlock");
tradeApi = "https://cairn-substrate.com/trade/api";
const RENEW = buildNameRenew({ name: "satoshi" });
const nrenewReq = (id) => ({
  id, method: "propose", origin: "https://cairn-substrate.com",
  // the treasury output value is not under test here (the underpayment warning needs a live tip and this
  // request carries none) — it is present because production's nrenew propose always carries it
  params: { domain: CAIRNX_DOMAIN, uri: RENEW.uri, payloadHash: RENEW.payloadHash, fee: 1_000_000, outputs: [{ to: TREASURY_ADDR, value: 100_000_000 }] },
});
const noteRe = /pending reservation, not a finalized registration/;
const settle = async (ms = 800) => { await new Promise((r) => setTimeout(r, ms)); await flush(); };  // 800ms = just past armButtons' 700ms re-enable timer

// 5a. a WARN-only verdict (the name is a pending reservation → a renewal is a no-op and the fee burns)
nameRecord = { name: "satoshi", owner: ME, pending: true };
state.pending = [nrenewReq("g1")];
await tick(); await flush(); await settle();
check("(5a) baseline: the nrenew approve gate paints its fee-burn note into #req", noteRe.test(registry.get("req").innerHTML));
check("(5a) the gate fetched the name record exactly once", nameFetches === 1);
check("(5a) a WARN-only verdict leaves Approve ENABLED (warn over block)", registry.get("btn-approve").disabled === false);

state.unlocked = false; await tick(); await flush();              // the idle auto-lock fires while the approval is open
state.unlocked = true;  await tick(); await flush(); await settle();  // the user unlocks; the poll repaints (settle = past armButtons' 700ms re-enable)
check("(5b) W8: the fee-burn gate note is STILL THERE after the unlock repaint (pre-fix it is silently gone)",
  noteRe.test(registry.get("req").innerHTML));
check("(5c) HAPPY-PATH: the unlock repaint fired ZERO new gate fetches (no re-arm, no second 6s name fetch)", nameFetches === 1);
check("(5c) HAPPY-PATH: a WARN-only verdict still leaves Approve enabled after the repaint", registry.get("btn-approve").disabled === false);

// 6. a BLOCKING verdict (clean 404 → the name is not registered, the renewal fee would burn for nothing)
// The fetch is SLOWED to 1.2s here, which is the whole point of the instrument: the real gate fetch is
// bounded at 6s, so it lands well AFTER armButtons' 700ms re-enable timer. With an instant stub the
// re-armed verdict beats the timer and the regression this case exists to catch is invisible.
console.log("\nPAIRED HAPPY-PATH (W8): a BLOCKED nrenew must stay blocked across the repaint");
nameRecord = null;                       // clean 404
nameFetches = 0;
fetchDelayMs = 1200;
state.pending = [nrenewReq("g2")];
await tick(); await flush(); await settle();
const blockRe = /not registered, so the renewal would be ignored on-chain/;
check("(6a) setup: on a FIRST paint Approve is live at the 700ms timer while the verdict is still in flight (the gate fails OPEN by design: approval never gains a hard network dependency, and resolve() awaits the verdict as the belt)",
  registry.get("btn-approve").disabled === false);
await settle(700);                       // the verdict lands (1.2s fetch)
check("(6a) baseline: a 404 nrenew paints the BLOCKING note", blockRe.test(registry.get("req").innerHTML));
check("(6a) baseline: and the landed verdict DISABLES Approve", registry.get("btn-approve").disabled === true);
check("(6a) the gate fetched once", nameFetches === 1);

state.unlocked = false; await tick(); await flush();
state.unlocked = true;  await tick(); await flush(); await settle();   // 800ms: past the 700ms timer, INSIDE the window a re-armed 1.2s fetch would still be in flight
check("(6b) W8: the BLOCKING note is re-attached after the unlock repaint", blockRe.test(registry.get("req").innerHTML));
check("(6b) HAPPY-PATH: Approve is STILL DISABLED at the repaint's own 700ms re-enable timer (THE TRAP: re-arming the gate here would clear nfinBlocked, and this button would go live on a request the gate had already BLOCKED until a fresh verdict landed)",
  registry.get("btn-approve").disabled === true);
check("(6c) HAPPY-PATH: the unlock repaint fired ZERO new gate fetches", nameFetches === 1);
await settle(700);                       // drain any verdict a mutation may have put in flight
fetchDelayMs = 0;

// 7. no leak onto a different request, and a genuinely NEW gated request still re-arms
console.log("\nPAIRED HAPPY-PATH (W8): an ungated request is unchanged and inherits no note");
state.pending = [sendReq("g3", RCPT_B, 1_00000000)];
await tick(); await flush(); await settle();
check("(7) a plain send after a gated request carries NO gate note", !blockRe.test(registry.get("req").innerHTML) && !noteRe.test(registry.get("req").innerHTML));
check("(7) ...fires no gate fetch", nameFetches === 1);
check("(7) ...and Approve is enabled again (the block belonged to the previous request)", registry.get("btn-approve").disabled === false);
nameRecord = { name: "satoshi", owner: ME, pending: true };
state.pending = [nrenewReq("g4")];
await tick(); await flush(); await settle();
check("(7) a genuinely NEW nrenew request DOES re-arm the gate (one new fetch)", nameFetches === 2);
check("(7) ...and paints its own verdict", noteRe.test(registry.get("req").innerHTML));
check("(7) the window was never closed during the W8 section", closes === 0);

console.log(`\napprove-repaint-dom: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
