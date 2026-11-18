// The approval window's page measurements, shared by the in-Chrome layout tests (test/approve-layout-chrome.test.mjs,
// test/approve-name-caution-chrome.test.mjs). `measure` runs in the page (it is passed to page.evaluate), so it reads
// nothing from this module.

// Runs in the page once the request has settled. `gap` is the distance from the lowest element with weight to the fold
// (the top of the buttons, or the bottom of the scroll area when that is higher); negative is below it.
export function measure([expect, origin]) {
  const reqEl = document.getElementById("req");
  const barTop = Math.min(document.getElementById("btn-reject").getBoundingClientRect().top, document.getElementById("btn-approve").getBoundingClientRect().top);
  const fold = Math.min(reqEl.getBoundingClientRect().bottom, barTop, innerHeight);
  const shown = (el) => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().height > 0;
  const WEIGHT_ROWS = new Set(["To", "Resolves to", "Paid to", "Only fillable by", "You receive", "Amount", "Token", "Give", "Want", "Bidding", "For", "Name", "Claim", "Keys removed"]);
  const weight = [];
  const add = (el, what) => { if (shown(el)) weight.push([el, what]); };
  add(document.getElementById("ap-origin"), "origin");
  add(document.getElementById("ap-signer"), "signer");
  const q = reqEl.querySelector(":scope > .req.dim");
  if (q && /^Request 1 of/.test(q.textContent)) add(q, "queue line");
  for (const el of reqEl.querySelectorAll(".ap-amt")) add(el, "amount");
  add(document.getElementById("cost"), "cost block");
  for (const el of reqEl.querySelectorAll(".check")) add(el, `check "${el.textContent.trim().slice(0, 32)}"`);
  for (const el of reqEl.querySelectorAll(".err")) add(el, `refusal "${el.textContent.trim().slice(0, 32)}"`);
  for (const row of reqEl.querySelectorAll(".kv > div")) {
    const dt = row.querySelector("dt")?.textContent ?? "";
    if (WEIGHT_ROWS.has(dt)) add(row, `row ${dt} "${row.querySelector("dd")?.textContent.slice(0, 20)}"`);
  }
  for (const id of ["token-sim", "reveal-preview", "nfin-note", "send-warn"]) add(document.getElementById(id), "#" + id);
  // the listing a fill buys: what it gives (a row above), a failed read (a check row above) and the offer's expiry
  for (const el of reqEl.querySelectorAll("#fill-view > .ap-lede")) if (/^Offer expire/.test(el.textContent)) add(el, "listing expiry");
  let lowest = null;
  for (const [el, what] of weight) {
    const b = el.getBoundingClientRect().bottom;
    if (!lowest || b > lowest.bottom) lowest = { what, bottom: b };
  }
  const below = weight.filter(([el]) => el.getBoundingClientRect().bottom > fold + 0.5).map(([, what]) => what);
  const marked = [...reqEl.querySelectorAll(".check > div")].filter((d) => /^\s*⚠/.test(d.textContent)).length;
  // Weight first, so a request a site makes longer than the window still shows the cost and every warning: the cost
  // block, the first-time and look-alike warnings, a name action's verdict and the balance note all come before the
  // first recipient row in the page,
  const firstRcpt = [...reqEl.querySelectorAll(".kv > div")].find((r) => ["To", "Resolves to", "Paid to"].includes(r.querySelector("dt")?.textContent));
  const short = [...reqEl.querySelectorAll(".check")].find((c) => /spendable balance does not cover/.test(c.textContent));
  const late = !firstRcpt ? [] : [["cost", document.getElementById("cost")], ["#send-warn", document.getElementById("send-warn")], ["#nfin-note", document.getElementById("nfin-note")], ["balance note", short]]
    .filter(([, el]) => shown(el) && !(el.compareDocumentPosition(firstRcpt) & Node.DOCUMENT_POSITION_FOLLOWING)).map(([what]) => what);
  // and the cost comes before every row without weight (ids, hashes, a site's text), whose length a site controls
  const firstPlain = [...reqEl.querySelectorAll(".kv > div")].find((r) => !r.closest("#cost, #fill-view, #token-sim, #reveal-preview") && !WEIGHT_ROWS.has(r.querySelector("dt")?.textContent ?? ""));
  const cost = document.getElementById("cost");
  if (firstPlain && !(cost.compareDocumentPosition(firstPlain) & Node.DOCUMENT_POSITION_FOLLOWING)) late.push(`cost after "${firstPlain.querySelector("dt").textContent}"`);
  // inside the listing box, the listing id (a reservation's) comes after what the listing gives and its expiry
  const box = document.getElementById("fill-view");
  const listing = [...(box?.querySelectorAll(".kv > div") ?? [])].find((r) => r.querySelector("dt")?.textContent === "Listing");
  const boxWeight = [...(box?.querySelectorAll(".kv > div, .ap-lede, .check") ?? [])].filter((el) => el.querySelector("dt")?.textContent === "You receive" || /^Offer expire/.test(el.textContent) || el.matches(".check"));
  if (listing && boxWeight.some((el) => !(listing.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING))) late.push("listing id before what the listing gives");

  // what must render
  const find = (label) => {
    if (label === "origin") { const o = document.getElementById("ap-origin"); return o && o.textContent === origin ? [o] : []; }
    if (label === "cost") return [document.getElementById("cost")];
    if (label.startsWith("#")) return [document.getElementById(label.slice(1))];
    if (label.startsWith("to:")) return [...reqEl.querySelectorAll(".kv > div")].filter((r) => r.querySelector("dt")?.textContent === "To");
    // the recipients the box names by head and tail (a look-alike line also names what it resembles, not a recipient)
    if (label.startsWith("named:")) return [...new Set([...(document.getElementById("send-warn")?.querySelectorAll("code") ?? [])].filter((c) => !/resembles\s*$/.test(c.previousSibling?.textContent ?? "")).map((c) => c.textContent))];
    // the recipients flagged: the marked rows once a request has more than one recipient row, else the one the box names
    if (label.startsWith("warn:")) {
      const marked = [...new Set([...reqEl.querySelectorAll(".kv > div[data-to].flag")].map((r) => r.dataset.to))];
      return marked.length ? marked : [...new Set([...(document.getElementById("send-warn")?.querySelectorAll("code") ?? [])].filter((c) => !/resembles\s*$/.test(c.previousSibling?.textContent ?? "")).map((c) => c.textContent))];
    }
    if (label === "Resolves to") return [...reqEl.querySelectorAll(".kv > div")].filter((r) => r.querySelector("dt")?.textContent === label);
    const words = label.replace(/[<>]/g, "");
    const walker = document.createTreeWalker(reqEl, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.matches(".check, .err, .ap-box, .kv > div, .req.dim, .ap-lede") && n.textContent.replace(/\s+/g, " ").includes(words)) return [n];
    return [];
  };
  const missing = [];
  for (const label of expect) {
    const els = find(label);
    const want = /^(to|warn|named):(\d+)$/.exec(label);
    if (want) { if (els.length !== Number(want[2])) missing.push(`${label} (found ${els.length})`); continue; }
    if (!els.length || !els.every((el) => shown(el))) missing.push(label);
  }

  // every <br> of the describe block ends a line in what is shown (CSS that hides or merges lines changes the meaning)
  const hiddenBr = [...reqEl.querySelectorAll("br")].filter((b) => getComputedStyle(b).display === "none").length;
  const desc = [...reqEl.children].find((k) => k.classList.contains("req") && !k.classList.contains("dim"));
  let text = "";
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) text += c.textContent;
      else if (c.nodeName === "BR") text += "\n";
      else if (c.nodeType === 1 && getComputedStyle(c).display !== "none") walk(c);
    }
  };
  if (desc) walk(desc);
  const squeeze = (s) => s.replace(/[^\S\n]+/g, "");
  const segs = squeeze(text).split("\n").filter(Boolean);
  let flat = "";
  const breakAt = new Set();
  for (const ch of desc ? squeeze(desc.innerText) : "") {
    if (ch === "\n") breakAt.add(flat.length);
    else flat += ch;
  }
  const lost = [];
  let at = 0;
  for (let i = 0; i < segs.length; i++) {
    const found = flat.indexOf(segs[i], at);
    if (found === -1) { lost.push(`"${segs[i].slice(0, 24)}" not shown`); break; }
    let broke = false;
    for (let k = at; k <= found; k++) if (breakAt.has(k)) broke = true;
    if (i > 0 && !broke) lost.push(`no break before "${segs[i].slice(0, 24)}"`);
    at = found + segs[i].length;
  }
  // the line under the buttons: while the request does not end in view it names the recipient rows not fully in view,
  // otherwise it says whether Approve is live; it sits in the footer under the buttons, inside the window, so it covers
  // nothing
  const RCPT = new Set(["To", "Resolves to", "Paid to", "Only fillable by"]);
  const open = reqEl.scrollTop + reqEl.clientHeight < reqEl.scrollHeight - 1;
  const hiddenRcpt = [...reqEl.querySelectorAll(".kv > div")].filter((r) => RCPT.has(r.querySelector("dt")?.textContent ?? "") && r.getBoundingClientRect().bottom > reqEl.getBoundingClientRect().bottom + 0.5).length;
  const cueEl = document.getElementById("ap-state");
  const barBottom = Math.max(document.getElementById("btn-reject").getBoundingClientRect().bottom, document.getElementById("btn-approve").getBoundingClientRect().bottom);
  const sim = document.getElementById("token-sim");
  const approve = document.getElementById("btn-approve");
  const cue = { text: cueEl ? cueEl.textContent : null, open, hiddenRcpt, clear: !!cueEl && cueEl.getBoundingClientRect().top >= barBottom - 0.5 && cueEl.getBoundingClientRect().bottom <= innerHeight + 0.5,
    live: !approve.disabled, latched: document.getElementById("btn-reject").disabled, confirmStep: approve.textContent === "Sign anyway",
    tokenWait: !!sim && !/^Filling this debits/.test(sim.textContent) };
  // a look-alike is danger, a first send caution (owner decision 2026-10-25): each warning row's tier against its words
  const tiers = [...(document.getElementById("send-warn")?.querySelectorAll(".check") ?? [])].map((c) => {
    const tier = c.classList.contains("danger") ? "danger" : c.classList.contains("caution") ? "caution" : "other";
    const want = /address-poisoning/.test(c.textContent) ? "danger" : "caution";
    return { tier, ok: tier === want };
  });
  return { below, cue, late, marked, missing, tiers, lowest: lowest && { what: lowest.what, gap: Math.round(fold - lowest.bottom) }, scrollTop: reqEl.scrollTop, hiddenBr, lost };
}

