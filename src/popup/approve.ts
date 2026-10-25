// MetaMask-style approval window: opened by the background when a site calls
// window.cairn.*. Unlock if needed, review the request, approve/reject. Closes
// itself when the queue is empty. The pure "what am I signing?" formatters live in ./clearsign (unit-tested).
import { describe, debitOf, checkRow, escapeHtml, groupedAddr, paidRecipients, requestRecipients, recipientFlags, warningChecks, warningsCounted, rowFlagHtml, fmtBalance, moreBelowText, nfinalizeApproveGate, tokenQuoteHtml, revealPreviewHtml, fillViewHtml, balanceShortNote, cairnxTokenTickers, reservationUnconfirmedHtml, secondSourceNote, APPROVE_LABELS, UNCONFIRMED_LABELS } from "./clearsign.js";
import { nameActApproveGate, readNameRecord, NAME_READ_TIMEOUT_MS, type NameFetchResult } from "../core/namegate.js";
import { decodeCairnxRecord, CAIRNX_DOMAIN, CONF_TOKEN_FILL } from "../core/cairnx.js";
import type { CairnThemeApi } from "../vendor/cairn-ui/theme.js";
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
// What each request type asks for, under the requesting origin in the header.
function asks(r: any): string {
  if (r.method === "connect" || r.method === "getAddress" || r.method === "requestPermissions") return "asks to connect to your wallet";
  if (r.method === "signin" || r.method === "signinWithCsd") return "asks you to sign in";
  return "asks you to sign a transaction";
}

