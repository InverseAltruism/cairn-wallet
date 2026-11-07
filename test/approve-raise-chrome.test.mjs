// A raise the wallet makes re-arms the approval window, in Chromium with the extension built from src/ and loaded
// unpacked: the real worker, the real approval window, the real content script and window.cairn. Every host name fails
// to resolve, so nothing leaves the machine, and the fresh wallet holds no coins.
// The site queues a fill of its own offer and waits until Approve is live; then, on the first click of a double click,
// it asks for the same fill again. The worker refuses it FILL_IN_PROGRESS and raises the window, and the second click
// lands on the raised window's Approve. The test wraps the worker's chrome.windows.update to read the window's buttons
// when the worker raises it, and clicks Approve with the mouse at once.
//   RED-FIRST (src/ at 379c08b): the window was raised with Approve live, and the click approved the fill.
//   PAIRED HONEST PATHS: a fresh request's window arms as before; a click after the raise's floor approves the fill
//   once; a click on a later request with no raise approves it at once.
// What this cannot show: headless Chromium reports every window focused and gives pages no focus events, so the raise
// is read at the worker's call, by a message the wrapper sends after it; that message queues behind the re-arm on the
// same channel, so it would read the buttons off even if the worker raised the window without waiting for the answer.
// The wait (the window answers before the worker raises it) is pinned with a mock chrome in
// test/approve-raise-rearm.test.mjs.
// Needs playwright-core (PLAYWRIGHT_CORE) and a full Chromium (PLAYWRIGHT_CHROMIUM); prints SKIP without them.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { UI_SHIP, UI_VENDOR_DIR } from "../scripts/check-ui-vendor.mjs";
import { findChromium } from "../scripts/playwright-core.mjs";
import * as approveWindow from "../src/approve-window.ts";
import { checker } from "./helpers/check.mjs";

const chromium = await findChromium();
if (!chromium) {
  console.log("SKIP: playwright-core not found (set PLAYWRIGHT_CORE); runs when it is installed");
  process.exit(0);
}
const t = checker("approval window raised by the wallet, in Chromium with the extension loaded");
const ROOT = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "approve-raise-"));
const ext = join(work, "ext");

