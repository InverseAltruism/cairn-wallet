// Plan 85 7.3b: the popup's own screens, driven through the REAL popup.ts against a fake DOM and a
// scripted background bridge.
//
//   1. Copy buttons say "copied" only after the clipboard write resolved (seed, key, phrase, address).
//      RED-FIRST: route the six copy handlers back to `navigator.clipboard?.writeText(x)?.catch(() => {});
//      flashBtn(id, "Copied")` and 1a-1d fail. HONEST PATH: 1e-1h.
//   2. A token send signs base units built from the PINNED decimals for a pinned ticker (CAIRN), not the
//      served ones. RED-FIRST: use `meta[t]?.decimals ?? 0` in renderAssets and 2a, 2b fail. HONEST PATH: 2c.
//   3. The CSD anchor-fee pre-check names the fee once ("0.25 CSD", not "0.25 CSD CSD"). RED-FIRST: 3a.
//   4. A saved remote RPC that the wallet moved to the Cairn proxy is announced once, then dismissed.
//      RED-FIRST: drop the showRpcMoved call in render() and 4a, 4b fail. HONEST PATH: 4c.
//   5. The RPC menu's add row reports a refused remote URL instead of dropping the rejection.
//      RED-FIRST: remove the try/catch around addRpc in renderRpcMenu and 5a fails. HONEST PATH: 5b.
//
// Run: node --import tsx test/popup-73b-dom.test.mjs   (offline)
import assert from "node:assert/strict";
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";

const { byId } = installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20);
const EXTERNAL = "0x" + "31".repeat(20);
const TXID = "0x" + "7e".repeat(32);
const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const KEY = "0x" + "11".repeat(32);
const REMOTE = "https://my-node.example/rpc";

const baseStatus = { hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://cairn-substrate.com/api/rpc", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true, rpcMovedFrom: REMOTE };
let dismissed = 0;
const rpcs = [];
const h = {
  status: () => ({ ...baseStatus, rpcMovedFrom: dismissed ? null : REMOTE }),
  dismissRpcNotice: () => { dismissed++; },
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  // CAIRN is pinned at 8 decimals; this resolver serves 0. FOO is not pinned and serves 2.
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" }, FOO: { available: "100000", locked: "0" } }, names: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 0 }, { ticker: "FOO", decimals: 2 }] }),
  prewarmSpv: () => ({ ok: true }),
  pending: () => [],
  history: () => [],
  sealedClaims: () => [],
  lock: () => ({ ok: true }),
  consolidatePreview: () => ({ ok: true, coins: 1, merge: 0, total: 0, out: 0 }),
  connectedSites: () => [],
  explorerList: () => [],
  create: () => ({ mnemonic: PHRASE, privkey: KEY }),
  export: () => KEY,
  exportMnemonic: () => PHRASE,
  rpcList: () => rpcs,
  addRpc: (u) => { if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(u)) throw new Error("RPC must be the Cairn proxy or a node on this computer (http://127.0.0.1:<port> or http://localhost:<port>)"); rpcs.push(u); },
  setRpc: () => {},
};
const { calls } = installBridge(h);
globalThis.setInterval = () => 0;

// The clipboard the popup sees: `mode` decides whether the next write resolves, rejects or is absent.
let mode = "ok";
const written = [];
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  get: () => (mode === "absent" ? undefined : { writeText: async (t) => { if (mode === "deny") throw new Error("Document is not focused."); written.push(t); } }),
});

const firstMsg = { text: "" };
await import("../src/popup/popup.ts");
await flush();
firstMsg.text = String(byId("msg").textContent || "");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.error("  ✗ " + name + "\n    " + String(e?.message || e).split("\n")[0]); } };
const text = () => String(byId("msg").textContent || "");

console.log("4. a saved remote RPC moved to the Cairn proxy");
t("4a the first open says the RPC now uses the Cairn proxy and names the old host", () => {
  assert.match(firstMsg.text, /my-node\.example\/rpc\) is a remote server, which this wallet no longer supports\. It now uses the Cairn proxy\./);
});
t("4b the notice is dismissed once it has been shown", () => { assert.equal(dismissed, 1); });
{
  const before = calls.filter((m) => m === "dismissRpcNotice").length;
  byId("msg").textContent = "";
  await byId("btn-refresh").click(); await flush();
  await byId("btn-lock").click(); await flush();
  t("4c honest: with no notice pending, a later render neither repeats it nor dismisses again", () => {
    assert.equal(calls.filter((m) => m === "dismissRpcNotice").length, before);
    assert.doesNotMatch(text(), /remote server/);
  });
}

