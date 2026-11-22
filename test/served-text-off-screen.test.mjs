// No server's free text reaches a refusal the wallet shows (Plan 91 WL1.2; copy sheet List 3, items 2 to 7). Each
// source that put a server's string into a user-visible `error` gets an invented hostile text and must keep it out;
// beside each, the honest answer still gives its result. The submit path (item 1) is submit-answers H6; the name
// service's "via" field (item 8) is popup-checks-dom 9a.
// RED-FIRST: on the commit before this one, (1a), (2a), (3a) and (4a) fail; (5a) is fill-reservation-verdict.
// Run: node --import tsx test/served-text-off-screen.test.mjs   (offline)
import { registerContent, signIn } from "../src/core/node.ts";
import { fillOfferPreflight } from "../src/core/fillpreflight.ts";
import { tokenFillQuote } from "../src/core/cairnxview.ts";
import { offerStatusWord } from "../src/core/servedtext.ts";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("=== a server's text stays off the wallet's lines ===");
const EVIL = "Your funds are at risk: visit evil.example to restore them";
const has = (v) => JSON.stringify(v ?? "").includes("evil.example");
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const quiet = console.info; console.info = () => { /* the server texts this file sends go to the console by design */ };

console.log("1. the content server's refusal of a body (a reveal shows it)");
for (const [status, body] of [[413, { ok: false, error: EVIL }], [400, { err: EVIL }], [422, { error: { text: EVIL } }]]) {
  globalThis.fetch = async () => reply(status, body);
  const r = await registerContent("https://api.example", { v: 1 }, "0x" + "11".repeat(32));
  check(`(1a) HTTP ${status}: the error is the wallet's label with the status (${r.error})`, r.ok === false && r.status === status && r.error === `/api/content -> ${status}` && !has(r.error));
}
globalThis.fetch = async () => reply(200, { ok: true, txid: "0x" + "11".repeat(32) });
check("(1b) honest: an accepted body still answers ok", (await registerContent("https://api.example", { v: 1 }, "0x" + "11".repeat(32))).ok === true);

console.log("2. the sign-in check's refusal");
const PRIV = "11".repeat(32);
for (const verify of [reply(401, { error: EVIL }), reply(200, { ok: false, error: EVIL }), reply(500, { err: EVIL })]) {
  globalThis.fetch = async (u) => String(u).endsWith("/auth/nonce") ? reply(200, { ok: true, nonce: "abcdef0123456789" }) : verify;
  const r = await signIn("https://api.example", PRIV);
  check(`(2a) HTTP ${verify.status}: the error is the wallet's words (${r.error})`, r.ok === false && r.error === "sign-in failed" && !has(r));
}
globalThis.fetch = async (u) => String(u).endsWith("/auth/nonce") ? reply(200, { ok: true, nonce: "abcdef0123456789" }) : reply(200, { ok: true, addr: "0x" + "ab".repeat(20), session: "s" });
const ok = await signIn("https://api.example", PRIV);
check("(2b) honest: an accepted sign-in still returns the server's session", ok.ok === true && ok.session === "s");

console.log("3. the offer service's status in a fill refusal");
const OFFER = "0x" + "22".repeat(32), ME = "0x" + "ab".repeat(20);
const io = (status) => ({ tradeGet: async () => reply(200, { id: OFFER, status }) });
for (const status of [EVIL, "OPEN", "open "]) {
  const r = await fillOfferPreflight(io(status), OFFER, [{ to: ME, value: 1 }], ME, undefined, undefined, {});
  check(`(3a) status ${JSON.stringify(status).slice(0, 24)}: refused FILL_UNSAFE as "not open" (${r?.error?.slice(0, 40)})`, r?.code === "FILL_UNSAFE" && r.error.startsWith("offer is not open:") && !has(r));
}
for (const status of ["filled", "cancelled", "expired", "locked", "closed"]) {
  const r = await fillOfferPreflight(io(status), OFFER, [{ to: ME, value: 1 }], ME, undefined, undefined, {});
  check(`(3b) honest: status ${status} is named (${r?.error?.slice(0, 30)})`, r?.code === "FILL_UNSAFE" && r.error.startsWith(`offer is ${status}:`));
}

console.log("4. the offer service's status in the token price read (shown on the fill card)");
const q = await tokenFillQuote({ tradeGet: async () => reply(200, { status: EVIL }) }, OFFER);
check(`(4a) a hostile status: "${q.error}"`, q.ok === false && q.error === "offer not open" && !has(q));
const q2 = await tokenFillQuote({ tradeGet: async () => reply(200, { status: "filled" }) }, OFFER);
check(`(4b) honest: a filled offer says so ("${q2.error}")`, q2.ok === false && q2.error === "offer filled");

console.log("5. the fixed list");
check("(5) offerStatusWord keeps the list and maps anything else", ["open", "filled", "cancelled", "expired", "locked", "closed"].every((s) => offerStatusWord(s) === s)
  && [EVIL, "", null, 7, {}, "Open"].every((s) => offerStatusWord(s) === "not open"));
console.info = quiet;
done("served-text-off-screen");
