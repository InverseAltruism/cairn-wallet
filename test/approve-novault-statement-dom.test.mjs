// Two things the approval window says to a person a site sent to the wallet, with the REAL approve.ts on
// helpers/approve-dom.mjs. With no vault yet it shows how to set the wallet up, not a password form for a password the
// person does not have; and a sign-in's statement is labelled as the site's text, so a site cannot dress its words up
// as the wallet's ("Cairn Wallet security check: approve to keep your funds safe").
//   RED-FIRST: drop the hasVault read in approve.ts render and section 1 fails (the unlock form shows); drop the label in
//   clearsign.ts and section 3 fails.
//   PAIRED HONEST PATHS: a locked wallet with a vault shows the unlock form as before (2); the statement text itself is
//   still shown in full, quoted (3).
// Run: npx tsx test/approve-novault-statement-dom.test.mjs   (offline)
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("the approval window for a person a site sent here:");
const ME = "0x" + "a1".repeat(20);
const SIGNIN = { id: "s1", origin: "https://app.example", method: "signinWithCsd", params: { nonce: "Nonce1234abcd", statement: "Cairn Wallet security check: approve to keep your funds safe" } };
let status = { hasVault: false, unlocked: false, accounts: [] };
const { registry } = mountApproveWindow({
  status: async () => status, pending: async () => [SIGNIN],
  balance: async () => ({ confirmed: 0, utxos: [] }), history: async () => [], tipFloor: async () => null, tip: async () => 1,
});
const tick = await loadApprove();
const step = async () => { await tick(); await sleep(30); await flush(); };
const shown = (id) => registry.get(id)?.hidden === false;

// 1. No vault: the set-up view, no unlock form, no request.
await step();
check("1. with no vault the window shows the set-up view", shown("view-novault"));
check("1. ...and not the unlock form or the request", !shown("view-locked") && !shown("view-req"));

// 2. Honest path: a vault, locked: the unlock form as before.
status = { hasVault: true, unlocked: false, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }] };
await step();
check("2. honest path: a locked wallet shows the unlock form, not the set-up view", shown("view-locked") && !shown("view-novault"));

// 3. Unlocked: the sign-in paints with the statement labelled as the site's.
status = { hasVault: true, unlocked: true, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }] };
await step();
const html = String(registry.get("req").innerHTML);
check("3. the set-up and unlock views are hidden once unlocked", !shown("view-novault") && !shown("view-locked") && shown("view-req"));
check("3. the statement is labelled as text from the site, not from Cairn Wallet", html.includes("Text from app.example, not from Cairn Wallet:"));
check("3. honest path: the statement is shown in full, quoted", html.includes("“Cairn Wallet security check: approve to keep your funds safe”"));
done("approve-novault-statement-dom");
