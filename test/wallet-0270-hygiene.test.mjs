// 0.2.70 source-structure pins: connector hang, popup isolation, snapshot detach,
// armButtons warning floor, CSD review parallel, proveEventAt pool, versions.
import { readFileSync } from "node:fs";
import { refuse } from "../src/core/refuse.ts";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.error("  ✗ " + n)); };
const src = (rel) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");

console.log("0.2.70 hygiene:");

const content = src("src/content.ts");
ok("content lastError posts WALLET_UNAVAILABLE (no silent hang)",
  /chrome\.runtime\.lastError/.test(content) && /WALLET_UNAVAILABLE/.test(content) && /cairn-inpage/.test(content));
ok("MUT: lastError is not a bare return", !/if \(chrome\.runtime\.lastError\) return;/.test(content));

const bg = src("src/background.ts");
ok("await ready still sendResponse on init reject",
  /await ready/.test(bg) && /WALLET_UNAVAILABLE/.test(bg) && /failed to initialize/.test(bg));
ok("openApprovalWindow is single-flight latched", /openingApproval/.test(bg) && /if \(openingApproval\) return openingApproval/.test(bg));
ok("confirmName is popup-bridged and READ_ONLY", /case "confirmName"/.test(bg) && /"confirmName"/.test(bg));

const popup = src("src/popup/popup.ts");
ok("popup has no Wallet value import", !/import\s*\{[^}]*\bWallet\b/.test(popup));
ok("popup imports Wallet as type only (or not at all as a value)", /import type \{ Wallet \}/.test(popup));
ok("popup explorer comes from explorer.ts", /from "\.\.\/core\/explorer\.js"/.test(popup));
ok("popup dynamically imports devshim", /import\("\.\/devshim\.js"\)/.test(popup));
ok("CSD Review parallelizes recipientChecks+balance",
  /const \[b, checks\] = await Promise\.all\(\[call\("balance"\)\.catch\(\(\) => null\), recipientChecks\(to\)\]\)/.test(popup));

const approve = src("src/popup/approve.ts");
ok("armButtons still owns the 700ms timer", /function armButtons\(\)[\s\S]*setTimeout\([\s\S]*700\)/.test(approve));
ok("armButtons waits for fillSendWarning (and, 0.2.71, the token preview) as well as 700ms",
  /Promise\.all\(\[minWait, Promise\.resolve\(warnPainted\)\.catch\(\(\) => \{\}\)\]\)/.test(approve) && /Promise\.all\(\[base, Promise\.resolve\(tokenPainted\)\.catch\(\(\) => \{\}\)\]\)/.test(approve));
ok("0.2.71: Approve stays disabled for a token fill until its preview is ready, and review state is keyed by request id",
  /nfinBlocked \|\| tokenNotReady\(current\)/.test(approve) && /const reviewState = new Map/.test(approve) && /rs\(id\)\.tokenQuoteDisplayed/.test(approve));
ok("warnPainted is assigned from fillSendWarning before armButtons",
  approve.indexOf("warnPainted = fillSendWarning") > 0 && approve.indexOf("warnPainted = fillSendWarning") < approve.indexOf("armButtons();"));

const fillspv = src("src/core/fillspv.ts");
ok("proveEventAt fan-out uses mapPool at SCAN_POOL", /await mapPool\(liveOthers, SCAN_POOL/.test(fillspv) && /await mapPool\(scanned, SCAN_POOL/.test(fillspv));
ok("countMyOtherLiveHolds body is still the conservative over-count (unchanged this vehicle)",
  /export function countMyOtherLiveHolds\([\s\S]*?\bn\+\+;/.test(fillspv));

const namespv = src("src/core/namespv.ts");
ok("toSnapshot stays inside the serialized block; cache.set is detached",
  /const snap = LC\.toSnapshot\(\); detachSnapshotWrite/.test(namespv));
ok("flushSpvSnapshotWrites is exported for tests", /export function flushSpvSnapshotWrites/.test(namespv));
ok("hashAt/merkleAt are on the live source", /async hashAt\(height/.test(namespv) && /async merkleAt\(height/.test(namespv));
ok("CP is still 29960 (no checkpoint bump)", /height: 29960/.test(namespv));

const inpage = src("src/inpage.ts");
const versions = [...inpage.matchAll(/version:\s*"([^"]+)"/g)].map((m) => m[1]);
ok("inpage lockstep 0.2.71 (both literals)", versions.length === 2 && versions.every((v) => v === "0.2.71"));
ok("package.json is 0.2.71", JSON.parse(src("package.json")).version === "0.2.71");
ok("manifest is 0.2.71", JSON.parse(src("public/manifest.json")).version === "0.2.71");

const build = src("build.mjs");
ok("popup entry is its own esbuild build with splitting:true",
  /entryPoints: \{ popup: "src\/popup\/popup\.ts" \}/.test(build) && /splitting: true/.test(build));
ok("background+approve stay splitting:false",
  /entryPoints: \{ background: "src\/background\.ts", approve: "src\/popup\/approve\.ts" \}/.test(build)
  && /splitting: false/.test(build));

const codes = src("WALLET-ERROR-CODES.md");
ok("WALLET_UNAVAILABLE is documented additively", /WALLET_UNAVAILABLE/.test(codes) && /0\.2\.70/.test(codes));

ok("refuse() helper exists and is the SubmitResult shape",
  refuse("X", "y").ok === false && refuse("X", "y").sighashMatch === false && refuse("X", "y").code === "X");

const explorer = src("src/core/explorer.ts");
ok("explorer helpers live in explorer.ts (not only wallet.ts)",
  /export function explorerLink/.test(explorer) && /EXPLORER_PRESETS/.test(explorer));
ok("wallet.ts re-exports explorer (selftest/clearsign keep working)",
  /export \{ EXPLORER_PRESETS, DEFAULT_EXPLORER, explorerLink \} from "\.\/explorer\.js"/.test(src("src/core/wallet.ts")));

const shim = src("src/popup/devshim.ts");
ok("devshim throws when chrome.runtime.sendMessage exists",
  /chromeRef\?\.runtime\?\.sendMessage/.test(shim) && /must not load in the extension/.test(shim));
ok("devshim forwards removeAccount password (args[1])", /removeAccount\(args\[0\], args\[1\]\)/.test(shim));
ok("devshim forwards send expectSigner (args[3])", /w\.send\(args\[0\], args\[1\], args\[2\], args\[3\]\)/.test(shim));

console.log(`\nwallet-0270-hygiene: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
