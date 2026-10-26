// The Receive sheet.
import { groupedAddr } from "./clearsign.js";
import { drawQr } from "./qr/draw.js";
import { call } from "./popup-bridge.js";
import { $, copyText } from "./popup-dom.js";
import { openPanel } from "./popup-panels.js";

// ── Receive: QR + full address in a panel. Re-rendered on open AND on every render() while
// open (account switches must never leave a previous account's address/QR on screen). The QR
// is a convenience rendering of the SAME address printed in full beside it; the text is the
// source of truth. ANY failure fail-softs: card hidden AND canvas zeroed (a stale QR bitmap
// must never survive into a different account's context).
export async function renderReceive() {
  const card = document.querySelector(".receive-card") as HTMLElement | null;
  const canvas = document.getElementById("receive-qr") as HTMLCanvasElement | null;
  try {
    const st = await call("status");
    if (($("receive-panel") as HTMLElement).hidden) return;   // closed while we fetched
    // Groups of four for comparing by eye; the spans hold no spaces, so textContent (what Copy copies) is the address.
    const addr = String(st.addr || "");
    $("receive-addr").innerHTML = groupedAddr(addr);
    const pn = $("primary-name"), rn = $("receive-name") as HTMLElement;
    if (!(pn as HTMLElement).hidden && pn.textContent) { rn.textContent = pn.textContent; rn.hidden = false; }
    else { rn.textContent = ""; rn.hidden = true; }
    if (!st.addr || !canvas) throw new Error("no address");
    drawQr(canvas, st.addr);
    if (card) card.hidden = false;
  } catch {
    if (canvas) { canvas.width = 0; canvas.height = 0; }      // encodeText throws BEFORE resizing: wipe the old bitmap explicitly
    if (card) card.hidden = true;
  }
}
$("btn-receive").addEventListener("click", () => { if (openPanel("receive-panel")) renderReceive(); });
$("btn-receive-copy").addEventListener("click", () => copyText("btn-receive-copy", $("receive-addr").textContent || ""));
