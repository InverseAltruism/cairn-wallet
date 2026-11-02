// The recovery phrase backs up the accounts created from it, not an imported key. The popup's backup and key panels,
// the README and the store listing said the phrase backs up or restores "all" or "every" account, so a user who
// imported a key and saved only the phrase lost that account with the device. The copy is static and true for every
// wallet; this pins it.
// Run: npx tsx test/recovery-copy.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("recovery copy: the phrase covers the accounts created from it:");
const ROOT = join(import.meta.dirname, "..");
const text = (f) => readFileSync(join(ROOT, f), "utf8").replace(/<[^>]+>/g, "");
// "all"/"every" account(s) as what the phrase backs up, restores or controls, unless the sentence narrows it to the
// accounts created from it.
const OVERCLAIM = /\b(all|every)\b (of )?(your )?accounts?\b(?! (created|you create) from (it|them))|all accounts derive|it is the only way to restore your wallet/i;
const sources = ["src/popup/popup.html", "README.md", "store/STORE-LISTING.md"];
for (const f of sources) {
  const bad = text(f).split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /phrase|12 words|backs? up|restore/i.test(l) && OVERCLAIM.test(l));
  check(`${f}: no line says the phrase covers all accounts (${bad.map(([n, l]) => `${n}: ${String(l).trim().slice(0, 90)}`).join(" | ") || "none"})`, bad.length === 0);
}
const popup = text("src/popup/popup.html");
check("the key panel says an imported key is not in the phrase", /An imported key is not in it: keep its own backup\./.test(popup));
check("the phrase panel says imported keys are not in it", /Imported keys are not in it\./.test(popup));
check("the store listing says to back up an imported account's key", /the private key of any account you imported/.test(text("store/STORE-LISTING.md")));
check("the README says an imported key needs its own backup", /an imported key needs its own backup/.test(text("README.md")));
done("recovery-copy");
