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
// Run: npx tsx test/sign-display-parity.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { mountApproveWindow, loadApprove, flush, sleep } from "./helpers/approve-dom.mjs";
import { fmtCsd, CONF_TOKEN_FILL, CAIRNX_DOMAIN, buildNameProfile } from "../src/core/cairnx.ts";
import { PROFILE_DROP_PENDING } from "../src/popup/clearsign.ts";
import { world, truthful, PRIV } from "./helpers/fillworld.mjs";
import { offer } from "../src/vendor/cairnx-spv.js";
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
const TOKEN_OFFER = "0x" + "7a".repeat(32), MINE = "0x" + "be".repeat(32), THEIRS = "0x" + "bf".repeat(32);
const tokenOffer = () => ({ id: TOKEN_OFFER, seller: me, give: { ticker: "AAA", amount: "10" }, want: { ticker: "PAY", amount: "7" }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150 });
const listed = offer({ give: { ticker: "AAA", amount: "10" }, want: { value: String(1e8) } });
const proposal = (id) => ({ ok: true, proposal: { payload_hash: listed.payloadHash, domain: CAIRNX_DOMAIN, uri: listed.uri, proposer: id === THEIRS ? "0x" + "99".repeat(20) : me } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init.body).tx); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + String(submits.length).padStart(64, "0") }) }; }
  if (u.includes("/api/content")) { posted.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  for (const id of [MINE, THEIRS, TOKEN_OFFER]) if (u.includes(`/proposal/${id}`)) return { ok: true, status: 200, json: async () => proposal(id) };
  if (u.includes("/proposal/")) return { ok: true, status: 200, json: async () => ({ ok: true, proposal: { payload_hash: "0x" + "11".repeat(32) } }) };
  if (u.includes("clarvis")) return truthful(fw)(init, u);
  if (u.includes(`/cairnx/offer/${TOKEN_OFFER}`)) return { ok: true, status: 200, json: async () => tokenOffer() };
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
// Queues one request, lets the window paint it (its pre-paint reads included), clicks Approve once the buttons arm, and
// returns the painted fields, the window's target reads and the transaction submitted, if any.
async function round(method, params, origin = ORIGIN) {
  const s0 = sent.length, n = submits.length;
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
  const calls = sent.slice(s0).map(([m]) => m).filter((m) => !POLLS.has(m));
  const reads = sent.slice(s0).filter(([m]) => TARGET_READS.includes(m)).map(([m, a]) => [m, String(a[0]).toLowerCase()]);
  const clicked = Date.now();
  if (armed()) await registry.get("btn-approve")._listeners.click();
  else await registry.get("btn-reject")._listeners.click();
  await until(() => page.reply !== undefined);
  return { queued: true, page, d: shown(html), html, drop, reads, calls, preview, armedMs, replyMs: Date.now() - clicked, tx: submits.length > n ? signed(submits.at(-1)) : null };
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
  const hexOf = (v) => (typeof v === "string" ? v : hex(v)).toLowerCase();
  nameAnswer = async () => rec({ contenthash: "ipfs://site-a", avatar: "https://a.example/x.png" });
  const cards = [];
  for (const origin of [ORIGIN, FIRST]) {
    const r0 = nameReads.length;
    const r = await round("propose", params, origin);
    signsShown(`8. nprofile from ${origin}`, r);
    check(`8. from ${origin}: the card says the record replaces the whole profile (${r.d.title})`, /identity profile/.test(r.d.title) && r.html.includes("This record replaces the whole profile on <code>alice.csd</code>: any key not listed below is removed."));
    check(`8. from ${origin}: the removed-keys row lists contenthash, not avatar (${r.drop})`, r.drop === "<code>contenthash</code>");
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
done("sign-display-parity");
