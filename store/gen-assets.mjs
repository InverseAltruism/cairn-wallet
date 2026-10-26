// Renders the Chrome Web Store images into store/assets/: the popup and approval-window captures they frame, five
// 1280x800 screenshots, the 440x280 promo tile and the 1400x560 marquee. The captures come from the built pages of
// this checkout (test/helpers/walletpage.mjs: the real popup.html and approve.html, bundled from src/, answered by a
// fixed demo wallet, every network request aborted), so the images follow the code. Colours, type and spacing are
// the vendored cairn-ui tokens and Geist; nothing is uploaded.
// Run: PLAYWRIGHT_CORE=<playwright-core dir> PLAYWRIGHT_CHROMIUM=<chrome binary> node store/gen-assets.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchOrSkip, openWalletPage } from "../test/helpers/walletpage.mjs";
import { APPROVE_WINDOW } from "../src/approve-window.ts";
import { readMark } from "../scripts/mark.mjs";
// the approval window's page at the size the wallet opens it: Linux draws no frame inside those bounds (measured);
// test/approve-layout-chrome.test.mjs measures the fold at the largest frame seen, the store shows the window as shipped
const APPROVE_PAGE = { width: APPROVE_WINDOW.width, height: APPROVE_WINDOW.height };

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "store", "assets");
const UI = join(ROOT, "src", "vendor", "cairn-ui");

// The demo wallet: one account with a primary name, two tokens, a short history.
const ME = "0x7a3f9c217a3f9c217a3f9c217a3f9c217a3f9c21";
const PAID = "0x31c4e0a9b27d58f6e13a90c4d7b2f85e6a1d3c90";
const NEW = "0x8e2b61f0c4a97d35e0b18c6f2a94d07b53e1c8a2";
const T0 = Date.UTC(2026, 9, 24, 15, 30);
const status = { hasVault: true, unlocked: true, addr: ME, active: 0, hasMnemonic: true, rpc: "https://cairn-substrate.com/api/rpc", explorer: "cairn", api: "https://cairn-substrate.com", tradeApi: "https://cairn-substrate.com/trade/api", accounts: [{ addr: ME, label: "Main" }] };
const popupAnswers = {
  status, balance: { confirmed: 128_473_500_000, utxos: [] }, pendingMerge: { pending: false, amount: 0, maybe: false, stuck: false }, prewarmSpv: { ok: true }, pending: [],
  cairnxAssets: { ok: true, primaryName: "alice", tipHeight: 120_000, balances: { CAIRN: { available: "1250000000000", locked: "0" }, SUNRISE: { available: "4200000", locked: "500000" } }, names: ["alice", "studio"],
    nameDetails: [{ name: "alice", leased: true, epochsLeft: 6000 }, { name: "studio", leased: true, epochsLeft: 400 }] },
  // CAIRN carries the deploy id the wallet pins, so its row shows the Cairn mark (src/popup/tiles.ts)
  cairnxTokens: { ok: true, tokens: [{ ticker: "CAIRN", decimals: 8, deployId: "0xdf7113afc41319b700c26f26ba657c8267533a3dd511cc59776601a9aba03517" }, { ticker: "SUNRISE", decimals: 2 }] },
  history: [
    { type: "send", to: PAID, amount: 150_000_000, fee: 1_000_000, txid: "0x" + "a1".repeat(32), ts: T0 },
    { type: "fillOffer", to: PAID, amount: 250_000_000, txid: "0x" + "a3".repeat(32), ts: T0 - 7_200_000 },
    { type: "post", title: "Wallet 0.3 feedback thread", fee: 25_000_000, txid: "0x" + "a5".repeat(32), ts: T0 - 86_400_000 },
  ],
  sealedClaims: [], connectedSites: [], rpcList: [], explorerList: [],
};
const approveAnswers = {
  status: { ...status, tradeApi: "https://x.invalid" }, balance: { confirmed: 128_473_500_000 }, history: [], tip: 120_000, epoch: 4_000, tipFloor: 0, sealedClaims: [], tokenDisplayMeta: {},
  pending: [{ id: "r-send", method: "send", origin: "https://cairn-substrate.com", params: { to: NEW, amount: 150_000_000, fee: 1_000_000 } }],
};

