// The popup's channel to the background (popup-outcome.ts, plus the dev path), and the one reading of a submit outcome
// for every flow, re-exported from popup-outcome.ts.
import { AnsweredError, extensionCall } from "./popup-outcome.js";
export { refusedCopy, thrownCopy, type Outcome } from "./popup-outcome.js";
export const chrome: any = (globalThis as any).chrome;
export const EXT = !!(chrome?.runtime?.sendMessage);

export async function call(method: string, ...args: any[]): Promise<any> {
  if (EXT) return extensionCall(chrome, method, ...args);
  // Dev/E2E only: the Wallet class lives in a dynamically imported chunk so popup.js never
  // statically embeds it (MV3 isolation). The shim throws at load if chrome.runtime.sendMessage exists.
  const { runDevPopupMethod } = await import("./devshim.js");
  try { return await runDevPopupMethod(method, args); }
  catch (e: any) { throw new AnsweredError(String(e?.message ?? e)); }
}