let current: any = null;
// 0.2.71 (CX-23): per-request review state, keyed by request id. `current` is a FRESH object on every
// 1.2 s poll (background "pending" maps new objects each call), so state stored on it was lost after one
// tick: in 0.2.70 the RT-W2 displayed quote therefore almost never reached the signer. Keep it here.
// `balShort`: the balance read showed the debit exceeds the spendable balance (a pending spend holds coins).
// `unconfirmed`: the worker returned RESERVATION_UNCONFIRMED for this request; the window shows the confirm step.
const reviewState = new Map<string, { tokenPreview?: "loading" | "ready" | "error"; tokenQuoteDisplayed?: any; balShort?: boolean; unconfirmed?: { fclaimTxid: string; fclaimHeight: number; tipHeight: number } }>();
const rs = (id: string) => { let v = reviewState.get(id); if (!v) { v = {}; reviewState.set(id, v); } return v; };
let renderedId: string | null = null; // only rebuild the request view when the request changes
let renderedSigner: string | null = null; // M5: the account address DISPLAYED for the current request ("signing as …")
// Bumped on every paint. The unlock repaint keeps the same request id, so renderedId alone cannot tell
// a superseded paint's in-flight quote or arm timer from the current paint's; those check this instead.
let paintGen = 0;
// The background drops a request from the queue before its outcome is known, so an empty queue alone
// does not mean the window is done: it stays open while a result is in flight, and after a failure or a
// sent fill's second-source notice until the user closes it or a new request is painted.
let inFlight = 0;
let holdOutcome = false;
// Bumped by resolve() when it sends and when its outcome lands: a render whose status/pending reads started before
// that is stale (its queue snapshot predates the outcome) and paints nothing.
let renderSeq = 0;
// The request id whose current paint is the warning state; only a click on that paint sends the acknowledgement.
let warnedFor: string | null = null;
async function render() {
  const seq = renderSeq;
  const st = await call("status");
  if (seq !== renderSeq) return;
  ($("view-locked") as HTMLElement).hidden = st.unlocked;
  ($("ap-signer") as HTMLElement).hidden = !st.unlocked;   // the account can change while locked; the unlock repaint writes it
  const pend = await call("pending");
  if (seq !== renderSeq) return;
  if (!pend.length) {
    if (inFlight || holdOutcome) { ($("view-req") as HTMLElement).hidden = true; return; }
    window.close(); return;
  }
  current = pend[0];
  // The requesting origin, in full however long (a look-alike keeps its tail), set from the browser's sender origin.
  $("ap-origin").textContent = String(current.origin);
  $("ap-ask").textContent = asks(current);
  void refreshNfinalize(current.id);   // runs while locked too, so the unlock repaint shows a current verdict
  const reqView = $("view-req") as HTMLElement;
  reqView.hidden = !st.unlocked;
  if (!st.unlocked) { renderedId = null; return; }
  // Rebuild only on a NEW request (or first unlock). Re-rendering every ~1.2s tick would
  // wipe the async-filled balance-after AND the security warning; so we don't.
  if (renderedId === current.id) return;
  renderedId = current.id;
  paintGen++;
  // AW-1: disable BOTH buttons the instant a NEW request is detected, BEFORE the pre-paint RPC await, so a
  // click landing during that await cannot resolve the new request against the still-visible OLD paint. Split
  // from armButtons deliberately: hoisting armButtons ENTIRE would start its 700ms re-enable timer DURING the
  // ~2.5s await, re-enabling the buttons well before the new request paints (relocating the very window this
  // closes). The re-enable timer still fires only from the armButtons call AFTER the paint below.
  disableButtons();
  // CX-35: decimals for the token amounts this record clear-signs, fetched in parallel with the reads below.
  // Bounded and display only; a miss paints base units alone.
  const p0 = current.params || {};
  const tickers = current.method === "propose" && String(p0.domain) === CAIRNX_DOMAIN ? cairnxTokenTickers(p0.uri, p0.payloadHash) : [];
  const metaP = tickers.length ? bounded(call("tokenDisplayMeta", tickers)) : null;
  // A propose carries a dApp-supplied expiresEpoch; fetch the current epoch (node tip / 30) ONCE so
  // the clear-signer can show the real remaining window from now + warn on a too-long horizon. Done
  // before building the request HTML (not per ~1.2s tick; this block runs once per new request).
  // Best-effort: offline leaves currentEpoch undefined → the raw signed epoch is still shown.
  if (current.method === "propose" && (current.params || {}).expiresEpoch !== undefined) {
    // These and the token display read above are the only network awaits before the request paints. Bound (module-level `bounded`) and
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
  if (metaP) { const m = await metaP; current.tokenMeta = m && typeof m === "object" ? m : {}; }
  if (seq !== renderSeq) { renderedId = null; return; }   // superseded during the pre-paint reads: the next render paints
  const acct = (st.accounts || [])[st.active || 0];
  renderedSigner = String(st.addr || ""); // M5: bind the resolve to the account the user is about to SEE
  const queued = pend.length > 1 ? `<div class="req dim">Request 1 of ${pend.length}: review each separately.</div>` : "";
  // For a connection request, tell the user exactly what approving grants: address
  // visibility until they disconnect the site; NOT permission to move funds (every
  // send/propose/attest still asks separately).
  const connectNote = (current.method === "connect" || current.method === "getAddress")
    ? `<div class="req dim">Approving lets this site see your address until you disconnect it (Settings › Connected sites). It can’t move funds or sign anything without asking you each time.</div>`
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
    balForId = warnForId = tokenSimForId = revealForId = fillViewForId = null;
    rs(current.id).balShort = false;   // re-derived by the fillBalance below, which this rebuild re-runs
    $("ap-signer").innerHTML = `<span>Signing as</span>${acct ? `<b>${escapeHtml(acct.label)}</b>` : ""}<code class="addr">${groupedAddr(String(st.addr || ""))}</code>`;
    $("req").innerHTML = `${queued}<div class="req">${describe(current)}</div>${connectNote}`;
    paintUnconfirmed(current.id);
    // Every paint starts at the top: a scroll kept from the previous request (or from this one before the confirm
    // step) would hide this paint's amount, fee, warnings and confirm warning above the view, which #ap-more,
    // reporting only what is below, would not mention.
    $("req").scrollTop = 0;
    msg(""); // clear any stale "approved"/"rejected" from a previous request
    holdOutcome = false;
    warnPainted = fillSendWarning(current);
    tokenPainted = fillTokenSim(current);   // 0.2.71: Approve waits for the token preview of THIS request
    armButtons();         // briefly disable Approve/Reject so a stale click can't land on a freshly-swapped request
    fillBalance(current);
    fillRevealPreview(current); // M14: which secret a revealClaim makes public (local sealedClaims read)
    fillFillView(current);      // a CSD-paid fill: the listing and the asset it gives (display only)
    armNfinalizeGate(current, st);
  } catch (e) {
    renderedId = null;   // AW-1: a describe()/paint throw must NOT latch renderedId, or `if (renderedId === current.id) return` (above) leaves the request permanently unpaintable AND (disableButtons ran, armButtons did not) unapprovable/unrejectable. Reset so the next tick retries.
    throw e;
  }
}