// The extension as build.mjs lays it out, plus an empty page the test drives the popup channel from.
const define = { __WALLET_VERSION__: '"0.0.0-test"' };
const common = { bundle: true, target: "es2022", logLevel: "warning", legalComments: "none", define, absWorkingDir: ROOT };
await build({ ...common, entryPoints: { background: "src/background.ts", approve: "src/popup/approve.ts" }, format: "esm", outdir: ext, splitting: false });
await build({ ...common, entryPoints: { content: "src/content.ts", inpage: "src/inpage.ts" }, format: "iife", outdir: ext });
writeFileSync(join(ext, "manifest.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, "public", "manifest.json"), "utf8")), version: "1.0.0" }));
for (const f of ["approve.html", "popup.css", "icons.svg"]) cpSync(join(ROOT, "src", "popup", f), join(ext, f));
for (const f of UI_SHIP) { mkdirSync(join(ext, "ui", f, ".."), { recursive: true }); cpSync(join(UI_VENDOR_DIR, f), join(ext, "ui", f)); }
cpSync(join(ROOT, "public", "icons"), join(ext, "icons"), { recursive: true });
writeFileSync(join(ext, "ctl.html"), "<!doctype html><title>ctl</title>");

const SITE = "https://dapp.test";
const OFFER = "0x" + "ab".repeat(32);
const FILL = { proposalId: OFFER, outputs: [{ to: "0x" + "31".repeat(20), value: 100_000_000 }], fee: 5_000_000 };
let ctx;
try {
  try {
    ctx = await chromium.launchPersistentContext(join(work, "profile"), {
      headless: false, executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, viewport: { width: 1000, height: 800 },
      args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-sandbox", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND"],
    });
  } catch (e) {
    if (!/executable doesn't exist|ENOENT/i.test(String(e?.message))) throw e;
    console.log(`SKIP: no Chromium binary for playwright-core (set PLAYWRIGHT_CHROMIUM): ${String(e.message).split("\n")[0]}`);
    process.exit(0);
  }
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  const ctl = await ctx.newPage();
  await ctl.goto(`chrome-extension://${id}/ctl.html`);
  const call = (method, ...args) => ctl.evaluate(([m, a]) => new Promise((res) => chrome.runtime.sendMessage({ kind: "popup", method: m, args: a }, res)), [method, args]);
  t.check("setup: the popup channel creates a wallet", (await call("create", "correct horse battery staple"))?.ok === true);
  // Each raise the worker makes: when, and the buttons the window shows then (read before the window is raised).
  await sw.evaluate(() => {
    const update = chrome.windows.update;
    globalThis.raises = [];
    chrome.windows.update = (...a) => {
      const rec = { at: performance.timeOrigin + performance.now() };
      globalThis.raises.push(rec);
      return chrome.runtime.sendMessage({ kind: "test-buttons" }).then((b) => { rec.buttons = b; }, (e) => { rec.error = String(e); }).then(() => update.apply(chrome.windows, a));
    };
  });
  const raises = () => sw.evaluate(() => globalThis.raises);

  // The worker never hears its own message: with no window open its re-arm finds no receiver (raised at once), and with
  // the window open the answer is the window's.
  const askWindow = () => sw.evaluate((kind) => chrome.runtime.sendMessage({ kind }).then((r) => ({ answer: r }), (e) => ({ error: String(e) })), approveWindow.APPROVE_REARM ?? "approve-rearm");
  const noWindow = await askWindow();
  t.check(`with no window open, the worker's re-arm message finds no receiver (${JSON.stringify(noWindow)})`, /Receiving end does not exist/.test(String(noWindow.error)));
  await ctx.route(`${SITE}/**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>dapp</title><p>dapp</p>" }));
  const site = await ctx.newPage();
  await site.goto(`${SITE}/trade`);
  await site.waitForFunction(() => !!window.cairn, null, { timeout: 10_000 });

  // The site's fill of its own offer opens the approval window; the request arms as before.
  await site.evaluate((p) => { window.first = undefined; window.cairn.fillOffer(p).then((r) => { window.first = r; }); }, FILL);
  // The window's page reports its URL once it has navigated, after the page event.
  let approval = null;
  for (let i = 0; i < 300 && !approval; i++) {
    approval = ctx.pages().find((p) => p.url().endsWith("/approve.html")) ?? null;
    if (!approval) await site.waitForTimeout(50);
  }
  if (!approval) throw new Error("the approval window did not open");
  const paint = await (await approval.waitForFunction((offer) => {
    const req = document.getElementById("req");
    return req && !document.getElementById("view-req").hidden && req.textContent.includes(offer.slice(0, 10))
      && { approveOff: document.getElementById("btn-approve").disabled, rejectOff: document.getElementById("btn-reject").disabled, at: performance.timeOrigin + performance.now() };
  }, OFFER, { timeout: 15_000, polling: "raf" })).jsonValue();
  t.check(`honest path, a fresh request: both buttons are off when the fill first shows (${JSON.stringify(paint)})`, paint.approveOff === true && paint.rejectOff === true);
  const armedAt = await (await approval.waitForFunction(() => !document.getElementById("btn-approve").disabled && performance.timeOrigin + performance.now(), null, { timeout: 15_000, polling: "raf" })).jsonValue();
  t.check(`honest path, a fresh request: Approve arms ${Math.round(armedAt - paint.at)} ms after the fill shows`, armedAt - paint.at >= 650);
  await approval.evaluate(() => chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m?.kind !== "test-buttons") return undefined;
    reply({ approveOff: document.getElementById("btn-approve").disabled, rejectOff: document.getElementById("btn-reject").disabled });
  }));
  const fromWindow = await askWindow();
  t.check(`with the window open, the re-arm is answered by the window (${JSON.stringify(fromWindow)})`, fromWindow.answer?.ok === true);
  await approval.waitForFunction(() => !document.getElementById("btn-approve").disabled, null, { timeout: 15_000, polling: "raf" });
  const box = await approval.locator("#btn-approve").boundingBox();
  const pendingIds = async () => ((await call("pending"))?.result ?? []).map((p) => p.id);
  const [fillId] = await pendingIds();

  // The double click: the first click asks for the same fill, the second lands on the raised window's Approve.
  const refusal = await site.evaluate((p) => window.cairn.fillOffer(p), FILL);
  t.check(`the site's second fill of its held offer is refused FILL_IN_PROGRESS (${refusal?.code})`, refusal?.ok === false && refusal?.code === "FILL_IN_PROGRESS");
  let r = [];
  const read = (x) => x.length && (x[0].buttons || x[0].error);
  for (let i = 0; i < 200 && !read(r = await raises()); i++) await approval.waitForTimeout(5);
  const raise = r[0];
  await approval.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const clickAt = await approval.evaluate(() => performance.timeOrigin + performance.now());
  t.check(`the refusal made the worker raise the window (${r.length} raise)`, r.length === 1);
  t.check(`when the worker raised the window, Approve and Reject were off (${JSON.stringify(raise?.buttons ?? raise?.error)})`, raise?.buttons?.approveOff === true && raise?.buttons?.rejectOff === true);
  await approval.waitForTimeout(150);
  const stillQueued = (await pendingIds()).includes(fillId);
  const unanswered = await site.evaluate(() => window.first === undefined);
  t.check(`a mouse click on Approve ${Math.round(clickAt - (raise?.at ?? clickAt))} ms after the raise is ignored: the fill is still queued and unanswered`, stillQueued && unanswered);

  // Paired honest path: once the floor has run, the mouse click approves the fill once.
  const liveAgain = await (await approval.waitForFunction(() => !document.getElementById("btn-approve").disabled && performance.timeOrigin + performance.now(), null, { timeout: 15_000, polling: "raf" })).jsonValue();
  t.check(`honest path: Approve arms again ${Math.round(liveAgain - raise.at)} ms after the raise`, liveAgain - raise.at >= 650);
  await approval.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await site.waitForFunction(() => window.first !== undefined, null, { timeout: 30_000 });
  const first = await site.evaluate(() => window.first);
  const code = first?.code ?? first?.result?.code;
  t.check(`honest path: the click approved the fill once: it left the queue and the site got the fill's own answer (${code})`, !(await pendingIds()).includes(fillId) && code !== "USER_REJECTED" && code !== "APPROVAL_CLOSED" && code !== undefined);

  // Paired honest path: a request painted with no raise after its floor takes the user's click at once.
  const n = (await raises()).length;
  await site.evaluate(() => { window.second = undefined; window.cairn.send({ to: "0x" + "32".repeat(20), amount: 100_000_000, fee: 1_000_000 }).then((x) => { window.second = x; }); });
  await approval.waitForFunction(() => document.getElementById("req").textContent.includes("3232"), null, { timeout: 15_000, polling: "raf" });
  await approval.waitForFunction(() => !document.getElementById("btn-approve").disabled, null, { timeout: 15_000, polling: "raf" });
  const quietFrom = (await raises()).length;
  await approval.bringToFront();
  await approval.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await site.waitForFunction(() => window.second !== undefined, null, { timeout: 30_000 });
  const second = await site.evaluate(() => window.second);
  const code2 = second?.code ?? second?.result?.code;
  t.check(`honest path: with no raise since it armed, the user's click approves the send at once (${code2}; ${quietFrom - n} raise when it queued, ${(await raises()).length - quietFrom} since)`,
    (await raises()).length === quietFrom && code2 !== "USER_REJECTED" && code2 !== "APPROVAL_CLOSED" && code2 !== undefined);
} finally {
  await ctx?.close();
  rmSync(work, { recursive: true, force: true });
}
t.done("approve-raise-chrome");
