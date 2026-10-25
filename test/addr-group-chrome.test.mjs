// Addresses a person compares are shown in groups of four, in the popup and in the approval window, from one helper
// (clearsign.ts groupedAddr), and what is copied stays the bare 42 characters: a selection of a grouped address, and
// the popup's Copy address button, take it with no space or line break between groups. A value that is not a whole
// address is shown as it is, ungrouped, with nothing dropped.
// RED-FIRST: write the More menu address, the accounts list, the signer and the send rows back as plain text and 1a,
// 1c and every 2a fail; group any string (the popup's old rule, which dropped a line break) and 3b fails. 1b holds
// both before and after: Copy took the bare address and still does.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM) for parts 1 and 2; part 3 runs without.
import * as cx from "../src/core/cairnx.ts";
import { groupedAddr, escapeHtml } from "../src/popup/clearsign.ts";
import { APPROVE_FRAME_PX, APPROVE_WINDOW } from "../src/approve-window.ts";
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const t = checker("grouped addresses, bare copies");
const ME = "0x" + "7a3f9c21".repeat(5);
const HD2 = "0x" + "4b8e0d17".repeat(5);
const RCPT = "0x" + "31".repeat(20);
const R2 = "0x" + "32".repeat(20);

// 3. the helper itself
{
  const g = groupedAddr(ME);
  t.check("3a: a whole address becomes ten groups whose text is the address", (g.match(/<span>/g) || []).length === 10 && g.replace(/<[^>]+>/g, "") === ME);
  const odd = ["0x12\n34", "0x" + "a".repeat(39), "0x" + "a".repeat(41), "<b>0x</b>", "alice.csd", "0x" + "g".repeat(40)];
  t.check("3b: any other value is only escaped, nothing grouped or dropped", odd.every((v) => groupedAddr(v) === escapeHtml(v)));
}

// What a person sees and copies of every grouped address under `root`.
const grouped = (root) => [...document.querySelectorAll(`${root} code.addr`)].filter((el) => el.getClientRects().length).map((el) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const kids = [...el.children];
  const gaps = kids.slice(1).map((k, i) => { const a = kids[i].getBoundingClientRect(), b = k.getBoundingClientRect(); return b.top > a.top + 1 ? 1 : b.left - a.right; });
  return { text: el.textContent, selected: sel.toString(), groups: kids.length, minGap: Math.min(...gaps) };
});
const ok = (g, want) => g.groups === 10 && g.text === want && g.selected === want && g.minGap > 0;

const browser = await launchOrSkip();
if (!browser) t.done("addr-group-chrome");
try {
  // 1. the popup: the More menu, the accounts list, and the Copy address button
  const accounts = [{ addr: ME, label: "Main" }, { addr: HD2, label: "Savings" }];
  const answers = {
    status: { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api", accounts },
    balance: { confirmed: 1e10, utxos: [] }, pendingMerge: { pending: false }, prewarmSpv: { ok: true }, pending: [], history: [], sealedClaims: [],
    cairnxAssets: { ok: true, balances: {}, names: [], nameDetails: [] }, cairnxTokens: { ok: true, tokens: [] },
  };
  const { page, ctx, errors } = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 } });
  try {
    await page.waitForSelector("#view-main:not([hidden])", { timeout: 10_000 });
    await page.evaluate(() => { window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (s) => { window.__copied.push(s); } } }); });
    await page.click('[popovertarget="more-menu"]:not([popovertargetaction])');
    const menu = await page.evaluate(grouped, "#more-menu");
    t.check(`1a: the More menu shows the address in groups of four (${JSON.stringify(menu)})`, menu.length === 1 && ok(menu[0], ME));
    await page.click("#btn-copy");
    await page.waitForTimeout(100);
    const copied = await page.evaluate(() => window.__copied);
    t.check(`1b: Copy address copies the bare address (${JSON.stringify(copied)})`, copied.length === 1 && copied[0] === ME);
    await page.click("#btn-accts");
    await page.waitForSelector("#accts-panel:not([hidden])");
    await page.waitForTimeout(300);
    const list = await page.evaluate(grouped, "#accts-list");
    t.check(`1c: the accounts list shows every address in groups of four (${list.length})`, list.length === 2 && ok(list[0], ME) && ok(list[1], HD2));
    t.check(`1d: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
  } finally { await ctx.close(); }

  // 2. the approval window: the signer and every recipient row
  const prop = (rec) => ({ domain: cx.CAIRNX_DOMAIN, uri: rec.uri, payloadHash: rec.payloadHash, fee: 25_000_000, expiresEpoch: 4_100 });
  const CASES = [
    ["send to two", { method: "send", params: { outputs: [{ to: RCPT, value: 1e8 }, { to: R2, value: 2e8 }], fee: 1e6 } }, [RCPT, R2]],
    ["fill", { method: "fillOffer", params: { proposalId: "0x" + "ab".repeat(32), outputs: [{ to: RCPT, value: 25e7 }, { to: cx.TREASURY_ADDR, value: 3_750_000 }], fee: 1e6, score: 100, confidence: 100 } }, [RCPT, cx.TREASURY_ADDR.toLowerCase()]],
    ["token transfer", { method: "propose", params: prop(cx.buildTransfer({ ticker: "CAIRN", amount: "1500000000", to: RCPT })) }, [RCPT]],
    ["name transfer", { method: "propose", params: prop(cx.buildNameXfer({ name: "alice", to: RCPT })) }, [RCPT]],
    ["name record", { method: "propose", params: prop(cx.buildNameSet({ name: "alice", addr: RCPT })) }, [RCPT]],
  ];
  for (const [name, r, want] of CASES) {
    const req = { id: "r-" + name, origin: "https://dapp.example", ...r };
    const { page, ctx, errors } = await openWalletPage(browser, "approve", {
      status: { hasVault: true, unlocked: true, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }], tradeApi: "https://x.invalid" },
      balance: { confirmed: 1e11 }, history: [], pending: [req], tip: 120_000, epoch: 4_000, tipFloor: 0, sealedClaims: [], tokenDisplayMeta: {},
    }, { viewport: { width: APPROVE_WINDOW.width, height: APPROVE_WINDOW.height - APPROVE_FRAME_PX } });
    try {
      await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
      await page.waitForTimeout(800);
      const signer = await page.evaluate(grouped, "#ap-signer");
      const rows = await page.evaluate(grouped, "#req");
      const texts = rows.map((g) => g.text.toLowerCase());
      t.check(`2a ${name}: the signer and every recipient are grouped and select bare (${rows.length} rows)`,
        signer.length === 1 && ok(signer[0], ME) && rows.length === want.length && rows.every((g) => ok(g, g.text)) && want.every((a, i) => texts[i] === a.toLowerCase()));
      t.check(`2b ${name}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); }
t.done("addr-group-chrome");