// [file, page, theme, what to do on the page first, if anything]
const CAPTURES = [
  ["1-home.png", "popup", "dark", null],
  ["2-send-review.png", "popup", "dark", async (p) => { await p.click("#btn-send-t"); await p.fill("#s-to", NEW); await p.fill("#s-amt", "1.5"); await p.click("#btn-send"); }],
  ["3-approve.png", "approve", "dark", null],
  ["4-names.png", "popup", "dark", async (p) => { await p.click("#nav-names"); }],
  ["5-home-light.png", "popup", "light", null],
];

const SCREENS = [
  { shot: "1-home.png", theme: "dark", kicker: "Self-custody", head: "Your keys stay on your device.", sub: "A 12-word recovery phrase is generated and encrypted on your device with AES-256-GCM. It is never uploaded." },
  { shot: "2-send-review.png", theme: "dark", kicker: "Review", head: "Check before you sign.", sub: "Every send shows the full address in groups of four, the fee and your balance after, with first-time and look-alike warnings." },
  { shot: "3-approve.png", theme: "dark", kicker: "Websites", head: "Sites ask. You approve.", sub: "A site's request opens in the wallet's approval window: who asks, what leaves your wallet and what it costs, before you sign." },
  { shot: "4-names.png", theme: "dark", kicker: ".csd names", head: "Send to a name, not a string of hex.", sub: "The wallet checks a name's address against block headers it verifies itself, and says how sure it can be." },
  { shot: "5-home-light.png", theme: "light", kicker: "Light and dark", head: "Follows your system.", sub: "Or choose light or dark in Settings. The approval window follows the same choice." },
];

const b64 = (p) => readFileSync(p).toString("base64");
const fontFaces = ["Geist", "Geist Mono"].map((family) => {
  const file = family === "Geist" ? "Geist-Latin.woff2" : "GeistMono-Latin.woff2";
  return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${b64(join(UI, "fonts", file))}) format("woff2");font-weight:100 900;font-style:normal}`;
}).join("");
const tokens = readFileSync(join(UI, "tokens.css"), "utf8");
const MARK = readMark();
// the mark sets no paint, so the drawing <svg> sets fill
const mark = (cls) => `<svg class="${cls}" viewBox="${MARK.viewBox}" fill="currentColor" aria-hidden="true">${MARK.parts.join("")}</svg>`;

const page = (theme, w, h, css, body) => `<!doctype html><html data-theme="${theme}"><meta charset="utf-8"><style>${fontFaces}${tokens}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:var(--ui-bg);color:var(--ui-ink);font-family:var(--ui-font-sans);-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:var(--ui-space-3);font-size:var(--ui-text-lg);font-weight:600;letter-spacing:-0.01em}
.brand .mark{width:30px;height:30px;color:var(--ui-ink)}
.brand span{color:var(--ui-muted);font-weight:500}
.kick{color:var(--ui-muted);font-size:var(--ui-text-sm);font-weight:500;letter-spacing:0.08em;text-transform:uppercase}
.device{flex:none;border-radius:var(--ui-radius-xl);border:1px solid var(--ui-line-2);overflow:hidden;box-shadow:var(--ui-shadow-2);background:var(--ui-surface)}
.device img{display:block}
${css}</style><body>${body}</body></html>`;

function screenshot({ shot, theme, kicker, head, sub }, img) {
  const w = img.page === "approve" ? APPROVE_PAGE.width : 360, h = img.page === "approve" ? APPROVE_PAGE.height : 600, scale = 640 / h;
  return page(theme, 1280, 800, `
