// The popup's send review in Chrome at 360 by 600, light and dark: each review check renders in its tier's colour
// (W-01, W-02). A first send to an address is a caution, amber, as in the approved design (owner decision 2026-10-25,
// which replaces 0.2.99's red); an address-poisoning look-alike stays danger, red. A positive name row is green, and
// every row sits above Confirm.
// RED-FIRST: drop the `.check.caution` rule from popup.css and the caution checks fail; drop `.check.danger` and the
// look-alike checks fail; give the first-time warning tier "danger" in popup-sendflow.ts and the first-send checks
// fail; restore popup.css and popup.ts from 5788776 and every tier check fails; drop the `key === pendingShown` return in renderPending and the
// pending card check fails; set data-enter on every write in enterOnce and the refresh check fails.
// HONEST PATH: the positive row on a two-source name; the first fill's stagger.
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";

const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker("popup review checks in Chrome");

const ME = "0x" + "7a3f9c21".repeat(5);
const NEW = "0x" + "42".repeat(20);
const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api",
    accounts: [{ addr: ME, label: "Main" }] },
  balance: { confirmed: 128_473_500_000, utxos: [] }, pendingMerge: { pending: false }, prewarmSpv: { ok: true }, pending: [],
  cairnxAssets: { ok: true, balances: {}, names: [], nameDetails: [] }, cairnxTokens: { ok: true, tokens: [] }, history: [],
  connectedSites: [], rpcList: [], explorerList: [], sealedClaims: [],
};

// Each check row's background against the token it should carry, read through a probe so both sides resolve alike.
const readRows = () => {
  const probe = (v) => { const d = document.createElement("div"); d.style.background = `var(${v})`; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
  const tint = { ok: probe("--ui-up-tint"), caution: probe("--ui-warn-tint"), danger: probe("--ui-down-tint") };
  const confirm = document.getElementById("btn-send-confirm").getBoundingClientRect();
  return [...document.querySelectorAll("#c-warn > .check")].map((el) => {
    const tier = ["ok", "caution", "danger"].find((x) => el.classList.contains(x));
    const r = el.getBoundingClientRect();
    return { tier, text: el.textContent.trim().slice(0, 40), tinted: getComputedStyle(el).backgroundColor === tint[tier], icon: !!el.querySelector(":scope > svg.i"), visible: r.height > 0, aboveConfirm: r.bottom <= confirm.top };
  });
};

async function review(theme, resolveName, to, extra = {}) {
  const { page, ctx, errors } = await openWalletPage(browser, "popup", { ...base, resolveName, confirmName: resolveName, ...extra }, { viewport: { width: 360, height: 600 }, colorScheme: theme });
  await page.waitForSelector("#view-main:not([hidden])");
  await page.click("#btn-send-t");
  await page.fill("#s-to", to);
  await page.fill("#s-amt", "1.5");
  await page.click("#btn-send");
  await page.waitForSelector("#send-confirm:not([hidden])");
  await page.waitForTimeout(500);
  const rows = await page.evaluate(readRows);
  await ctx.close();
  return { rows, errors };
}

// The entrance plays once: rows stagger in on the list's first fill, a refresh rewrites them in place, and the 1.5 s
// pending poll leaves the request card (and the focus on Review) alone while the queue is unchanged.
async function entrances() {
  const answers = { ...base, cairnxAssets: { ok: true, balances: { CAIRN: { available: "1", locked: "0" }, SUN: { available: "2", locked: "0" } }, names: [], nameDetails: [] },
    pending: [{ id: "p1", method: "send", origin: "https://dapp.example" }] };
  const { page, ctx, errors } = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 } });
  await page.waitForSelector("#assets .w-row");
  const first = await page.evaluate(() => [...document.querySelectorAll("#assets > .w-row")].map((r) => r.getAnimations().map((a) => a.animationName).join()).join("|"));
  await page.waitForTimeout(1200);
  await page.click("#btn-refresh");
  await page.waitForTimeout(300);
  const again = await page.evaluate(() => ({ anims: [...document.querySelectorAll("#assets > .w-row")].map((r) => r.getAnimations().length).join(), rows: document.querySelectorAll("#assets > .w-row").length }));
  await page.waitForSelector("#pending:not([hidden]) [data-review]");
  await page.focus("#pending [data-review]");
  const card = await page.evaluateHandle(() => document.querySelector("#pending [data-review]"));
  await page.waitForTimeout(3400);
  const kept = await page.evaluate((el) => el.isConnected && document.activeElement === el && document.getElementById("pending").getAnimations().filter((a) => a.animationName === "pending-in" && a.playState === "running").length === 0, card);
  await ctx.close();
  return { first, again, kept, errors };
}

