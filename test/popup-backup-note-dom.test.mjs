// The grey line under the balance when Cairn's second server answered the balance read (copy sheet [M11]). Drives the
// REAL popup.ts against a fake DOM and a scripted background bridge.
// RED-FIRST: 0.3.4 hides the balance note on every successful read, so (1) fails there.
// PAIRED UNTOUCHED CASE: (2) a balance the main server answered shows no line, as before; (3) a failed read keeps its
// own caption.
// Run: node --import tsx test/popup-backup-note-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";
import { M11_BACKUP_SERVER } from "../src/popup/sentences.ts";

const { check, done } = checker("popup: the backup server line (real popup.ts):");
const { byId } = installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20);
let bal = { confirmed: 100e8, utxos: [], via: "backup" };
let fail = false;
installBridge({
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => { if (fail) throw new Error("node unreachable"); return bal; },
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false, stuck: false }),
  cairnxAssets: () => ({ ok: true, balances: {}, names: [], nameDetails: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [] }),
  prewarmSpv: () => ({ ok: true }),
  pending: () => [],
  history: () => [],
  sealedClaims: () => [],
});
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();
const note = () => byId("bal-note");
check(`(1) a balance read from the second server shows "${M11_BACKUP_SERVER}"`, note().hidden === false && note().textContent === M11_BACKUP_SERVER);
bal = { confirmed: 100e8, utxos: [] };
await byId("btn-refresh").click(); await flush();
check("(2) the next read from the main server hides the line", note().hidden === true && note().textContent === "");
fail = true;
await byId("btn-refresh").click(); await flush();
check("(3) a failed read shows its own caption, not the backup line", note().hidden === false && note().textContent === "Last balance read; the refresh failed.");
done("popup-backup-note-dom");
