// Nothing drawn for one account acts for another (W-23, W-02, W-11, W-12). An account switch, or a removal that moves
// the active account, leaves the old account's rows, an open name detail and a token send inert at once, while the
// new account's assets read is still in flight; a refreshed read redraws or closes an open name detail.
// Driven through the REAL popup.ts against a fake DOM, with the background's answers held to open each window.
//   RED-FIRST (each in a scratch copy):
//   - drop invalidateAccountViews() from switchAcct: 1a fails (A's rows stay while the switch is in flight);
//   - in render(), only bump acctGen on a new address instead of invalidating: 5a fails;
//   - make viewCurrent return true: 2b fails (A's token row sends from B with A's balance);
//   - drop the viewCurrent check after confirmNameAction's balance read: 3a fails (a review primed for A's name
//     under B signs set-primary as B);
//   - drop refreshOpenDetail() from renderAssets: 4a and 4b fail.
//   HONEST PATH: 2c (B's own name signs set-primary as B), 4c (an unchanged refresh keeps the detail actionable).
// Run: node --import tsx test/popup-stale-switch-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("rows and sheets bound to their account (real popup.ts):");
const { byId } = installFakeDom({ autoCreate: true });
const A = "0x" + "ab".repeat(20);
const B = "0x" + "cd".repeat(20);
const TO = "0x" + "31".repeat(20);
const TXID = "0x" + "7e".repeat(32);

