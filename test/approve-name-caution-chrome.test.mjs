// A .csd name transfer or profile write whose served name record does not give the name to the signing account
// (test/sign-display-parity.test.mjs section 14), in the approval window at its real size in Chrome: the caution lands
// in #nfin-note after the paint, at both window heights and in both themes. While the read is held Approve is live and
// reads "Approve"; once it answers, the caution renders above the buttons with everything else that has weight
// (test/helpers/approve-measure.mjs `measure`), Approve stays live and reads "Sign anyway", the line under the buttons
// asks to read the warning, and neither the buttons nor the density move. The longest honest removed-keys list beside
// the caution can run past the fold as served text can: what comes before it stays above the buttons and the line says
// more is below. Both cards paint compact at both heights, so their density reserve (approve-density.ts reservesFor)
// decides nothing here: these checks pass with or without it (run 2026-11-18). Its own file because
// test/approve-layout-chrome.test.mjs already takes most of the runner's 180 s per-file cap.
//   RED-FIRST: drop the paintLabels call in approve.ts applyNfin and the label and line checks fail (40 of them).
// Needs playwright-core (PLAYWRIGHT_CORE) and a Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import * as cx from "../src/core/cairnx.ts";
import { APPROVE_FRAME_PX, APPROVE_WINDOW } from "../src/approve-window.ts";
import { checker } from "./helpers/check.mjs";
import { launchOrSkip, openWalletPage } from "./helpers/walletpage.mjs";
import { measure, settle, windowFixed, buttonsAt, STATE, cueText } from "./helpers/approve-measure.mjs";

const INNER_H = APPROVE_WINDOW.height - APPROVE_FRAME_PX;
const WIDTH = APPROVE_WINDOW.width;
const browser = await launchOrSkip();
if (!browser) process.exit(0);
const t = checker(`the name record caution in Chrome (${WIDTH} by ${INNER_H} and ${APPROVE_WINDOW.height})`);

const ME = "0x" + "7a3f9c21".repeat(5);
const RCPT = "0x" + "31".repeat(20);
const R3 = "0x" + "33".repeat(20);
const D = "https://dapp.example";
const nfinTip = 117_200;
const req = (id, method, origin, params) => ({ id, method, origin, params });
const prop = (rec) => ({ domain: cx.CAIRNX_DOMAIN, uri: rec.uri, payloadHash: rec.payloadHash, fee: 25_000_000, expiresEpoch: 4_100 });
const base = {
  status: { hasVault: true, unlocked: true, addr: ME, active: 0, accounts: [{ addr: ME, label: "Main" }], tradeApi: "https://x.invalid" },
  balance: { confirmed: 128_473_500_000 }, history: [], epoch: Math.floor(nfinTip / 30), tip: nfinTip, tipFloor: 0,
};
// a current profile at the 16-key cap, every key 32 characters
const wide = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`${i}`.padStart(32, "w"), "v"]));

