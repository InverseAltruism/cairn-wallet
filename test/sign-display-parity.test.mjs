// What the approval window shows is what the wallet signs, for every request type the window paints. A page's request
// goes through the REAL background worker to the REAL approval window (src/popup/approve.ts on helpers/approve-dom.mjs,
// its pre-paint reads answered by the worker over the popup channel), and a click on its Approve button sends it to the
// real Wallet on a fetch stub that records the submitted transaction. For every shape the wallet signs, the painted
// fields equal the signed transaction's: the title's kind, the attestation's score and confidence, each output's
// recipient and amount, the network fee, the domain, the expiry epoch; and every pre-paint read the window makes about
// a target (attestTarget, tokenFillQuote, fillOfferView) names the target the transaction signs, with the cancel read
// made only for an attest the wallet signs as an attest. For a shape the wallet refuses, nothing is submitted and the
// window says it will be refused.
//   RED-FIRST (src/ at 29034be): an attest at the token-fill confidence with no score painted "Cancel your offer" with
//   "score 0" and signed score 100 (W1a's review of 0.3.3, R1); a seal domain with spaces painted untrimmed and signed
//   trimmed; a sign-in with no uri signed a URI the window did not show. Put approve.ts's cancel pre-read back on the
//   raw score (`(Number(current.params.score) >>> 0) === SCORE_CANCEL`) and section 3 fails: the window asks the node
//   about the target of a request the wallet signs as a fill.
// One home: src/core/signfields.ts (attestFields, fillFields, proposeFields, sendFields, sealFields, revealFields,
// fillOf) and src/core/siwcparams.ts (siwcFieldsFor), which the signer builds from and the window reads. revealClaim
// signs nothing (it publishes a stored preimage); its pair is the txid shown against the txid posted (section 6).
// Sections 9 to 12 pin what docs/PROVIDER.md states about the approval window and consent; each says its red-first runs.
// Run: npx tsx test/sign-display-parity.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { fmtCsd, CONF_TOKEN_FILL, CAIRNX_DOMAIN, buildNameProfile } from "../src/core/cairnx.ts";
import { PROFILE_DROP_PENDING } from "../src/popup/clearsign.ts";
import { world, truthful, PRIV } from "./helpers/fillworld.mjs";
import {
  offer, transfer, deploy, mint, bid, offerCancelAll, nameCommitRecord, nameClaim, nameFinalize, nameXfer, nameSet, nameRenew,
  nameProfile, tokenMeta, fclaim, canonicalJson, payloadHash, resolve, requiredFillOutputs, provenOfferTerms, parseRecord,
  epochOf, DEPLOY_FEE, TREASURY_ADDR,
} from "../src/vendor/cairnx-spv.js";
import { mkCoin, txReply } from "./_coin.ts";

const { check, done } = checker("the approval window shows what the wallet signs:");
const ID = "cairnwallettestid";
const WINDOW_PAGE = { id: ID, url: "chrome-extension://x/approve.html", tab: { id: 1 } };
const WORKER = { id: ID, url: "chrome-extension://x/background.js" };
const ORIGIN = "https://site.example";
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await sleep(5); return cond(); };
let listener = () => undefined;
const popup = (method, ...args) => new Promise((res) => listener({ kind: "popup", method, args }, WINDOW_PAGE, res));
const dapp = (method, params, origin = ORIGIN) => { const out = { reply: undefined }; listener({ kind: "dapp", method, params }, { origin, url: origin + "/", tab: { id: 2 } }, (r) => { out.reply = r; }); return out; };

// The window's channel is the worker's popup channel; `sent` records every call the window makes, with its arguments.
const sent = [];
const handlers = new Proxy({}, { get: (_, method) => async (...args) => {
  sent.push([method, args]);
  const r = await popup(method, ...args);
  if (!r?.ok) throw new Error(r?.error ?? "error");
  return r.result;
} });
const { registry, deliver } = mountApproveWindow(handlers);
globalThis.window.addEventListener = () => undefined;
globalThis.document.addEventListener = () => undefined;
const windowChannel = globalThis.chrome.runtime.sendMessage;
globalThis.chrome.runtime.sendMessage = (m, cb) => {
  if (m?.kind === "popup") return windowChannel(m, cb);
  return new Promise((res) => setTimeout(() => { const a = deliver(m, WORKER); setTimeout(() => res(a?.value), 0); }, 0));
};
const windowOnMessage = globalThis.chrome.runtime.onMessage;
const mem = new Map();
globalThis.__CAIRN_TEST__ = true;
Object.assign(globalThis.chrome.runtime, { id: ID, getURL: (p) => "chrome-extension://x/" + p, onMessage: { addListener: (fn) => { listener = fn; } }, onConnect: { addListener: () => undefined } });
Object.assign(globalThis.chrome, {
  storage: { local: { get: async (k) => ({ [k]: structuredClone(mem.get(k)) }), set: async (o) => { for (const k of Object.keys(o)) mem.set(k, structuredClone(o[k])); }, remove: async (k) => { mem.delete(k); } } },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  action: { setBadgeText: () => undefined },
  windows: { create: (_o, cb) => { cb?.({ id: 77 }); }, update: () => undefined, onRemoved: { addListener: () => undefined } },
});

