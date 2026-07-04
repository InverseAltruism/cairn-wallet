// MetaMask-style approval window: opened by the background when a site calls
// window.cairn.*. Unlock if needed, review the request, approve/reject. Closes
// itself when the queue is empty. The pure "what am I signing?" formatters live in ./clearsign (unit-tested).
import { describe, debitOf, lookalikeOf, costLine, escapeHtml, paidRecipients } from "./clearsign.js";
import { decodeCairnxRecord, CAIRNX_DOMAIN, TREASURY_ADDR } from "../core/cairnx.js";
const chrome: any = (globalThis as any).chrome;
const $ = (id: string) => document.getElementById(id)!;

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
  // A propose carries a dApp-supplied expiresEpoch; fetch the current epoch (node tip / 30) ONCE so
  // the clear-signer can show the real remaining window from now + warn on a too-long horizon. Done
  // before building the request HTML (not per ~1.2s tick — this block runs once per new request).
  // Best-effort: offline leaves currentEpoch undefined → the raw signed epoch is still shown.
  if (current.method === "propose" && (current.params || {}).expiresEpoch !== undefined) {
    // These are the ONLY network awaits before the request paints, and node.get() carries no timeout —
    // a hung (not refused) RPC would hold the approval UI hostage indefinitely. Bound them at 2.5s and
    // run them in PARALLEL: healthy RPC ≈ one round-trip before paint (was two, unbounded), and a miss
    // degrades exactly as before (raw signed epoch shown; fee-sufficiency hint skipped).
    const bounded = (p: Promise<unknown>): Promise<unknown> =>
      Promise.race([p.catch(() => null), new Promise((res) => setTimeout(() => res(null), 2500))]);
    const [e, t] = await Promise.all([bounded(call("epoch")), bounded(call("tip"))]);
    if (e != null) current.currentEpoch = e;
    if (t != null) current.currentTip = t;
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
  $("req").innerHTML = `<div class="req dim">signing as <b>${signer}</b></div>${queued}`
    + `<div class="req">${describe(current)}</div><div class="req dim">from ${escapeHtml(String(current.origin))}</div>`
    + connectNote
    + `<div class="req dim" id="cost">${costLine(current)}</div>`;
  msg(""); // clear any stale "approved"/"rejected" from a previous request
  armButtons();         // briefly disable Approve/Reject so a stale click can't land on a freshly-swapped request
  fillBalance(current);
  fillSendWarning(current);
  fillTokenSim(current);
}

// M3 (token-fill simulation): for a TOKEN-priced fill (confidence===1e6 on fillOffer/attest), show the actual
// token DEBIT the convention will take (ask + 1% fee), fetched from the resolver — closing the "not visible
// here" gap in the clear-sign. Fail-CLOSED: if it can't be computed, ESCALATE to a "do NOT approve unless
// verified" caution rather than leave the amount quietly unknown. Once per request (render doesn't rebuild each tick).
let tokenSimForId: string | null = null;
async function fillTokenSim(r: any) {
  const conf = Number((r.params || {}).confidence ?? 100) >>> 0;
  if ((r.method !== "fillOffer" && r.method !== "attest") || conf !== 1_000_000 || tokenSimForId === r.id) return; tokenSimForId = r.id;
  const el = document.getElementById("token-sim");
  if (!el) return;
  const show = (html: string) => { el.innerHTML = html; (el as HTMLElement).hidden = false; };
  try {
    const q = await call("tokenFillQuote", (r.params || {}).proposalId);
    if (q && q.ok) show(`<b>You will pay ${escapeHtml(String(q.total))} base units of ${escapeHtml(String(q.ticker))}</b> <span class="dim">(${escapeHtml(String(q.amount))} ask + ${escapeHtml(String(q.fee))} fee${q.estimated ? ", estimated" : ""})</span> — confirm this token + amount on the site/explorer.`);
    else show(`<b class="err">⚠ could not compute the token debit (${escapeHtml(String(q?.error || "offer unavailable"))}). Do NOT approve unless you have verified the exact token + amount on the site/explorer.</b>`);
  } catch {
    show(`<b class="err">⚠ could not compute the token debit. Do NOT approve unless you have verified the exact token + amount on the site/explorer.</b>`);
  }
}

