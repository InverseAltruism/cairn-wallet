// An account label is display text (the popup's account rows, the approval window's "Signing as" line), so the wallet
// stores at most MAX_LABEL characters of it, trimmed, whatever reaches addAccount, importAccount or renameAccount.
// RED-FIRST: store the trimmed label uncapped (Wallet.label without the slice) and 1a-1c fail.
// HONEST PATH: 2a-2c (a short label, an empty rename and the default label stay as before).
// Run: node --import tsx test/account-label.test.mjs   (offline)
import { Wallet, MAX_LABEL } from "../src/core/wallet.js";
import { memoryStore } from "../src/core/storage.js";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("account labels are capped where they are stored:");
const w = new Wallet(memoryStore());
const { addr: A } = await w.create("super-secret-pw");
const long = "word ".repeat(400);
const labelOf = (addr) => w.accounts().find((a) => a.addr === addr)?.label;

await w.renameAccount(A, long);
check(`1a a 2,000-character rename is stored as ${MAX_LABEL} characters (${labelOf(A)?.length})`, labelOf(A) === long.trim().slice(0, MAX_LABEL));
const { addr: B } = await w.addAccount("x".repeat(100));
check(`1b a 100-character new account label is stored as ${MAX_LABEL} (${labelOf(B)?.length})`, labelOf(B) === "x".repeat(MAX_LABEL));
const { addr: C } = await w.importAccount("0x" + "11".repeat(32), "🪨".repeat(60));
check(`1c an imported key's label is cut by characters, never inside one (${Array.from(labelOf(C) ?? "").length} characters)`, labelOf(C) === "🪨".repeat(MAX_LABEL));

await w.renameAccount(A, "  Savings  ");
check(`2a honest: a short label is stored trimmed and whole (${labelOf(A)})`, labelOf(A) === "Savings");
await w.renameAccount(A, "   ");
check("2b honest: an empty rename keeps the label", labelOf(A) === "Savings");
const { addr: D } = await w.addAccount();
check(`2c honest: an unnamed account gets the default label (${labelOf(D)})`, labelOf(D) === "Account 4");

done("account-label");