// The chain the stub serves: one coin of 5,000 CSD, the CSD-lane fill world (fillworld), and for the cancel read three
// open CairnX listings: MINE and TOKEN_OFFER (token-priced) listed by this account, THEIRS by another.
const coin = mkCoin(5_000e8);
const submits = [], posted = [];
let fw = null, me = "";
// The name service's `/cairnx/name/:name` answer (section 8); every other section reads no name record.
const nameReads = [];
let nameAnswer = async () => ({ ok: false, status: 404, json: async () => ({}) });
// Offers the stub serves by id beside the fill world's (section 12's taker-bound offer).
const servedOffers = new Map();
const TOKEN_OFFER = "0x" + "7a".repeat(32), MINE = "0x" + "be".repeat(32), THEIRS = "0x" + "bf".repeat(32);
const tokenOffer = () => ({ id: TOKEN_OFFER, seller: me, give: { ticker: "AAA", amount: "10" }, want: { ticker: "PAY", amount: "7" }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150 });
const listed = offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(1e8) } });
const proposal = (id) => ({ ok: true, proposal: { payload_hash: listed.payloadHash, domain: CAIRNX_DOMAIN, uri: listed.uri, proposer: id === THEIRS ? "0x" + "99".repeat(20) : me } });
// Every fetch the worker and the window make, in order (section 13 counts them).
const fetchLog = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  fetchLog.push(u);
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init.body).tx); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + String(submits.length).padStart(64, "0") }) }; }
  if (u.includes("/api/content")) { posted.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  for (const id of [MINE, THEIRS, TOKEN_OFFER]) if (u.includes(`/proposal/${id}`)) return { ok: true, status: 200, json: async () => proposal(id) };
  if (u.includes("/proposal/")) return { ok: true, status: 200, json: async () => ({ ok: true, proposal: { payload_hash: "0x" + "11".repeat(32) } }) };
  if (u.includes("clarvis")) return truthful(fw)(init, u);
  if (u.includes(`/cairnx/offer/${TOKEN_OFFER}`)) return { ok: true, status: 200, json: async () => tokenOffer() };
  for (const [id, o] of servedOffers) if (u.includes(`/cairnx/offer/${id}`)) return { ok: true, status: 200, json: async () => structuredClone(o) };
  if (u.includes("/cairnx/offer/")) return { ok: true, status: 200, json: async () => fw.primary };
  if (/\/utxos\//.test(u)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: fw?.tip ?? 116_520 }) };
  if (u.includes("/cairnx/name/")) { nameReads.push(u); return nameAnswer(u); }
  return txReply(u, [coin]) ?? { ok: false, status: 404, json: async () => ({}) };
};
await import("../src/background.ts");
globalThis.chrome.runtime.onMessage = windowOnMessage;
await tick();
check("setup: a wallet from a known key", (await popup("import", PRIV, "pw-parity-1234")).ok === true);
me = String((await popup("status")).result.addr).toLowerCase();
fw = world(me, "none", 5000);
const wallet = globalThis.__cairnBgWallet;
wallet.fillSpvIoForTest = () => fw.io();
wallet.provenPaytoForTest = () => ({ payto: me, seller: me, expiresEpoch: 9e15, height: 47_000, terms: { height: 47_000, feeBps: 150, value: undefined, taker: undefined, bid: undefined, giveTicker: "AAA", giveAmount: "10", giveName: undefined, wantType: "token", wantTicker: "PAY", wantAmount: "7" }, wantTicker: "PAY", wantAmount: "7" });

// The window's displayed fields, read from the painted request.
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
    expires: rows.find((r) => r.label === "Expires")?.value ?? "",
    refused: /refus/i.test(strip(html)),
    text: strip(html),
    rows: Object.fromEntries(rows.map((r) => [r.label, r.value])),
  };
}
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const hexOf = (v) => (typeof v === "string" ? v : hex(v)).toLowerCase();
// The signed transaction's fields: the app payload, the outputs that leave the wallet (not change to self), the fee.
function signed(tx) {
  const ins = tx.inputs.length * coin.coin.value;
  const outs = tx.outputs.map((o) => ({ to: hex(o.script_pubkey), value: o.value }));
  const fee = ins - outs.reduce((a, o) => a + o.value, 0);
  const a = tx.app;
  const app = a === "None" ? { kind: "None" }
    : a.Attest ? { kind: "Attest", target: hex(a.Attest.proposal_id), score: a.Attest.score, confidence: a.Attest.confidence }
    : { kind: "Propose", domain: a.Propose.domain, expires: a.Propose.expires_epoch };
  return { app, fee, outputs: outs.filter((o) => o.to !== me).map((o) => ({ to: o.to.toLowerCase(), amount: fmtCsd(o.value) })) };
}