// While a sheet is open the scrim, not the account chip, takes a click at the chip's centre (an account switch under an
// open review is the path W-23 guards); the review's To address is grouped in fours and a selection copies it raw;
// the longest legal ticker (12 characters) is shown whole; the account address in More is whole.
async function layout() {
  const LONGEST = "ABCDEFGHIJKL";
  const answers = { ...base, cairnxAssets: { ok: true, balances: { [LONGEST]: { available: "123456789012345678", locked: "0" } }, names: [], nameDetails: [] },
    cairnxTokens: { ok: true, tokens: [{ ticker: LONGEST, decimals: 0 }] } };
  const { page, ctx, errors } = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 } });
  await page.waitForSelector("#assets .w-row");
  const ticker = await page.evaluate(() => { const b = document.querySelector("#assets .w-row .nm b"); return { text: b.textContent, clipped: b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > innerWidth }; });
  await page.click(".act-more");
  await page.waitForTimeout(300);
  const addr = await page.evaluate(() => { const a = document.getElementById("addr"); const r = a.getBoundingClientRect(); return { text: a.textContent, clipped: a.scrollWidth > a.clientWidth + 1, inView: r.right <= innerWidth && r.height > 0 }; });
  await page.keyboard.press("Escape");
  await page.click("#btn-send-t");
  await page.waitForTimeout(600);
  const hit = await page.evaluate(() => {
    const r = document.querySelector(".acct-chip").getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el?.classList.contains("scrim") ? "scrim" : (el?.closest(".acct-chip") ? "chip" : el?.tagName);
  });
  await page.fill("#s-to", "0x" + "42".repeat(20));
  await page.fill("#s-amt", "1");
  await page.click("#btn-send");
  await page.waitForSelector("#send-confirm:not([hidden])");
  const to = await page.evaluate(() => {
    const el = document.getElementById("c-to");
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return { text: el.textContent, selected: sel.toString(), groups: el.children.length };
  });
  await ctx.close();
  return { ticker, addr, hit, to, errors, LONGEST };
}

