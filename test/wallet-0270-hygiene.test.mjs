// 0.2.70 source-structure pins: connector hang, popup isolation, header-store write detach,
// CSD review parallel, proveEventAt pool. The approval-window arm and latch behaviour is tested
// through the real module in approve-guards-dom.test.mjs and approve-repaint-dom.test.mjs.
import { readFileSync } from "node:fs";
import { scriptSource } from "../scripts/popup-ids.mjs";
import { refuse } from "../src/core/refuse.ts";
import { SPV_CHECKPOINTS } from "../src/core/namespv.ts";
import { SPV_FLOOR } from "../src/core/spvanchors.ts";
import { checker } from "./helpers/check.mjs";

const { check: ok, done } = checker();
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

const popup = scriptSource("popup.ts");
ok("popup has no Wallet value import", !/import\s*\{[^}]*\bWallet\b/.test(popup));
ok("popup imports nothing from core/wallet.js as a value (a type-only import or none)", !/^import (?!type )[^;]*from "\.\.\/core\/wallet\.js"/m.test(popup));
ok("popup has no side-effect import of core/wallet.js", !/^import\s*["']\.\.\/core\/wallet(\.js)?["']/m.test(popup));
ok("popup explorer comes from explorer.ts", /from "\.\.\/core\/explorer\.js"/.test(popup));
ok("popup dynamically imports devshim", /import\("\.\/devshim\.js"\)/.test(popup));
ok("CSD Review parallelizes recipientChecks+balance",
  /const \[b, checks\] = await Promise\.all\(\[call\("balance"\)\.catch\(\(\) => null\), recipientChecks\(to, rr\.name\)\]\)/.test(popup));

const fillspv = src("src/core/fillspv.ts");
ok("proveEventAt fan-out uses mapPool at SCAN_POOL", /await mapPool\(liveOthers, SCAN_POOL/.test(fillspv) && /await mapPool\(scanned, SCAN_POOL/.test(fillspv));

const namespv = src("src/core/namespv.ts");
// The store write is built (LC.toRecords) only inside the serialized block and only its transaction is detached:
// never awaited on the proof path. persist() awaits only the seal key for the write and a rebase, never the store.
const suffixFn = namespv.slice(namespv.indexOf("const suffixWrite = "), namespv.indexOf("const persist = "));
const prepBody = namespv.slice(namespv.indexOf("async prepare(maxEventHeight"), namespv.indexOf("async blockAt("));
// Every use of persist outside its definition: handed to the serializer, or awaited inside the serialized adoption op.
const persistUses = [...namespv.matchAll(/\bpersist\b(?=[()])/g)].map((m) => m.index);
const adoptOp = [namespv.indexOf("const adopt = (fresh: Seeded, seed: Seed) => serializeSync(async () => {"), namespv.indexOf("\n  });", namespv.indexOf("const adopt = "))];
const inLock = (i) => namespv.startsWith("serializeSync(persist)", i - "serializeSync(".length) || (i > adoptOp[0] && i < adoptOp[1]);
const rebaseFn = namespv.slice(namespv.indexOf("const rebase = "), namespv.indexOf("const persist = "));
ok("LC.toRecords is read in suffixWrite(), which persist() calls and detaches, and in the rebase's re-ingest only",
  (namespv.match(/LC\.toRecords\(/g) || []).length === 2 && /LC\.toRecords\(/.test(suffixFn.slice(0, suffixFn.indexOf("const knownTops"))) && /LC\.toRecords\(/.test(rebaseFn)
  && /const persist = async \(\) => \{\s*const w = suffixWrite\(\);\s*if \(w\) \{ const sealed = await withSeals\(w, persistedTip\); if \(live\(\)\) detachStoreWrite\(store!, sealed, live\); \}\s*if \(LC\.chain\.length > REBASE_SPAN\) await rebase\(\);\s*\};/.test(namespv));
ok("persist() is used only inside serialized ops: the runner's three and the adoption (the write is built under the lock)",
  adoptOp[0] > 0 && adoptOp[1] > adoptOp[0] && persistUses.length === 4 && persistUses.every(inLock));
ok("the detached write is never awaited on the proof path (no await on detachStoreWrite or a store write in prepare)",
  !/await\s+detachStoreWrite\(/.test(namespv) && !/await\s+store\.write\(/.test(prepBody));
ok("suffixWrite has exactly two callers: persist(), and the one-time legacy migration before the source is returned",
  (namespv.match(/\bsuffixWrite\(\)/g) || []).length === 2 && namespv.indexOf("suffixWrite() ??") > 0 && namespv.indexOf("suffixWrite() ??") < namespv.indexOf("async prepare(maxEventHeight"));
ok("flushSpvStoreWrites is exported for tests", /export async function flushSpvStoreWrites/.test(namespv));
ok("hashAt/merkleAt are on the live source", /async hashAt\(height/.test(namespv) && /async merkleAt\(height/.test(namespv));
// That the light client gets this whole map under an anchors prefix is pinned by test/namespv-anchor-prefix.test.mjs.
ok("the names floor is still 29960 (no checkpoint bump) and the release checkpoint map holds it",
  SPV_FLOOR.height === 29960 && SPV_CHECKPOINTS[29960] === SPV_FLOOR.hash);

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
ok("devshim forwards send expectSigner (args[3]) and the name for the history row (args[4])", /w\.send\(args\[0\], args\[1\], args\[2\], args\[3\], args\[4\]\)/.test(shim));

done("wallet-0270-hygiene");
