// Removing an HD account takes two clicks and no password, and New account never derives it again (nextIndex only
// moves forward), so the remove step says how its coins are reached again. The imported branch keeps its own
// password-gated warning. Drives the REAL popup.ts against the fake DOM (test/_fakedom.mjs).
// Run: npx tsx test/account-remove-warn-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("account removal: the HD step says how to reach the coins again:");
const { byId } = installFakeDom({ autoCreate: true });
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), I = "0x" + "c3".repeat(20), D = "0x" + "d4".repeat(20);
installBridge({
  status: () => ({ hasVault: true, unlocked: true, addr: A, active: 0, accounts: [{ label: "Main", addr: A }, { label: "Second", addr: B }, { label: "Cold", addr: I, imported: true }, { label: "Spare", addr: D }], rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }), pendingMerge: () => ({ pending: false, amount: 0, maybe: false, stuck: false }),
  cairnxAssets: () => ({ ok: true, primaryName: null, tipHeight: 1, balances: {}, names: [], nameDetails: [] }), cairnxTokens: () => ({ ok: true, tokens: [] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], history: () => [], sealedClaims: () => [],
  unrevealedSeals: (addr) => { if (addr === B) return 2; if (addr === I) return 1; if (addr === A) throw new Error("storage"); return 0; },
});
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();

const list = () => byId("accts-list");
const HD_LINE = "New account will not bring this address back. Its coins stay on chain; to reach them again, restore your recovery phrase and add accounts until this one reappears (export any imported keys first).";
async function removeStep(addr) {
  await list().querySelectorAll("[data-open]").find((b) => b.dataset.open === addr).click(); await flush();
  await list().querySelectorAll("[data-remove]").find((b) => b.dataset.remove === addr).click(); await flush();
  return list().innerHTML;
}
await byId("btn-accts").click(); await flush();
let html = await removeStep(B);
check("the HD remove step asks Remove this account? and shows how to reach the coins again", /Remove this account\?/.test(html) && html.includes(HD_LINE));
await list().querySelectorAll("[data-cancel]")[0].click(); await flush();
html = await removeStep(I);
check("the imported remove step keeps its own warning and no HD line", /is <b>not<\/b> in your recovery phrase/.test(html) && !html.includes(HD_LINE));
// Removal keeps unrevealed sealed claims, revealable only with the account in this wallet: the step counts them.
check("the HD remove step names its 2 unrevealed sealed claims and how they come back", html.length > 0 && (await (async () => {
  await list().querySelectorAll("[data-cancel]")[0].click(); await flush();
  const h = await removeStep(B);
  return h.includes("2 sealed claims not yet revealed") && h.includes("import this account's key again (switch to this account first; More › Reveal key then shows its key)") && h.includes(HD_LINE);
})()));
await list().querySelectorAll("[data-cancel]")[0].click(); await flush();
html = await removeStep(I);
check("the imported remove step names its 1 unrevealed sealed claim beside its own warning", html.includes("1 sealed claim not yet revealed") && /is <b>not<\/b> in your recovery phrase/.test(html));
await list().querySelectorAll("[data-cancel]")[0].click(); await flush();
html = await removeStep(A);
check("a count that cannot be read says what is known, not a number", html.includes("could not count this account's sealed claims") && !/\d+ sealed claims? not yet revealed/.test(html));
await list().querySelectorAll("[data-cancel]")[0].click(); await flush();
html = await removeStep(D);
check("honest path: an account with no unrevealed sealed claims shows no sealed-claim line", html.includes(HD_LINE) && !/sealed claim/.test(html));
done("account-remove-warn-dom");
