// MetaMask-style approval window: opened by the background when a site calls
// window.cairn.*. Unlock if needed, review the request, approve/reject. Closes
// itself when the queue is empty. The pure "what am I signing?" formatters live in ./clearsign (unit-tested).
import { describe, debitOf, costLine, escapeHtml, paidRecipients, sendWarnings, fmtBalance, isZeroAddr, nfinalizeApproveGate, nameActApproveGate, tokenQuoteHtml, revealPreviewHtml, type NameFetchResult } from "./clearsign.js";
import { decodeCairnxRecord, CAIRNX_DOMAIN, CONF_TOKEN_FILL } from "../core/cairnx.js";
const chrome: any = (globalThis as any).chrome;
const $ = (id: string) => document.getElementById(id)!;
// Bound a background call at 2.5s: node.get() carries no timeout, and a hung (not refused) RPC must
// never hold the approval UI hostage. A miss degrades to null (callers fail soft).
const bounded = (p: Promise<unknown>): Promise<unknown> =>
  Promise.race([p.catch(() => null), new Promise((res) => setTimeout(() => res(null), 2500))]);

function call(method: string, ...args: any[]): Promise<any> {
  return new Promise((res, rej) => chrome.runtime.sendMessage({ kind: "popup", method, args }, (r: any) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    r?.ok ? res(r.result) : rej(new Error(r?.error || "error"));
  }));
}
function msg(t: string, cls = "info") { const m = $("msg"); m.textContent = t; m.className = "msg " + cls; }