function heldNameAnswer([status, body]) {
  let release;
  const answered = new Promise((r) => { release = r; });
  window.__answerName = () => release();
  const real = window.fetch;
  window.fetch = (url, opts) => /\/cairnx\/name\//.test(String(url))
    ? answered.then(() => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
    : real(url, opts);
}
const served = (extra) => [200, { name: "alice", owner: ME, locked: false, tipHeight: nfinTip, ...extra }];
const NAME_STATES = [["another owner", served({ owner: R3 })], ["pending", served({ pending: true })], ["lapsed", served({ expired: true })],
  ["locked", served({ locked: true })], ["no record", [404, { ok: false }]], ["another owner, 16 keys removed", served({ owner: R3, profile: wide })]];
const NAME_CARDS = [
  ["name-nxfer", req("cx", "propose", D, prop(cx.buildNameXfer({ name: "alice", to: RCPT }))), ["First time transferring a name to", "This transfer is final", "#nfin-note", "to:1", "cost"]],
  ["name-nprofile", req("cp", "propose", D, prop(cx.buildNameProfile({ name: "alice", profile: { contenthash: "ipfs://site-b", wallet: RCPT } }))), ["replaces the whole profile", "Other applications read this key", "Keys removed", "#nfin-note", "cost"]],
];
try {
  for (const [height, hTag] of [[INNER_H, "framed"], [APPROVE_WINDOW.height, "full"]]) for (const theme of ["light", "dark"]) {
    for (const [card, r, expect] of NAME_CARDS) for (const [state, answer] of NAME_STATES) {
      if (card === "name-nprofile" && state === "locked") continue;   // a profile write on a locked name is applied: no caution
      if (card === "name-nxfer" && state.includes("keys")) continue;   // a transfer card has no removed-keys row
      const tag = `${hTag} ${theme} ${card}, ${state}`;
      const { page, ctx, errors } = await openWalletPage(browser, "approve", { ...base, pending: [r] }, { viewport: { width: WIDTH, height }, colorScheme: theme, init: heldNameAnswer, initArg: answer });
      try {
        await page.waitForSelector("#view-req:not([hidden])", { timeout: 10_000 });
        await settle(page);
        const face = () => page.evaluate(() => ({ live: !document.getElementById("btn-approve").disabled, label: document.getElementById("btn-approve").textContent,
          note: !!document.getElementById("nfin-note"), density: document.getElementById("app").dataset.density, line: document.getElementById("ap-state").textContent }));
        const before = { ...(await face()), at: await buttonsAt(page) };
        t.check(`${tag}: while the read is held, Approve is live and reads "${before.label}", no caution`, before.live && before.label === "Approve" && !before.note);
        await page.evaluate(() => window.__answerName());
        await page.waitForSelector("#nfin-note", { timeout: 5_000 });
        await settle(page);
        const after = { ...(await face()), at: await buttonsAt(page) };
        const m = await page.evaluate(measure, [expect, r.origin]);
        if (state.includes("keys")) {
          // The longest honest removed-keys list is served text and can run past the fold, as any served text can
          // (approve-density.ts): what comes before it stays above the buttons, the row starts in view, the line says so.
          const rowTop = await page.evaluate(() => [...document.querySelectorAll("#req .kv > div")].find((d) => d.querySelector("dt")?.textContent === "Keys removed").getBoundingClientRect().top < document.getElementById("btn-approve").getBoundingClientRect().top);
          t.check(`${tag}: the caution and everything before the removed keys are above the buttons, the row starts in view (${rowTop}) and the line says more is below (below: ${m.below.join(", ") || "none"}; "${m.cue.text}")`,
            m.missing.length === 0 && m.below.every((w) => w.startsWith("row Keys removed")) && rowTop && m.cue.open && m.late.length === 0 && m.scrollTop === 0);
        } else t.check(`${tag}: the caution and everything with weight are above the buttons (missing: ${m.missing.join(", ") || "none"}; below: ${m.below.join(", ") || "none"}; late: ${m.late.join(", ") || "none"})`, m.missing.length === 0 && m.below.length === 0 && m.late.length === 0 && m.scrollTop === 0);
        t.check(`${tag}: Approve stays live and reads "${after.label}"; the line says "${after.line}"`, after.live && after.label === "Sign anyway" && m.cue.text === cueText(m.cue) && m.cue.clear && (m.cue.open || after.line === STATE.readyUnconfirmed));
        t.check(`${tag}: the buttons and the density do not move when the caution lands (${before.at} then ${after.at}; ${before.density} then ${after.density})`, after.at.join() === before.at.join() && after.density === before.density);
        const fx = await windowFixed(page);
        t.check(`${tag}: the window itself does not scroll (document ${fx.doc.h} of ${fx.doc.inner} px)`, fx.ok);
        t.check(`${tag}: no page error (${errors.join(" | ") || "none"})`, errors.length === 0);
      } finally {
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
t.done("approve-name-caution-chrome");