const req = () => String(registry.get("req").innerHTML);
const armed = () => registry.get("btn-approve").disabled === false;
let pollTick = null;
const TARGET_READS = ["attestTarget", "tokenFillQuote", "fillOfferView"];
// Every call the window makes for a request, before its paint and after, other than the queue and status polls.
const POLLS = new Set(["pending", "status", "resolve"]);
// The window's painted parts outside the request markup: the header (origin line, ask, signer) and the mounts approve.ts
// fills after the paint.
const FACE = ["ap-origin", "ap-tile", "ap-ask", "ap-signer", "send-warn", "fill-view", "token-sim", "profile-drop"];
// Queues one request, lets the window paint it (its pre-paint reads included), clicks Approve once the buttons arm, and
// returns the painted fields, the window's target reads and the transaction submitted, if any.
async function round(method, params, origin = ORIGIN) {
  const s0 = sent.length, n = submits.length, f0 = fetchLog.length;
  const page = dapp(method, params, origin); await flush();
  const q = (await popup("pending")).result.at(-1);
  if (!q) return { queued: false, page };
  pollTick ??= await loadApprove();
  await pollTick();
  const painted = Date.now();
  await until(() => req().includes(String(q.id)) || (req().length > 0 && sent.slice(s0).some(([m]) => m === "pending")));
  await until(() => armed(), 600);
  const armedMs = Date.now() - painted;
  await flush();
  await until(() => !String(registry.get("reveal-preview")?.innerHTML ?? "x").includes("Loading"), 100);
  const html = req();
  const preview = strip(registry.get("reveal-preview")?.innerHTML ?? "");
  const drop = registry.get("profile-drop")?.innerHTML;
  const face = Object.fromEntries(FACE.map((id) => [id, String(registry.get(id)?.innerHTML ?? "")]));
  const calls = sent.slice(s0).map(([m]) => m).filter((m) => !POLLS.has(m));
  const reads = sent.slice(s0).filter(([m]) => TARGET_READS.includes(m)).map(([m, a]) => [m, String(a[0]).toLowerCase()]);
  const clicked = Date.now(), f1 = fetchLog.length;
  if (armed()) await registry.get("btn-approve")._listeners.click();
  else await registry.get("btn-reject")._listeners.click();
  await until(() => page.reply !== undefined);
  const fetches = { paint: fetchLog.slice(f0, f1), click: fetchLog.slice(f1) };
  return { queued: true, page, d: shown(html), html, face, drop, reads, calls, preview, armedMs, fetches, replyMs: Date.now() - clicked, tx: submits.length > n ? signed(submits.at(-1)) : null };
}
const sameOutputs = (d, s) => d.length === s.length && d.every((o, i) => o.to.toLowerCase() === s[i].to && o.amount === s[i].amount);
// The invariant for a signed request; `kind` is what the title must call it, `wantReads` the target reads it must make.
function agree(label, r, kind, wantReads = []) {
  if (!r.tx) return check(`${label}: signed (${JSON.stringify(r.page.reply).slice(0, 160)})`, false);
  const { d, tx, reads } = r;
  // A legacy reservation's row reads "score 50 (claim) · no payment": confidence 0 is what "no payment" says.
  const claimRow = Number.isNaN(d.confidence) && /score 50 \(claim\) · no payment/.test(d.rows.Attestation ?? "") && tx.app.confidence === 0;
  const att = tx.app.kind === "Attest" ? d.score === tx.app.score && (d.confidence === tx.app.confidence || claimRow) : true;
  const dom = tx.app.kind === "Propose" ? d.domain === tx.app.domain && (d.expires === "" || d.expires.includes(String(tx.app.expires))) : true;
  check(`${label}: title "${d.title}", fee ${d.fee}${tx.app.kind === "Attest" ? `, score ${d.score} · confidence ${d.confidence}` : ""}${tx.app.kind === "Propose" ? `, domain ${d.domain}` : ""} shown = signed (${JSON.stringify({ ...tx.app, fee: fmtCsd(tx.fee) })})`,
    kind.test(d.title) && d.fee === fmtCsd(tx.fee) && att && dom && sameOutputs(d.outputs, tx.outputs));
  const target = tx.app.target;
  check(`${label}: the window's target reads ${JSON.stringify(reads.map(([m]) => m))} name the signed target, and are the ones this shape makes ${JSON.stringify(wantReads)}`,
    reads.every(([, id]) => id === target) && reads.map(([m]) => m).sort().join() === [...wantReads].sort().join());
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
agree("3. a review attest, fee omitted", await round("attest", { proposalId: MINE, score: 80, confidence: 70 }), /^Support \/ review/);
agree("3. honest path: the site's cancel of the user's own offer (score 0, confidence 100)", await round("attest", { proposalId: MINE, score: 0, confidence: 100, fee: 5_000_000 }), /^Cancel your offer/, ["attestTarget"]);
agree("3. honest path: score 0 on another account's offer is a review, not a cancel", await round("attest", { proposalId: THEIRS, score: 0, confidence: 100 }), /^Support \/ review/, ["attestTarget"]);
agree("3. an attest with no score and no confidence on the user's own offer", await round("attest", { proposalId: MINE }), /^Cancel your offer/, ["attestTarget"]);
{
  const r = await round("attest", { proposalId: MINE, score: 50, confidence: 0 });
  agree("3. a legacy reservation (score 50, confidence 0)", r, /^Reserve an open offer/);
  check(`3. the legacy reservation's pre-paint read is the wallet's local tip floor, with no tip read (${JSON.stringify(r.calls)})`, r.calls.includes("tipFloor") && !r.calls.includes("tip"));
}
agree("3. W1a R1: the token-fill confidence with no score is shown and signed as a fill at score 100, not a cancel", await round("attest", { proposalId: TOKEN_OFFER, confidence: CONF_TOKEN_FILL, fee: 5_000_000 }), /^Fill offer/, ["tokenFillQuote"]);
agree("3. the token-fill confidence as a digit string, score 100", await round("attest", { proposalId: TOKEN_OFFER, score: 100, confidence: String(CONF_TOKEN_FILL) }), /^Fill offer/, ["tokenFillQuote"]);
refusedShown("3. the token-fill confidence with score 0", await round("attest", { proposalId: TOKEN_OFFER, score: 0, confidence: CONF_TOKEN_FILL }));
// 4. fillOffer (the CSD lane through its reservation)
agree("4. a fill, score, confidence and fee omitted", await round("fillOffer", { proposalId: fw.fc.id, outputs: fw.outputs }), /^Fill offer/, ["fillOfferView"]);
fw = world(me, "none", 6000);
agree("4. a fill with score null", await round("fillOffer", { proposalId: fw.fc.id, outputs: fw.outputs, score: null }), /^Fill offer/, ["fillOfferView"]);
fw = world(me, "none", 7000);
refusedShown("4. a fill naming score 50", await round("fillOffer", { proposalId: fw.fc.id, outputs: fw.outputs, score: 50 }));
// 5. sealClaim: the domain and the fee against the commit, the claim against what the wallet keeps to reveal
for (const [label, params] of [["5. a seal, domain and fee omitted", { claim: "first" }], ["5. a seal whose domain has spaces around it", { claim: "second", domain: "  board:v1  " }], ["5. a seal with an explicit fee", { claim: "third", fee: 30_000_000 }]]) {
  const before = (await popup("sealedClaims")).result.length;
  const r = await round("sealClaim", params);
  agree(label, r, /Seal a claim/);
  const list = (await popup("sealedClaims")).result, kept = list[0];   // newest first
  check(`${label}: the claim shown is the claim kept for the reveal (${kept?.claim})`, list.length === before + 1 && r.d.text.includes(String(kept?.claim)) && kept?.claim === params.claim);
}
refusedShown("5. a seal whose domain is not a string", await round("sealClaim", { claim: "x", domain: 5 }));
// 6. revealClaim: no transaction; the txid shown is the txid posted
{
  const sealTx = (await popup("sealedClaims")).result[0].txid;
  const p0 = posted.length;
  const r = await round("revealClaim", sealTx);
  const body = posted.at(-1);
  check(`6. revealClaim: the seal txid shown is the one whose preimage is posted (${body?.txid?.slice(0, 12)})`, r.d.text.includes(sealTx) && posted.length === p0 + 1 && body.txid === sealTx && r.page.reply?.ok === true && r.tx === null);
  check(`6. revealClaim: the preview names the domain and claim the post makes public (${r.preview.slice(0, 80)})`, r.preview.includes(`Domain ${body?.domain}`) && r.preview.includes(`Claim ${body?.claim}`));
}
// 7. signinWithCsd: the audience, nonce, expiry, URI and statement shown are the lines of the signed message
for (const [label, params] of [["7. a sign-in with a statement, uri omitted", { nonce: "Nonce1234abcdef", statement: "Sign in" }], ["7. a sign-in asking a 99999 s expiry and a not-before", { nonce: "Nonce1234abcdef", expirationSecs: 99_999, notBeforeSecs: 30, uri: "https://site.example/login", resources: ["https://site.example/terms"] }]]) {
  const r = await round("signinWithCsd", params);
  const d = r.d;
  const msg = String(r.page.reply?.result?.message ?? "");
  const line = (k) => msg.split("\n").find((l) => l.startsWith(k + ": "))?.slice(k.length + 2);
  const secs = (Date.parse(line("Expiration Time")) - Date.parse(line("Issued At"))) / 1000;
  const rows = d.rows;
  check(`${label}: audience ${rows.Audience}, URI ${rows.URI}, expiry ${rows.Expires} shown = signed (${msg.split("\n")[0].split(" ")[0]}, ${line("URI")}, ${secs} s)`,
    msg.startsWith(`${rows.Audience} wants you`) && rows.URI === line("URI") && rows.Expires === `in ~${secs}s` && line("Nonce") === params.nonce && (!params.statement || (d.text.includes(params.statement) && msg.includes("\n" + params.statement + "\n"))) && (params.notBeforeSecs ? d.text.includes(`~${params.notBeforeSecs}s from now`) && !!line("Not Before") : !line("Not Before")));
}
// 8. nprofile replaces the name's whole profile. The card says so with the request, and its reserved row lists the keys
// of the current profile the new map drops, read from the configured name service (never the requesting site), for a
// third-party site and the first-party site alike. The read is information only: Approve arms at its 700 ms floor and a
// click signs without waiting for it.
//   RED-FIRST: drop fillProfileDrop from approve.ts's paint and the removed-keys and hostile-text checks fail; make
//   resolve() await the read and the held-open click signs nothing.
{
  const FIRST = "https://cairn-substrate.com";
  check(`8. setup: ${FIRST} is the wallet's first-party origin`, wallet.isFirstPartyOrigin(FIRST) === true && !wallet.isFirstPartyOrigin(ORIGIN));
  const tradeApi = String((await popup("status")).result.tradeApi);
  const rec = (profile) => ({ ok: true, status: 200, json: async () => ({ name: "alice", owner: me, profile, tipHeight: 116_520 }) });
  const b = buildNameProfile({ name: "alice", profile: { avatar: "https://b.example/y.png" } });
  const params = { domain: CAIRNX_DOMAIN, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 9_000 };
  const signsShown = (label, r) => check(`${label}: signed as shown (fee ${r.d.fee}, ${JSON.stringify(r.tx?.app)})`,
    r.tx?.app.kind === "Propose" && r.tx.app.domain === CAIRNX_DOMAIN && r.d.fee === fmtCsd(r.tx.fee) && r.tx.outputs.length === 0 && r.page.reply?.ok === true
    && submits.at(-1).app.Propose.uri === b.uri && [b.payloadHash, b.payloadHash.slice(2)].includes(hexOf(submits.at(-1).app.Propose.payload_hash)));
  nameAnswer = async () => rec({ contenthash: "ipfs://site-a", avatar: "https://a.example/x.png" });
  const cards = [];
  for (const origin of [ORIGIN, FIRST]) {
    const r0 = nameReads.length;
    const r = await round("propose", params, origin);
    signsShown(`8. nprofile from ${origin}`, r);
    check(`8. from ${origin}: the card says the record replaces the whole profile (${r.d.title})`, /identity profile/.test(r.d.title) && r.html.includes("This record replaces the whole profile on <code>alice.csd</code>: any key not listed below is removed."));
    check(`8. from ${origin}: the removed-keys row lists contenthash, with what it did for other applications, not avatar (${r.drop})`, r.drop === "<code>contenthash</code> (the site other applications open for this name)");
    check(`8. from ${origin}: the current profile is read from the configured name service (${nameReads.slice(r0).join(", ")})`, nameReads.length === r0 + 1 && nameReads[r0] === `${tradeApi}/cairnx/name/alice`);
    cards.push(`${r.html}|${r.drop}`);
  }
  check("8. a third-party site and the first-party site paint the same card", cards.length === 2 && cards[0] === cards[1]);
  nameAnswer = async () => rec({ "<img src=x onerror=alert(1)>": "v", "ab‮cd​": "v", avatar: "x" });
  const h = await round("propose", params);
  check(`8. HTML and bidi characters in a current key are rendered as text (${h.drop})`, h.drop === "<code>&lt;img src=x onerror=alert(1)&gt;</code>, <code>ab\\u202Ecd\\u200B</code>");
  signsShown("8. hostile current profile", h);
  nameAnswer = () => new Promise(() => { /* the name service never answers */ });
  const held = await round("propose", params);
  check(`8. read held open: Approve arms at the 700 ms floor (${held.armedMs} ms after the paint)`, held.armedMs >= 650 && held.armedMs < 1500);
  check("8. read held open: the reserved row keeps its pending text", held.html.includes(`<span id="profile-drop" class="dim">${PROFILE_DROP_PENDING}</span>`) && !held.drop);
  check(`8. read held open: the click signs without waiting for the read (${held.replyMs} ms)`, held.tx !== null && held.replyMs < 1500);
  signsShown("8. read held open", held);
}

// The proposal the wallet signed carries the request's domain, uri and payload hash, and moves no CSD.
const FIRST_PARTY = "https://cairn-substrate.com";
function signedAsRequested(r, params) {
  const a = r.tx ? submits.at(-1).app.Propose : null;
  return !!a && r.page.reply?.ok === true && r.tx.outputs.length === 0 && r.d.fee === fmtCsd(r.tx.fee) && a.domain === params.domain && a.uri === params.uri
    && [params.payloadHash.toLowerCase(), params.payloadHash.slice(2).toLowerCase()].includes(hexOf(a.payload_hash));
}
// 9. Every cairnx:v1 record type the window decodes, proposed by a third-party site, paints its decoded card (its title,
// anchored as a cairnx:v1 proposal, no raw Domain row), and the wallet signs the request's uri and payload hash. The same
// record from the wallet's first-party origin paints the same window: the request, the header and every mount filled
// after the paint are equal; only the origin line (the origin and its initial tile) differs. No origin is connected.
// The name service answers 503, so the name gates and the profile row take their could-not-read path for both alike.
//   RED-FIRST: make describe() skip the cairnx:v1 branch and every decoded-card check fails; make approve.ts asks()
//   word the first-party origin differently and every same-window check fails.
nameAnswer = async () => ({ ok: false, status: 503, json: async () => ({}) });
{
  const SALT = "5a".repeat(16), HASH = "0x" + "ef".repeat(32);
  const RECORDS = [
    ["transfer", /^CairnX token transfer$/, transfer({ ticker: "AAA", amount: "5", to: TO })],
    ["deploy", /^CairnX token deploy$/, deploy({ ticker: "NEWT", decimals: 2, supply: "100000", mint: "issuer" })],
    ["mint", /^CairnX token mint$/, mint({ ticker: "AAA", amount: "10" })],
    ["offer", /^CairnX offer$/, offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(1e8) } })],
    ["bid", /^CairnX bid$/, bid({ want: { name: "alice" }, give: { value: String(1e8) } })],
    ["ocancel", /^CairnX cancel offers$/, offerCancelAll({ ticker: "AAA" })],
    ["ncommit", /^\.csd registration, step 1 of 3/, nameCommitRecord({ commit: HASH })],
    ["name", /^\.csd registration, step 2 of 3/, nameClaim({ name: "alice", salt: SALT })],
    ["nfinalize", /^\.csd registration, step 3 of 3/, nameFinalize({ name: "alice", salt: SALT })],
    ["nxfer", /^\.csd name transfer$/, nameXfer({ name: "alice", to: TO })],
    ["nset", /^\.csd name → address record$/, nameSet({ name: "alice", addr: TO2 })],
    ["nrenew", /^\.csd name renewal$/, nameRenew({ name: "alice" })],
    ["nprofile", /^\.csd identity profile$/, nameProfile({ name: "alice", p: { avatar: "https://b.example/y.png" } })],
    ["tmeta", /^CairnX token metadata/, tokenMeta({ ticker: "AAA", hash: HASH })],
    ["fclaim", /^Reserve an open offer$/, fclaim({ offer: MINE })],
  ];
  const painted = (r) => JSON.stringify({ req: r.html, ...r.face, "ap-origin": undefined, "ap-tile": undefined });
  for (const [t, titled, b] of RECORDS) {
    const params = { domain: CAIRNX_DOMAIN, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 9_000 };
    const third = await round("propose", params, ORIGIN);
    check(`9. ${t} from ${ORIGIN}: the decoded card "${third.d.title}", signed with the request's uri and payload hash`,
      titled.test(third.d.title) && third.d.rows["Anchored as"] === "a cairnx:v1 proposal" && !("Domain" in third.d.rows) && signedAsRequested(third, params));
    const first = await round("propose", params, FIRST_PARTY);
    check(`9. ${t}: ${FIRST_PARTY} paints the same window as ${ORIGIN} but for the origin line (${first.face["ap-origin"]} / ${third.face["ap-origin"]})`,
      signedAsRequested(first, params) && painted(first) === painted(third) && first.face["ap-origin"] === FIRST_PARTY && third.face["ap-origin"] === ORIGIN);
  }
}