// The reservation confirm step: after RESERVATION_UNCONFIRMED the request is painted again with the warning, and
// Approve/Reject become "Sign anyway"/"Cancel". The warning goes first, above the fold. Part of the rebuild, so an unlock repaint keeps it.
function paintUnconfirmed(id: string) {
  const u = rs(id).unconfirmed;
  warnedFor = u ? id : null;
  const labels = u ? UNCONFIRMED_LABELS : APPROVE_LABELS;
  $("btn-approve").textContent = labels.approve;
  $("btn-reject").textContent = labels.reject;
  // In the confirm step the safe choice (Cancel) carries the filled `primary` style; the order is unchanged.
  $("btn-approve").className = u ? "" : "primary";
  $("btn-reject").className = u ? "primary" : "";
  if (u) $("req").insertAdjacentHTML("afterbegin", reservationUnconfirmedHtml(u));
}

// ── nfinalize finalize-window gate (Plan 63 carry-over, shipped with 0.2.54) ──────────────────
// Before an nfinalize can be APPROVED, re-check on the name service that the reservation is still
// the signer's live pending one and inside its finalize window; an expired/displaced finalize burns
// the fee (the C1 class; the pure verdict is clearsign.nfinalizeApproveGate). A clean 404 is a
// definitive "no reservation" → refuse; 5xx/timeout fails OPEN (warn card, Approve stays live) so
// approval never gains a hard network dependency. resolve() AWAITS the (bounded) verdict, so a click
// racing the fetch cannot slip past a blocking verdict. Armed once per request; an nfinalize verdict is
// then kept current by refreshNfinalize (poll) and nfinAtClick (click), because its window moves with the tip.
let nfinForId: string | null = null;
let nfinBlocked = false;   // read by armButtons' re-enable
let nfinGate: Promise<{ block: boolean; note: string | null }> | null = null;
// The latest verdict for nfinForId. Kept per request id, never per paint: a verdict that settles while the
// wallet is locked must still reach the unlock repaint (note and button state).
let nfinSettled: { block: boolean; note: string | null } | null = null;
// nfinalize only: the inputs of the last verdict, so the poll and the click can re-derive it at a newer tip.
// The finalize window is a function of the tip, so a verdict computed once goes wrong while the request
// stays open (too late: Approve would burn the fee; too early: the user is stuck until a reopen).
// `tip`/`at`/`seq`: the tip of the latest verdict, when its read started (its age) and that read's start order, so
// a read that started earlier never replaces a verdict from one that started later (a clock tick is too coarse).
// `recTip`: a tip read no later than `fetched` (null after the first check, which reads the record before the tip),
// so the reservation is refetched whenever the tip may have moved since, whoever read the newer tip. `tried`: the last refresh attempt, so an RPC that is down is retried at the refresh cadence
// instead of on every poll tick.
type NfinLive = { id: string; name: string; tradeApi: string; me: string; fetched: NameFetchResult; recTip: number | null; tip: number | null; at: number; seq: number; tried: number; busy: boolean };
let nfinLive: NfinLive | null = null;
let nfinReadSeq = 0;
// Re-read the tip this often while an nfinalize request is open (driven by the 1.2 s poll, also while
// locked). Blocks average 120 s and finalizeWinnerCheck keeps a 2-block margin before the window closes,
// so on average a verdict is a fraction of a block behind the chain.
const NFIN_REFRESH_MS = 20_000;
// A click on a verdict older than this re-reads the tip first (one bounded read). In a focused window the
// verdict is at most about 30 s old (a refresh starts within one 1.2 s tick of the 20 s period and lands after
// at most a 2.5 s tip read and a 6 s name fetch), so the bound sits above that and an honest click never pays
// the read; it fires when the poll was throttled or suspended (background tab, sleep), when the verdict can be
// blocks stale.
const NFIN_CLICK_MAX_AGE_MS = 35_000;
function fetchNameRecord(name: string, tradeApi: string): Promise<NameFetchResult> {
  const base = String(tradeApi || "").replace(/\/$/, "");
  return readNameRecord((path) => fetch(base + path, { signal: AbortSignal.timeout(NAME_READ_TIMEOUT_MS) }), name);
}
async function readTip(): Promise<number | null> {
  const t = await bounded(call("tip"));
  return t == null ? null : Number(t);
}
async function checkNfinalize(live: NfinLive): Promise<{ block: boolean; note: string | null }> {
  live.fetched = await fetchNameRecord(live.name, live.tradeApi);
  live.at = live.tried = Date.now();
  live.seq = ++nfinReadSeq;
  live.tip = await readTip();
  live.recTip = null;
  live.busy = false;
  return nfinalizeApproveGate(live.fetched, live.me, live.tip);
}
// same fetch, lighter verdict: nrenew/nset existence + ownership (Plans/68 B2)
async function checkNameAct(kind: "nrenew" | "nset", name: string, tradeApi: string, me: string): Promise<{ block: boolean; note: string | null }> {
  return nameActApproveGate(kind, await fetchNameRecord(name, tradeApi), me);
}
// The gate's note is written INTO $("req"), so the innerHTML rebuild in render() destroys it exactly like
// #send-warn. One emitter, used by the settle path, the refresh and the repaint re-attach; it replaces the
// previous note so a changed verdict never leaves the old one on screen.
function paintNfinNote(g: { block: boolean; note: string | null }) {
  document.getElementById("nfin-note")?.remove();
  if (!g.note) return;
  // after the cost rows and the warnings under them, before the record's own rows (test/approve-layout-chrome.test.mjs)
  const html = `<div class="req" id="nfin-note">${checkRow({ tier: g.block ? "danger" : "caution", html: escapeHtml(g.note) })}</div>`;
  const after = document.getElementById("send-warn") ?? document.getElementById("cost");
  if (after) after.insertAdjacentHTML("afterend", html); else $("req").insertAdjacentHTML("beforeend", html);
}
// Record a verdict for request `id` and, when that request is on screen, show it: note in place, Approve
// down on a block, back up on a pass once this paint's own re-enable floor has run.
function applyNfin(id: string, g: { block: boolean; note: string | null }) {
  if (nfinForId !== id) return;                      // a different request was armed since: never paint over it (the AW-3 class)
  nfinSettled = g;
  nfinBlocked = g.block;
  if (renderedId !== id) return;                     // locked or mid-repaint: the repaint re-attaches nfinSettled
  paintNfinNote(g);
  const btn = $("btn-approve") as HTMLButtonElement;
  // render() sets renderedId only to current.id (or null), so here current is the request `id`.
  if (g.block) btn.disabled = true;
  else if (approveArmedGen === paintGen) btn.disabled = tokenNotReady(current) || !!rs(id).balShort;
}
// Called on every poll tick for the request at the head of the queue. Reads the tip at most once per
// NFIN_REFRESH_MS and refetches the reservation only when the tip moved (resolver state changes per block).
// It computes a verdict and nothing else: no signing, no broadcast.
async function refreshNfinalize(id: string) {
  const live = nfinLive;
  if (!live || live.id !== id || nfinForId !== id || live.busy || Date.now() - live.tried < NFIN_REFRESH_MS) return;
  live.busy = true; live.tried = Date.now();
  try {
    const at = Date.now(), seq = ++nfinReadSeq;
    const t = await readTip();
    if (t == null) return;                           // keep the last verdict; its age makes the click re-check
    let fetched = live.fetched, recTip = live.recTip;
    if (t !== recTip || fetched.failed) {
      const f = await fetchNameRecord(live.name, live.tradeApi);
      // A transient miss keeps the last good record (and its tip, so the next refresh retries the fetch), so a
      // name-service outage cannot turn a refusal into the fail-open warning while the tip has moved past the window.
      if (!f.failed || fetched.failed) fetched = f;
      if (!f.failed) recTip = t;
    }
    if (nfinLive !== live || live.seq > seq) return; // superseded, or a click re-check started a read after this one
    live.fetched = fetched; live.recTip = recTip; live.tip = t; live.at = at; live.seq = seq;
    applyNfin(id, nfinalizeApproveGate(fetched, live.me, t));
  } finally { live.busy = false; }
}
// Click-time re-check: a verdict older than NFIN_CLICK_MAX_AGE_MS is re-derived from a fresh tip and the
// last fetched record (no name fetch, so at most one bounded tip read). An unreadable tip keeps the last
// verdict, so a dead RPC adds no refusal here. The click acts on the latest verdict recorded for the request
// once its read is back: a refresh that landed a newer one meanwhile (a block now on screen) wins over both
// `g` and this read when this read started earlier.
async function nfinAtClick(id: string, g: { block: boolean; note: string | null } | null) {
  const live = nfinLive;
  if (!live || live.id !== id || Date.now() - live.at <= NFIN_CLICK_MAX_AGE_MS) return g;
  const at = Date.now(), seq = ++nfinReadSeq;
  const t = await readTip();
  if (t != null && nfinLive === live && seq > live.seq) {
    live.tip = t; live.at = at; live.seq = seq;
    applyNfin(id, nfinalizeApproveGate(live.fetched, live.me, t));
  }
  return nfinForId === id && nfinSettled ? nfinSettled : g;
}
function armNfinalizeGate(r: any, st: any) {
  if (nfinForId === r.id) {
    // W8 (AW-4, the fifth latch): SAME request, repainted. The unlock-after-idle-auto-lock rebuild just
    // destroyed this gate's note, and that note is a FEE-BURN warning. Re-attach the latest verdict
    // (including one that settled while locked) and return. Re-arming instead would re-run the name
    // fetch on every repaint and reset nfinBlocked, so armButtons' 700ms timer would re-enable Approve on
    // a blocked request until the new verdict landed. armButtons reads the unchanged nfinBlocked.
    if (nfinSettled) paintNfinNote(nfinSettled);
    return;
  }
  nfinForId = r.id;
  nfinBlocked = false; nfinGate = null; nfinSettled = null; nfinLive = null;
  const p = r.params || {};
  if (r.method !== "propose" || String(p.domain) !== CAIRNX_DOMAIN) return;
  const rec = decodeCairnxRecord(p.uri, p.payloadHash);
  if (!rec || typeof rec.name !== "string") return;
  // Plans/68 B2: the gate now also covers nrenew and nset (set-primary / re-point); both ride a fee
  // that burns on a resolver no-op. nfinalize keeps the full winner+window verdict; nrenew/nset get
  // the lighter existence/ownership verdict (nameActApproveGate). Same fail-open transport posture.
  if (rec.t !== "nfinalize" && rec.t !== "nrenew" && rec.t !== "nset") return;
  // signer captured at arm time = the account this request is DISPLAYED as signing with (M5 pairing:
  // the background refuses the resolve anyway if the active account changed since render)
  if (rec.t === "nfinalize") {
    nfinLive = { id: r.id, name: rec.name, tradeApi: String(st.tradeApi || ""), me: String(st.addr || ""), fetched: { failed: true }, recTip: null, tip: null, at: Date.now(), seq: 0, tried: Date.now(), busy: true };
    nfinGate = checkNfinalize(nfinLive);
  } else {
    nfinGate = checkNameAct(rec.t, rec.name, String(st.tradeApi || ""), String(st.addr || ""));
  }
  nfinGate.then((g) => applyNfin(r.id, g));
}

