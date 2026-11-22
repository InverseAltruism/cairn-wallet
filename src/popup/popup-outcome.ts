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
import { sentenceKeyOf, sentenceOf, type SentenceKey } from "./sentences.js";
// `details`: the technical sentence and the code (sentences.ts), never a server's text.
export type Outcome = { text: string; cls: "err" | "info"; maybe: boolean; details?: string; key?: SentenceKey };
const MAYBE_SENT: ReadonlySet<SentenceKey> = new Set(["R2", "R3", "MR_FEE", "MR_BUSY", "MR_OTHER"]);
/** The outcome of a sentence: grey reads as information, amber and red as a warning. */
export function sentenceOutcome(key: SentenceKey, code?: unknown, details?: string): Outcome {
  const s = sentenceOf(key, code);
  return { text: s.text, cls: s.tone === "grey" ? "info" : "err", maybe: MAYBE_SENT.has(key), details: details ? `${s.details} ${details}` : s.details, key };
}
const clause = (s: unknown): string => String(s).replace(/[.\s]+$/, "");
// A result whose code the sentence module words shows its line (sentences.ts); any other code keeps the engine's own
// text (wallet text: a submit's server text never reaches `error`, core/node.ts submitResult) until its slice words it.
export function refusedCopy(r: any, what: string): Outcome {
  const key = sentenceKeyOf(r);
  if (key) return sentenceOutcome(key, r?.code);
  return { text: `${r?.error ? clause(r.error) : `The ${what} was refused`}. Nothing was sent.`, cls: "err", maybe: false };
}
// A broken channel may hide a send ([R2]); a lock before signing is [R8]; any other throw submitted nothing and keeps
// the engine's own text (wallet text) until its slice words it.
export function thrownCopy(e: any, _what: string): Outcome {
  if (!(e instanceof AnsweredError)) return sentenceOutcome("R2", undefined, e?.message ? `(${clause(e.message)})` : undefined);
  if (e.message === "locked" || e.message === "wallet locked") return sentenceOutcome("R8");
  return { text: `${clause(e.message)}. Nothing was sent.`, cls: "err", maybe: false };
}
// A view's Approve or Reject gets { done: false } when the request left the queue before that view resolved it:
// rejected in another view, answered in another approval view (which may have signed it), or dropped when a worker
// restart emptied the queue. The view signed nothing, and cannot tell which.
export const HANDLED_ELSEWHERE = sentenceOf("R2").text;
// The reading of a Reject's answer, for the approval window and the toolbar popup; `r` is null when the call threw.
// Nothing was signed only when the background confirms it took the request off the queue as a rejection
// (resolvePending's reject path: done true, USER_REJECTED). A request already off the queue may be signing in another
// view, and a lost reply leaves the rejection unknown: both are `maybe`.
export function rejectCopy(r: any): Outcome {
  if (r?.done === true && r.code === "USER_REJECTED") return sentenceOutcome("R7", r.code);
  if (r?.done === false) return sentenceOutcome("R2");
  return sentenceOutcome("R2");
}
