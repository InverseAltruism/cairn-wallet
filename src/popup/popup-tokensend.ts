// Sending a CairnX token: recipient and amount, the review, the signature.
import { formatUnits, parseUnits, CAIRNX_PROPOSE_FEE } from "../core/cairnx.js";
import { nameCheck, fmtCsd, fmtBalance, tokenAmountBothScales, groupedAddr } from "./clearsign.js";
import { call } from "./popup-bridge.js";
import { $, busy, msg, val } from "./popup-dom.js";
import { curAddr, reviewState, type ViewBind, bindView, viewCurrent } from "./popup-state.js";
import { dropStaleView, openPanel } from "./popup-panels.js";
import { resolveRecipient, nameStillPointsTo, setNameRow, recipientChecks } from "./popup-recipient.js";
import { TOKEN_FLOW, teardownReview, armReview, composeSendWarning, setWarn, sendThrew, sendRefused, sentOk } from "./popup-sendflow.js";

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
  if (!tsend) return;
  if (!viewCurrent(tsend.bind)) { tsend = null; return dropStaleView(); }   // opened for another account
  const base = parseUnits(val("ts-amt").trim(), tsend.decimals);
  if (base === null || base === "0") return msg(tsend.decimals ? `Enter an amount (up to ${tsend.decimals} decimal places).` : "Enter a whole-number amount (this token has 0 decimals).", "err");
  const rr = await resolveRecipient(val("ts-to").trim());   // 0x… or alice.csd (refuse lapsed)
  if (!rr.ok) return msg(rr.error!, "err");
  const to = rr.addr!;
  setNameRow("tc-name-row", "tc-name", rr.label);
  // `available` comes from the (configurable) trade API; never let a hostile/garbled value
  // throw out of the handler and silently kill the send flow; treat unparseable as zero.
  let avail = 0n;
  try { avail = BigInt(tsend.available || "0"); } catch { avail = 0n; }
  if (BigInt(base) > avail) return msg(`The amount exceeds your available ${tsend.ticker} balance (${formatUnits(tsend.available, tsend.decimals)}).`, "err");
  // A token transfer still anchors on-chain via a Propose carrying the 0.25 CSD fee. "Received
  // tokens but holds no CSD" is a completely normal account state, so pre-check the CSD side HERE
  // with a message that names the actual problem; otherwise the engine's generic "insufficient
  // confirmed balance" reads as nonsense to someone staring at a big token balance. Best-effort:
  // offline skips the check and the engine still refuses cleanly at sign time.
  // Run the CSD-fee pre-check CONCURRENTLY with the recipient checks (both are best-effort network reads)
  // so a slow node doesn't add serial latency before the review card arms. Offline -> b is null -> the fee
  // check is skipped and the engine still refuses cleanly at sign time.
  const [b, checks] = await Promise.all([call("balance").catch(() => null), recipientChecks(to)]);
  if (b && Number(b.confirmed ?? 0) < CAIRNX_FEE) return msg(`Sending ${tsend.ticker} needs ${fmtCsd(CAIRNX_FEE)} for the on-chain anchor fee; your confirmed CSD balance is ${fmtBalance(Number(b.confirmed ?? 0))} CSD.`, "err");
  // same first-time / address-poisoning checks as a CSD send; token sends are just as irreversible
  const { firstTime, lookalike } = checks;
  $("tc-ticker").textContent = tsend.ticker;
  $("tc-to").innerHTML = groupedAddr(to.toLowerCase());     // FULL address, as it will appear in the signed record
  // W8 (B5g): BOTH scales on the review card. `decimals` is resolver-served (the popup token list), so a
  // decimals lie rescales the human number by up to 10^8 while the balance guard compares against the SAME
  // resolver's `available`; the card alone could confirm a rescaled amount back to the user. The base-unit
  // integer IS the value that gets signed; rendering it beside the scaled number makes any rescale visible
  // at review time (F12: both scales, never either alone).
  $("tc-amt").textContent = tokenAmountBothScales(base, tsend.decimals, tsend.ticker);
  $("tc-fee").textContent = fmtCsd(CAIRNX_FEE);
  // A .csd token send ALWAYS carries the name-service-trust caution (XREPO-1), same as a CSD send.
  setWarn($("tc-warn") as HTMLElement, composeSendWarning(lookalike, firstTime, nameCheck(rr), TOKEN_FLOW.noun));
  // SNAPSHOT what was reviewed; the confirm step signs EXACTLY this, never the live inputs
  // signer snapshot (A1/POPUP-SEND-RACE-2): the confirm's nameStillPointsTo await can park across an
  // account switch; expectSigner makes the background refuse at the sign tick instead of signing from
  // the switched-to account (the recipient stays correct but the WRONG account would pay).
  reviewState.reviewed = { to, base, name: rr.name ?? null, verified: rr.verified, signer: curAddr }; // snapshot verified for the L7 confirm-time regression check
  armReview(TOKEN_FLOW);
});
// Back: keep the draft, refresh nothing (only success clears/refreshes)
$("btn-tsend-back").addEventListener("click", () => teardownReview(TOKEN_FLOW, false));
$("btn-tsend-confirm").addEventListener("click", async () => {
  if (!tsend || !reviewState.reviewed) return;
  const { to, base, name, verified, signer } = reviewState.reviewed;
  // re-resolve the name at sign-time and refuse if it now points somewhere else (XREPO-1) or its
  // chain-verification regressed since review (L7).
  if (name && !(await nameStillPointsTo(name, to, verified))) return msg(`${name}.csd changed where it points. Nothing was sent: review it again.`, "err");
  // Only the call is inside the try: a throw from the outcome's own display code must not read as a submit outcome.
  let r: any;
  try {
    busy("Sending…");
    r = await call("cairnxTransfer", { ticker: tsend.ticker, amount: base, to, decimals: tsend.decimals, fee: CAIRNX_FEE, expectSigner: signer ?? undefined });
  } catch (e: any) {
    return sendThrew(TOKEN_FLOW, e);       // a wallet-answered throw submitted nothing; only a broken channel is ambiguous
  }
  if (r?.ok) sentOk(TOKEN_FLOW, `Sent ${tokenAmountBothScales(base, tsend.decimals, tsend.ticker)}`); // W8: both scales here too
  else sendRefused(TOKEN_FLOW, r);                  // structured refusal: show the REAL reason (token parity with the CSD path)
});