// Wait until Reject is armed, every mount the request carries is painted (the listing, the token quote, the reveal
// preview) and the request has not changed for 400 ms (the warnings and a name action's verdict land after the arm).
export const settle = (page) => page.evaluate(() => new Promise((done) => {
  let last = performance.now();
  const mo = new MutationObserver(() => { last = performance.now(); });
  mo.observe(document.getElementById("req"), { subtree: true, childList: true, characterData: true, attributes: true });
  const start = performance.now();
  const tick = () => {
    const armed = !document.getElementById("btn-reject").disabled
      && !["fill-view", "token-sim", "reveal-preview"].some((id) => document.getElementById(id)?.hidden);
    if ((armed && performance.now() - last > 400) || performance.now() - start > 9000) { mo.disconnect(); done(); } else setTimeout(tick, 50);
  };
  tick();
}));

// The window's own document never scrolls: only the request does. Its scroll height is the window's, and a scroll of the
// document or a wheel over the header moves neither the origin nor the buttons (an absolutely positioned element with
// no positioned ancestor inside the request once made the document 11,200 px tall at 500 flagged rows).
export async function windowFixed(page) {
  const at = () => page.evaluate(() => [document.getElementById("ap-origin").getBoundingClientRect().top, document.getElementById("btn-approve").getBoundingClientRect().top]);
  const before = await at();
  const doc = await page.evaluate(() => { const se = document.scrollingElement; const h = se.scrollHeight; window.scrollTo(0, 1e6); return { h, inner: innerHeight, y: window.scrollY }; });
  const box = await page.evaluate(() => { const r = document.querySelector(".ap-top").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y); await page.mouse.wheel(0, 2000); await page.waitForTimeout(150);
  const after = await at();
  await page.evaluate(() => window.scrollTo(0, 0));
  return { ok: doc.h <= doc.inner && doc.y === 0 && after.join() === before.join(), doc, before, after };
}

// The line's words, written out here so a change to them fails the tests that use them (security copy: listed for the
// owner's sign-off).
export const STATE = { arming: "Arming: both buttons wait 700 ms", ready: "Ready.", readyUnconfirmed: "Ready. Read the warning above before you sign.",
  held: "Approve is off: see the warning above.", tokenWait: "Approve waits for the token amount." };
export const cueText = ({ open, hiddenRcpt, live, latched, confirmStep, tokenWait }) => latched ? STATE.arming
  : open ? (hiddenRcpt === 1 ? "1 more recipient below: scroll to see it" : hiddenRcpt > 1 ? `${hiddenRcpt} more recipients below: scroll to see them` : "More below: scroll to read the whole request")
  : live ? (confirmStep ? STATE.readyUnconfirmed : STATE.ready) : tokenWait ? STATE.tokenWait : STATE.held;

// Where the buttons are and where the request area ends: neither moves when the line comes or goes, or a mount fills.
export const buttonsAt = (page) => page.evaluate(() => [document.getElementById("btn-reject").getBoundingClientRect().top, document.getElementById("btn-approve").getBoundingClientRect().top, document.getElementById("req").getBoundingClientRect().bottom]);