let active = 0;
const held = {};                       // method -> resolve function while that answer is held
const hold = (m) => new Promise((r) => { held[m] = r; });
const ASSETS = {
  [A]: { ok: true, primaryName: null, tipHeight: 1, balances: { CAIRN: { available: "900000000000", locked: "0" } }, names: ["alice"], nameDetails: [{ name: "alice", leased: true, epochsLeft: 30 }] },
  [B]: { ok: true, primaryName: null, tipHeight: 1, balances: {}, names: ["carol"], nameDetails: [{ name: "carol", leased: true, epochsLeft: 9000 }] },
};
let holdNext = new Set();
const dispatched = [];
const h = {
  status: () => ({ hasVault: true, unlocked: true, addr: active ? B : A, active, accounts: [{ label: "A", addr: A }, { label: "B", addr: B }], rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => (holdNext.delete("balance") ? hold("balance").then(() => ({ confirmed: 100e8, utxos: [] })) : { confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false, stuck: false }),
  cairnxAssets: () => { const who = active ? B : A; return holdNext.delete("assets") ? hold("assets").then((x) => x ?? ASSETS[who]) : ASSETS[who]; },
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], history: () => [], sealedClaims: () => [],
  switchAccount: (i) => (holdNext.delete("switch") ? hold("switch").then(() => { active = i; return true; }) : (active = i, true)),
  removeAccount: () => { active = 1; return true; },
  resolveName: () => ({ ok: true, addr: TO, verified: true, sources: 2, depth: 14, via: "owner" }),
  confirmName: () => ({ ok: true, addr: TO, verified: true, sources: 2, depth: 14, via: "owner" }),
  cairnxNameRenewFee: () => 15e8,
  cairnxSetPrimary: (...a) => { dispatched.push(["cairnxSetPrimary", ...a]); return { ok: true, txid: TXID }; },
  cairnxNameRenew: (...a) => { dispatched.push(["cairnxNameRenew", ...a]); return { ok: true, txid: TXID }; },
  cairnxTransfer: (...a) => { dispatched.push(["cairnxTransfer", ...a]); return { ok: true, txid: TXID }; },
};
installBridge(h);
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();

const nl = () => byId("names-list");
const rowsOf = (el, attr) => el.querySelectorAll(`[data-${attr}]`);
const release = async (m, x) => { const r = held[m]; delete held[m]; r?.(x); await flush(); };
// not awaited: the click runs switchAcct, which waits on the (possibly held) switch
const switchTo = async (i) => { void byId("acct-menu").querySelectorAll("[data-acct]").find((b) => b.dataset.acct === String(i)).click(); await flush(); };
// every way a stale handle could reach a signature: its click, then each Confirm and Review a primed sheet would arm
async function pressAll(stale) {
  for (const el of stale) await el.click();
  await flush();
  byId("ts-to").value = TO; byId("ts-amt").value = "1";
  for (const id of ["btn-name-confirm", "btn-tsend"]) { await byId(id).click(); await flush(); }
  await byId("btn-tsend-confirm").click(); await flush();
}

console.log("1-2. a switch while B's assets read is held");
{
  await byId("nav-names").click(); await flush();
  const aName = rowsOf(nl(), "name")[0], aChip = rowsOf(nl(), "nrenew")[0], aToken = rowsOf(byId("assets"), "tsend")[0];
  await aName.click(); await flush();
  const aDetail = [...rowsOf(byId("nd-actions"), "nprimary"), ...rowsOf(byId("nd-actions"), "nrenew")];
  check("setup: A's name row, Renew chip, token row and detail actions exist", !!aName && !!aChip && !!aToken && aDetail.length === 2);
  holdNext.add("switch"); holdNext.add("assets");
  await switchTo(1);
  check("1a while the switch itself is in flight, no row of A's is drawn", rowsOf(nl(), "name").length === 0 && rowsOf(byId("assets"), "tsend").length === 0 && byId("name-detail").hidden === true);
  await pressAll([aName, aChip, aToken, ...aDetail]);
  check("1a ...and A's rows open nothing and dispatch nothing", dispatched.length === 0 && byId("name-action-form").hidden === true && byId("tsend-form").hidden === true);
  await release("switch");
  check("1a while B loads, no row of A's is drawn and the detail is closed", rowsOf(nl(), "name").length === 0 && rowsOf(byId("assets"), "tsend").length === 0 && byId("name-detail").hidden === true);
  await pressAll([aName, aChip, aToken, ...aDetail]);
  check("1b while B loads, A's rows and detail open nothing and dispatch nothing", dispatched.length === 0 && byId("name-action-form").hidden === true && byId("tsend-form").hidden === true && byId("name-detail").hidden === true);
  await release("assets");
  await pressAll([aName, aChip, aToken, ...aDetail]);
  check(`2a after B's read, A's rows and detail still dispatch nothing (${JSON.stringify(dispatched)})`, dispatched.length === 0);
  check("2b nothing of A's is actionable: no review and no token send is open", byId("name-action-form").hidden === true && byId("tsend-form").hidden === true);
  await rowsOf(nl(), "name").find((b) => b.dataset.name === "carol").click(); await flush();
  await rowsOf(byId("nd-actions"), "nprimary")[0].click(); await flush();
  await byId("btn-name-confirm").click(); await flush();
  check(`2c honest: B's own name signs set-primary as B (${JSON.stringify(dispatched.at(-1))})`, JSON.stringify(dispatched.at(-1)) === JSON.stringify(["cairnxSetPrimary", "carol", B]));
}

console.log("3. a review being priced when the account changes");
{
  dispatched.length = 0;
  await switchTo(0);
  await byId("nav-home").click(); await byId("nav-names").click(); await flush();
  await rowsOf(nl(), "name")[0].click(); await flush();
  holdNext.add("balance");
  await rowsOf(byId("nd-actions"), "nprimary")[0].click(); await flush();   // confirmNameAction waits on the balance
  await switchTo(1);
  await release("balance");
  await byId("btn-name-confirm").click(); await flush();
  check(`3a a review started for A's name before the switch signs nothing as B (${JSON.stringify(dispatched)})`, dispatched.length === 0);
}

console.log("4. a refreshed read and an open name detail");
{
  await byId("nav-home").click(); await byId("nav-names").click(); await flush();
  await rowsOf(nl(), "name").find((b) => b.dataset.name === "carol").click(); await flush();
  holdNext.add("assets"); await byId("btn-refresh").click(); await flush();
  await release("assets", { ...ASSETS[B], nameDetails: [{ name: "carol", pending: true }] });
  check("4a carol turned pending: the open detail loses its owner actions", byId("name-detail").hidden === false && !/data-n(renew|primary)/.test(byId("nd-actions").innerHTML) && /Finalize on the site/.test(byId("nd-actions").innerHTML));
  holdNext.add("assets"); await byId("btn-refresh").click(); await flush();
  await release("assets", { ...ASSETS[B], names: [], nameDetails: [] });
  check("4b carol is gone from the read: the detail closes and holds no action", byId("name-detail").hidden === true && byId("nd-actions").innerHTML === "");
  await byId("btn-refresh").click(); await flush();
  await rowsOf(nl(), "name").find((b) => b.dataset.name === "carol").click(); await flush();
  await byId("btn-refresh").click(); await flush();
  check("4c honest: an unchanged refresh keeps the detail open with its actions", byId("name-detail").hidden === false && /data-nprimary="carol"/.test(byId("nd-actions").innerHTML));
}

console.log("5. removing the active account moves it, with the same effect");
{
  dispatched.length = 0;
  await switchTo(0);
  await byId("nav-home").click(); await flush();
  const aToken = rowsOf(byId("assets"), "tsend")[0];
  holdNext.add("assets");
  await byId("btn-accts").click(); await flush();
  await byId("accts-list").querySelectorAll("[data-remove]")[0].click(); await flush();
  await byId("accts-list").querySelectorAll("[data-confirm-remove]")[0].click(); await flush();
  check("5a after the removal moved the account to B, A's token row is gone while B loads", rowsOf(byId("assets"), "tsend").length === 0);
  await pressAll([aToken]);
  await release("assets");
  await pressAll([aToken]);
  check(`5b A's token row sends nothing from B (${JSON.stringify(dispatched)})`, dispatched.length === 0 && byId("tsend-form").hidden === true);
}

done("popup-stale-switch-dom");