// While a sheet is open the page behind it is inert: Tab never reaches the header, the tabs or the lists, focus moves
// into the sheet and back to what opened it; Escape and the back button still close; the request band shows the
// longest origin whole; the receive address copies raw.
const LONG = "https://cairn-substrate.com.account-verify.evil.example";
const LONGEST = "https://" + "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(48) + ".example";
async function sheets() {
  const answers = { ...base, pending: [{ id: "p1", method: "send", origin: LONG }, { id: "p2", method: "propose", origin: "https://dapp.example" }] };
  const { page, ctx, errors } = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 } });
  await page.waitForSelector("#pending:not([hidden])");
  const BEHIND = "#view-main > .topbar, #view-main > .bal-hero, #view-main > .actions, #tabs, #home, #names-tab, #activity";
  await page.focus("#btn-send-t"); await page.keyboard.press("Enter"); await page.waitForTimeout(600);
  const into = await page.evaluate(() => document.activeElement?.id);
  const visited = [];
  for (let i = 0; i < 40; i++) { await page.keyboard.press("Tab"); visited.push(await page.evaluate((sel) => { const a = document.activeElement; return { id: a?.id || a?.className || a?.tagName, behind: !!a?.closest(sel) }; }, BEHIND)); }
  const band = await page.evaluate(() => {
    const p = document.getElementById("pending"), req = p.querySelector(".req"), sheet = document.getElementById("send-form");
    const r = p.getBoundingClientRect(), s = sheet.getBoundingClientRect(), rv = p.querySelector("[data-review]").getBoundingClientRect();
    const top = document.elementFromPoint(rv.left + rv.width / 2, rv.top + rv.height / 2);
    return { whole: req.scrollHeight <= req.clientHeight + 1 && req.textContent.includes("account-verify.evil.example"), clear: r.bottom <= s.top + 0.5, reviewOnTop: !!top?.closest("[data-review]") };
  });
  await page.keyboard.press("Escape"); await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({ closed: document.getElementById("send-form").hidden, focus: document.activeElement?.id }));
  let chip = false;
  for (let i = 0; i < 30 && !chip; i++) { await page.keyboard.press("Tab"); chip = await page.evaluate(() => document.activeElement?.id === "acct-select"); }
  await page.click("#btn-receive"); await page.waitForTimeout(600);
  await page.click("#receive-panel .panel-head .panel-back"); await page.waitForTimeout(600);
  const backBtn = await page.evaluate(() => document.getElementById("receive-panel").hidden);
  await ctx.close();
  return { into, visited, band, back, chip, backBtn, errors };
}
async function longestBand() {
  const { page, ctx } = await openWalletPage(browser, "popup", { ...base, pending: [{ id: "p1", method: "send", origin: LONGEST }] }, { viewport: { width: 360, height: 600 } });
  await page.waitForSelector("#pending:not([hidden])");
  await page.click("#btn-send-t"); await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const p = document.getElementById("pending"), req = p.querySelector(".req"), s = document.getElementById("send-form").getBoundingClientRect();
    return { whole: req.scrollHeight <= req.clientHeight + 1 && req.getBoundingClientRect().bottom <= innerHeight, clear: p.getBoundingClientRect().bottom <= s.top + 0.5, text: req.textContent.length };
  });
  await ctx.close();
  return r;
}
async function receive() {
  const { page, ctx } = await openWalletPage(browser, "popup", { ...base }, { viewport: { width: 360, height: 600 } });
  await page.waitForSelector("#view-main:not([hidden])");
  await page.click("#btn-receive"); await page.waitForSelector("#receive-addr span");
  const r = await page.evaluate(() => {
    const el = document.getElementById("receive-addr");
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return { selected: sel.toString(), text: el.textContent, unsplit: [...el.children].every((g) => g.getClientRects().length === 1) };
  });
  await ctx.close();
  return r;
}

