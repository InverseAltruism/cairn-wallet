// Sending a CairnX token: recipient and amount, the review, the signature.
import { formatUnits, parseUnits, CAIRNX_PROPOSE_FEE } from "../core/cairnx.js";
import { nameCheck, fmtCsd, fmtBalance, tokenAmountBothScales, groupedAddr } from "./clearsign.js";
import { call } from "./popup-bridge.js";
import { $, msg, val } from "./popup-dom.js";
import { beginReview, curAddr, reviewCurrent, reviewState, type ViewBind, bindView, viewCurrent } from "./popup-state.js";
import { dropStaleView, openPanel } from "./popup-panels.js";
import { resolveRecipient, setNameRow, recipientChecks } from "./popup-recipient.js";
import { TOKEN_FLOW, teardownReview, armReview, composeSendWarning, setWarn, runConfirm } from "./popup-sendflow.js";

// ── send a CairnX token: recipient + amount → review (ticker/amount/to/fee) → sign ──
// The transfer record is built INSIDE the wallet (core/cairnx.ts) and anchored through
// the existing propose pipeline with the 0.25 CSD convention fee; no value outputs.
export const CAIRNX_FEE = CAIRNX_PROPOSE_FEE; // 0.25 CSD (anchor fee, paid in CSD); the vendored MIN_FEE_PROPOSE, never a hand-typed literal
let tsend: { ticker: string; decimals: number; available: string; bind: ViewBind } | null = null;

export function openTokenSend(ticker: string, decimals: number, available: string) {
  tsend = { ticker, decimals, available, bind: bindView() };
  // force-open (openPanel toggles; clicking send on a second token must keep it open)
  if (!openPanel("tsend-form")) ($("tsend-form") as HTMLElement).hidden = false;
  ($("ts-ticker") as HTMLElement).textContent = ticker;
  ($("ts-avail") as HTMLElement).textContent = `Available: ${formatUnits(available, decimals)} ${ticker} · fee 0.25 CSD`;
  ($("ts-to") as HTMLInputElement).value = ""; ($("ts-amt") as HTMLInputElement).value = "";
  ($("tsend-confirm") as HTMLElement).hidden = true;
  msg("");
}
$("btn-tsend").addEventListener("click", async () => {
  // The sheet this Review is for, captured before any await: the amount is parsed with its decimals, and the card and the
  // snapshot are built from it alone. A Review the user leaves (another token's sheet, Back, a lock, an account switch)
  // primes nothing (popup-state reviewCurrent).
  const sheet = tsend;
  if (!sheet) return;
  if (!viewCurrent(sheet.bind)) { tsend = null; return dropStaleView(); }   // opened for another account
  const gen = beginReview();
  const left = () => !reviewCurrent(gen) || tsend !== sheet || !viewCurrent(sheet.bind);
  const base = parseUnits(val("ts-amt").trim(), sheet.decimals);
  if (base === null || base === "0") return msg(sheet.decimals ? `Enter an amount (up to ${sheet.decimals} decimal places).` : "Enter a whole-number amount (this token has 0 decimals).", "err");
  const rr = await resolveRecipient(val("ts-to").trim());   // 0x… or alice.csd (refuse lapsed)
  if (left()) return;
  if (!rr.ok) return msg(rr.error!, "err");
  const to = rr.addr!;
  setNameRow("tc-name-row", "tc-name", rr.label);
  // `available` comes from the (configurable) trade API; never let a hostile/garbled value
  // throw out of the handler and silently kill the send flow; treat unparseable as zero.
  let avail = 0n;
  try { avail = BigInt(sheet.available || "0"); } catch { avail = 0n; }
  if (BigInt(base) > avail) return msg(`The amount exceeds your available ${sheet.ticker} balance (${formatUnits(sheet.available, sheet.decimals)}).`, "err");
  // A token transfer still anchors on-chain via a Propose carrying the 0.25 CSD fee. "Received
  // tokens but holds no CSD" is a completely normal account state, so pre-check the CSD side HERE
  // with a message that names the actual problem; otherwise the engine's generic "insufficient
  // confirmed balance" reads as nonsense to someone staring at a big token balance. Best-effort:
  // offline skips the check and the engine still refuses cleanly at sign time.
  // Run the CSD-fee pre-check CONCURRENTLY with the recipient checks (both are best-effort network reads)
  // so a slow node doesn't add serial latency before the review card arms. Offline -> b is null -> the fee
  // check is skipped and the engine still refuses cleanly at sign time.
  const [b, checks] = await Promise.all([call("balance").catch(() => null), recipientChecks(to)]);
  if (left()) return;
  if (b && Number(b.confirmed ?? 0) < CAIRNX_FEE) return msg(`Sending ${sheet.ticker} needs ${fmtCsd(CAIRNX_FEE)} for the on-chain anchor fee; your confirmed CSD balance is ${fmtBalance(Number(b.confirmed ?? 0))} CSD.`, "err");
  // same first-time / address-poisoning checks as a CSD send; token sends are just as irreversible
  const { firstTime, lookalike } = checks;
  $("tc-ticker").textContent = sheet.ticker;
  $("tc-to").innerHTML = groupedAddr(to.toLowerCase());     // FULL address, as it will appear in the signed record
  // W8 (B5g): BOTH scales on the review card. `decimals` is resolver-served (the popup token list), so a
  // decimals lie rescales the human number by up to 10^8 while the balance guard compares against the SAME
  // resolver's `available`; the card alone could confirm a rescaled amount back to the user. The base-unit
  // integer IS the value that gets signed; rendering it beside the scaled number makes any rescale visible
  // at review time (F12: both scales, never either alone).
  $("tc-amt").textContent = tokenAmountBothScales(base, sheet.decimals, sheet.ticker);
  $("tc-fee").textContent = fmtCsd(CAIRNX_FEE);
  // A .csd token send ALWAYS carries the name-service-trust caution (XREPO-1), same as a CSD send.
  setWarn($("tc-warn") as HTMLElement, composeSendWarning(lookalike, firstTime, nameCheck(rr), TOKEN_FLOW.noun));
  // SNAPSHOT what was reviewed; the confirm step signs EXACTLY this, never the live inputs
  // signer snapshot (A1/POPUP-SEND-RACE-2): the confirm's nameStillPointsTo await can park across an
  // account switch; expectSigner makes the background refuse at the sign tick instead of signing from
  // the switched-to account (the recipient stays correct but the WRONG account would pay).
  // The token and its decimals ride in the snapshot: the sheet's live `tsend` can be another token by the time Confirm signs.
  reviewState.reviewed = { to, base, ticker: sheet.ticker, decimals: sheet.decimals, name: rr.name ?? null, verified: rr.verified, signer: curAddr }; // snapshot verified for the L7 confirm-time regression check
  armReview(TOKEN_FLOW);
});
// Back: keep the draft, refresh nothing (only success clears/refreshes)
$("btn-tsend-back").addEventListener("click", () => teardownReview(TOKEN_FLOW, false));
// Confirm signs the frozen review and nothing else (popup-sendflow runConfirm): every field of the call from the snapshot.
$("btn-tsend-confirm").addEventListener("click", () => runConfirm(TOKEN_FLOW,
  { read: () => reviewState.reviewed, consume: () => { reviewState.reviewed = null; } },
  ({ to, base, ticker, decimals, signer }) => call("cairnxTransfer", { ticker, amount: base, to, decimals, fee: CAIRNX_FEE, expectSigner: signer ?? undefined }),
  ({ base, ticker, decimals }) => `Sent ${tokenAmountBothScales(base, decimals, ticker)}`)); // W8: both scales here too
