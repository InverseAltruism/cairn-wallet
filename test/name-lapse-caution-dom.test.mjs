// [A4] in the real popup.ts: a send review to a .csd name whose lapse the wallet could not settle (resolveName's
// `lapseUnconfirmed`) shows the amber line, and its Confirm and Back read "Send anyway" and "Cancel"; that Confirm
// signs the reviewed address (the second click after Review). Untouched beside it: a verified name keeps its line and
// "Confirm send" / "Back"; a proven lapse is still refused before any review.
// RED-FIRST: on the commit before this one the file does not load (no [A4] entry, no LAPSE_BUTTONS). Mutations:
// reviewButtons without its [A4] branch fails (1c) and (3a); the recipient without the flag fails (1a) to (1c) and
// (3a).
// Run: node --import tsx test/name-lapse-caution-dom.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { sentenceOf, LAPSE_BUTTONS } from "../src/popup/sentences.ts";
import { checker } from "./helpers/check.mjs";

const { byId } = installFakeDom({ autoCreate: true });
const { check, done } = checker("=== a name whose lapse the wallet could not settle (real popup.ts) ===");
const ME = "0x" + "ab".repeat(20), LAST = "0x" + "31".repeat(20), TXID = "0x" + "7e".repeat(32);
const answers = {
  alice: { ok: true, addr: LAST, name: "alice", lapsed: false, lapseUnconfirmed: true, addrProven: true, verified: false },
  bob: { ok: true, addr: LAST, name: "bob", verified: true, sources: 2, depth: 14 },
  carol: { ok: false, lapsed: true, error: "carol.csd has lapsed, so we did not send. Send to the owner's 0x address directly, or ask them to renew the name before sending again." },
};
const sends = [];
installBridge({
  status: () => ({ hasVault: true, unlocked: true, addr: ME, accounts: [{ label: "A1", addr: ME }], active: 0, rpc: "https://x", api: "https://x", tradeApi: "https://x/trade/api", explorer: "cairn", hasMnemonic: true }),
  balance: () => ({ confirmed: 100e8, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: { CAIRN: { available: "100000000000", locked: "0" } }, names: [], nameDetails: [], primaryName: null, tipHeight: 1 }),
  cairnxTokens: () => ({ ok: true, tokens: [{ ticker: "CAIRN", decimals: 8 }] }),
  prewarmSpv: () => ({ ok: true }), pending: () => [], sealedClaims: () => [], history: () => [],
  resolveName: (nm) => answers[nm],
  confirmName: (nm) => answers[nm],
  send: (...args) => { sends.push(args); return { ok: true, txid: TXID }; },
  cairnxTransfer: (p) => { sends.push([p]); return { ok: true, txid: TXID }; },
});
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();

const A4 = sentenceOf("A4", undefined, { name: "alice.csd" }).text;
const csdReview = async (to) => {
  byId("btn-send-back").click(); await flush();
  byId("s-to").value = to; byId("s-amt").value = "1";
  await byId("btn-send").click(); await flush();
  return { warn: byId("c-warn").hidden ? "" : String(byId("c-warn").innerHTML), confirm: byId("btn-send-confirm").textContent, back: byId("btn-send-back").textContent, shown: !byId("send-confirm").hidden };
};

console.log("1. alice.csd: lapse not settled");
let r = await csdReview("alice.csd");
check(`(1a) the review shows [A4] (${A4.slice(0, 50)}...)`, r.shown && r.warn.includes(A4));
check("(1b) [A4] is amber (the caution tier)", /<div class="check caution">[^]*?may have expired/.test(r.warn));
check(`(1c) Confirm reads "${r.confirm}" and Back "${r.back}"`, r.confirm === LAPSE_BUTTONS.confirm && r.back === LAPSE_BUTTONS.back);
await byId("btn-send-confirm").click(); await flush();
check(`(1d) that Confirm signs the reviewed address with the name (${sends.at(-1)?.[0]})`, sends.at(-1)?.[0] === LAST && sends.at(-1)?.[4] === "alice");

console.log("2. untouched");
r = await csdReview("bob.csd");
check("(2a) a verified name: no [A4], and the buttons are not relabelled", r.shown && !r.warn.includes("may have expired") && r.confirm === "Confirm send" && r.back === "Back");
r = await csdReview("carol.csd");
check("(2b) a proven lapse is refused before any review", !r.shown && sends.length === 1);
check("(2c) after the caution's send, the buttons read as before", byId("btn-send-confirm").textContent === "Confirm send");

console.log("3. the token send");
{
  byId("assets").querySelectorAll("[data-tsend]")[0].click(); await flush();
  byId("ts-to").value = "alice.csd"; byId("ts-amt").value = "1";
  await byId("btn-tsend").click(); await flush();
  const warn = String(byId("tc-warn").innerHTML);
  check(`(3a) a token send to alice.csd: [A4] with the two buttons (${byId("btn-tsend-confirm").textContent})`, warn.includes(A4) && byId("btn-tsend-confirm").textContent === LAPSE_BUTTONS.confirm && byId("btn-tsend-back").textContent === LAPSE_BUTTONS.back);
  await byId("btn-tsend-confirm").click(); await flush();
  check("(3b) its Confirm sends to the reviewed address with the name", sends.at(-1)?.[0]?.to === LAST && sends.at(-1)?.[0]?.name === "alice");
}
done("name-lapse-caution-dom");