// Fetch the signer's balance once per request and show the projected balance-after so
// the user sees the real impact of approving (render no longer rebuilds each tick, so
// this value persists once filled).
let balForId: string | null = null;
async function fillBalance(r: any) {
  if (balForId === r.id) return; balForId = r.id;
  try {
    const b = await call("balance");
    const after = (b.confirmed - debitOf(r)) / 1e8;
    const el = document.getElementById("cost");
    if (el) el.textContent = `${costLine(r)}  balance: ${(b.confirmed / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 })} → ~${after.toLocaleString(undefined, { maximumFractionDigits: 4 })} CSD`;
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
    if (rec && rec.t === "nset" && typeof rec.addr === "string" && !/^(0x)?0{40}$/i.test(rec.addr)) outs.push({ to: rec.addr });   // QA #24: a V23 un-point (nset→0x0) is a sentinel, not a recipient — skip the poisoning check (0x0 sends are hard-blocked anyway)
    if (rec && rec.t === "nxfer" && typeof rec.to === "string") outs.push({ to: rec.to });
    // M1 (deep-review 2026-07-03): an `offer` routes its SALE PROCEEDS to want.payto when it fills. A
    // bad-faith dApp can set payto to a look-alike of the user's OWN address, silently redirecting the
    // proceeds. The field is shown at clear-sign but had no automated look-alike flag — add it here so it
    // gets the same first-time / address-poisoning check as every other dApp-supplied recipient.
    if (rec && rec.t === "offer" && rec.want && typeof (rec.want as any).payto === "string") outs.push({ to: (rec.want as any).payto });
  }
  try {
    const [h, st] = await Promise.all([call("history"), call("status")]);
    const sentTo = paidRecipients(h); // single-sourced paid-recipient set (audit NSPV-POISON-FILTERS)
    const known = [...sentTo, ...((st.accounts || []).map((a: any) => a.addr))];
    const warns: string[] = [];
    for (const o of outs) {
      const to = String(o.to || "");
      // The protocol fee/rebate sink is a FIXED, known convention address (CONVENTION §10; v1.6 1.5%
      // treasury + maker rebate ride a fill as outputs to it / the maker) — not a user-chosen recipient,
      // so it must not raise a first-time / address-poisoning warning. Skip it.
      if (to.toLowerCase() === TREASURY_ADDR) continue;
      const tag = `<code>${escapeHtml(to.slice(0, 10))}…${escapeHtml(to.slice(-6))}</code>`;
      const la = lookalikeOf(to, known);
      if (la) warns.push(`⚠ <b>Possible address-poisoning:</b> ${tag} resembles <code>${escapeHtml(la.slice(0, 10))}…${escapeHtml(la.slice(-6))}</code> you've seen before but is NOT identical. Verify every character — payments are irreversible.`);
      else if (!sentTo.some((a) => a.toLowerCase() === to.toLowerCase())) warns.push(`⚠ First time sending to ${tag} — verify every character. Payments are irreversible.`);
    }
    const el = document.getElementById("send-warn");
    if (el && warns.length) { el.innerHTML = warns.join("<br>"); (el as HTMLElement).hidden = false; }
  } catch { /* no history → no warning */ }
}
// Anti-click-through: when the request view (re)builds for a NEW request, disable both
// buttons for a beat so a click already in motion (or a reflexive double-click after a
// prior "approved") cannot resolve a request the user hasn't actually looked at. Defeats
// the approval-swap hijack where a second request is queued behind the one on screen.
function armButtons() {
  const ap = $("btn-approve") as HTMLButtonElement, rj = $("btn-reject") as HTMLButtonElement;
  ap.disabled = true; rj.disabled = true;
  setTimeout(() => { ap.disabled = false; rj.disabled = false; }, 700);
}
async function resolve(approve: boolean) {
  if (!current) return;
  const id = current.id;
  const signer = renderedSigner; // M5: the account this request was DISPLAYED as signing with
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
