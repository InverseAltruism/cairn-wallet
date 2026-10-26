// The balance hero: the amount and its count-up, the identity avatar and the pending-merge line.
import { INCLUSION_NOTICE_BLOCKS } from "../core/inclusion.js";
import { escapeHtml, fmtBalance } from "./clearsign.js";
import { avatarBackground, avatarHtml, identitySeed } from "../vendor/cairn-ui/avatar.js";
import { flashChange, tokenEase, tokenMs } from "./motion.js";
import { call } from "./popup-bridge.js";
import { $ } from "./popup-dom.js";
import { renderHistory } from "./popup-history.js";
import { balanceState, knownNames } from "./popup-state.js";

// Send-success moment: the balance settles once (popup.css `.bal-hero.sent`), `delay` ms from now (once the closing sheet
// has cleared the hero); display only, reduced-motion aware.
export function celebrateSend(delay = 0) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const hero = document.querySelector(".bal-hero") as HTMLElement | null;
  const dur = tokenMs("--ui-dur-4");
  if (!hero || dur === null) return;
  setTimeout(() => {
    hero.classList.remove("sent"); void hero.offsetWidth; hero.classList.add("sent");
    setTimeout(() => hero.classList.remove("sent"), dur * 2);
  }, delay);
}

// Balance count-up: a display-only tween between the previous fetched value and the new one
// (ends on the exact canonical string; skipped on first paint, on reduced-motion, and on failure).
// `balanceState.last` is reset when render() sees another account (forgetBalance), so neither a tween nor a failed read's
// dimmed amount crosses an identity boundary; `balSeq` supersedes a stale tween if refreshes overlap.

