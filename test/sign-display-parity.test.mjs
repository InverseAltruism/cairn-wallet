// What the approval window shows is what the wallet signs, for every request type the window paints. Each request goes
// through the REAL background worker (its queue and resolvePending dispatch, as approve.ts drives it) to the real Wallet
// on a fetch stub that records the submitted transaction; the window's text is describe() of the queued request, with a
// target read that names the request as the user's own offer (the worst case for the cancel title). For every shape the
// wallet signs, the fields the window displays equal the fields of the signed transaction: the title's kind, the
// attestation's score and confidence, each output's recipient and amount, the network fee, the domain. For a shape the
// wallet refuses, nothing is submitted and the window says it will be refused.
//   RED-FIRST (src/ at 29034be): an attest at the token-fill confidence with no score painted "Cancel your offer" with
//   "score 0" and signed score 100 (W1a's review of 0.3.3, R1); a seal domain with spaces painted untrimmed and signed
//   trimmed; a sign-in with no uri signed a URI the window did not show.
// One home: src/core/signfields.ts (attestFields, fillFields, proposeFields, sendFields, sealFields) and
// src/core/siwcparams.ts (siwcFieldsFor), which the signer builds from and describe() reads. revealClaim signs nothing (it
// publishes a stored preimage); its pair is the txid shown against the txid posted (section 6).
// Run: npx tsx test/sign-display-parity.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { describe } from "../src/popup/clearsign.ts";
import { fmtCsd, CONF_TOKEN_FILL } from "../src/core/cairnx.ts";
import { world, truthful, PRIV } from "./helpers/fillworld.mjs";
import { mkCoin, txReply } from "./_coin.ts";

const { check, done } = checker("the approval window shows what the wallet signs:");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const mem = new Map();
globalThis.__CAIRN_TEST__ = true;
const chrome = {
  runtime: { id: "cairnwallettestid", lastError: undefined, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { chrome.listener = fn; } }, onConnect: { addListener: () => undefined }, sendMessage: () => Promise.reject(new Error("no receiver")) },
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: { create: (_o, cb) => { cb?.({ id: 77 }); }, update: () => undefined, onRemoved: { addListener: () => undefined } },
};
globalThis.chrome = chrome;

// The chain the stub serves: one coin of 5,000 CSD, the CSD-lane fill world (fillworld), a token-priced offer.
const coin = mkCoin(5_000e8);
const submits = [], posted = [];
let fw = null;
const TOKEN_OFFER = "0x" + "7a".repeat(32);
let me = "";
const tokenOffer = () => ({ id: TOKEN_OFFER, seller: me, give: { ticker: "AAA", amount: "10" }, want: { ticker: "PAY", amount: "7" }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150 });
const TQ = { ticker: "PAY", amount: "7", fee: "1", total: "8", giveTicker: "AAA", giveAmount: "10" };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init.body).tx); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + String(submits.length).padStart(64, "0") }) }; }
  if (u.includes("/api/content")) { posted.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (u.includes("/proposal/")) return { ok: true, status: 200, json: async () => ({ ok: true, proposal: { payload_hash: "0x" + "11".repeat(32) } }) };
  if (u.includes("clarvis")) return truthful(fw)(init, u);
  if (u.includes(`/cairnx/offer/${TOKEN_OFFER}`)) return { ok: true, status: 200, json: async () => tokenOffer() };
  if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => fw.primary };
  if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: fw?.tip ?? 116_520 }) };
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
await import("../src/background.ts");
const ORIGIN = "https://site.example";
const popup = (method, ...args) => new Promise((res) => chrome.listener({ kind: "popup", method, args }, { id: "cairnwallettestid", url: "chrome-extension://x/approve.html" }, (r) => res(r)));
const dapp = (method, params) => { const out = { reply: undefined }; chrome.listener({ kind: "dapp", method, params }, { origin: ORIGIN, url: ORIGIN + "/" }, (r) => { out.reply = r; }); return out; };
check("setup: a wallet from a known key", (await popup("import", PRIV, "pw-parity-1234")).ok === true);
me = String((await popup("status")).result.addr).toLowerCase();
fw = world(me, "none", 5000);
const wallet = globalThis.__cairnBgWallet;
wallet.fillSpvIoForTest = () => fw.io();
wallet.provenPaytoForTest = () => ({ payto: me, seller: me, expiresEpoch: 9e15, height: 47_000, terms: { height: 47_000, feeBps: 150, value: undefined, taker: undefined, bid: undefined, giveTicker: "AAA", giveAmount: "10", giveName: undefined, wantType: "token", wantTicker: "PAY", wantAmount: "7" }, wantTicker: "PAY", wantAmount: "7" });