// W-1, W-4, W-9: the send sheet while the amount is typed (the fee and the balance after, the unit in the field), its
// review (titled Review send, Confirm send, the Network fee label, no Amount caption over the amount), then a confirmed
// send: the sheet closes, the sent toast shows at the bottom with what happens next, and the balance settles in the
// hero once the sheet has cleared it.
// RED-FIRST: drop closeAllPanels from sentOk and the closed-sheet and balance checks fail; drop the `#msg.sent` rule
// and the bottom check fails; drop the step-title rules and the title checks fail.
async function sendSheet(theme) {
  const { page, ctx, errors } = await openWalletPage(browser, "popup", { ...base, send: { ok: true, txid: "0x" + "ee".repeat(32) } }, { viewport: { width: 360, height: 600 }, colorScheme: theme });
  await page.waitForSelector("#view-main:not([hidden])");
  await page.waitForTimeout(400);
  await page.click("#btn-send-t");
  await page.fill("#s-to", NEW);
  await page.fill("#s-amt", "1.5");
  await page.waitForTimeout(500);
  const form = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const unit = document.querySelector("#send-form .field-unit > .unit"), amt = document.getElementById("s-amt");
    const u = unit.getBoundingClientRect(), a = amt.getBoundingClientRect();
    return { title: document.getElementById("send-form-title").innerText, fee: document.getElementById("s-fee").textContent, after: document.getElementById("s-after").textContent,
      rows: vis(document.getElementById("s-est")), unit: unit.textContent, unitInside: u.left > a.left && u.right <= a.right && u.top >= a.top && u.bottom <= a.bottom };
  });
  await page.click("#btn-send");
  await page.waitForSelector("#send-confirm:not([hidden])");
  await page.waitForTimeout(500);
  const review = await page.evaluate(() => ({
    title: document.getElementById("send-form-title").innerText, confirm: document.getElementById("btn-send-confirm").textContent,
    labels: [...document.querySelectorAll("#send-confirm .crow .label")].filter((l) => l.getClientRects().length).map((l) => l.textContent),
    estHidden: document.getElementById("s-est").getClientRects().length === 0,
  }));
  // the balance read after the send answers the lower amount the node now reports
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (m, cb) => m.method === "balance" ? setTimeout(() => cb({ ok: true, result: { confirmed: 128_322_500_000, utxos: [] } }), 5) : send(m, cb);
    window.__bal = [];
    const tick = () => { window.__bal.push(document.getElementById("balance").textContent); if (window.__bal.length < 90) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.click("#btn-send-confirm");
  await page.waitForTimeout(1200);
  const sent = await page.evaluate(() => {
    const m = document.getElementById("msg"), r = m.getBoundingClientRect();
    return { sheet: document.getElementById("send-form").hidden, cls: m.className, text: m.innerText, bottom: Math.round(innerHeight - r.bottom), top: Math.round(r.top),
      seen: [...new Set(window.__bal)], scrim: getComputedStyle(document.querySelector("#layer > .scrim")).opacity };
  });
  await ctx.close();
  return { form, review, sent, errors };
}

// W-7: a failed balance read. With no earlier read the caption takes the amount's place at the caption scale, muted;
// over an earlier read the amount stays, dimmed, with the caption under it; the refresh button beside it is the retry,
// and a good read clears both. RED-FIRST: put back `el.textContent = "unavailable"` in refreshBalance's catch and the
// caption checks fail.
async function balanceFailure(theme) {
  const answers = { ...base };
  delete answers.balance;
  const { page, ctx, errors } = await openWalletPage(browser, "popup", answers, { viewport: { width: 360, height: 600 }, colorScheme: theme });
  await page.waitForSelector("#view-main:not([hidden])");
  await page.waitForTimeout(600);
  const look = () => page.evaluate(() => {
    const probe = (v) => { const d = document.createElement("div"); d.style.color = `var(${v})`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    const b = document.getElementById("balance"), n = document.getElementById("bal-note"), row = document.getElementById("csd-row-amt");
    const cs = getComputedStyle(b);
    return { text: b.textContent, size: cs.fontSize, muted: cs.color === probe("--ui-muted"), note: n.hidden ? null : n.textContent, noteSize: getComputedStyle(n).fontSize,
      row: row.textContent, rowMuted: getComputedStyle(row).color === probe("--ui-muted"), retry: !!document.getElementById("btn-refresh")?.getClientRects().length };
  });
  const none = await look();
  // a good read, then a refresh that fails
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    window.__balOk = true;
    chrome.runtime.sendMessage = (m, cb) => m.method !== "balance" ? send(m, cb)
      : setTimeout(() => cb(window.__balOk ? { ok: true, result: { confirmed: 128_473_500_000, utxos: [] } } : { ok: false, error: "rpc down" }), 5);
  });
  await page.click("#btn-refresh"); await page.waitForTimeout(400);
  await page.evaluate(() => { window.__balOk = false; });
  await page.click("#btn-refresh"); await page.waitForTimeout(400);
  const stale = await look();
  await page.evaluate(() => { window.__balOk = true; });
  await page.click("#btn-refresh"); await page.waitForTimeout(900);
  const back = await look();
  await ctx.close();
  return { none, stale, back, errors };
}

