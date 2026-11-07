// The extension pages' channel to the background and the one reading of a submit outcome, for the popup
// (popup-bridge.ts adds its dev path) and the approval window (approve.ts). No dynamic import here: the approval
// window is built without code splitting, so anything this module imported would ship inside approve.js.

// The background ran the method and it threw. The engine returns every outcome after a submit as a
// value (node.ts post() never throws; test/submit-outcome.test.mjs), so a method that threw submitted
// nothing. A broken channel (the service worker died mid-call) is the only ambiguous rejection.
export class AnsweredError extends Error {}
export function extensionCall(chrome: any, method: string, ...args: any[]): Promise<any> {
  return new Promise((res, rej) => chrome.runtime.sendMessage({ kind: "popup", method, args }, (r: any) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    r?.ok ? res(r.result) : rej(new AnsweredError(r?.error || "error"));
  }));
}
// Only SUBMIT_MAYBE_INFLIGHT and a broken channel may say "may already be in flight".
export type Outcome = { text: string; cls: "err" | "info"; maybe: boolean };
const clause = (s: unknown): string => String(s).replace(/[.\s]+$/, "");
function inFlightCopy(prefix: string, what: string, txid?: string): Outcome {
  const where = txid ? ` It's in your history as ${String(txid).slice(0, 12)}…` : "";
  return { text: `${prefix}The ${what} didn't confirm; it may already be in flight. Check your history before trying again.${where}`, cls: "err", maybe: true };
}
export function refusedCopy(r: any, what: string): Outcome {
  if (r?.code === "SUBMIT_MAYBE_INFLIGHT") return inFlightCopy(r?.error ? clause(r.error) + ". " : "", what, r?.txid);
  if (r?.code === "SUBMIT_DUPLICATE") return { text: String(r?.error ?? "This transaction, or one spending the same coins, is already pending. Check your history once it is mined before sending again."), cls: "info", maybe: true };
  return { text: `${r?.error ? clause(r.error) : `The ${what} was refused`}. Nothing was sent.`, cls: "err", maybe: false };
}
export function thrownCopy(e: any, what: string): Outcome {
  if (!(e instanceof AnsweredError)) return inFlightCopy(e?.message ? clause(e.message) + ". " : "", what);
  if (e.message === "locked") return { text: "The wallet locked before anything was signed. Nothing was sent. Unlock and try again.", cls: "err", maybe: false };
  return { text: `${clause(e.message)}. Nothing was sent.`, cls: "err", maybe: false };
}
// A view's Approve or Reject gets { done: false } when the request left the queue before that view resolved it:
// rejected in another view, answered in another approval view (which may have signed it), or dropped when a worker
// restart emptied the queue. The view signed nothing, and cannot tell which.
export const HANDLED_ELSEWHERE = "This request was already handled or closed (possibly in another window), and may have been approved and sent. Check your history before sending again.";
// The reading of a Reject's answer, for the approval window and the toolbar popup; `r` is null when the call threw.
// Nothing was signed only when the background confirms it took the request off the queue as a rejection
// (resolvePending's reject path: done true, USER_REJECTED). A request already off the queue may be signing in another
// view, and a lost reply leaves the rejection unknown: both are `maybe`.
export function rejectCopy(r: any): Outcome {
  if (r?.done === true && r.code === "USER_REJECTED") return { text: "Rejected. Nothing was signed.", cls: "info", maybe: false };
  if (r?.done === false) return { text: HANDLED_ELSEWHERE, cls: "info", maybe: true };
  return { text: "The rejection could not be confirmed. Check your history before sending again.", cls: "err", maybe: true };
}
