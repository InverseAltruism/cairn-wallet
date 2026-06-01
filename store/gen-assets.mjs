// Generate Chrome Web Store visual assets as self-contained HTML at exact pixel sizes,
// to be rendered + screenshotted by a headless browser. Brand = Cairn's monochrome
// phosphor-terminal look. Embeds the live popup captures + the wallet logo as base64.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SHOTS = "/tmp/wallet-shots";
const OUT = join(ROOT, "store", "assets");

const b64 = (p) => existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString("base64")}` : "";
const logo = b64(join(ROOT, "public", "icons", "logo-white.png"));
const icon = b64(join(ROOT, "public", "icons", "icon-128.png"));

const FONT = `ui-monospace,SFMono-Regular,Menlo,monospace`;
const css = `*{margin:0;padding:0;box-sizing:border-box}html,body{background:#070707;color:#e6e6e6;font-family:${FONT};overflow:hidden}`;

// A 1280×800 store screenshot: caption on the left, device-framed popup on the right.
function screenshot({ shot, kicker, head, sub }) {
  return `<!doctype html><meta charset=utf-8><style>${css}
  .wrap{width:1280px;height:800px;display:flex;align-items:center;gap:60px;padding:0 90px;
    background:radial-gradient(1200px 600px at 78% 50%,rgba(110,231,160,.06),transparent 60%),#070707}
  .left{flex:1}
  .kick{color:#6ee7a0;font-size:20px;letter-spacing:3px;text-transform:uppercase;margin-bottom:22px}
  h1{font-size:62px;line-height:1.07;font-weight:700;letter-spacing:-1px}
  p{margin-top:26px;font-size:25px;line-height:1.5;color:#9a9a9a;max-width:560px}
  .brand{position:absolute;top:46px;left:90px;display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;letter-spacing:1px}
  .brand img{height:40px}
  .brand .d{color:#7d7d7d;font-weight:400}
  .device{width:392px;flex:none;border:1px solid #2a2a2a;border-radius:22px;padding:14px;background:#0c0c0c;
    box-shadow:0 40px 120px rgba(0,0,0,.7),0 0 0 1px rgba(110,231,160,.05)}
  .device img{width:100%;display:block;border-radius:12px}
  </style>
  <div class=wrap>
    <div class=brand><img src="${logo}">CAIRN <span class=d>wallet</span></div>
    <div class=left><div class=kick>${kicker}</div><h1>${head}</h1><p>${sub}</p></div>
    <div class=device><img src="${b64(join(SHOTS, shot))}"></div>
  </div>`;
}

// 440×280 small promo tile.
const promo = `<!doctype html><meta charset=utf-8><style>${css}
  .t{width:440px;height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    background:radial-gradient(500px 300px at 50% 30%,rgba(110,231,160,.10),transparent 60%),#070707;text-align:center}
  .t img{height:84px}
  .n{font-size:34px;font-weight:700;letter-spacing:1px}
  .n .d{color:#7d7d7d;font-weight:400}
  .s{color:#6ee7a0;font-size:15px;letter-spacing:1px}
  </style><div class=t><img src="${logo}"><div class=n>CAIRN <span class=d>wallet</span></div>
  <div class=s>non-custodial CSD wallet</div></div>`;

// 1400×560 marquee tile.
const marquee = `<!doctype html><meta charset=utf-8><style>${css}
  .m{width:1400px;height:560px;display:flex;align-items:center;gap:70px;padding:0 110px;
    background:radial-gradient(1000px 600px at 80% 50%,rgba(110,231,160,.07),transparent 60%),#070707}
  .m .txt{flex:1}.m img.logo{height:64px;margin-bottom:26px}
  .m h1{font-size:66px;font-weight:700;letter-spacing:-1px;line-height:1.05}
  .m p{margin-top:24px;font-size:26px;color:#9a9a9a;max-width:680px;line-height:1.5}
  .m .dev{width:360px;flex:none;border:1px solid #2a2a2a;border-radius:20px;padding:12px;background:#0c0c0c;box-shadow:0 40px 110px rgba(0,0,0,.7)}
  .m .dev img{width:100%;display:block;border-radius:11px}
  </style><div class=m><div class=txt><img class=logo src="${logo}">
  <h1>Your keys. Your device.</h1>
  <p>A non-custodial wallet for Compute Substrate — local signing, a 12-word recovery phrase, and Sign in with CSD.</p></div>
  <div class=dev><img src="${b64(join(SHOTS, "3-main.png"))}"></div></div>`;

const screens = [
  { file: "screenshot-1.html", shot: "1-setup.png", kicker: "Self-custody", head: "Your keys.<br>Your device.", sub: "A 12-word recovery phrase is generated and encrypted locally with AES-256-GCM. It is never uploaded." },
  { file: "screenshot-2.html", shot: "2-backup.png", kicker: "BIP-39 · BIP-32 HD", head: "Back up once,<br>recover anywhere.", sub: "One standard recovery phrase restores every account, in order — portable to any compatible wallet." },
  { file: "screenshot-3.html", shot: "3-main.png", kicker: "On-chain", head: "Send, post,<br>and sign.", sub: "Transactions are built and signed on your device, then submitted to the node. The key never leaves the wallet." },
  { file: "screenshot-4.html", shot: "4-send.png", kicker: "Safe by default", head: "No surprises<br>before you sign.", sub: "Every send shows the full address, fee, and balance-after — with first-time and address-poisoning warnings." },
];

for (const s of screens) writeFileSync(join(OUT, s.file), screenshot(s));
writeFileSync(join(OUT, "promo-440x280.html"), promo);
writeFileSync(join(OUT, "marquee-1400x560.html"), marquee);
console.log("✓ wrote", screens.length, "screenshot templates + promo + marquee to store/assets/");
console.log("  logo embedded:", !!logo, "| icon present:", !!icon);
