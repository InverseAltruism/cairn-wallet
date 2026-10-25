// Reveal the private key and the recovery phrase; both are wiped from the page on every panel switch and on lock.
import { call } from "./popup-bridge.js";
import { $, copyText, msg, val } from "./popup-dom.js";
import { openPanel } from "./popup-panels.js";
import { seedGridHtml } from "./popup-onboarding.js";

let revealedKey = "", revealedPhrase = "";
// C-8 / PH-16 (2026-09-09): the "auto-clears" clipboard promise was FALSE (the clear needs a
// clipboardRead permission the manifest lacks, and the beforeunload path never settles in the
// shipped build). The machinery is deleted rather than repaired - a clipboard-read permission on a
// wallet is a Chrome Web Store red flag disproportionate to a cosmetic label.
export function resetRevealPanel() {
  revealedKey = ""; const o = $("reveal-out"); o.textContent = ""; o.classList.remove("shown"); (o as HTMLElement).hidden = true;
  ($("reveal-actions") as HTMLElement).hidden = true; ($("reveal-pw") as HTMLInputElement).value = "";
}
export function resetPhrasePanel() {
  revealedPhrase = ""; const o = $("phrase-out"); o.innerHTML = ""; o.classList.remove("shown"); o.classList.add("blur"); (o as HTMLElement).hidden = true;
  ($("phrase-actions") as HTMLElement).hidden = true; ($("phrase-pw") as HTMLInputElement).value = "";
}

// Reveal private key; in-popup panel (password → masked secret box).
$("btn-export").addEventListener("click", () => { openPanel("reveal-panel"); });
$("btn-reveal-go").addEventListener("click", async () => {
  const pw = val("reveal-pw"); if (!pw) return msg("enter your password", "err");
  try {
    revealedKey = await call("export", pw);
    const out = $("reveal-out") as HTMLElement;
    out.textContent = revealedKey; out.classList.remove("shown"); out.hidden = false;
    ($("reveal-actions") as HTMLElement).hidden = false; ($("reveal-pw") as HTMLInputElement).value = ""; msg("");
  } catch (e: any) { msg(e.message, "err"); }
});
$("btn-reveal-show").addEventListener("click", () => { ($("reveal-out") as HTMLElement).classList.toggle("shown"); });
$("btn-reveal-copy").addEventListener("click", () => copyText("btn-reveal-copy", revealedKey));
$("btn-reveal-close").addEventListener("click", () => { resetRevealPanel(); ($("reveal-panel") as HTMLElement).hidden = true; });

// Reveal recovery phrase; in-popup panel (password → blurred 12-word grid).
$("btn-phrase").addEventListener("click", () => { openPanel("phrase-panel"); });
$("btn-phrase-go").addEventListener("click", async () => {
  const pw = val("phrase-pw"); if (!pw) return msg("enter your password", "err");
  try {
    revealedPhrase = await call("exportMnemonic", pw);
    const out = $("phrase-out") as HTMLElement;
    out.innerHTML = seedGridHtml(revealedPhrase); out.classList.add("blur"); out.classList.remove("shown"); out.hidden = false;
    ($("phrase-actions") as HTMLElement).hidden = false; ($("phrase-pw") as HTMLInputElement).value = ""; msg("");
  } catch (e: any) { msg(e.message, "err"); }
});
$("btn-phrase-show").addEventListener("click", () => { const o = $("phrase-out"); o.classList.toggle("shown"); o.classList.toggle("blur"); });
$("btn-phrase-copy").addEventListener("click", () => copyText("btn-phrase-copy", revealedPhrase));
$("btn-phrase-close").addEventListener("click", () => { resetPhrasePanel(); ($("phrase-panel") as HTMLElement).hidden = true; });