console.log("1. copy buttons are honest about the clipboard");
async function copy(btn) { await byId(btn).click(); await flush(); return String(byId(btn).textContent); }
{
  byId("setup-pw").value = "pw-strong-enough";
  await byId("btn-create").click(); await flush();
  await byId("btn-export").click(); byId("reveal-pw").value = "pw"; await byId("btn-reveal-go").click(); await flush();
  mode = "deny";
  const seed = await copy("btn-copy-seed"), priv = await copy("btn-copy-priv");
  t("1a a refused write on the recovery phrase does not say copied", () => { assert.equal(seed, "Copy failed"); assert.equal(byId("btn-copy-seed").classList.contains("copied"), false); assert.match(text(), /Could not copy to the clipboard/); });
  t("1b a refused write on the backup key does not say copied", () => { assert.equal(priv, "Copy failed"); });
  mode = "absent";
  const key = await copy("btn-reveal-copy"), addr = await copy("btn-copy");
  await byId("btn-phrase").click(); byId("phrase-pw").value = "pw"; await byId("btn-phrase-go").click(); await flush();
  t("1c no clipboard API on the revealed key: copy failed", () => { assert.equal(key, "Copy failed"); });
  t("1d no clipboard API on the address: copy failed", () => { assert.equal(addr, "Copy failed"); });

  mode = "ok"; written.length = 0;
  const okSeed = await copy("btn-copy-seed"), okPriv = await copy("btn-copy-priv"), okPhrase = await copy("btn-phrase-copy");
  await byId("btn-export").click(); byId("reveal-pw").value = "pw"; await byId("btn-reveal-go").click(); await flush();   // opening the phrase panel wiped the revealed key
  const okKey = await copy("btn-reveal-copy");
  t("1e honest: the phrase copy writes the phrase and says copied", () => { assert.equal(okSeed, "Copied"); assert.equal(written[0], PHRASE); });
  t("1f honest: the backup key copy writes the key and says copied", () => { assert.equal(okPriv, "Copied"); assert.equal(written[1], KEY); });
  t("1g honest: the revealed phrase copy writes the phrase", () => { assert.equal(okPhrase, "Copied"); assert.equal(written[2], PHRASE); });
  t("1h honest: the revealed key copy writes the key", () => { assert.equal(okKey, "Copied"); assert.equal(written[3], KEY); });
  await byId("btn-backup-done").click(); await flush();
}

console.log("2. token send uses the pinned decimals");
async function tokenReview(i, amt) {
  await byId("btn-refresh").click(); await flush();
  await byId("assets").querySelectorAll("[data-tsend]")[i].click(); await flush();
  byId("ts-to").value = EXTERNAL; byId("ts-amt").value = amt;
  await byId("btn-tsend").click(); await flush();
}
{
  let sent = null;
  h.cairnxTransfer = (p) => { sent = p; return { ok: true, txid: TXID }; };
  await tokenReview(0, "1");   // tickers sort: CAIRN, FOO
  t("2a the CAIRN review shows 1 CAIRN as 100000000 base units (pinned 8), not 1 base unit (served 0)", () => {
    assert.equal(String(byId("tc-amt").textContent), "1 CAIRN = 100000000 base units");
  });
  await byId("btn-tsend-confirm").click(); await flush();
  t("2b the signed transfer carries 100000000 base units and the pinned decimals", () => {
    assert.equal(sent?.amount, "100000000"); assert.equal(sent?.decimals, 8);
  });
  sent = null;
  await tokenReview(1, "1");
  await byId("btn-tsend-confirm").click(); await flush();
  t("2c honest: an unpinned token keeps its served decimals (FOO, 2: 1 FOO = 100 base units)", () => {
    assert.equal(sent?.amount, "100"); assert.equal(sent?.decimals, 2);
  });
}

console.log("3. the anchor-fee pre-check");
{
  h.balance = () => ({ confirmed: 1_000_000, utxos: [] });
  await tokenReview(0, "1");
  t("3a the message names the fee once", () => {
    assert.match(text(), /needs 0\.25 CSD for the on-chain anchor fee/); assert.doesNotMatch(text(), /CSD CSD/);
  });
  h.balance = () => ({ confirmed: 100e8, utxos: [] });
}

console.log("5. the RPC menu's add row");
{
  byId("rpc-menu").hidden = true;   // the menu starts closed; the button opens and renders it
  await byId("btn-rpc").click(); await flush();
  byId("rpc-add-input").value = "https://remote.example/rpc";
  await byId("rpc-add-btn").click(); await flush();
  t("5a a remote URL is refused with the wallet's reason on the status line", () => {
    assert.match(text(), /RPC must be the Cairn proxy or a node on this computer/);
    assert.equal(rpcs.length, 0);
  });
  byId("rpc-add-input").value = "http://127.0.0.1:9000";
  await byId("rpc-add-btn").click(); await flush();
  t("5b honest: a local node is added and selected", () => {
    assert.deepEqual(rpcs, ["http://127.0.0.1:9000"]);
    assert.ok(calls.includes("setRpc")); assert.match(text(), /^RPC: 127\.0\.0\.1:9000/);
  });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