// M3 (token-fill simulation): for a TOKEN-priced fill (confidence===1e6 on fillOffer/attest), show the token
// DEBIT the offer service quotes (ask + the FEE_BPS_V16 protocol fee), fetched from the resolver; closing
// the "not visible here" gap in the clear-sign. The number is resolver-served and unverifiable here, so the
// copy ATTRIBUTES it to the offer service (clearsign.tokenQuoteHtml) instead of asserting a first-person
// debit (B5g re-framing; a second price source was DECLINED, Plan 71 section 8 decline 6). Fail-CLOSED: if
// it can't be computed, ESCALATE to a "do NOT approve unless verified" caution rather than leave the amount
// quietly unknown. Once per request (render doesn't rebuild each tick).
let tokenSimForId: string | null = null;
// 0.2.71 (CX-15): a token-debiting fill is approvable only once its preview is `ready` for this very
// request. States: loading -> ready | error. A failed quote is retried a few times before `error`.
function isTokenFill(r: any): boolean {
  const conf = Number((r?.params || {}).confidence ?? 100) >>> 0;
  return !!r && (r.method === "fillOffer" || r.method === "attest") && conf === CONF_TOKEN_FILL;
}
function tokenNotReady(r: any): boolean { return isTokenFill(r) && rs(r.id).tokenPreview !== "ready"; }
async function fillTokenSim(r: any) {
  const conf = Number((r.params || {}).confidence ?? 100) >>> 0;
  if ((r.method !== "fillOffer" && r.method !== "attest") || conf !== CONF_TOKEN_FILL || tokenSimForId === r.id) return; tokenSimForId = r.id;
  rs(r.id).tokenPreview = "loading";
  const el = document.getElementById("token-sim");
  if (!el) return;
  // `el` is resolved before the await, so a superseded paint (including the same-id unlock repaint) would
  // write into the detached old node AND mark this request `ready` with a quote that is not on screen.
  const gen = paintGen;
  const live = () => gen === paintGen && renderedId === r.id;
  const show = (html: string) => { el.innerHTML = html; (el as HTMLElement).hidden = false; };
  try {
    const tipRead = cardTip();   // display only: the offer's remaining blocks on the card
    let q: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      q = await call("tokenFillQuote", (r.params || {}).proposalId).catch(() => null);
      if (q && q.ok) break;
      if (!live()) return;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    if (!live()) return;
    // RT-W2: remember the quote actually DISPLAYED so the approve click can thread it to the
    // preflight, which refuses unless it equals the chain-proven want (a resolver that quotes low
    // at review and honest at click used to debit the larger proven amount behind the low card).
    const shown = q && q.ok ? { ticker: q.ticker, amount: q.amount, fee: q.fee, total: q.total, giveTicker: q.giveTicker, giveAmount: q.giveAmount, giveName: q.giveName } : undefined;
    rs(r.id).tokenQuoteDisplayed = shown;
    rs(r.id).tokenPreview = shown ? "ready" : "error";
    const tip = await tipRead;
    if (!live()) return;
    show(tokenQuoteHtml(q, tip));
  } catch {
    rs(r.id).tokenPreview = "error";
    show(tokenQuoteHtml(null)); // bridge threw → same loud "could not compute" caution
  }
}