// The window's displayed fields, read from describe()'s markup.
const strip = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function shown(html) {
  const rows = [...String(html).matchAll(/<div(?: data-to="([^"]*)")?><dt>([^<]*)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g)].map((m) => ({ to: m[1], label: m[2], value: strip(m[3]), raw: m[3].replace(/<[^>]+>/g, "") }));
  const att = rows.find((r) => r.label === "Attestation")?.value ?? "";
  return {
    title: strip(String(html).match(/<div class="ap-title">([\s\S]*?)<\/div>/)?.[1] ?? ""),
    fee: rows.find((r) => r.label === "Network fee")?.value ?? "",
    score: Number(att.match(/score (\d+)/)?.[1] ?? NaN), confidence: Number(att.match(/confidence (\d+)/)?.[1] ?? NaN),
    outputs: rows.filter((r) => r.label === "To").map((r) => ({ to: r.to, amount: r.value.split(" ").slice(-2).join(" ") })),
    domain: rows.find((r) => r.label === "Domain")?.raw ?? "",   // as painted, spaces kept
    refused: /refus/i.test(strip(html)),
    text: strip(html),
    rows: Object.fromEntries(rows.map((r) => [r.label, r.value])),
  };
}
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
// The signed transaction's fields: the app payload, the outputs that leave the wallet (not change to self), the fee.
function signed(tx) {
  const ins = tx.inputs.length * coin.coin.value;
  const outs = tx.outputs.map((o) => ({ to: hex(o.script_pubkey), value: o.value }));
  const fee = ins - outs.reduce((a, o) => a + o.value, 0);
  const app = tx.app === "None" ? { kind: "None" } : tx.app.Attest ? { kind: "Attest", score: tx.app.Attest.score, confidence: tx.app.Attest.confidence } : { kind: "Propose", domain: tx.app.Propose.domain };
  return { app, fee, outputs: outs.filter((o) => o.to !== me).map((o) => ({ to: o.to.toLowerCase(), amount: fmtCsd(o.value) })) };
}

// Queues one request, paints it as the window does, approves it with the window's call shape, and returns both sides.
async function round(method, params, { quote } = {}) {
  const page = dapp(method, params); await settle();
  const q = (await popup("pending")).result.at(-1);
  if (!q) return { queued: false, page };
  const html = describe({ ...q, attestTarget: { kind: "offer", mine: true } });
  const n = submits.length;
  await popup("resolve", q.id, true, me, quote);
  await settle();
  return { queued: true, page, d: shown(html), tx: submits.length > n ? signed(submits.at(-1)) : null };
}
const sameOutputs = (d, s) => d.length === s.length && d.every((o, i) => o.to.toLowerCase() === s[i].to && o.amount === s[i].amount);
// The invariant for a signed request; `kind` is what the title must call it.
function agree(label, r, kind) {
  if (!r.tx) return check(`${label}: signed (${JSON.stringify(r.page.reply).slice(0, 160)})`, false);
  const { d, tx } = r;
  const att = tx.app.kind === "Attest" ? d.score === tx.app.score && d.confidence === tx.app.confidence : true;
  const dom = tx.app.kind === "Propose" ? d.domain === tx.app.domain : true;
  check(`${label}: title "${d.title}", fee ${d.fee}${tx.app.kind === "Attest" ? `, score ${d.score} · confidence ${d.confidence}` : ""}${dom && tx.app.kind === "Propose" ? `, domain ${d.domain}` : ""} shown = signed (${JSON.stringify({ ...tx.app, fee: fmtCsd(tx.fee) })})`,
    kind.test(d.title) && d.fee === fmtCsd(tx.fee) && att && dom && sameOutputs(d.outputs, tx.outputs));
}
function refusedShown(label, r) {
  check(`${label}: nothing is signed, and the window says it will be refused (${r.d?.text?.slice(0, 90)})`, r.tx === null && r.d?.refused === true);
}

const TO = "0x" + "31".repeat(20), TO2 = "0x" + "32".repeat(20);
// 1. send
agree("1. send, fee omitted", await round("send", { to: TO, amount: 150_000_000 }), /Send CSD/);
agree("1. send, explicit fee", await round("send", { to: TO, amount: 150_000_000, fee: 2_000_000 }), /Send CSD/);
agree("1. send to two, fee omitted, one amount a digit string", await round("send", { outputs: [{ to: TO, value: "250000000" }, { to: TO2, value: 100_000_000 }] }), /Send CSD/);
// 2. propose
const PH = "0x" + "ab".repeat(32);
agree("2. propose, fee omitted", await round("propose", { domain: "example:v1", payloadHash: PH, uri: "data:,hi", expiresEpoch: 9_000 }), /Post a proposal/);
agree("2. propose with an output and a fee", await round("propose", { domain: "example:v1", payloadHash: PH, uri: "data:,hi", expiresEpoch: 9_000, fee: 30_000_000, outputs: [{ to: TO, value: 100_000_000 }] }), /Post a proposal/);
// 3. attest
const BOARD = "0x" + "be".repeat(32);
agree("3. a review attest, fee omitted", await round("attest", { proposalId: BOARD, score: 80, confidence: 70 }), /Support \/ review/);
agree("3. honest path: the site's cancel of the user's own offer (score 0, confidence 100)", await round("attest", { proposalId: BOARD, score: 0, confidence: 100, fee: 5_000_000 }), /^Cancel your offer/);
agree("3. an attest with no score and no confidence", await round("attest", { proposalId: BOARD }), /^Cancel your offer|Support/);
agree("3. W1a R1: the token-fill confidence with no score is shown and signed as a fill at score 100, not a cancel", await round("attest", { proposalId: TOKEN_OFFER, confidence: CONF_TOKEN_FILL, fee: 5_000_000 }, { quote: TQ }), /^Fill offer/);
agree("3. the token-fill confidence as a digit string, score 100", await round("attest", { proposalId: TOKEN_OFFER, score: 100, confidence: String(CONF_TOKEN_FILL) }, { quote: TQ }), /^Fill offer/);
refusedShown("3. the token-fill confidence with score 0", await round("attest", { proposalId: TOKEN_OFFER, score: 0, confidence: CONF_TOKEN_FILL }, { quote: TQ }));
// 4. fillOffer (the CSD lane through its reservation)
agree("4. a fill, score, confidence and fee omitted", await round("fillOffer", { proposalId: fw.fc.id, outputs: fw.outputs }), /^Fill offer/);
fw = world(me, "none", 6000);
agree("4. a fill with score null", await round("fillOffer", { proposalId: fw.fc.id, outputs: fw.outputs, score: null }), /^Fill offer/);
fw = world(me, "none", 7000);
refusedShown("4. a fill naming score 50", await round("fillOffer", { proposalId: fw.fc.id, outputs: fw.outputs, score: 50 }));
// 5. sealClaim: the domain and the fee against the commit, the claim against what the wallet keeps to reveal
for (const [label, params] of [["5. a seal, domain and fee omitted", { claim: "first" }], ["5. a seal whose domain has spaces around it", { claim: "second", domain: "  board:v1  " }], ["5. a seal with an explicit fee", { claim: "third", fee: 30_000_000 }]]) {
  const r = await round("sealClaim", params);
  agree(label, r, /Seal a claim/);
  const kept = (await popup("sealedClaims")).result.find((x) => x.txid === "0x" + String(submits.length).padStart(64, "0")) ?? (await popup("sealedClaims")).result[0];
  check(`${label}: the claim shown is the claim kept for the reveal (${kept?.claim})`, r.d.text.includes(String(kept?.claim)) && kept?.claim === params.claim);
}
refusedShown("5. a seal whose domain is not a string", await round("sealClaim", { claim: "x", domain: 5 }));
// 6. revealClaim: no transaction; the txid shown is the txid posted
{
  const sealTx = (await popup("sealedClaims")).result[0].txid;
  const page = dapp("revealClaim", sealTx); await settle();
  const q = (await popup("pending")).result.at(-1);
  const d = shown(describe(q));
  const p0 = posted.length;
  await popup("resolve", q.id, true, me); await settle();
  check(`6. revealClaim: the seal txid shown is the one whose preimage is posted (${posted.at(-1)?.txid?.slice(0, 12)})`, d.text.includes(sealTx) && posted.length === p0 + 1 && posted.at(-1).txid === sealTx && page.reply?.ok === true);
}
// 7. signinWithCsd: the audience, nonce, expiry, URI and statement shown are the lines of the signed message
for (const [label, params] of [["7. a sign-in with a statement, uri omitted", { nonce: "Nonce1234abcdef", statement: "Sign in" }], ["7. a sign-in asking a 99999 s expiry and a not-before", { nonce: "Nonce1234abcdef", expirationSecs: 99_999, notBeforeSecs: 30, uri: "https://site.example/login", resources: ["https://site.example/terms"] }]]) {
  const page = dapp("signinWithCsd", params); await settle();
  const q = (await popup("pending")).result.at(-1);
  const d = shown(describe(q));
  await popup("resolve", q.id, true, me); await settle();
  const msg = String(page.reply?.result?.message ?? "");
  const line = (k) => msg.split("\n").find((l) => l.startsWith(k + ": "))?.slice(k.length + 2);
  const secs = (Date.parse(line("Expiration Time")) - Date.parse(line("Issued At"))) / 1000;
  const rows = d.rows;
  check(`${label}: audience ${rows.Audience}, URI ${rows.URI}, expiry ${rows.Expires} shown = signed (${msg.split("\n")[0].split(" ")[0]}, ${line("URI")}, ${secs} s)`,
    msg.startsWith(`${rows.Audience} wants you`) && rows.URI === line("URI") && rows.Expires === `in ~${secs}s` && line("Nonce") === params.nonce && (!params.statement || (d.text.includes(params.statement) && msg.includes("\n" + params.statement + "\n"))) && (params.notBeforeSecs ? d.text.includes(`~${params.notBeforeSecs}s from now`) && !!line("Not Before") : !line("Not Before")));
}
done("sign-display-parity");