// 10. A proposal the window does not decode is shown raw as "Post a proposal", with the domain, the payload hash and the
// uri as sent and signed: a valid cairnx record's bytes in another domain, and three cairnx:v1 records the vendored
// parser refuses (a payload hash that is not the record's, a record type it does not know, a uri that is not JSON).
//   RED-FIRST: decode a record in any domain (drop the CAIRNX_DOMAIN test in describe()) and the first case fails; let
//   decodeCairnxRecord parse the uri without its hash check and the hash-mismatch case fails.
{
  const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const tr = transfer({ ticker: "AAA", amount: "5", to: TO }), other = mint({ ticker: "AAA", amount: "10" });
  const unknown = { v: 1, t: "zzz", x: 1 };
  const RAW = [
    ["a cairnx transfer's bytes in domain example:v1", { domain: "example:v1", uri: tr.uri, payloadHash: tr.payloadHash }],
    ["cairnx:v1 whose payload hash is another record's", { domain: CAIRNX_DOMAIN, uri: tr.uri, payloadHash: other.payloadHash }],
    ["cairnx:v1 with a record type the parser does not know", { domain: CAIRNX_DOMAIN, uri: canonicalJson(unknown), payloadHash: payloadHash(unknown) }],
    ["cairnx:v1 whose uri is not JSON", { domain: CAIRNX_DOMAIN, uri: "data:,hello", payloadHash: PH }],
  ];
  for (const [label, p] of RAW) {
    const params = { ...p, expiresEpoch: 9_000 };
    const r = await round("propose", params);
    agree(`10. ${label}`, r, /^Post a proposal$/);
    const raw = (k) => unesc([...String(r.html).matchAll(/<div(?: data-to="[^"]*")?><dt>([^<]*)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g)].find((m) => m[1] === k)?.[2].replace(/<[^>]+>/g, "") ?? "");
    check(`10. ${label}: the raw rows are the request's (Domain ${raw("Domain")}), not a decoded card, and the signed proposal is the request's`,
      raw("Domain") === params.domain && raw("Payload hash") === params.payloadHash && raw("URI") === params.uri && !("Anchored as" in r.d.rows) && signedAsRequested(r, params));
  }
}

// 11. A site that never called connect gets the approval window for a signing request, and the wallet signs on approve;
// the request records no connection, so the site's getPermissions stays empty. Paired: a connect the user approves
// records one.
//   RED-FIRST: have resolvePending record consent for every approved request and the no-consent checks fail; refuse a
//   signing method from an unconnected origin in queueDappRequest and the window check fails.
{
  const NEVER = "https://never-connected.example", JOINS = "https://connects.example";
  const sites = async () => (await popup("connectedSites")).result.map((s) => s.origin);
  const perms = async (origin) => { const out = dapp("getPermissions", undefined, origin); await until(() => out.reply !== undefined); return out.reply; };
  check(`11. setup: neither ${NEVER} nor ${JOINS} is connected (${JSON.stringify(await sites())})`, !(await sites()).includes(NEVER) && !(await sites()).includes(JOINS));
  const r = await round("send", { to: TO, amount: 120_000_000 }, NEVER);
  check(`11. a send from ${NEVER}, never connected, is painted in the approval window (${r.face?.["ap-origin"] ?? JSON.stringify(r.page.reply)})`, r.queued && r.face["ap-origin"] === NEVER && r.d.title === "Send CSD");
  agree("11. the unconnected site's send", r, /^Send CSD$/);
  const p = await perms(NEVER);
  check(`11. the signed request recorded no connection: not listed, getPermissions ${JSON.stringify(p)}`, !(await sites()).includes(NEVER) && p?.ok === true && Array.isArray(p.result) && p.result.length === 0);
  const c = await round("connect", undefined, JOINS);
  const q = await perms(JOINS);
  check(`11. paired: an approved connect from ${JOINS} records the connection (getPermissions ${JSON.stringify(q?.result?.[0]?.invoker)})`,
    c.page.reply?.ok === true && (await sites()).includes(JOINS) && q?.result?.[0]?.invoker === JOINS && String(q.result[0].accounts[0]).toLowerCase() === me);
}

// 12. A fill whose outputs pay one address more than the offer needs. Both lanes paint the extra output as a recipient
// row and flag it as new to the wallet. The reservation (fclaim) lane refuses it before signing (FILL_UNSAFE: the planned
// payment must equal the proven need exactly); the offer-id lane, here a taker-bound offer, signs it with the extra
// output in the transaction. Paired: the same offer-id fill without the extra signs exactly the need.
//   RED-FIRST: drop the `sums` bind passed to verifyFillSpv and the fclaim-lane refusal check fails; refuse an output
//   to an address outside the need in csdLanePreflight and the offer-id lane check fails.
{
  const EXTRA = "0x" + "e7".repeat(20);
  const flagged = (r) => r.face["send-warn"].includes(EXTRA.slice(0, 10)) && r.d.outputs.some((o) => o.to.toLowerCase() === EXTRA && o.amount === fmtCsd(1e8));
  fw = world(me, "none", 8000);
  const n0 = submits.length;
  const a = await round("fillOffer", { proposalId: fw.fc.id, outputs: [...fw.outputs, { to: EXTRA, value: 1e8 }] });
  const res = a.page.reply?.result;
  check(`12. reservation lane: the extra output is shown and flagged as new (${strip(a.face["send-warn"]).slice(0, 60)})`, flagged(a));
  check(`12. reservation lane: refused before signing, nothing submitted (${res?.code}: ${String(res?.error).slice(0, 70)})`,
    a.page.reply?.ok === true && res?.ok === false && res.code === "FILL_UNSAFE" && /payment does not match the proven fill progress/.test(res.error) && submits.length === n0);

  const S2 = "0x" + "5e".repeat(20), T = TREASURY_ADDR.toLowerCase(), h0 = 116_000;
  const nid = (k) => "0x" + (0xf5000 + k).toString(16).padStart(64, "0");
  const ev = (id, rec, h, paidTo = {}) => ({ kind: "propose", id, proposer: S2, uri: rec.uri, payloadHash: rec.payloadHash, height: h, pos: 1, expiresEpoch: epochOf(h) + 50_000, paidTo });
  const dep = ev(nid(1), deploy({ ticker: "TKB", decimals: 0, supply: "10", mint: "issuer" }), h0, { [T]: String(DEPLOY_FEE) });
  const mnt = ev(nid(2), mint({ ticker: "TKB", amount: "10" }), h0 + 1);
  const offers = [3, 4].map((k) => ev(nid(k), offer({ give: { ticker: "TKB", amount: "1" }, want: { value: String(1e8) }, taker: me, memo: `lot ${k}` }), h0 + 2));
  const state = resolve([dep, mnt, ...offers], 116_520).offers;
  for (const o of offers) servedOffers.set(o.id, state[o.id]);
  const prior = wallet.provenPaytoForTest;
  wallet.provenPaytoForTest = (id, ...rest) => {
    const o = offers.find((x) => x.id === String(id).toLowerCase());
    return o ? { payto: S2, seller: S2, terms: provenOfferTerms(parseRecord(o.uri, o.payloadHash), o.height), expiresEpoch: o.expiresEpoch, height: o.height } : prior(id, ...rest);
  };
  const need = (o) => requiredFillOutputs(state[o.id], BigInt(1e8)).map(({ to, value }) => ({ to, value: Number(value) }));
  check(`12. setup: the taker-bound offer is open and needs ${need(offers[0]).length} outputs`, state[offers[0].id]?.status === "open" && need(offers[0]).length >= 1);
  const extra = await round("fillOffer", { proposalId: offers[0].id, outputs: [...need(offers[0]), { to: EXTRA, value: 1e8 }] });
  check("12. offer-id lane: the extra output is shown and flagged as new", flagged(extra));
  agree("12. offer-id lane: the fill with the extra output signs as shown", extra, /^Fill offer/, ["fillOfferView"]);
  check(`12. offer-id lane: the signed transaction pays the extra output (${JSON.stringify(extra.tx?.outputs.map((o) => o.to.slice(0, 6)))})`,
    extra.page.reply?.result?.ok === true && extra.tx?.outputs.some((o) => o.to === EXTRA && o.amount === fmtCsd(1e8)));
  const exact = await round("fillOffer", { proposalId: offers[1].id, outputs: need(offers[1]) });
  agree("12. paired: the offer-id fill of exactly the need signs", exact, /^Fill offer/, ["fillOfferView"]);
  check("12. paired: ...and pays no address outside the need", exact.page.reply?.result?.ok === true && !exact.tx?.outputs.some((o) => o.to === EXTRA));
  wallet.provenPaytoForTest = prior;
}
// 13. The cards that say what a record does, through the real background and window, from a third-party site and from
// the first-party origin alike (one card, and the signed uri and hash are the request's): a name transfer is final and
// clears the name's address record and profile; a profile write says what contenthash, csd.rpc and csd.p2p do for other
// applications, in the new map and in the removed-keys row (filled from the read the window already makes); a cairnx:v1 record the wallet cannot read, and a record in
// another domain, say what they can and cannot do; an offer's only taker gets the look-alike check and no first-time
// notice, and an offer that wants nothing says so. Each card arms Approve at its 700 ms floor and is signed on the click.
// The window and the worker make as many fetches for a name transfer and a profile write as before this wording (counted
// on 649fcb4 with this section: before the click and after it).
//   RED-FIRST: on 649fcb4 the 13 copy and taker checks here fail and the arm, signing, same-window and fetch checks
//   pass; remove any one new sentence from src/popup/clearsign.ts and its two copy checks (one per origin) fail.
{
  const pickRec = (b) => ({ uri: b.uri, payloadHash: b.payloadHash });
  const LOOK_ME = me.slice(0, 8) + [...me.slice(8, 38)].map((c) => (c === "0" ? "1" : "0")).join("") + me.slice(38);
  const unknown = { v: 1, t: "zzz", x: 1 };
  nameAnswer = async () => ({ ok: true, status: 200, json: async () => ({ name: "alice", owner: me, profile: { contenthash: "ipfs://site-a", "csd.p2p": "peer.example:7779", avatar: "https://a.example/x.png" }, tipHeight: 116_520 }) });
  const CARDS = [
    ["name transfer", { domain: CAIRNX_DOMAIN, ...pickRec(nameXfer({ name: "alice", to: TO })) }, ["This transfer is final: the new owner controls <code>alice.csd</code> from then on. It also clears the name's address record and its profile."]],
    ["profile write setting contenthash and csd.rpc", { domain: CAIRNX_DOMAIN, ...pickRec(nameProfile({ name: "alice", p: { avatar: "https://b.example/y.png", contenthash: "ipfs://site-b", "csd.rpc": "https://rpc.example" } })) },
      ["Other applications read these keys:<br><code>contenthash</code>: the site other applications open for this name.<br><code>csd.rpc</code>: the node address other applications may read the chain through for this name.",
        "The other keys do <b>not</b> change where funds go, and other applications may read some of them."]],
    ["cairnx:v1 record the wallet cannot read", { domain: CAIRNX_DOMAIN, uri: canonicalJson(unknown), payloadHash: payloadHash(unknown) },
      ["This wallet does not recognise this cairnx:v1 record, so it cannot show what it does; it may be a record type newer than this wallet. The network may give it no effect, and the fee is spent either way."]],
    ["record in another domain", { domain: "example:v1", uri: "data:,hi", payloadHash: PH },
      ["This wallet does not interpret records of this domain: they cannot change CairnX names, tokens or offers. This one costs the network fee."]],
    ["offer that wants nothing, for a look-alike of this account", { domain: CAIRNX_DOMAIN, ...pickRec(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "0" }, taker: LOOK_ME })) },
      ["This offer asks <b>nothing</b> in return: whoever fills it gets what you give for nothing."]],
    ["offer for a new taker", { domain: CAIRNX_DOMAIN, ...pickRec(offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(1e8) }, taker: TO2 })) }, []],
  ];
  const painted = (r) => JSON.stringify({ req: r.html, ...r.face, "ap-origin": undefined, "ap-tile": undefined });
  const counts = {};
  for (const [label, p, copy] of CARDS) {
    const params = { ...p, expiresEpoch: 9_000 };
    const third = await round("propose", params, ORIGIN);
    const first = await round("propose", params, FIRST_PARTY);
    for (const [o, r] of [[ORIGIN, third], [FIRST_PARTY, first]]) {
      const missing = copy.filter((s) => !r.html.includes(s));
      check(`13. ${label} from ${o}: the card says what it does (missing: ${missing.map((s) => s.slice(0, 40)).join(" | ") || "none"})`, missing.length === 0);
      check(`13. ${label} from ${o}: Approve arms at the 700 ms floor (${r.armedMs} ms) and the click signs the request's uri and hash`, r.armedMs >= 650 && r.armedMs < 1500 && signedAsRequested(r, params));
    }
    check(`13. ${label}: ${FIRST_PARTY} paints the same window as ${ORIGIN} but for the origin line`, painted(first) === painted(third));
    counts[label] = [third.fetches, first.fetches].map((f) => [f.paint.length, f.click.length]);
    if (label === "name transfer" || label.startsWith("profile write")) console.log(`13. ${label} fetches:`, JSON.stringify(third.fetches).replace(/https?:\/\/[^/"]+/g, ""));
    if (label.startsWith("offer that")) {
      const w = third.face["send-warn"];
      check(`13. a taker that looks like this account gets the look-alike warning (${strip(w).slice(0, 80)})`, /Possible address-poisoning/.test(w) && w.includes("Only this address can fill the offer.") && !/First time/.test(w));
      check("13. ...and its row carries the address it names", third.html.includes(`<div data-to="${LOOK_ME}"><dt>Only fillable by</dt>`));
    }
    if (label === "offer for a new taker") check(`13. a new taker gets no first-time notice (send-warn ${JSON.stringify(third.face["send-warn"])} / ${JSON.stringify(first.face["send-warn"])})`, third.face["send-warn"] === "" && first.face["send-warn"] === "");
    if (label.startsWith("profile write")) {
      check(`13. the removed-keys row marks the csd.p2p it removes (${third.drop})`, third.drop === "<code>csd.p2p</code> (a peer other applications may dial)" && first.drop === third.drop);
    }
  }
  // Fetches before the click (the window's own reads and the worker's answers to them) and after it (the signing), on
  // 649fcb4 and on this change: the wording added no read.
  console.log("13. fetches [before the click, after it] per origin:", JSON.stringify(counts));
  // The CSD-paid fill card (its listing ticker warning and mark fill #fill-view after the paint) arms at the same floor.
  fw = world(me, "none", 9000);
  const fl = await round("fillOffer", { proposalId: fw.fc.id, outputs: fw.outputs });
  agree("13. a CSD-paid fill", fl, /^Fill offer/, ["fillOfferView"]);
  check(`13. a CSD-paid fill: Approve arms at the 700 ms floor (${fl.armedMs} ms)`, fl.armedMs >= 650 && fl.armedMs < 1500);
  check(`13. a name transfer makes the fetches it made before (${JSON.stringify(counts["name transfer"])})`, JSON.stringify(counts["name transfer"]) === "[[3,3],[3,3]]");
  check(`13. a profile write makes the fetches it made before (${JSON.stringify(counts["profile write setting contenthash and csd.rpc"])})`, JSON.stringify(counts["profile write setting contenthash and csd.rpc"]) === "[[4,3],[4,3]]");
}
done("sign-display-parity");