// M14 (B5h): a revealClaim approval must show WHICH secret goes public. The claim text + domain live in
// the wallet's own sealedClaims store (READ_ONLY_METHODS; vault-decrypted locally; no network read).
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
    html = revealPreviewHtml({ failed: true }); // lookup failed ≠ "no such claim"; distinct honest caution
  }
  if (renderedId !== r.id) return; // superseded; never paint over a different request
  el.innerHTML = html;
  (el as HTMLElement).hidden = false;
}

// Fetch the signer's balance once per request and show the projected balance-after so
// the user sees the real impact of approving (render no longer rebuilds each tick, so
// this value persists once filled).
let balForId: string | null = null;
async function fillBalance(r: any) {
  if (balForId === r.id) return; balForId = r.id;
  const gen = paintGen;   // a same-id repaint's read owns #cost and balShort; this one must not override it
  try {
    const b = await call("balance");
    if (gen !== paintGen || renderedId !== r.id) return;
    const el = document.getElementById("bal-after");
    if (el) { el.textContent = `${fmtBalance(b.confirmed)} → ~${fmtBalance(b.confirmed - debitOf(r))} CSD`; el.className = ""; }
    // The engine spends only the coins this balance counts, so a negative balance-after can only end in an
    // INSUFFICIENT refusal: keep Approve down and say why. Reject stays available.
    rs(r.id).balShort = Number(b.confirmed) - debitOf(r) < 0;
    if (rs(r.id).balShort) {
      ($("btn-approve") as HTMLButtonElement).disabled = true;
      // under the cost rows it explains, above the buttons (test/approve-layout-chrome.test.mjs)
      const short = `<div class="checks">${checkRow({ tier: "danger", html: escapeHtml(balanceShortNote("Reject this")) })}</div>`;
      const cost = document.getElementById("cost");
      if (cost) cost.insertAdjacentHTML("afterend", short); else $("req").insertAdjacentHTML("beforeend", short);
    }
  } catch {
    // offline: the cost rows stay, and the balance after says it could not be read
    if (gen !== paintGen || renderedId !== r.id) return;
    const el = document.getElementById("bal-after");
    if (el) el.textContent = "unavailable";
  }
}
// The tip a fill card measures the offer's expiry against: the node tip clamped up by the PoW-backed floor, as the
// preflight clamps it; undefined when neither read answers (the card then shows the expiry block alone).
async function cardTip(): Promise<number | undefined> {
  const [t, f] = await Promise.all([bounded(call("tip")), bounded(call("tipFloor"))]);
  const at = Math.max(Number(t) || 0, Number(f) || 0);
  return at > 0 ? at : undefined;
}
let fillViewForId: string | null = null;
async function fillFillView(r: any) {
  if (r.method !== "fillOffer" || fillViewForId === r.id) return; fillViewForId = r.id;
  const el = document.getElementById("fill-view");
  if (!el) return;   // token-priced fills carry #token-sim instead
  const id = String((r.params || {}).proposalId || "");
  const [view, tip] = await Promise.all([bounded(call("fillOfferView", id)), cardTip()]);
  if (renderedId !== r.id) return;
  el.innerHTML = fillViewHtml(view as any, id, tip);
  (el as HTMLElement).hidden = false;
}
// For a send, warn on a never-seen-before recipient and hard-flag an address-poisoning
// lookalike; checked against this account's send history + own addresses. The recipient
// is dApp-supplied, so this defense MUST live in the approval window (not just the manual
// send form). Runs once per request; the warning persists (render doesn't rebuild).
let warnForId: string | null = null;
async function fillSendWarning(r: any) {
  // send / fillOffer / propose-with-outputs all move funds to dApp-chosen recipients → same
  // first-time / look-alike (address-poisoning) defenses (clearsign.requestRecipients).
  if ((r.method !== "send" && r.method !== "fillOffer" && r.method !== "propose") || warnForId === r.id) return; warnForId = r.id;
  const outs = requestRecipients(r);
  try {
    const [h, st] = await Promise.all([call("history"), call("status")]);
    if (renderedId !== r.id) return; // W2 (AW-3): superseded, never paint a resolved request's warnings over the one now on screen
    const sentTo = paidRecipients(h); // single-sourced paid-recipient set (audit NSPV-POISON-FILTERS)
    // NXFER-POISON-DROP (Part B): the first-time / poisoning computation is the pure clearsign.recipientFlags
    // (approve.ts owns only the DOM read + mount). It keys the first-time check on `known` = paid recipients
    // PLUS the wallet's OWN account addresses, so an nset pre-filled with the user's own address (the "set as
    // primary" prompt right after registration) no longer warns about the user's own address on a no-CSD op.
    const flags = recipientFlags(outs, sentTo, (st.accounts || []).map((a: any) => String(a.addr)));
    const el = document.getElementById("send-warn");
    if (!el || !flags.length) return;
    // a look-alike is a danger row, a first send a caution row; past NAMED_WARNINGS the rows count and each flagged
    // recipient row carries its mark
    el.innerHTML = warningChecks(flags).map(checkRow).join(""); (el as HTMLElement).hidden = false;
    if (warningsCounted(flags)) {
      const rows = [...$("req").querySelectorAll<HTMLElement>(".kv > div[data-to]")];
      for (const f of flags) for (const row of rows) if (row.dataset.to === f.to.toLowerCase()) row.querySelector("dd")?.insertAdjacentHTML("beforeend", rowFlagHtml(f.tier));
    }
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
// 0.2.70: never re-enable before the send-warning paint. 700ms remains the floor (click-through);
// fillSendWarning settling is the ceiling so a slow history fetch cannot leave Approve live over
// an unpainted poisoning warning.
let warnPainted: Promise<unknown> = Promise.resolve();
let tokenPainted: Promise<unknown> = Promise.resolve();
let approveArmedGen = -1;   // the paintGen whose re-enable floor has run; a later verdict may re-enable Approve only then
function armButtons() {
  disableButtons();  // AW-1: same immediate disable; the 700ms RE-ENABLE timer stays here, after the paint
  // Approve stays disabled when the nfinalize gate already blocked this request (a verdict landing
  // after this timer sets the button itself, in applyNfin), and for a token-debiting fill until its
  // preview for THIS request is ready (0.2.71). Reject is always re-enabled.
  const armedId = current?.id;
  const armedGen = paintGen;   // a same-id repaint re-arms with its own floor and its own quote
  const minWait = new Promise((r) => setTimeout(r, 700));
  const base = Promise.all([minWait, Promise.resolve(warnPainted).catch(() => { /* the send warnings are advisory: a failed paint must not leave both buttons disabled */ })]);
  // Reject never waits for the token preview: a hanging quote must not lock the user out of rejecting.
  base.then(() => { if (current?.id === armedId) ($("btn-reject") as HTMLButtonElement).disabled = false; });
  Promise.all([base, Promise.resolve(tokenPainted).catch(() => { /* a failed preview is not "ready", so tokenNotReady keeps Approve disabled; Reject re-enables */ })]).then(() => {
    if (current?.id !== armedId || armedGen !== paintGen) return;   // superseded: the current paint arms itself
    approveArmedGen = armedGen;
    ($("btn-approve") as HTMLButtonElement).disabled = nfinBlocked || tokenNotReady(current) || !!rs(armedId!).balShort; ($("btn-reject") as HTMLButtonElement).disabled = false;
  });
}
async function resolve(approve: boolean) {
  if (!current) return;
  const id = current.id;
  const signer = renderedSigner; // M5: the account this request was DISPLAYED as signing with
  const displayedQuote = rs(id).tokenQuoteDisplayed; // RT-W2: the number the user actually saw (survives the 1.2 s re-poll)
  // 0.2.71: no approval of a token-debiting fill without a ready preview (the signer also refuses).
  if (approve && tokenNotReady(current)) { msg("The token amount is not shown yet. Wait for it or reject.", "err"); return; }
  if (approve && rs(id).balShort) { msg("Your spendable balance does not cover this request. Reject it and retry once your pending transaction is mined.", "err"); return; }
  // An nfinalize approval first awaits the finalize-window verdict (bounded: ≤6s fetch + 2.5s tip, plus one
  // 2.5s tip read when the verdict is older than NFIN_CLICK_MAX_AGE_MS), then acts on the latest one recorded.
  // A blocking verdict REFUSES without consuming the request (Reject stays available); a warn-only
  // verdict proceeds (fail-open). Reject never waits.
  if (approve && nfinGate && nfinForId === id) {
    const first = await nfinGate.catch(() => null);
    if (!current || current.id !== id) return;   // superseded while awaiting the verdict
    const g = await nfinAtClick(id, nfinSettled ?? first);   // the latest verdict, re-derived first when stale
    if (!current || current.id !== id) return;
    if (g?.block) { msg(g.note || "Refusing to sign this finalize.", "err"); return; }
  }
  // Only a click on the warning-state paint of this request acknowledges the unconfirmed reservation.
  const u = warnedFor === id ? rs(id).unconfirmed : undefined;
  // Force the NEXT request (if any) to fully re-render + re-arm before it can be resolved.
  current = null; renderedId = null; renderedSigner = null; warnedFor = null; renderSeq++;
  if (!approve) { try { await call("resolve", id, false, signer); } catch { /* no-op */ } msg("Rejected. Nothing was signed."); render(); return; }
  msg("Approving…");
  // POPUP-OUTCOME-1: show the TRUE result of the signed action (sent/failed), not a blanket "approved".
  // background refuses if the active account changed since render; a failed broadcast/guard returns ok:false.
  let r: any;
  inFlight++;
  const ack = u ? { requestId: id, fclaimTxid: u.fclaimTxid } : undefined;
  try { r = await call("resolve", id, true, signer, displayedQuote, ...(ack ? [ack] : [])); } catch (e: any) { r = { ok: false, error: e?.message }; }
  finally { inFlight--; }
  renderSeq++; renderedId = null;   // a poll that read the queue before this outcome must not paint; repaint and re-arm
  if (r && r.code === "RESERVATION_UNCONFIRMED" && r.unconfirmed && typeof r.unconfirmed.fclaimTxid === "string") {
    rs(id).unconfirmed = { fclaimTxid: String(r.unconfirmed.fclaimTxid), fclaimHeight: Number(r.unconfirmed.fclaimHeight), tipHeight: Number(r.unconfirmed.tipHeight) };
    msg("");
  } else if (r && r.ok === false) { msg("Failed: " + (r.error || "?") + (r.code ? ` (${r.code})` : ""), "err"); holdOutcome = true; }
  else if (r && r.txid) {
    msg("Sent " + String(r.txid).slice(0, 10) + "…", "ok");
    const note = secondSourceNote(r.secondSource);
    if (note) { $("msg").insertAdjacentHTML("beforeend", checkRow({ tier: "danger", html: escapeHtml(note) })); holdOutcome = true; }
  }
  else msg("Approved.", "ok");
  render();
}

// A site can make a request longer than the window (more recipients, a long origin). While the request body does not
// end in view, #ap-more says so, counting the recipient rows not fully shown. It reads geometry only: it never touches
// the buttons, and it is recomputed on a scroll, on any change to the request (the async rows) and on a resize.
const RECIPIENT_ROWS = new Set(["To", "Resolves to", "Paid to", "Only fillable by"]);
function updateMore() {
  const req = $("req");
  const open = !($("view-req") as HTMLElement).hidden && req.scrollTop + req.clientHeight < req.scrollHeight - 1;
  const fold = req.getBoundingClientRect().bottom;
  const hidden = open ? [...req.querySelectorAll(".kv > div")]
    .filter((row) => RECIPIENT_ROWS.has(row.querySelector("dt")?.textContent ?? "") && row.getBoundingClientRect().bottom > fold + 0.5).length : 0;
  const text = open ? moreBelowText(hidden) : "";
  if ($("ap-more").textContent !== text) $("ap-more").textContent = text;
}
$("req").addEventListener("scroll", updateMore);
new MutationObserver(updateMore).observe($("app"), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
new ResizeObserver(updateMore).observe($("req"));

$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", ($("unlock-pw") as HTMLInputElement).value); msg("Unlocked.", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-approve").addEventListener("click", () => { if (!($("btn-approve") as HTMLButtonElement).disabled) resolve(true); });
$("btn-reject").addEventListener("click", () => { if (!($("btn-reject") as HTMLButtonElement).disabled) resolve(false); });
// Follow a theme chosen in the popup's Settings while this window is open (theme.js, loaded by approve.html).
(globalThis as { CairnTheme?: CairnThemeApi }).CairnTheme?.startSync();
render();
setInterval(render, 1200);

export {};
