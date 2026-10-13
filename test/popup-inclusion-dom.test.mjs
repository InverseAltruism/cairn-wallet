// The popup shows what Wallet.pendingMerge settled from chain state (test/inclusion-chain.test.mjs), never a
// clock verdict. Drives the REAL popup.ts against a fake DOM and a scripted background bridge.
//   History marker of a row whose inclusion is open: "sent, not yet included" at any age; the standing
//   notice once the reconcile marked it stuck (10 blocks past submit); "not included" only once it is gone.
//   The merge line switches to the notice when the open merge is stuck. A refresh with the activity list
//   on screen repaints its markers.
//   RED-FIRST: put the 60-minute clock back into the history marker (`Date.now() - t.ts <= 3_600_000`
//   choosing the fresh copy) and (1) fails: the 61-minute-old row stops reading "sent, not yet included".
//   PAIRED HONEST PATH: (4) a settled row carries no marker, and (5) a merge that is not stuck keeps its
//   "+X CSD merging" line, with pendingMerge called as the popup calls it (the balance fetch's utxos).
// Run: node --import tsx test/popup-inclusion-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("popup inclusion markers (real popup.ts):");
const { byId } = installFakeDom({ autoCreate: true });
const ME = "0x" + "ab".repeat(20);
const MIN = 60_000;
const id = (b) => "0x" + b.repeat(32);
const UTXOS = [{ txid: id("01"), vout: 0, value: 5e8, confirmations: 9 }];
let history = [];
let merge = { pending: false, amount: 0, maybe: false, stuck: false };
const mergeCalls = [];
const h = {
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: UTXOS }),
  pendingMerge: (utxos) => { mergeCalls.push(utxos); return merge; },
  cairnxAssets: () => ({ ok: true, balances: {}, names: [], nameDetails: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [] }),
  prewarmSpv: () => ({ ok: true }),
  pending: () => [],
  history: () => history,
  sealedClaims: () => [],
};
installBridge(h);
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();

const send = (txid, extra) => ({ txid, ts: Date.now() - 61 * MIN, type: "send", to: "0x" + "31".repeat(20), amount: 1e8, fee: 1e6, ...extra });
const rowOf = (txid) => {
  const html = String(byId("history-list").innerHTML);
  const at = html.indexOf(txid.slice(0, 10));
  return at < 0 ? "" : html.slice(html.lastIndexOf('<div class="tx">', at), html.indexOf('<div class="tx">', at) >>> 0);
};
async function openActivity() {
  byId("activity").hidden = true;
  await byId("btn-activity-t").click(); await flush();
}
async function refresh() { await byId("btn-refresh").click(); await flush(); }

// ── (1)-(4) the history marker ───────────────────────────────────────────────────────────────────────────
history = [
  send(id("a1"), { maybe: true, subTip: 1_000, chkTip: 1_003 }),
  send(id("a2"), { maybe: true, subTip: 1_000, chkTip: 1_010, stuck: true }),
  send(id("a3"), { gone: true, subTip: 1_000 }),
  send(id("a4"), {}),
];
await openActivity();
check("setup: the activity list is painted", byId("activity").hidden === false && rowOf(id("a4")).length > 0);
check("(1) a 61-minute-old open row reads: sent, not yet included", rowOf(id("a1")).includes("sent, not yet included"));
check("(1) ...and does not call it unconfirmable, lost or never landed", !/cannot be confirmed|never landed|lost|failed/.test(rowOf(id("a1"))));
check("(2) a row the reconcile marked stuck shows the standing notice", rowOf(id("a2")).includes("still not included after 10 blocks; check the explorer"));
check("(2) ...and the notice offers no resend", !/resend|send again|retry/i.test(rowOf(id("a2"))));
check("(3) a gone row says it was not included and why", rowOf(id("a3")).includes("not included: its coins were spent by another transaction; check the explorer"));
check("(4) paired: a row whose submit was answered carries no marker", !/included|in flight/.test(rowOf(id("a4"))));

// ── (5)-(6) the merge line, and the repaint after a refresh ──────────────────────────────────────────────
merge = { pending: true, amount: 5e8, maybe: false, stuck: false };
await refresh();
check("(5) paired: pendingMerge gets the balance fetch's utxos", mergeCalls.at(-1)?.[0]?.txid === UTXOS[0].txid);
check("(5) paired: an open merge that is not stuck keeps its merging line", byId("merge-pending").hidden === false && byId("merge-pending").textContent === "+5 CSD merging; back in your balance once the merge is mined");
merge = { pending: true, amount: 5e8, maybe: false, stuck: true };
history = [send(id("a1"), { subTip: 1_000, chkTip: 1_011 })];   // the reconcile settled a1 meanwhile
await refresh();
check("(6) a stuck merge shows the standing notice", byId("merge-pending").textContent === "merge of 5 CSD still not included after 10 blocks; check the explorer");
check("(6) the refresh repainted the open activity list: a1 settled, no marker", rowOf(id("a1")).length > 0 && !/included/.test(rowOf(id("a1"))));
merge = { pending: false, amount: 0, maybe: false, stuck: false };
await refresh();
check("(6) the merge line hides once nothing is open", byId("merge-pending").hidden === true);

done("popup-inclusion-dom");
