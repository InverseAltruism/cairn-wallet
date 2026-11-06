// The band that lists the dApp requests waiting for the approval window.
import { escapeHtml } from "./clearsign.js";
import { EXT, call, rejectCopy } from "./popup-bridge.js";
import { $, msg } from "./popup-dom.js";

// The queue the card last showed: the 1.5 s poll rewrites the card only when it changed, so a poll does not replay
// its entrance or take the focus off Review.
let pendingShown: string | null = null;
export async function renderPending() {
  if (!EXT) return;
  const p = await call("pending"); const el = $("pending") as HTMLElement;
  const key = JSON.stringify(p.map((r: any) => [r.id, r.method, r.origin]));
  if (key === pendingShown) return;
  pendingShown = key;
  if (!p.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  // The toolbar popup NEVER approves a request inline; approving a fund-moving send/propose/
  // attest requires the full clear-signing window (recipient, amount, fee, balance-after,
  // first-time/poisoning/large-fee warnings). "Review & approve" opens that window; Reject is
  // safe to do blind. This keeps a single, fully-disclosed approval path.
  const pluralReview = p.length > 1 ? `Review ${p.length} requests` : "Review and approve";
  el.innerHTML =
    p.map((r: any) => `<div class="req"><b>${escapeHtml(String(r.method))}</b> from ${escapeHtml(String(r.origin))}</div>`).join("") +
    `<div class="row"><button data-review="1" class="primary">${escapeHtml(pluralReview)}</button>` +
    p.map((r: any) => `<button data-rj="${escapeHtml(String(r.id))}">Reject ${escapeHtml(String(r.method))}</button>`).join("") +
    `</div>`;
  const reviewBtn = el.querySelector<HTMLElement>("[data-review]");
  if (reviewBtn) reviewBtn.onclick = async () => { await call("openApproval"); window.close(); };
  el.querySelectorAll<HTMLButtonElement>("[data-rj]").forEach((b) => b.onclick = () => { b.disabled = true; reject(b.dataset.rj!); });
}
// The approval window's reading of the answer (popup-outcome.ts): an approval under way in the window can take a listed
// request before this Reject arrives. The button disables at the click, so a second click cannot reach the background
// and get { done: false } for a request the first one rejected.
async function reject(id: string) { const o = rejectCopy(await call("resolve", id, false).catch(() => null)); msg(o.text, o.cls); renderPending(); }