let current: any = null;
let renderedId: string | null = null; // only rebuild the request view when the request changes
let renderedSigner: string | null = null; // M5: the account address DISPLAYED for the current request ("signing as …")
async function render() {
  const st = await call("status");
  ($("view-locked") as HTMLElement).hidden = st.unlocked;
  const pend = await call("pending");
  if (!pend.length) { window.close(); return; }
  current = pend[0];
  const reqView = $("view-req") as HTMLElement;
  reqView.hidden = !st.unlocked;
  if (!st.unlocked) { renderedId = null; return; }
  // Rebuild only on a NEW request (or first unlock). Re-rendering every ~1.2s tick would
  // wipe the async-filled balance-after AND the security warning — so we don't.
  if (renderedId === current.id) return;
  renderedId = current.id;
  // AW-1: disable BOTH buttons the instant a NEW request is detected, BEFORE the pre-paint RPC await, so a
  // click landing during that await cannot resolve the new request against the still-visible OLD paint. Split
  // from armButtons deliberately: hoisting armButtons ENTIRE would start its 700ms re-enable timer DURING the
  // ~2.5s await, re-enabling the buttons well before the new request paints (relocating the very window this
  // closes). The re-enable timer still fires only from the armButtons call AFTER the paint below.
  disableButtons();
  // A propose carries a dApp-supplied expiresEpoch; fetch the current epoch (node tip / 30) ONCE so
  // the clear-signer can show the real remaining window from now + warn on a too-long horizon. Done
  // before building the request HTML (not per ~1.2s tick — this block runs once per new request).
  // Best-effort: offline leaves currentEpoch undefined → the raw signed epoch is still shown.
  if (current.method === "propose" && (current.params || {}).expiresEpoch !== undefined) {
    // These are the ONLY network awaits before the request paints. Bound (module-level `bounded`) and
    // run in PARALLEL: healthy RPC ≈ one round-trip before paint (was two, unbounded), and a miss
    // degrades exactly as before (raw signed epoch shown; fee-sufficiency hint skipped).
    const [e, t, f] = await Promise.all([bounded(call("epoch")), bounded(call("tip")), bounded(call("tipFloor"))]);
    if (e != null) current.currentEpoch = e;
    if (t != null) current.currentTip = t;
    if (f != null) current.tipFloor = f; // M11 (B5b): PoW-backed floor so the review-side fee warning prices from the same clamped tip as the build side
  } else if (current.method === "attest"
      && (Number((current.params || {}).score) >>> 0) === 50 && (Number((current.params || {}).confidence) >>> 0) === 0) {
    // B5h (score-50 V28 truth): thread the PoW-backed tip floor so describe() can warn that a legacy
    // SCORE_CLAIM past the V28 gate is a guaranteed on-chain no-op. tipFloor is a wallet-store read
    // (READ_ONLY, no network), so the attest paint gains no network dependency; a miss degrades to no
    // warning (today's behavior).
    const f = await bounded(call("tipFloor"));
    if (f != null) current.tipFloor = f;
  }
  const acct = (st.accounts || [])[st.active || 0];
  renderedSigner = String(st.addr || ""); // M5: bind the resolve to the account the user is about to SEE
  const signer = acct ? `${escapeHtml(acct.label)} · ${escapeHtml(String(st.addr || ""))}` : escapeHtml(String(st.addr || ""));
  const queued = pend.length > 1 ? `<div class="req dim">request 1 of ${pend.length} — review each separately</div>` : "";
  // For a connection request, tell the user exactly what approving grants: address
  // visibility until they disconnect the site — NOT permission to move funds (every
  // send/propose/attest still asks separately).
  const connectNote = (current.method === "connect" || current.method === "getAddress")
    ? `<div class="req dim">Approving lets this site see your address until you disconnect it (Settings → Connected sites). It can’t move funds or sign anything without asking you each time.</div>`
    : "";
  try {
    // W1 (AW-4): this assignment DESTROYS every element describe() emits (#send-warn, #token-sim,
    // #reveal-preview) and the #cost row. It runs on a new request AND on the unlock repaint after an
    // idle auto-lock (render() returns early while locked and nulls renderedId, and `status` is in
    // READ_ONLY_METHODS so the 1.2s poll does not defer the lock). The once-per-request latches below
    // would then keep the async fillers from refilling, leaving the approval signable with the
    // address-poisoning and first-time-recipient warnings silently ABSENT and the token debit quote an
    // empty box. Reset them exactly HERE, where the rebuild happens, and nowhere else: resetting on the
    // 1.2s tick would refetch balance and history twice a second per open approval window.
    balForId = warnForId = tokenSimForId = revealForId = null;
    $("req").innerHTML = `<div class="req dim">signing as <b>${signer}</b></div>${queued}`
      + `<div class="req">${describe(current)}</div><div class="req dim">from ${escapeHtml(String(current.origin))}</div>`
      + connectNote
      + `<div class="req dim" id="cost">${costLine(current)}</div>`;
    msg(""); // clear any stale "approved"/"rejected" from a previous request
    armButtons();         // briefly disable Approve/Reject so a stale click can't land on a freshly-swapped request
    fillBalance(current);
    fillSendWarning(current);
    fillTokenSim(current);
    fillRevealPreview(current); // M14: which secret a revealClaim makes public (local sealedClaims read)
    armNfinalizeGate(current, st);
  } catch (e) {
    renderedId = null;   // AW-1: a describe()/paint throw must NOT latch renderedId, or `if (renderedId === current.id) return` (above) leaves the request permanently unpaintable AND (disableButtons ran, armButtons did not) unapprovable/unrejectable. Reset so the next tick retries.
    throw e;
  }
}

