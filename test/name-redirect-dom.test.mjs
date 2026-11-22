// WL1.1 in the real popup.ts: a send review to a .csd name this account paid before, which now resolves to another
// address, shows [A19] (amber) first among the review's checks, and its Confirm and Back read "Send to new address" and
// "Cancel"; that Confirm signs as before (one click after Review, the second click). It fires on every redirection,
// whatever its cause. Untouched beside it: the same name at the same address, a name never paid, a send to an address
// and a row from before rows kept the name all show what they showed, with "Confirm send" and "Back".
// RED-FIRST: on the commit before this one, (1a) to (1e), (2a), (4a) and (4b) fail; (2b) and (3a) to (3e) pass there.
// Run: node --import tsx test/name-redirect-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { sentenceOf, REDIRECT_BUTTONS, SENTENCES } from "../src/popup/sentences.ts";
import { checker } from "./helpers/check.mjs";

const { byId } = installFakeDom({ autoCreate: true });
const { check, done } = checker("=== a name paid before that now points elsewhere (real popup.ts) ===");
const ME = "0x" + "ab".repeat(20);
const OLD = "0x" + "31".repeat(20), NEW = "0x" + "42".repeat(20), TXID = "0x" + "7e".repeat(32);
let history = [];
const resolved = { alice: OLD };
const sends = [];
const h = {
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" } }, names: [], nameDetails: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], sealedClaims: () => [],
  history: () => history,
  resolveName: (nm) => ({ ok: true, addr: resolved[nm], name: nm, verified: true, sources: 2, depth: 14 }),
  confirmName: (nm) => ({ ok: true, addr: resolved[nm], verified: true }),
  send: (...args) => { sends.push(args); return { ok: true, txid: TXID }; },
  cairnxTransfer: (p) => { sends.push([p]); return { ok: true, txid: TXID }; },
};
installBridge(h);
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();

const A19 = sentenceOf("A19", undefined, { name: "alice.csd" }).text;
const csdReview = async (to) => {
  byId("btn-send-back").click(); await flush();
  byId("s-to").value = to; byId("s-amt").value = "1";
  await byId("btn-send").click(); await flush();
  return { warn: byId("c-warn").hidden ? "" : String(byId("c-warn").innerHTML), confirm: byId("btn-send-confirm").textContent, back: byId("btn-send-back").textContent };
};
const paid = (to, name, ts) => ({ type: "send", to, amount: 1e8, fee: 1e6, txid: "0x" + String(ts).padStart(64, "0"), ts, ...(name ? { name } : {}) });