.wrap{width:1280px;height:800px;display:flex;align-items:center;gap:var(--ui-space-9);padding:0 var(--ui-space-9)}
.left{flex:1;display:flex;flex-direction:column;gap:var(--ui-space-5)}
h1{font-size:var(--ui-text-5xl);line-height:var(--ui-leading-tight);font-weight:600;letter-spacing:-0.025em}
p{font-size:var(--ui-text-xl);line-height:var(--ui-leading-body);color:var(--ui-ink-2);max-width:520px}
.brand{position:absolute;top:var(--ui-space-7);left:var(--ui-space-9)}
.device img{width:${Math.round(w * scale)}px;height:${Math.round(h * scale)}px}`,
  `<div class="brand">${mark("mark")}Cairn <span>Wallet</span></div><div class="wrap"><div class="left"><div class="kick">${kicker}</div><h1>${head}</h1><p>${sub}</p></div>
  <div class="device"><img src="data:image/png;base64,${img.data}"></div></div>`);
}
const promo = page("dark", 440, 280, `
.t{width:440px;height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--ui-space-4);text-align:center}
.t .mark{width:72px;height:72px;color:var(--ui-ink)}
.n{font-size:var(--ui-text-3xl);font-weight:600;letter-spacing:-0.02em}
.n span{color:var(--ui-muted);font-weight:500}
.s{color:var(--ui-ink-2);font-size:var(--ui-text-md)}`,
`<div class="t">${mark("mark")}<div class="n">Cairn <span>Wallet</span></div><div class="s">A non-custodial wallet for Compute Substrate</div></div>`);
const marquee = (img) => page("dark", 1400, 560, `
.m{width:1400px;height:560px;display:flex;align-items:center;gap:var(--ui-space-9);padding:0 var(--ui-space-9);overflow:hidden}
.txt{flex:1;display:flex;flex-direction:column;gap:var(--ui-space-5)}
h1{font-size:var(--ui-text-5xl);line-height:var(--ui-leading-tight);font-weight:600;letter-spacing:-0.025em}
p{font-size:var(--ui-text-xl);line-height:var(--ui-leading-body);color:var(--ui-ink-2);max-width:620px}
.device{align-self:flex-start;margin-top:var(--ui-space-8)}
.device img{width:384px;height:640px}`,
`<div class="m"><div class="txt"><div class="brand">${mark("mark")}Cairn <span>Wallet</span></div><h1>Your keys. Your device.</h1>
<p>A non-custodial wallet for Compute Substrate: local signing, a 12-word recovery phrase, clear-signed site requests and Sign in with CSD.</p></div>
<div class="device"><img src="data:image/png;base64,${img.data}"></div></div>`);

const browser = await launchOrSkip();
if (!browser) process.exit(1);
mkdirSync(OUT, { recursive: true });
const shots = new Map();
try {
  for (const [file, which, theme, steps] of CAPTURES) {
    const answers = which === "approve" ? approveAnswers : popupAnswers;
    const viewport = which === "approve" ? APPROVE_PAGE : { width: 360, height: 600 };
    const { page: p, ctx, errors } = await openWalletPage(browser, which, answers, { viewport, colorScheme: theme, deviceScaleFactor: 2 });
    try {
      await p.waitForSelector(which === "approve" ? "#view-req:not([hidden])" : "#view-main:not([hidden])", { timeout: 15_000 });
      await p.evaluate(() => document.fonts.ready);
      await p.waitForTimeout(900);
      if (steps) await steps(p);
      await p.waitForTimeout(1_200);
      if (errors.length) throw new Error(`${file}: page error ${errors.join(" | ")}`);
      const path = join(OUT, file);
      await p.screenshot({ path });
      shots.set(file, { page: which, data: b64(path) });
    } finally { await ctx.close(); }
  }
  const render = async (file, html, width, height) => {
    const ctx = await browser.newContext({ viewport: { width, height } });
    try {
      const p = await ctx.newPage();
      await p.route("**/*", (route) => route.abort());   // the page is self-contained: data URLs only
      await p.setContent(html);
      await p.evaluate(() => document.fonts.ready);
      await p.screenshot({ path: join(OUT, file) });
    } finally { await ctx.close(); }
  };
  for (const [i, s] of SCREENS.entries()) await render(`screenshot-${i + 1}.png`, screenshot(s, shots.get(s.shot)), 1280, 800);
  await render("promo-440x280.png", promo, 440, 280);
  await render("marquee-1400x560.png", marquee(shots.get("1-home.png")), 1400, 560);
} finally { await browser.close(); }
console.log(`wrote ${CAPTURES.length} captures, ${SCREENS.length} screenshots, the promo tile and the marquee to store/assets/`);
