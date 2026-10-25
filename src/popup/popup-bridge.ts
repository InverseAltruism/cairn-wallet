// The popup's channel to the background, and the one reading of a submit outcome for every flow.
export const chrome: any = (globalThis as any).chrome;
export const EXT = !!(chrome?.runtime?.sendMessage);

// The background ran the method and it threw. The engine returns every outcome after a submit as a
// value (node.ts post() never throws; test/submit-outcome.test.mjs), so a method that threw submitted
// nothing. A broken channel (the service worker died mid-call) is the only ambiguous rejection.
class AnsweredError extends Error {}
export async function call(method: string, ...args: any[]): Promise<any> {
  if (EXT) return new Promise((res, rej) => chrome.runtime.sendMessage({ kind: "popup", method, args }, (r: any) => {
    if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
    r?.ok ? res(r.result) : rej(new AnsweredError(r?.error || "error"));
  }));
  // Dev/E2E only: the Wallet class lives in a dynamically imported chunk so popup.js never
  // statically embeds it (MV3 isolation). The shim throws at load if chrome.runtime.sendMessage exists.
  const { runDevPopupMethod } = await import("./devshim.js");
  try { return await runDevPopupMethod(method, args); }
  catch (e: any) { throw new AnsweredError(String(e?.message ?? e)); }
}
// One reading of a submit outcome for every popup flow (send, token send, merge, name actions, post,
// seal): only SUBMIT_MAYBE_INFLIGHT and a broken channel may say "may already be in flight".
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