console.log("1. alice.csd paid at OLD now resolves to NEW");
history = [paid(OLD, "alice", 10)];
resolved.alice = NEW;
let r = await csdReview("alice.csd");
check(`(1a) the review shows [A19] first (${r.warn.replace(/<[^>]*>/g, "").slice(0, 60)})`, r.warn.indexOf(A19) >= 0 && r.warn.indexOf(A19) < r.warn.indexOf("Chain-backed"));
check("(1b) [A19] is amber (the caution tier)", /<div class="check caution">[^]*?points to a different address/.test(r.warn));
check(`(1c) Confirm reads "${r.confirm}" and Back "${r.back}"`, r.confirm === REDIRECT_BUTTONS.confirm && r.back === REDIRECT_BUTTONS.back);
await byId("btn-send-confirm").click(); await flush();
const last = sends.at(-1);
check(`(1d) that Confirm signs the reviewed send, to NEW, and passes the name for the row (${JSON.stringify(last?.slice(0, 1))}, ${last?.[4]})`, last?.[0] === NEW && last?.[1] === 1e8 && last?.[4] === "alice");
check("(1e) honest: Back and Confirm read as before once the review is gone", byId("btn-send-confirm").textContent === "Confirm send" && byId("btn-send-back").textContent === "Back");
check("(1f) [A19] carries the sheet's technical sentence behind Details", r.warn.includes("<summary>Details</summary>") && r.warn.includes(SENTENCES.A19.details.replace(/'/g, "&#39;")));

console.log("1b. after \"Send to new address\" the confirm-time re-check still decides, and Cancel restores the labels");
{
  const THIRD = "0x" + "53".repeat(20);
  history = [paid(OLD, "alice", 10)];
  resolved.alice = NEW;
  r = await csdReview("alice.csd");
  const n0 = sends.length;
  resolved.alice = THIRD;                       // the name moved again between the review and the click
  await byId("btn-send-confirm").click(); await flush();
  check(`(1g) the name moved again before "Send to new address": nothing is signed (${sends.length - n0} sends)`, r.confirm === REDIRECT_BUTTONS.confirm && sends.length === n0 && byId("msg").textContent === sentenceOf("A14", undefined, { name: "alice.csd" }).text);
  check("(1g) ...and the buttons read as before", byId("btn-send-confirm").textContent === "Confirm send" && byId("btn-send-back").textContent === "Back");
  resolved.alice = NEW;
  r = await csdReview("alice.csd");
  byId("btn-send-back").click(); await flush();
  check(`(1h) Cancel on an [A19] review restores "Confirm send" and "Back" (${byId("btn-send-confirm").textContent}, ${byId("btn-send-back").textContent})`, r.back === REDIRECT_BUTTONS.back && byId("btn-send-confirm").textContent === "Confirm send" && byId("btn-send-back").textContent === "Back");
}

console.log("2. it fires on every redirection, by the newest row");
history = [paid(NEW, "alice", 20), paid(OLD, "alice", 10)];
resolved.alice = OLD;   // back to the old address: a change from the last payment, whatever its cause
r = await csdReview("alice.csd");
check("(2a) the newest row decides: last paid at NEW, now OLD, [A19]", r.warn.includes(A19) && r.confirm === REDIRECT_BUTTONS.confirm);
resolved.alice = NEW;
r = await csdReview("alice.csd");
check("(2b) honest: the name still where it was last paid: no [A19], and the buttons are not relabelled", !r.warn.includes("points to a different address") && r.confirm !== REDIRECT_BUTTONS.confirm && r.back !== REDIRECT_BUTTONS.back);

console.log("3. untouched cases");
history = [];
r = await csdReview("alice.csd");
check("(3a) a name never paid: no [A19]; the first-time caution as before", !r.warn.includes("points to a different address") && /First time sending to this address/.test(r.warn) && r.confirm !== REDIRECT_BUTTONS.confirm);
history = [{ type: "send", to: OLD, amount: 1e8, fee: 1e6, txid: TXID, ts: 5 }];   // a 0.3.4 row: no name kept
r = await csdReview("alice.csd");
check("(3b) a row from before rows kept the name: no [A19] (nothing to compare)", !r.warn.includes("points to a different address") && r.confirm !== REDIRECT_BUTTONS.confirm);
history = [paid(OLD, "alice", 10)];
r = await csdReview(NEW);
check("(3c) a send to an address: no [A19]", !r.warn.includes("points to a different address") && r.confirm !== REDIRECT_BUTTONS.confirm);
await byId("btn-send-confirm").click(); await flush();
check("(3d) honest: a send to an address passes no name", sends.at(-1)?.[0] === NEW && sends.at(-1)?.[4] === undefined);
history = [paid(OLD, "bob", 10)];
r = await csdReview("alice.csd");
check("(3e) another name's row does not count", !r.warn.includes("points to a different address"));

console.log("4. the token send");
{
  history = [{ type: "tokenSend", ticker: "CAIRN", to: OLD, amount: "1", name: "alice", txid: TXID, ts: 10 }];
  resolved.alice = NEW;
  byId("assets").querySelectorAll("[data-tsend]")[0].click(); await flush();
  byId("ts-to").value = "alice.csd"; byId("ts-amt").value = "1";
  await byId("btn-tsend").click(); await flush();
  const warn = String(byId("tc-warn").innerHTML);
  check(`(4a) a token send to alice.csd, last paid at OLD: [A19] with the two buttons (${byId("btn-tsend-confirm").textContent})`, warn.includes(A19) && byId("btn-tsend-confirm").textContent === REDIRECT_BUTTONS.confirm && byId("btn-tsend-back").textContent === REDIRECT_BUTTONS.back);
  await byId("btn-tsend-confirm").click(); await flush();
  check("(4b) its Confirm sends to NEW with the name", sends.at(-1)?.[0]?.to === NEW && sends.at(-1)?.[0]?.name === "alice");
  byId("assets").querySelectorAll("[data-tsend]")[0].click(); await flush();
  byId("ts-to").value = "alice.csd"; byId("ts-amt").value = "1";
  await byId("btn-tsend").click(); await flush();
  const relabelled = byId("btn-tsend-back").textContent === REDIRECT_BUTTONS.back;
  byId("btn-tsend-back").click(); await flush();
  check(`(4c) Cancel on a token [A19] review restores the labels (${byId("btn-tsend-confirm").textContent}, ${byId("btn-tsend-back").textContent})`, relabelled && byId("btn-tsend-confirm").textContent !== REDIRECT_BUTTONS.confirm && byId("btn-tsend-back").textContent !== REDIRECT_BUTTONS.back);
}
done("name-redirect-dom");
