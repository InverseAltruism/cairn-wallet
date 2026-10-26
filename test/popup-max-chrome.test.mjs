// The send sheet's Max in Chrome at 360 by 600, light and dark: the button sits at the end of the amount field after
// the unit, as the approved design draws it; pressing it asks the background's maxSendable (the send engine's own
// selection, test/maxsendable.test.mjs) with the sheet's fee, fills the amount with that figure exactly, and the review
// and the confirm then carry it: the `send` the popup makes is (recipient, that amount, the same fee). A capped answer
// says so; a failed one says Max is not available and leaves the amount alone; an answer that lands after the amount
// was typed is dropped.
// RED-FIRST: fill the amount from the balance instead (`formatUnits(String(balanceState.last - SEND_FEE), 8)`) and the
// fill and send checks fail; drop `maxSeq++` from the amount's input listener in popup-send.ts and the typed-meanwhile
// check fails.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("Max in the send sheet, in Chrome");

const ME = "0x" + "7a3f9c21".repeat(5);
const TO = "0x" + "42".repeat(20);
const MAX = { ok: true, amount: 1_284_724_999_993, fee: 1_000_000, inputs: 512, eligible: 600, skipped: 0, capped: true };
const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api", accounts: [{ addr: ME, label: "Main" }] },
  balance: { confirmed: 1_300_000_000_000, utxos: [] }, pendingMerge: { pending: false }, prewarmSpv: { ok: true }, pending: [], history: [{ type: "send", to: TO, amount: 1, txid: "0x" + "a1".repeat(32), ts: 1 }],
  cairnxAssets: { ok: true, balances: {}, names: [], nameDetails: [] }, cairnxTokens: { ok: true, tokens: [] }, csdMarket: { ok: false },
  connectedSites: [], rpcList: [], explorerList: [], sealedClaims: [], send: { ok: true, txid: "0x" + "b2".repeat(32), sighashMatch: true },
};
// records every popup call and holds maxSendable back by `window.__maxDelay` ms
function record() {
  const send = chrome.runtime.sendMessage;
  window.__calls = [];
  chrome.runtime.sendMessage = (m, cb) => {
    window.__calls.push({ method: m.method, args: m.args });
    if (m.method === "maxSendable" && window.__maxDelay) return setTimeout(() => send(m, cb), window.__maxDelay);
    return send(m, cb);
  };
}
async function open(theme, answers, delay = 0) {
  const r = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 }, colorScheme: theme, init: record });
  await r.page.waitForSelector("#view-main:not([hidden])");
  if (delay) await r.page.evaluate((d) => { window.__maxDelay = d; }, delay);
  await r.page.click("#btn-send-t");
  await r.page.waitForSelector("#send-form:not([hidden])");
  return r;
}

for (const theme of ["light", "dark"]) {
  const { page, ctx, errors } = await open(theme, { ...base, maxSendable: MAX });
  const geo = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const unit = document.querySelector("#send-form .field-unit > .unit").getBoundingClientRect();
    return { input: box("s-amt"), max: box("s-max"), unit };
  });
  t.check(`${theme}: Max sits inside the amount field, after the unit`, geo.max.left >= geo.unit.right && geo.max.right <= geo.input.right && geo.max.top >= geo.input.top && geo.max.bottom <= geo.input.bottom);
  await page.click("#s-max");
  await page.waitForFunction(() => document.getElementById("s-amt").value !== "");
  const filled = await page.evaluate(() => ({ amt: document.getElementById("s-amt").value, after: document.getElementById("s-after").textContent, note: document.getElementById("s-max-note").textContent,
    asked: window.__calls.filter((c) => c.method === "maxSendable").map((c) => c.args) }));
  t.check(`${theme}: Max asks the background with the sheet's fee (${JSON.stringify(filled.asked)})`, JSON.stringify(filled.asked) === "[[1000000]]");
  t.check(`${theme}: the amount is the engine's figure exactly (${filled.amt})`, filled.amt === "12847.24999993");
  t.check(`${theme}: balance after reads what Max leaves (${filled.after})`, filled.after === "152.74 CSD");
  t.check(`${theme}: the cap is said (${filled.note})`, filled.note.startsWith("The most one transaction can send: it spends 512 of your 600 coins"));
  await page.fill("#s-to", TO);
  await page.click("#btn-send");
  await page.waitForSelector("#send-confirm:not([hidden])");
  const reviewed = await page.evaluate(() => ({ amt: document.getElementById("c-amt").textContent, maxHidden: getComputedStyle(document.getElementById("s-max")).visibility === "hidden" }));
  t.check(`${theme}: the review shows Max (${reviewed.amt}) and Max is out of reach while the review holds the inputs`, reviewed.amt === "12847.24999993 CSD" && reviewed.maxHidden);
  await page.waitForTimeout(800);
  await page.click("#btn-send-confirm");
  await page.waitForFunction(() => window.__calls.some((c) => c.method === "send"));
  const sent = await page.evaluate(() => window.__calls.find((c) => c.method === "send").args);
  t.check(`${theme}: the send signs (recipient, Max, the same fee) (${JSON.stringify(sent.slice(0, 3))})`, sent[0] === TO && sent[1] === 1_284_724_999_993 && sent[2] === 1_000_000);
  t.check(`${theme}: no page error (${errors.join("; ") || "none"})`, errors.length === 0);
  await ctx.close();
}

{
  const { page, ctx } = await open("light", { ...base, maxSendable: { ok: false, error: "couldn't fetch your coins (node unreachable or erroring); nothing was signed, try again in a moment", code: "VERIFY_UNAVAILABLE" } });
  await page.fill("#s-amt", "2");
  await page.evaluate(() => { const a = document.getElementById("s-amt"); a.value = "2"; });
  await page.click("#s-max");
  await page.waitForFunction(() => document.getElementById("s-max-note").textContent.startsWith("Max is not available"));
  const r = await page.evaluate(() => ({ amt: document.getElementById("s-amt").value, note: document.getElementById("s-max-note").textContent }));
  t.check(`a failed Max says so and leaves the amount (${r.amt}): ${r.note.slice(0, 60)}`, r.amt === "2" && r.note.includes("node unreachable"));
  await ctx.close();
}
{
  const { page, ctx } = await open("light", { ...base, maxSendable: MAX }, 400);
  await page.click("#s-max");
  await page.waitForTimeout(50);
  await page.fill("#s-amt", "3");
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => ({ amt: document.getElementById("s-amt").value, note: document.getElementById("s-max-note").hidden }));
  t.check(`an answer after the amount was typed is dropped (${r.amt})`, r.amt === "3" && r.note);
  await ctx.close();
}
{
  const { page, ctx } = await open("light", { ...base, maxSendable: { ...MAX, amount: 0, inputs: 0, eligible: 0, capped: false } });
  await page.click("#s-max");
  await page.waitForFunction(() => document.getElementById("s-max-note").textContent.startsWith("Nothing to send"));
  t.check("Max 0 says nothing can be sent and fills nothing", (await page.inputValue("#s-amt")) === "");
  await ctx.close();
}

await browser.close();
t.done("popup-max-chrome");
