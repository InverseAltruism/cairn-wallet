// Create, restore and import a wallet, the backup screen, and unlock.
import { escapeHtml } from "./clearsign.js";
import { call } from "./popup-bridge.js";
import { $, copyText, msg, show, val } from "./popup-dom.js";
import { render } from "./popup-render.js";

// Render the 12 words as a numbered grid.
export function seedGridHtml(mnemonic: string): string {
  return mnemonic.split(" ").map((w, i) => `<span class="seed-word"><span class="seed-n">${i + 1}</span>${escapeHtml(w)}</span>`).join("");
}
// Post-create backup screen: shows BOTH the recovery phrase and this account's
// (portable) private key, each with its own info note.
let backupPhrase = "", backupPriv = "";
function showBackup(mnemonic: string, privkey: string) {
  backupPhrase = mnemonic; backupPriv = privkey;
  $("seed-words").innerHTML = seedGridHtml(mnemonic);
  $("backup-priv").textContent = privkey;
  ($("ack-backup") as HTMLInputElement).checked = false;
  ($("btn-backup-done") as HTMLButtonElement).disabled = true;
  show("backup");
}
$("btn-create").addEventListener("click", async () => { try { const pw = val("setup-pw"); if (!pw) return msg("enter a password", "err"); const r = await call("create", pw); ($("setup-pw") as HTMLInputElement).value = ""; const h0 = document.getElementById("setup-pw-hint"); if (h0) h0.textContent = ""; showBackup(r.mnemonic, r.privkey); } catch (e: any) { msg(e.message, "err"); } });
// CUST-1-1 nudge: a no-dependency password-strength HINT on the new-wallet field. NON-blocking (the keystore
// still enforces the 8-char minimum); it just steers users toward a long passphrase, which is the real defense
// against an offline brute of an exfiltrated at-rest vault. Length-dominant with a small variety bonus; no dep.
function pwStrength(pw: string): string {
  const len = pw.length; if (!len) return "";
  if (len < 8) return "too short (8+ required)";
  let classes = 0; for (const re of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]) if (re.test(pw)) classes++;
  if (len >= 16 || (len >= 12 && classes >= 3)) return "strong";
  if (len >= 12 && classes >= 2) return "fair";
  return "weak: use a longer passphrase";
}
$("setup-pw").addEventListener("input", () => {
  const v = ($("setup-pw") as HTMLInputElement).value; const h = document.getElementById("setup-pw-hint");
  if (h) h.textContent = v ? `password strength: ${pwStrength(v)}` : "";
});
$("btn-restore").addEventListener("click", async () => { try { const ph = val("restore-phrase").trim(); const pw = val("restore-pw"); if (!ph) return msg("enter your recovery phrase", "err"); if (!pw) return msg("enter a password to encrypt it", "err"); await call("restore", ph, pw); ($("restore-phrase") as HTMLTextAreaElement).value = ""; ($("restore-pw") as HTMLInputElement).value = ""; msg("wallet restored", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-copy-seed").addEventListener("click", () => copyText("btn-copy-seed", backupPhrase));
$("btn-copy-priv").addEventListener("click", () => copyText("btn-copy-priv", backupPriv));
($("ack-backup") as HTMLInputElement).addEventListener("change", (e) => { ($("btn-backup-done") as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked; });
$("btn-backup-done").addEventListener("click", () => {
  backupPhrase = ""; backupPriv = ""; $("seed-words").innerHTML = ""; $("backup-priv").textContent = "";
  msg("wallet ready", "ok"); render();
  // wallet-ready moment: one-shot ring pulse over the balance hero (CSS-only; killed by reduced-motion)
  const vm = $("view-main");
  vm.classList.add("born");
  setTimeout(() => vm.classList.remove("born"), 1600);
});
$("btn-import").addEventListener("click", async () => { try { if (!val("import-pw")) return msg("enter a password to encrypt the key", "err"); await call("import", val("import-key").trim(), val("import-pw")); msg("key imported", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
$("btn-unlock").addEventListener("click", async () => { try { await call("unlock", val("unlock-pw")); msg("unlocked", "ok"); render(); } catch (e: any) { msg(e.message, "err"); } });