try {
  for (const theme of ["light", "dark"]) {
    const f = await balanceFailure(theme);
    t.check(`${theme}: no earlier read: the caption in the amount's place, 13 px, muted, the retry beside it (${JSON.stringify(f.none)})`,
      f.none.text === "Balance unavailable. Refresh to try again." && f.none.size === "13px" && f.none.muted && f.none.note === null && f.none.row === "Unavailable" && f.none.rowMuted && f.none.retry);
    t.check(`${theme}: over an earlier read: that amount, dimmed, the caption under it (${JSON.stringify(f.stale)})`,
      f.stale.text === "1,284.735CSD" && f.stale.size === "40px" && f.stale.muted && f.stale.note === "Not refreshed: the last balance read. Refresh to try again." && f.stale.noteSize === "13px" && f.stale.row === "1,284.735" && f.stale.rowMuted);
    t.check(`${theme}: a good read clears the failed state (${JSON.stringify(f.back)})`, f.back.text === "1,284.735CSD" && !f.back.muted && f.back.note === null && !f.back.rowMuted);
    t.check(`${theme}: balance failure: no page error (${f.errors.join(" | ") || "none"})`, f.errors.length === 0);
    const s = await sendSheet(theme);
    t.check(`${theme}: the form says Send CSD, shows the network fee and the balance after (${JSON.stringify(s.form)})`, s.form.title === "Send CSD" && s.form.rows && s.form.fee === "0.01 CSD" && s.form.after === "1,283.225 CSD");
    t.check(`${theme}: the amount field carries its CSD unit inside it`, s.form.unit === "CSD" && s.form.unitInside);
    t.check(`${theme}: the review is titled Review send, its button says Confirm send, its fee row Network fee, and no Amount caption (${JSON.stringify(s.review)})`,
      s.review.title === "Review send" && s.review.confirm === "Confirm send" && s.review.labels.includes("Network fee") && !s.review.labels.includes("Amount") && !s.review.labels.includes("Fee") && s.review.estHidden);
    t.check(`${theme}: a confirmed send closes the sheet and the scrim (${s.sent.sheet}, scrim ${s.sent.scrim})`, s.sent.sheet === true && s.sent.scrim === "0");
    t.check(`${theme}: the sent toast sits at the bottom and says what happens next (${JSON.stringify({ cls: s.sent.cls, text: s.sent.text, bottom: s.sent.bottom })})`,
      /\bsent\b/.test(s.sent.cls) && s.sent.bottom >= 0 && s.sent.bottom <= 16 && s.sent.top > 300 && /^Sent 1\.5 CSD/.test(s.sent.text) && /Waiting for inclusion in a block\./.test(s.sent.text));
    t.check(`${theme}: the balance counts down to the new amount in the hero (${s.sent.seen.length} values, ends ${s.sent.seen.at(-1)})`, s.sent.seen.length > 3 && s.sent.seen.at(-1) === "1,283.225CSD");
    t.check(`${theme}: send sheet: no page error (${s.errors.join(" | ") || "none"})`, s.errors.length === 0);
  }
  {
    const k = await sheets();
    t.check(`opening a sheet from the keyboard moves focus into it (${k.into})`, k.into === "s-to");
    t.check(`40 Tabs from the sheet never reach the header, the tabs or the lists (${[...new Set(k.visited.map((v) => v.id))].join(", ")})`, k.visited.every((v) => !v.behind));
    t.check("...and they do reach the request band's Review", k.visited.some((v) => /primary/.test(v.id)));
    t.check(`the band shows the long origin whole, above the sheet, Review on top (${JSON.stringify(k.band)})`, k.band.whole && k.band.clear && k.band.reviewOnTop);
    t.check(`Escape closes the sheet and focus returns to Send (${JSON.stringify(k.back)})`, k.back.closed && k.back.focus === "btn-send-t");
    t.check("after it closes, Tab reaches the account chip again", k.chip);
    t.check("the back button still closes a sheet", k.backBtn);
    t.check(`sheets: no page error (${k.errors.join(" | ") || "none"})`, k.errors.length === 0);
    const b = await longestBand();
    t.check(`a ${b.text}-character request line with a 200-character origin shows whole, the sheet below it (${JSON.stringify(b)})`, b.whole && b.clear);
    const r = await receive();
    t.check(`Receive: a selection copies the raw address, each group on one line (${JSON.stringify(r)})`, r.selected === ME && r.text === ME && r.unsplit);
  }
  {
    const l = await layout();
    t.check(`the longest legal ticker shows whole (${JSON.stringify(l.ticker)})`, l.ticker.text === l.LONGEST && !l.ticker.clipped);
    t.check(`More shows the account address whole (${JSON.stringify(l.addr)})`, l.addr.text === ME && !l.addr.clipped && l.addr.inView);
    t.check(`with a sheet open the scrim takes a click at the account chip's centre (${l.hit})`, l.hit === "scrim");
    t.check(`the To address shows in groups of four and a selection copies it raw (${JSON.stringify(l.to)})`, l.to.groups === 10 && l.to.text === "0x" + "42".repeat(20) && l.to.selected === l.to.text);
    t.check(`layout: no page error (${l.errors.join(" | ") || "none"})`, l.errors.length === 0);
  }
  {
    const e = await entrances();
    t.check(`rows play row-in on the list's first fill (${e.first})`, e.first === "row-in|row-in");
    t.check(`a refresh rewrites the rows without replaying it (${JSON.stringify(e.again)})`, e.again.rows === 2 && e.again.anims === "0,0");
    t.check("two pending polls later the request card is the same element, Review keeps the focus, no entrance replays", e.kept);
    t.check(`entrances: no page error (${e.errors.join(" | ") || "none"})`, e.errors.length === 0);
  }
  for (const theme of ["light", "dark"]) {
    const a = await review(theme, { ok: true, addr: NEW, verified: true, sources: 2, depth: 14, via: "owner" }, "alice.csd");
    const [name, first] = a.rows;
    t.check(`${theme}: a two-source name renders a positive row in the up tint (${JSON.stringify(name)})`, name?.tier === "ok" && name.tinted && name.icon && name.visible);
    t.check(`${theme}: a first send renders a caution row in the warn tint (${JSON.stringify(first)})`, first?.tier === "caution" && first.tinted && first.icon && first.visible && /First time sending/.test(first.text));
    t.check(`${theme}: every row sits above Confirm`, a.rows.length === 2 && a.rows.every((r) => r.aboveConfirm));
    const b = await review(theme, { ok: true, addr: NEW, verified: true, sources: 2, soleSource: true, depth: 14, via: "owner" }, "alice.csd");
    t.check(`${theme}: a single-source name renders a caution row in the warn tint (${JSON.stringify(b.rows[0])})`, b.rows[0]?.tier === "caution" && b.rows[0].tinted && b.rows[0].visible);
    // an address-poisoning look-alike of an address this account paid: shares its head and tail, differs inside
    const PAID = "0x" + "31".repeat(20), LOOK = "0x313131" + "9".repeat(30) + "3131";
    const c = await review(theme, null, LOOK, { history: [{ type: "send", to: PAID, amount: 1, txid: "0x" + "a1".repeat(32) }] });
    t.check(`${theme}: a look-alike renders a danger row in the down tint (${JSON.stringify(c.rows[0])})`, c.rows.length === 1 && c.rows[0].tier === "danger" && c.rows[0].tinted && c.rows[0].icon && /address-poisoning/.test(c.rows[0].text) && c.rows[0].aboveConfirm);
    t.check(`${theme}: no page error (${[...a.errors, ...b.errors, ...c.errors].join(" | ") || "none"})`, a.errors.length + b.errors.length + c.errors.length === 0);
  }
} finally {
  await browser.close();
}
t.done("popup-checks-chrome");
