// The balance hero: the amount and its count-up, the identity avatar and the pending-merge line.
import { INCLUSION_NOTICE_BLOCKS } from "../core/inclusion.js";
import { escapeHtml, fmtBalance } from "./clearsign.js";
import { avatarGradient, monogram, identitySeed } from "./identicon.js";
import { flashChange, tokenEase, tokenMs } from "./motion.js";
import { call } from "./popup-bridge.js";
import { $ } from "./popup-dom.js";
import { renderHistory } from "./popup-history.js";

// Send-success moment: the balance settles once (popup.css `.bal-hero.sent`); display only, reduced-motion aware.
export function celebrateSend() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const hero = document.querySelector(".bal-hero") as HTMLElement | null;
  const dur = tokenMs("--ui-dur-4");
  if (!hero || dur === null) return;
  hero.classList.remove("sent"); void hero.offsetWidth; hero.classList.add("sent");
  setTimeout(() => hero.classList.remove("sent"), dur * 2);
}

// Balance count-up: a display-only tween between the previous fetched value and the new one
// (ends on the exact canonical string; skipped on first paint, on reduced-motion, and on failure).
// `lastBal` is reset on lock and account switch (clearSendDrafts / render) so a tween never
// crosses an identity boundary; `balSeq` supersedes a stale tween if refreshes overlap.

let lastBal: number | null = null;
let balSeq = 0;
// The amount in Geist with the unit muted; fmtBalance output is digits, separators and a sign only.
const balHtml = (base: number) => `${escapeHtml(fmtBalance(base))}<span class="bal-unit">CSD</span>`;
// Identity avatar: a primary .csd name gets its CNS-parity gradient + monogram; a name-less
// account gets the phosphor cairn mark (a bare gradient + hex nibble read as a placeholder).
const CAIRN_MARK_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="12" cy="18.4" rx="8.4" ry="2.7"/><ellipse cx="12" cy="12.1" rx="6" ry="2.5"/><ellipse cx="12" cy="6.2" rx="3.8" ry="2.1"/></svg>`;
export function paintAvatar(name: string | null, addr: string) {
  const av = document.getElementById("avatar") as HTMLElement | null;
  if (!av) return;
  const seed = name ? identitySeed(name, addr) : "__mark__";
  if (av.dataset.seed === seed) return;
  av.dataset.seed = seed;
  if (name) {
    av.classList.remove("mark");
    av.style.background = avatarGradient(identitySeed(name, addr));
    av.textContent = monogram(name, addr);
  } else {
    av.classList.add("mark");
    av.style.background = "";
    av.innerHTML = CAIRN_MARK_SVG; // static markup, no interpolation
  }
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
export async function refreshBalance() {
  const el = $("balance");
  const seq = ++balSeq;
  el.classList.add("loading");                 // shimmer while we fetch
  try {
    const b = await call("balance");
    if (seq !== balSeq) return;                // a newer refresh superseded this one
    void updateMergePending(b.utxos);          // piggybacks the utxos this fetch already carried
    el.classList.remove("loading");
    const next = Number(b.confirmed);
    const from = lastBal;
    lastBal = next;
    $("csd-row-amt").textContent = fmtBalance(next);
    if (from !== null && from !== next) flashChange(el, next > from ? "up" : "down");
    const dur = from === null || from === next || matchMedia("(prefers-reduced-motion: reduce)").matches ? null : tokenMs("--ui-dur-4");
    const ease = dur === null ? null : tokenEase();
    if (from === null || dur === null || ease === null) {
      el.innerHTML = balHtml(next);
    } else {
      const t0 = performance.now();
      const step = (t: number) => {
        if (seq !== balSeq) return;            // superseded mid-tween: let the newer write win
        const p = Math.min(1, (t - t0) / dur);
        el.innerHTML = p < 1 ? balHtml(Math.round(from + (next - from) * ease(p))) : balHtml(next);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }
  catch { if (seq === balSeq) { el.classList.remove("loading"); el.textContent = "unavailable"; $("csd-row-amt").textContent = "unavailable"; lastBal = null; } }
}

export function supersedeBalance() { balSeq++; }
export function forgetBalance() { lastBal = null; }