let balSeq = 0;
// The amount in Geist with the unit muted; fmtBalance output is digits, separators and a sign only.
const balHtml = (base: number) => `${escapeHtml(fmtBalance(base))}<span class="bal-unit">CSD</span>`;
// The identity avatar: cairn-ui's avatar of the account's identity seed, its primary .csd name once read (the one its names
// page draws) and its address until then or when it has none, with no letter (the name or the address is printed
// beside it). One account, one avatar on every surface. avatarBackground output is numbers only, so it is safe in
// style.background.
export function paintAvatar(name: string | null, addr: string) {
  const av = document.getElementById("avatar") as HTMLElement | null;
  if (!av) return;
  const seed = identitySeed(name, addr);
  if (av.dataset.seed === seed) return;
  av.dataset.seed = seed;
  av.classList.add("ui-avatar");
  av.style.background = avatarBackground(seed);
  av.innerHTML = "";
  repaintRowAvatars();
}
// The account switcher draws the account the header shows with the header's seed, and any other account with the seed
// of its primary name once this popup has read it (knownNames), else of its address. avatarHtml writes numbers only.
export function rowAvatarHtml(addr: string, active: boolean): string {
  const header = active ? (document.getElementById("avatar") as HTMLElement | null)?.dataset.seed : undefined;
  return avatarHtml(header || identitySeed(knownNames.get(addr.toLowerCase()) ?? null, addr), "acct-dot");
}
function repaintRowAvatars() {
  for (const el of document.querySelectorAll<HTMLElement>("#acct-menu [data-avatar-for]")) el.innerHTML = rowAvatarHtml(el.dataset.avatarFor ?? "", el.dataset.active === "1");
}
// Pending-merge state (Plans/66 B4): derived by the engine from history + the utxo set the
// balance fetch ALREADY returned (zero extra requests). Cached module-level so the refusal copy
// (sendRefused) can consult it synchronously; refreshed on every balance refresh, which runs on
// open, after sends, and after merges; exactly the moments the state can change.
export let mergePendingNow: { pending: boolean; amount: number; maybe: boolean; stuck: boolean } = { pending: false, amount: 0, maybe: false, stuck: false };
async function updateMergePending(utxos: unknown) {
  const line = $("merge-pending") as HTMLElement;
  try {
    mergePendingNow = await call("pendingMerge", utxos);
    if (mergePendingNow?.pending) {
      line.textContent = mergePendingNow.stuck
        ? `Merge of ${fmtBalance(mergePendingNow.amount)} CSD still not included after ${INCLUSION_NOTICE_BLOCKS} blocks: check the explorer.`
        : mergePendingNow.maybe
          ? `Up to +${fmtBalance(mergePendingNow.amount)} CSD may be merging; back in your balance once the merge is mined.`
          : `+${fmtBalance(mergePendingNow.amount)} CSD merging; back in your balance once the merge is mined.`;
      line.hidden = false;
    } else line.hidden = true;
  } catch { line.hidden = true; mergePendingNow = { pending: false, amount: 0, maybe: false, stuck: false }; }
  // the reconcile may have settled history rows: repaint their markers if the list is on screen
  if (!($("activity") as HTMLElement).hidden) void renderHistory();
}
// `settleIn`: ms from now before a change shows (the flash and the count-up), so a send's settle plays once the closing
// sheet has cleared the hero; the value itself is current from the read on.
export async function refreshBalance(settleIn = 0) {
  const el = $("balance");
  const seq = ++balSeq;
  el.classList.add("loading");                 // shimmer while we fetch
  try {
    const b = await call("balance");
    if (seq !== balSeq) return;                // a newer refresh superseded this one
    void updateMergePending(b.utxos);          // piggybacks the utxos this fetch already carried
    el.classList.remove("loading", "stale", "failed");
    ($("bal-note") as HTMLElement).hidden = true;
    const next = Number(b.confirmed);
    const from = balanceState.last;
    balanceState.last = next; balanceState.stale = false;
    const row = $("csd-row-amt");
    row.textContent = fmtBalance(next); row.classList.remove("stale");
    balanceState.onChange?.();
    if (from !== null && from !== next) setTimeout(() => { if (seq === balSeq) flashChange(el, next > from ? "up" : "down"); }, settleIn);
    const dur = from === null || from === next || matchMedia("(prefers-reduced-motion: reduce)").matches ? null : tokenMs("--ui-dur-4");
    const ease = dur === null ? null : tokenEase();
    if (from === null || dur === null || ease === null) {
      el.innerHTML = balHtml(next);
    } else {
      const t0 = performance.now() + settleIn;
      const step = (t: number) => {
        if (seq !== balSeq) return;            // superseded mid-tween: let the newer write win
        const p = Math.min(1, Math.max(0, (t - t0) / dur));
        el.innerHTML = p < 1 ? balHtml(Math.round(from + (next - from) * ease(p))) : balHtml(next);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }
  catch { if (seq === balSeq) balanceFailed(); }
}
// A failed read: the last balance this popup read for the account, dimmed, with a caption that says so; with none, the
// caption alone in the amount's place. The refresh button beside it is the retry.
function balanceFailed() {
  const el = $("balance"), row = $("csd-row-amt"), note = $("bal-note") as HTMLElement;
  balanceState.stale = true;
  el.classList.remove("loading");
  el.classList.add("stale");
  row.classList.add("stale");
  if (balanceState.last !== null) {
    el.classList.remove("failed");
    el.innerHTML = balHtml(balanceState.last);
    row.textContent = fmtBalance(balanceState.last);
    note.textContent = "Last balance read; the refresh failed.";
    note.hidden = false;
  } else {
    el.classList.add("failed");
    el.textContent = "Balance unavailable. Refresh to try again.";
    row.textContent = "Unavailable";
    note.hidden = true;
  }
  balanceState.onChange?.();
}

export function supersedeBalance() { balSeq++; }
// At an account switch: the old account's amount, its failed state and caption go, and the amount shimmers until the
// new account's read lands.
export function resetBalanceView() {
  const el = $("balance"), row = $("csd-row-amt");
  el.classList.remove("stale", "failed"); el.classList.add("loading");
  row.textContent = ""; row.classList.remove("stale");
  ($("bal-note") as HTMLElement).hidden = true;
}
export function forgetBalance() { balanceState.last = null; balanceState.stale = false; balanceState.onChange?.(); }