// ── nfinalize finalize-window gate (Plan 63 carry-over, shipped with 0.2.54) ──────────────────
// Before an nfinalize can be APPROVED, re-check on the name service that the reservation is still
// the signer's live pending one and inside its finalize window — an expired/displaced finalize burns
// the fee (the C1 class; the pure verdict is clearsign.nfinalizeApproveGate). A clean 404 is a
// definitive "no reservation" → refuse; 5xx/timeout fails OPEN (warn card, Approve stays live) so
// approval never gains a hard network dependency. resolve() AWAITS the (bounded) verdict, so a click
// racing the fetch cannot slip past a blocking verdict. Once per request (render doesn't rebuild).
let nfinForId: string | null = null;
let nfinBlocked = false;   // read by armButtons' re-enable + belt for the resolve() gate
let nfinGate: Promise<{ block: boolean; note: string | null }> | null = null;
// W8 (AW-4, the fifth latch): the SETTLED verdict for nfinForId, retained for one reason only — so a
// repaint can put its note back. Never read by the approve/refuse path (that still awaits nfinGate).
let nfinSettled: { block: boolean; note: string | null } | null = null;
async function checkNfinalize(name: string, tradeApi: string, me: string): Promise<{ block: boolean; note: string | null }> {
  let fetched: NameFetchResult = { failed: true };
  try {
    const res = await fetch(`${String(tradeApi || "").replace(/\/$/, "")}/cairnx/name/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
    if (res.status === 404) fetched = { record: null };
    else if (res.ok) { const j = await res.json().catch(() => null); if (j && typeof j === "object") fetched = { record: j }; }
  } catch { /* unreachable → fail-open (gate warns, never blocks) */ }
  const t = await bounded(call("tip"));
  return nfinalizeApproveGate(fetched, me, t == null ? null : Number(t));
}
// same fetch, lighter verdict: nrenew/nset existence + ownership (Plans/68 B2)
async function checkNameAct(kind: "nrenew" | "nset", name: string, tradeApi: string, me: string): Promise<{ block: boolean; note: string | null }> {
  let fetched: NameFetchResult = { failed: true };
  try {
    const res = await fetch(`${String(tradeApi || "").replace(/\/$/, "")}/cairnx/name/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
    if (res.status === 404) fetched = { record: null };
    else if (res.ok) { const j = await res.json().catch(() => null); if (j && typeof j === "object") fetched = { record: j }; }
  } catch { /* unreachable → fail-open (gate warns, never blocks) */ }
  return nameActApproveGate(kind, fetched, me);
}
// The gate's note is written INTO $("req"), so the innerHTML rebuild in render() destroys it exactly like
// #send-warn. One emitter, used by both the settle path and the repaint re-attach.
function paintNfinNote(g: { block: boolean; note: string | null }) {
  if (!g.note) return;
  $("req").insertAdjacentHTML("beforeend",
    g.block ? `<div class="req"><b class="err">⚠ ${escapeHtml(g.note)}</b></div>`
            : `<div class="req dim">⚠ ${escapeHtml(g.note)}</div>`);
}
function armNfinalizeGate(r: any, st: any) {
  if (nfinForId === r.id) {
    // W8 (AW-4, the fifth latch): SAME request, repainted — the unlock-after-idle-auto-lock rebuild just
    // destroyed this gate's note, and that note is a FEE-BURN warning. Re-attach the ALREADY-SETTLED
    // verdict and return. This latch is deliberately NOT in W1's reset line: clearing it would RE-ARM,
    // i.e. re-run the ≤6s name fetch on every repaint AND reset nfinBlocked to false with a fresh
    // in-flight verdict, so armButtons' 700ms timer would RE-ENABLE Approve on a request this gate had
    // already BLOCKED, until the new verdict landed. Re-attaching makes no network call and touches no
    // latch, so a blocked request stays blocked (armButtons still reads the unchanged nfinBlocked).
    // NOT handled here, stated plainly rather than left implied: a verdict that settles WHILE the wallet
    // is locked is still dropped by the renderedId guard below (renderedId is null while locked), so
    // there is nothing to re-attach and nfinBlocked stays false. resolve() still awaits nfinGate and
    // refuses a blocking verdict at the click, which is the fund-safety belt in that corner.
    if (nfinSettled) paintNfinNote(nfinSettled);
    return;
  }
  nfinForId = r.id;
  nfinBlocked = false; nfinGate = null; nfinSettled = null;
  const p = r.params || {};
  if (r.method !== "propose" || String(p.domain) !== CAIRNX_DOMAIN) return;
  const rec = decodeCairnxRecord(p.uri, p.payloadHash);
  if (!rec || typeof rec.name !== "string") return;
  // Plans/68 B2: the gate now also covers nrenew and nset (set-primary / re-point) — both ride a fee
  // that burns on a resolver no-op. nfinalize keeps the full winner+window verdict; nrenew/nset get
  // the lighter existence/ownership verdict (nameActApproveGate). Same fail-open transport posture.
  if (rec.t !== "nfinalize" && rec.t !== "nrenew" && rec.t !== "nset") return;
  // signer captured at arm time = the account this request is DISPLAYED as signing with (M5 pairing:
  // the background refuses the resolve anyway if the active account changed since render)
  nfinGate = rec.t === "nfinalize"
    ? checkNfinalize(rec.name, String(st.tradeApi || ""), String(st.addr || ""))
    : checkNameAct(rec.t, rec.name, String(st.tradeApi || ""), String(st.addr || ""));
  nfinGate.then((g) => {
    if (renderedId !== r.id) return;                 // superseded — never paint over a different request
    nfinSettled = g;                                 // W8: retained for a later repaint. Recorded AFTER the guard on purpose: a superseded verdict must not be re-attached to the request now on screen (the AW-3 class).
    if (g.block) { nfinBlocked = true; ($("btn-approve") as HTMLButtonElement).disabled = true; }
    paintNfinNote(g);
  });
}

// M3 (token-fill simulation): for a TOKEN-priced fill (confidence===1e6 on fillOffer/attest), show the token
// DEBIT the offer service quotes (ask + the FEE_BPS_V16 protocol fee), fetched from the resolver — closing
// the "not visible here" gap in the clear-sign. The number is resolver-served and unverifiable here, so the
// copy ATTRIBUTES it to the offer service (clearsign.tokenQuoteHtml) instead of asserting a first-person
// debit (B5g re-framing; a second price source was DECLINED, Plan 71 section 8 decline 6). Fail-CLOSED: if
// it can't be computed, ESCALATE to a "do NOT approve unless verified" caution rather than leave the amount
// quietly unknown. Once per request (render doesn't rebuild each tick).
let tokenSimForId: string | null = null;
async function fillTokenSim(r: any) {
  const conf = Number((r.params || {}).confidence ?? 100) >>> 0;
  if ((r.method !== "fillOffer" && r.method !== "attest") || conf !== CONF_TOKEN_FILL || tokenSimForId === r.id) return; tokenSimForId = r.id;
  const el = document.getElementById("token-sim");
  if (!el) return;
  const show = (html: string) => { el.innerHTML = html; (el as HTMLElement).hidden = false; };
  try {
    const q = await call("tokenFillQuote", (r.params || {}).proposalId);
    // W2 (AW-3), the same rule applied uniformly: any async filler that writes into the DOM after an
    // await carries the guard. This one is defense in depth rather than a live hole (`el` is resolved
    // BEFORE the await, so a superseded write lands on the detached old node, not on the request now on
    // screen); keeping the shape identical across all fillers is what stops the next one from drifting.
    if (renderedId !== r.id) return;
    show(tokenQuoteHtml(q));
  } catch {
    show(tokenQuoteHtml(null)); // bridge threw → same loud "could not compute" caution
  }
}

// M14 (B5h): a revealClaim approval must show WHICH secret goes public. The claim text + domain live in
// the wallet's own sealedClaims store (READ_ONLY_METHODS; vault-decrypted locally — no network read).
// Pure rendering in clearsign.revealPreviewHtml; a missing or undecryptable record shows a LOUD caution
// instead of silently narrowing the review to a txid. Once per request (render doesn't rebuild each tick).
let revealForId: string | null = null;
async function fillRevealPreview(r: any) {
  if (r.method !== "revealClaim" || revealForId === r.id) return; revealForId = r.id;
  const el = document.getElementById("reveal-preview");
  if (!el) return;
  let html: string;
  try {
    const list = await call("sealedClaims");
    const txid = String(r.params || "");
    html = revealPreviewHtml((Array.isArray(list) ? list : []).find((x: any) => x && String(x.txid) === txid) ?? null);
  } catch {
    html = revealPreviewHtml({ failed: true }); // lookup failed ≠ "no such claim" — distinct honest caution
  }
  if (renderedId !== r.id) return; // superseded — never paint over a different request
  el.innerHTML = html;
  (el as HTMLElement).hidden = false;
}

// Fetch the signer's balance once per request and show the projected balance-after so
// the user sees the real impact of approving (render no longer rebuilds each tick, so
// this value persists once filled).
let balForId: string | null = null;
async function fillBalance(r: any) {
  if (balForId === r.id) return; balForId = r.id;
  try {
    const b = await call("balance");
    if (renderedId !== r.id) return; // W2 (AW-3): superseded, never paint a resolved request's money row over the one now on screen
    const el = document.getElementById("cost");
    if (el) el.textContent = `${costLine(r)}  balance: ${fmtBalance(b.confirmed)} → ~${fmtBalance(b.confirmed - debitOf(r))} CSD`;
  } catch { /* offline — leave the static cost line */ }
}
// For a send, warn on a never-seen-before recipient and hard-flag an address-poisoning
// lookalike — checked against this account's send history + own addresses. The recipient
// is dApp-supplied, so this defense MUST live in the approval window (not just the manual
// send form). Runs once per request; the warning persists (render doesn't rebuild).
let warnForId: string | null = null;
async function fillSendWarning(r: any) {
  // send / fillOffer / propose-with-outputs all move funds to dApp-chosen recipients → same
  // first-time / look-alike (address-poisoning) defenses. (propose outputs could be a disguised
  // payout, so they get the warning too — they're shown neutrally as "transfers OUT" in clearsign.)
  if ((r.method !== "send" && r.method !== "fillOffer" && r.method !== "propose") || warnForId === r.id) return; warnForId = r.id;
  const p = r.params || {};
  const outs = Array.isArray(p.outputs) ? p.outputs.slice() : (p.to ? [{ to: p.to }] : []);
  // A dApp-proposed CairnX token transfer carries its recipient in the decoded record's `to` (NOT a CSD
  // output), so the first-time / address-poisoning check would otherwise skip it (audit POPUP-1). Decode
  // the canonical+hash-committed record and include the token recipient in the same check.
  if (r.method === "propose" && String(p.domain) === CAIRNX_DOMAIN) {
    const rec = decodeCairnxRecord(p.uri, p.payloadHash);
    if (rec && rec.t === "transfer" && typeof rec.to === "string") outs.push({ to: rec.to });
    // NSET-POISON-1: an nset re-points where a name RESOLVES (so future sends to it land there), and an
    // nxfer hands the name to a new owner — both carry an attacker-influenceable address that deserves the
    // same first-time / address-poisoning (look-alike) check as a transfer recipient.
    if (rec && rec.t === "nset" && typeof rec.addr === "string" && !isZeroAddr(rec.addr)) outs.push({ to: rec.addr });   // QA #24: a V23 un-point (nset→0x0) is a sentinel, not a recipient — skip the poisoning check (0x0 sends are hard-blocked anyway)
    if (rec && rec.t === "nxfer" && typeof rec.to === "string") outs.push({ to: rec.to });
    // M1 (deep-review 2026-07-03): an `offer` routes its SALE PROCEEDS to want.payto when it fills. A
    // bad-faith dApp can set payto to a look-alike of the user's OWN address, silently redirecting the
    // proceeds. The field is shown at clear-sign but had no automated look-alike flag — add it here so it
    // gets the same first-time / address-poisoning check as every other dApp-supplied recipient.
    if (rec && rec.t === "offer" && rec.want && typeof (rec.want as any).payto === "string") outs.push({ to: (rec.want as any).payto });
  }
  try {
    const [h, st] = await Promise.all([call("history"), call("status")]);
    if (renderedId !== r.id) return; // W2 (AW-3): superseded, never paint a resolved request's warnings over the one now on screen
    const sentTo = paidRecipients(h); // single-sourced paid-recipient set (audit NSPV-POISON-FILTERS)
    // NXFER-POISON-DROP (Part B): the first-time / poisoning computation is the pure clearsign.sendWarnings
    // (approve.ts owns only the DOM read + mount). It keys the first-time check on `known` = paid recipients
    // PLUS the wallet's OWN account addresses, so an nset pre-filled with the user's own address (the "set as
    // primary" prompt right after registration) no longer warns about the user's own address on a no-CSD op.
    const warns = sendWarnings(outs.map((o: any) => String(o.to || "")), sentTo, (st.accounts || []).map((a: any) => String(a.addr)));
    const el = document.getElementById("send-warn");
    if (el && warns.length) { el.innerHTML = warns.join("<br>"); (el as HTMLElement).hidden = false; }
  } catch { /* no history → no warning */ }
}
// Anti-click-through: when the request view (re)builds for a NEW request, disable both
// buttons for a beat so a click already in motion (or a reflexive double-click after a
// prior "approved") cannot resolve a request the user hasn't actually looked at. Defeats
// the approval-swap hijack where a second request is queued behind the one on screen.
function disableButtons() {
  ($("btn-approve") as HTMLButtonElement).disabled = true;
  ($("btn-reject") as HTMLButtonElement).disabled = true;
}
function armButtons() {
  disableButtons();  // AW-1: same immediate disable; the 700ms RE-ENABLE timer stays here, after the paint
  // Approve stays disabled when the nfinalize gate already blocked this request (a verdict landing
  // AFTER this timer disables it directly in armNfinalizeGate).
  setTimeout(() => { ($("btn-approve") as HTMLButtonElement).disabled = nfinBlocked; ($("btn-reject") as HTMLButtonElement).disabled = false; }, 700);
}
async function resolve(approve: boolean) {
  if (!current) return;
  const id = current.id;
  const signer = renderedSigner; // M5: the account this request was DISPLAYED as signing with
  // An nfinalize approval first awaits the finalize-window verdict (bounded: ≤6s fetch + 2.5s tip).
  // A blocking verdict REFUSES without consuming the request (Reject stays available); a warn-only
  // verdict proceeds (fail-open). Reject never waits.
  if (approve && nfinGate && nfinForId === id) {
    const g = await nfinGate.catch(() => null);
    if (!current || current.id !== id) return;   // superseded while awaiting the verdict
    if (g?.block) { msg(g.note || "refusing to approve this finalize", "err"); return; }
  }
  // Force the NEXT request (if any) to fully re-render + re-arm before it can be resolved.
  current = null; renderedId = null; renderedSigner = null;
  if (!approve) { try { await call("resolve", id, false, signer); } catch { /* no-op */ } msg("rejected"); render(); return; }
  msg("approving…");
  // POPUP-OUTCOME-1: show the TRUE result of the signed action (sent/failed), not a blanket "approved".
  // background refuses if the active account changed since render; a failed broadcast/guard returns ok:false.
  let r: any; try { r = await call("resolve", id, true, signer); } catch (e: any) { r = { ok: false, error: e?.message }; }
  if (r && r.ok === false) msg("failed: " + (r.error || "?"), "err");
  else if (r && r.txid) msg("sent " + String(r.txid).slice(0, 10) + "…", "ok");
  else msg("approved", "ok");
  render();
}

$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", ($("unlock-pw") as HTMLInputElement).value); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-approve").addEventListener("click", () => { if (!($("btn-approve") as HTMLButtonElement).disabled) resolve(true); });
$("btn-reject").addEventListener("click", () => { if (!($("btn-reject") as HTMLButtonElement).disabled) resolve(false); });
render();
setInterval(render, 1200);

export {};
