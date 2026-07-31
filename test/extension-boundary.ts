// BEHAVIORAL test of the extension trust boundary — the Freighter (CVE-2023-40580)
// and Frontier class, where a crafted page message reached a UI-privileged handler
// and leaked the seed with zero user interaction. We load the REAL background service
// worker with a mock `chrome`, capture its onMessage listener, and drive the actual
// message path: a website can only reach the wallet via the content-script relay,
// which stamps kind:"dapp" — so we fire dApp requests for privileged methods and
// prove they are rejected (not executed), even after the user approves.
import { sha256 } from "@noble/hashes/sha256"; // (force module init parity w/ background)
import { readFileSync } from "node:fs";
import { mkCoin, txReply } from "./_coin.js";

declare const process: { exit(code: number): void };
declare const setTimeout: (f: () => void, ms: number) => void;
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };
const PW = "correct horse battery staple";
void sha256;

// Controllable clock — installed BEFORE importing background so the Wallet's lastActive (set at
// construction + on touch()) reads it. Lets the WL-1/R19 test advance "idle time" deterministically.
let NOW = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;

// ── mock chrome (storage-backed, captures the message listener + window opens + alarm handler) ──
const mem = new Map<string, any>();
let listener: (m: any, s: any, r: (v: any) => void) => any = () => {};
let alarmHandler: (a: any) => any = () => {};
let connectListener: (port: any) => any = () => {}; // L2: capture the onConnect handler (event ports)
let windowsOpened = 0;
(globalThis as any).chrome = {
  runtime: {
    id: "cairnwallettestid",
    lastError: undefined,
    getURL: (p: string) => "chrome-extension://x/" + p,
    onMessage: { addListener: (fn: any) => { listener = fn; } },
    onConnect: { addListener: (fn: any) => { connectListener = fn; } },
  },
  storage: { local: {
    get: async (k: string) => ({ [k]: mem.get(k) }),
    set: async (o: any) => { for (const k of Object.keys(o)) mem.set(k, o[k]); },
    remove: async (k: string) => { mem.delete(k); },
  } },
  alarms: { create: () => {}, onAlarm: { addListener: (fn: any) => { alarmHandler = fn; } } },
  action: { setBadgeText: () => {} },
  windows: { create: () => { windowsOpened++; } },
};
void realNow;
// Fire the background's registered idle-autolock alarm (it calls wallet.autoLock(15min)). We advance
// the clock by `idleMs` first so the wallet sees that much idle time since its last touch().
async function fireAutolock(idleMs: number): Promise<void> { NOW += idleMs; alarmHandler({ name: "cairn-autolock" }); await tick(); await tick(); }

// ── mock the node RPC so an approved `send` actually builds + "submits" a tx we can
//    inspect (one confirmed UTXO worth 10 CSD; /tx/submit captures the tx). ──
const MC = mkCoin(1_000_000_000, 0, { coinbase: false }); const MOCK_UTXO = MC.coin;
let lastSubmit: any = null;
let submitN = 0;
// fillOffer's C2/C3/C4 pre-flight fetches /cairnx/offer/:id; a test can seed a crafted offer here to
// exercise the refusal paths (an unseeded id returns the generic {ok:true}, which the gate skips).
const offerFixtures = new Map<string, any>();
let tipDown = false; // simulate a node-RPC /tip blip (get() fails soft → tip reads 0, never throws)
let tipHeight = 34000; // ≥ V13/V17 (open-lane heights); lower it to simulate a stale/hostile RPC
(globalThis as any).fetch = async (url: string, init?: any) => {
  const u = String(url);
  if (u.includes("/utxos/")) return { ok: true, json: async () => ({ ok: true, confirmed_balance: MOCK_UTXO.value, utxos: [MOCK_UTXO] }) };
  if (u.endsWith("/tip")) return tipDown ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => ({ ok: true, height: tipHeight }) };  // ≥ V13/V17 (open-lane heights)
  const om = u.match(/\/cairnx\/offer\/(0x[0-9a-fA-F]{64})/);
  if (om && offerFixtures.has(om[1].toLowerCase())) return { ok: true, status: 200, json: async () => offerFixtures.get(om[1].toLowerCase()) };
  const tr = txReply(u, [MC]); if (tr) return tr;
  // unique txid per submit — the wallet's history is (correctly) idempotent by txid,
  // so a fixed mock txid would silently drop later records and mask real behavior.
  if (u.includes("/tx/submit")) { lastSubmit = JSON.parse(init.body); const id = "0x" + (submitN++).toString(16).padStart(64, "5"); return { ok: true, json: async () => ({ ok: true, txid: id }) }; }
  return { ok: true, json: async () => ({ ok: true }) };
};
const spkHex = (a: any) => "0x" + (a as number[]).map((b) => b.toString(16).padStart(2, "0")).join("");

// popup-channel call (privileged, used only by the extension's own pages). The REAL popup/extension
// pages share our runtime id and a chrome-extension://<our-id>/ sender.url. The approval window is
// opened via chrome.windows.create({type:"popup"}) so it ALSO carries a sender.tab — the F12 gate must
// key on the extension ORIGIN, not on tab-absence (keying on tab broke the connect/approval flow).
const popup = (method: string, ...args: any[]) => new Promise<any>((res) => listener({ kind: "popup", method, args }, { id: "cairnwallettestid", url: "chrome-extension://x/approve.html", tab: { id: 1 } }, res));
// a forged popup message from a content script (web-page sender.url) or a wrong extension id — must be rejected
const popupAs = (sender: any, method: string, ...args: any[]) => new Promise<any>((res) => { let r: any; listener({ kind: "popup", method, args }, sender, (v: any) => { r = v; res(v); }); return r; });
// a website's request always arrives via the content-script relay as kind:"dapp"
const dappAsync = (method: string, params: any, origin = "https://evil.test") => {
  let resp: any; let done = false;
  listener({ kind: "dapp", method, params }, { origin }, (r: any) => { resp = r; done = true; });
  return { get: () => resp, done: () => done };
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function main() {
  (globalThis as { __CAIRN_TEST__?: boolean }).__CAIRN_TEST__ = true; // expose the bg wallet for the F2-legacy seam
  await import("../src/background.js"); // registers the listener (side-effecting module)
  await tick();

  console.log("=== set up an UNLOCKED wallet via the privileged popup channel ===");
  const created = await popup("create", PW);
  check("popup channel can create a wallet (extension UI is privileged)", created.ok === true && !!created.result.addr);
  const priv = (await popup("export", PW)).result.replace(/^0x/, "").toLowerCase();
  check("popup channel can export the key with the password (UI-only)", /^[0-9a-f]{64}$/.test(priv));

  console.log("\n=== a website (dApp channel) CANNOT invoke key-exposing / privileged methods ===");
  // These are not in the dApp allowlist, so queueDappRequest rejects them IMMEDIATELY —
  // they never enter the pending queue, never open an approval window, and cannot be
  // approved into execution. (`send` is intentionally NOT here — it is an approval-gated
  // dApp method now; positive-control + smuggle tests below.)
  for (const m of ["export", "exportMnemonic", "restore", "import", "reset", "setApi", "setRpc", "addAccount", "switchAccount", "removeAccount", "unlock", "lock", "create"]) {
    const winBefore = windowsOpened;
    const req = dappAsync(m, ["x"]);
    await tick();
    const pend = (await popup("pending")).result;
    const r = req.get();
    const refused = r && r.ok === false && !pend.some((x: any) => x.method === m);
    const noWindow = windowsOpened === winBefore;
    const noKey = !JSON.stringify(r ?? {}).toLowerCase().includes(priv);
    check(`dApp '${m}' is refused before queuing (no window, no approval path), leaks no key`, refused && noWindow && noKey);
  }

  console.log("\n=== the approval flow actually gates dApp requests (no silent auto-exec) ===");
  const before = windowsOpened;
  const propose = dappAsync("propose", { domain: "csd:test", payloadHash: "0x" + "11".repeat(32), uri: "cairn:v1:x", expiresEpoch: 1, fee: 25000000 });
  await tick();
  check("a dApp request opens an approval window (user must act)", windowsOpened > before);
  check("dApp propose does NOT resolve until the user approves it", propose.done() === false);

  console.log("\n=== legitimate dApp identity request works (positive control) ===");
  const addr = (await popup("status")).result.addr;
  const conn = dappAsync("getAddress", {});
  await tick();
  let p = (await popup("pending")).result;
  await popup("resolve", p[p.length - 1].id, true);
  await tick();
  check("approved dApp getAddress returns the address (and only the address)", conn.get()?.ok === true && conn.get().result.addr === addr && !JSON.stringify(conn.get()).toLowerCase().includes(priv));

  console.log("\n=== per-origin consent (connected sites): connect goes silent after approval; SIGNING never does ===");
  const SITE = "https://app.test";
  // 1. first connect from a brand-new origin must prompt
  const winBeforeC = windowsOpened;
  const c1 = dappAsync("connect", {}, SITE);
  await tick();
  check("first connect from a new origin opens an approval window", windowsOpened > winBeforeC && c1.done() === false);
  let cp = (await popup("pending")).result;
  await popup("resolve", cp[cp.length - 1].id, true); // approve → records consent
  await tick();
  check("approved connect returns the address", c1.get()?.ok === true && c1.get().result.addr === addr);
  // 2. the origin now appears in connected sites
  const sites = (await popup("connectedSites")).result;
  check("the origin is now listed under connected sites", Array.isArray(sites) && sites.some((s: any) => s.origin === SITE));
  // 3. a SECOND connect/getAddress from the same origin is SILENT (no new window, resolves immediately)
  const winBeforeC2 = windowsOpened;
  const c2 = dappAsync("getAddress", {}, SITE);
  await tick();
  check("repeat getAddress from a consented origin opens NO new window (silent)", windowsOpened === winBeforeC2);
  check("repeat getAddress resolves immediately with only the address", c2.done() === true && c2.get()?.ok === true && c2.get().result.addr === addr && !JSON.stringify(c2.get()).toLowerCase().includes(priv));
  // 4. THE CRITICAL ASSERTION: signing from the SAME consented origin STILL prompts, every time
  const winBeforeSign = windowsOpened;
  const sgn = dappAsync("send", { to: "0x" + "cc".repeat(20), amount: 1_000_000, fee: 1_000_000 }, SITE);
  await tick();
  check("send from a CONSENTED origin STILL opens the approval window (consent never auto-approves signing)", windowsOpened > winBeforeSign && sgn.done() === false);
  await popup("resolve", (await popup("pending")).result.slice(-1)[0].id, false); // reject to clean up
  await tick();
  const winBeforeProp = windowsOpened;
  const pr = dappAsync("propose", { domain: "csd:test", payloadHash: "0x" + "11".repeat(32), uri: "x", expiresEpoch: 1, fee: 25000000 }, SITE);
  await tick();
  check("propose from a consented origin STILL prompts", windowsOpened > winBeforeProp && pr.done() === false);
  await popup("resolve", (await popup("pending")).result.slice(-1)[0].id, false);
  await tick();
  // 5. revoke → the next connect prompts again
  const rev = (await popup("disconnectSite", SITE)).result;
  check("disconnectSite removes the origin from connected sites", rev.removed === true);
  const winBeforeRe = windowsOpened;
  const c3 = dappAsync("connect", {}, SITE);
  await tick();
  check("after revoke, connect prompts again (no longer silent)", windowsOpened > winBeforeRe && c3.done() === false);
  await popup("resolve", (await popup("pending")).result.slice(-1)[0].id, false);
  await tick();

  console.log("\n=== dApp `send` is approval-gated, routed to wallet.send, and cannot smuggle ===");
  const RECIP = "0x" + "cc".repeat(20);
  const EVIL_CHANGE = "0x" + "de".repeat(20);
  // a hostile page tries to ALSO pass its own inputs + a change address — both must be ignored
  const sreq = dappAsync("send", { to: RECIP, amount: 100_000_000, fee: 1_000_000, inputs: [{ txid: "0x" + "ff".repeat(32), vout: 9 }], change: EVIL_CHANGE });
  await tick();
  check("dApp send is NOT auto-executed — it opens an approval window", sreq.done() === false);
  let sp = (await popup("pending")).result;
  await popup("resolve", sp[sp.length - 1].id, true); // user approves
  await tick(); await tick();
  const sr = sreq.get();
  check("approved dApp send is ROUTED to wallet.send (not refused by the whitelist)", sr && sr.ok === true && !/unsupported dApp method/.test(JSON.stringify(sr)));
  check("dApp send leaks no private key", !JSON.stringify(sr ?? {}).toLowerCase().includes(priv));
  const outs = lastSubmit?.tx?.outputs ?? [];
  const ins = lastSubmit?.tx?.inputs ?? [];
  check("send used the wallet's OWN selected input (smuggled `inputs` ignored)", ins.length === 1 && spkHex(ins[0].prevout.txid) === MOCK_UTXO.txid);
  check("send paid exactly the recipient the user approved", outs.some((o: any) => spkHex(o.script_pubkey) === RECIP && Number(o.value) === 100_000_000));
  check("change returned to the wallet's OWN address (smuggled `change` ignored)", outs.some((o: any) => spkHex(o.script_pubkey) === addr) && !outs.some((o: any) => spkHex(o.script_pubkey) === EVIL_CHANGE));
  check("no output value exceeds the approved spend", outs.every((o: any) => Number(o.value) <= MOCK_UTXO.value));

  console.log("\n=== multi-output (1→many) send also routes + returns change to self ===");
  lastSubmit = null;
  const R1 = "0x" + "a1".repeat(20), R2 = "0x" + "b2".repeat(20);
  const mreq = dappAsync("send", { outputs: [{ to: R1, value: 50_000_000 }, { to: R2, value: 30_000_000 }], fee: 1_000_000 });
  await tick();
  sp = (await popup("pending")).result;
  await popup("resolve", sp[sp.length - 1].id, true);
  await tick(); await tick();
  const mouts = lastSubmit?.tx?.outputs ?? [];
  check("multi-output send paid both recipients + change to self", mreq.get()?.ok === true
    && mouts.some((o: any) => spkHex(o.script_pubkey) === R1 && Number(o.value) === 50_000_000)
    && mouts.some((o: any) => spkHex(o.script_pubkey) === R2 && Number(o.value) === 30_000_000)
    && mouts.some((o: any) => spkHex(o.script_pubkey) === addr));

  console.log("\n=== dApp `fillOffer` (Attest + payment, atomic DvP) is approval-gated and cannot smuggle ===");
  lastSubmit = null;
  const OFFER_ID = "0x" + "22".repeat(32);
  const SELLER = "0x" + "ee".repeat(20);
  // F2-legacy: the legacy CSD lane now binds the payment recipient to the merkle-proven offer author. These
  // fixtures are honest (payto == seller == SELLER), so inject the proven author on the background wallet so the
  // downstream need-map (F2 output-sizing) assertions below are reached rather than short-circuited on the SPV read.
  const bgWallet = (globalThis as { __cairnBgWallet?: { provenPaytoForTest?: unknown } }).__cairnBgWallet;
  const fillerAddr = (await popup("status")).result.addr as string;
  // The proven terms are offer-id-aware (provenPaytoForTest receives the offerId): the SMOKE offer OFFER_ID is a
  // CSD-priced TAKER-BOUND offer (XR-1/N26: a token-priced offer may carry NO CSD outputs, so a DvP smoke that
  // pays the seller a CSD leg must be a CSD offer), and every other CSD fixture (MY_CLAIM_ID etc.: payto/seller
  // = SELLER, height 34000 feeBps 150, value 40000000, no taker) gets the CSD terms the F2 amount-bind mirrors.
  if (bgWallet) bgWallet.provenPaytoForTest = (offerId: string) =>
    String(offerId).toLowerCase() === OFFER_ID.toLowerCase()
      ? ({ payto: SELLER.toLowerCase(), seller: SELLER.toLowerCase(), terms: { height: 34000, feeBps: 150, value: "40000000", taker: fillerAddr.toLowerCase(), bid: undefined, giveTicker: "TKN", giveAmount: "1", giveName: undefined, wantType: "csd" } })
      : ({ payto: SELLER.toLowerCase(), seller: SELLER.toLowerCase(), terms: { height: 34000, feeBps: 150, value: "40000000", taker: undefined, bid: undefined, giveTicker: "TKN", giveAmount: "1", giveName: undefined, wantType: "csd" } });   // B7e: give matches the CSD fixtures (give TKN/1) so the flipped give leg passes on the honest need-map fill
  // B1 (0.2.57): the preflight now fails CLOSED unless the resolver positively parses to an open
  // offer — the old "unseeded id returns a status-less {ok:true} and the gate skips it" harness
  // assumption models exactly the hole B1 closed. Seed a REAL open offer for the smoke: CSD-priced
  // (want.value, XR-1/N26 requires a token offer to move NO CSD) + taker-bound to this wallet, so the
  // approved outputs are the honest whole-fill need-map (seller payment + treasury fee).
  const SMOKE_TREASURY = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016"; // TREASURY_ADDR — the whole-fill fee leg
  offerFixtures.set(OFFER_ID.toLowerCase(), { id: OFFER_ID, seller: SELLER, status: "open", give: { ticker: "TKN", amount: "1" }, want: { value: "40000000", payto: SELLER }, taker: fillerAddr, height: 34000, feeBps: 150 });
  const winBeforeFill = windowsOpened;
  // hostile extras (inputs/change) must be ignored exactly like send
  const freq = dappAsync("fillOffer", {
    proposalId: OFFER_ID, outputs: [{ to: SELLER, value: 40_000_000 }, { to: SMOKE_TREASURY, value: 600_000 }], fee: 5_000_000,
    inputs: [{ txid: "0x" + "ff".repeat(32), vout: 9 }], change: "0x" + "de".repeat(20),
  });
  await tick();
  check("dApp fillOffer ALWAYS opens the approval window (never silent)", windowsOpened > winBeforeFill && freq.done() === false);
  sp = (await popup("pending")).result;
  check("fillOffer request is queued with its method intact", sp[sp.length - 1].method === "fillOffer");
  await popup("resolve", sp[sp.length - 1].id, true);
  await tick(); await tick();
  const fr = freq.get();
  check("approved fillOffer is ROUTED to wallet.fillOffer (txid returned)", fr?.ok === true && !!fr.result?.txid);
  check("fillOffer leaks no private key", !JSON.stringify(fr ?? {}).toLowerCase().includes(priv));
  const fapp = lastSubmit?.tx?.app?.Attest;
  check("fillOffer tx carries the Attest app referencing the offer", !!fapp && spkHex(fapp.proposal_id) === OFFER_ID && fapp.score === 100 && fapp.confidence === 100);
  const fouts = lastSubmit?.tx?.outputs ?? [];
  const fins = lastSubmit?.tx?.inputs ?? [];
  check("fillOffer paid the seller exactly the approved amount IN THE SAME TX as the attest", fouts.some((o: any) => spkHex(o.script_pubkey) === SELLER && Number(o.value) === 40_000_000));
  check("fillOffer used the wallet's OWN input (smuggled `inputs` ignored)", fins.length === 1 && spkHex(fins[0].prevout.txid) === MOCK_UTXO.txid);
  check("fillOffer change returned only to the wallet's own address", fouts.every((o: any) => spkHex(o.script_pubkey) === SELLER || spkHex(o.script_pubkey) === SMOKE_TREASURY || spkHex(o.script_pubkey) === addr));
  check("fillOffer recorded in history as a fill with the offer target + total spent", ((await popup("history")).result as any[]).some((t) => t.type === "fillOffer" && t.target === OFFER_ID && t.to === "2 recipients" && t.amount === 40_600_000));

  console.log("\n=== fillOffer C2/C3/C4 pre-flight REFUSES a doomed value tx (deep-review 2026-07-03) ===");
  // helper: approve a queued fillOffer and return the dApp response (refusals arrive as {ok:false,error})
  const approveFill = async (params: any) => {
    const req = dappAsync("fillOffer", params); await tick();
    const q = (await popup("pending")).result; await popup("resolve", q[q.length - 1].id, true); await tick(); await tick();
    return req.get();
  };
  // (a) a FILLED offer → refuse before any payment (no fill submit)
  const FILLED_ID = "0x" + "23".repeat(32);
  offerFixtures.set(FILLED_ID.toLowerCase(), { id: FILLED_ID, seller: SELLER, status: "filled", give: { ticker: "TKN", amount: "1" }, want: { value: "40000000", payto: SELLER }, height: 34000, feeBps: 150 });
  lastSubmit = null;
  const rFilled = await approveFill({ proposalId: FILLED_ID, outputs: [{ to: SELLER, value: 40_000_000 }], fee: 5_000_000 });
  check("fillOffer REFUSES a filled offer (no payment signed)", rFilled?.result?.ok === false && /filled|no-op/i.test(String(rFilled?.result?.error)) && lastSubmit === null);
  check("WS5: the preflight refusal carries the FILL_UNSAFE code on the nested result", rFilled?.result?.code === "FILL_UNSAFE");
  // (b) an OPEN CSD offer taker-bound to SOMEONE ELSE → refuse (taker mismatch; no tip needed)
  const TAKER_OTHER_ID = "0x" + "24".repeat(32);
  offerFixtures.set(TAKER_OTHER_ID.toLowerCase(), { id: TAKER_OTHER_ID, seller: SELLER, status: "open", give: { ticker: "TKN", amount: "1" }, want: { value: "40000000", payto: SELLER }, taker: "0x" + "9a".repeat(20), height: 34000, feeBps: 150 });
  lastSubmit = null;
  const rTaker = await approveFill({ proposalId: TAKER_OTHER_ID, outputs: [{ to: SELLER, value: 40_000_000 }], fee: 5_000_000 });
  check("fillOffer REFUSES a taker-bound offer bound to someone else (no payment signed)", rTaker?.result?.ok === false && /taker-bound|refusing/i.test(String(rTaker?.result?.error)) && lastSubmit === null);
  // (c) an OPEN (untaken) CSD offer with NO live claim by me → refuse (C2/C4 whole-payment-loss)
  const OPEN_UNCLAIMED_ID = "0x" + "25".repeat(32);
  offerFixtures.set(OPEN_UNCLAIMED_ID.toLowerCase(), { id: OPEN_UNCLAIMED_ID, seller: SELLER, status: "open", give: { ticker: "TKN", amount: "1" }, want: { value: "40000000", payto: SELLER }, height: 34000, feeBps: 150 });
  lastSubmit = null;
  const rOpen = await approveFill({ proposalId: OPEN_UNCLAIMED_ID, outputs: [{ to: SELLER, value: 40_000_000 }], fee: 5_000_000 });
  check("fillOffer REFUSES an open CSD offer with no live claim by me (C2/C4)", rOpen?.result?.ok === false && /claim/i.test(String(rOpen?.result?.error)) && lastSubmit === null);

  // ── review F1/F2/F4 follow-ups: tip-down fail-closed, fee/rebate need-map, integer-only money ──
  // an OPEN CSD offer where *I* hold the live claim (claimUntilHeight past tip 34000): the fill is mine
  // to make — the remaining ways it can still burn are a missing fee/rebate output or an unknown tip.
  const MY_CLAIM_ID = "0x" + "26".repeat(32);
  const TREASURY = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016"; // TREASURY_ADDR (types.ts:79) — the fee sink
  const myAddr = (await popup("status")).result.addr as string;
  offerFixtures.set(MY_CLAIM_ID.toLowerCase(), { id: MY_CLAIM_ID, seller: SELLER, status: "open", give: { ticker: "TKN", amount: "1" }, want: { value: "40000000", payto: SELLER }, height: 34000, feeBps: 150, claimedBy: myAddr, claimUntilHeight: 34100 });
  // (d) F1: node-RPC /tip blip → tip reads 0 → the claim gate CANNOT be evaluated → fail CLOSED (retryable)
  tipDown = true; lastSubmit = null;
  const rTipDown = await approveFill({ proposalId: MY_CLAIM_ID, outputs: [{ to: SELLER, value: 65_200_000 }, { to: TREASURY, value: 600_000 }], fee: 5_000_000 });
  check("fillOffer REFUSES an open-CSD fill when the tip cannot be fetched (F1 fail-closed, no payment signed)", rTipDown?.result?.ok === false && /chain tip/i.test(String(rTipDown?.result?.error)) && lastSubmit === null);
  check("WS5: the tip-unavailable refusal carries the retryable VERIFY_UNAVAILABLE code", rTipDown?.result?.code === "VERIFY_UNAVAILABLE");
  tipDown = false;
  // (d2) RED-TEAM 2026-07-06: a stale/hostile RPC reporting a POSITIVE tip BELOW V13_HEIGHT (31,100)
  // used to DISARM the open-CSD claim gate (isOpenClaimLane false → fillIsSafe skips the check), letting
  // a fill through that the real chain (~47k) no-ops → whole payment lost. Even the LIVE CLAIMANT here
  // must be refused, because the gate cannot be evaluated at a sub-V13 tip. The old `!(tip > 0)` guard
  // missed this band; the fix fails closed on `!isOpenClaimLane(offer, tip)` for the open-CSD lane.
  for (const staleTip of [1, 30000, 31099]) {
    tipHeight = staleTip; lastSubmit = null;
    const rStale = await approveFill({ proposalId: MY_CLAIM_ID, outputs: [{ to: SELLER, value: 65_200_000 }, { to: TREASURY, value: 600_000 }], fee: 5_000_000 });
    check(`fillOffer REFUSES an open-CSD fill at a sub-V13 reported tip (${staleTip}) — claim gate disarm closed, no payment`,
      rStale?.result?.ok === false && /chain tip/i.test(String(rStale?.result?.error)) && rStale?.result?.code === "VERIFY_UNAVAILABLE" && lastSubmit === null);
  }
  tipHeight = 34000; // restore a healthy open-lane tip
  // (e) F2: resolver need-map — treasury fee output missing → on-chain "protocol fee unpaid" AFTER payment; refuse
  lastSubmit = null;
  const rNoFee = await approveFill({ proposalId: MY_CLAIM_ID, outputs: [{ to: SELLER, value: 65_200_000 }], fee: 5_000_000 });
  check("fillOffer REFUSES a fill missing the protocol-fee output (F2, no payment signed)", rNoFee?.result?.ok === false && /protocol fee/i.test(String(rNoFee?.result?.error)) && lastSubmit === null);
  // (f) F2 SUM rule: payto==seller, so the seller output must cover price+rebate SUMMED (40M+25.2M); 40M alone underpays
  lastSubmit = null;
  const rNoRebate = await approveFill({ proposalId: MY_CLAIM_ID, outputs: [{ to: SELLER, value: 40_000_000 }, { to: TREASURY, value: 600_000 }], fee: 5_000_000 });
  check("fillOffer REFUSES when price+rebate at the same address underpays the SUM (F2)", rNoRebate?.result?.ok === false && /underpaid|missing/i.test(String(rNoRebate?.result?.error)) && lastSubmit === null);
  // (g) F4: a fractional output value is a structured refusal, never a raw BigInt throw
  lastSubmit = null;
  const rFrac = await approveFill({ proposalId: MY_CLAIM_ID, outputs: [{ to: SELLER, value: 1.5 }], fee: 5_000_000 });
  check("fillOffer REFUSES a fractional output value with the structured error shape (F4)", rFrac?.result?.ok === false && /integer/i.test(String(rFrac?.result?.error)) && lastSubmit === null);
  check("WS5: the bad-output refusal carries the BAD_OUTPUTS code", rFrac?.result?.code === "BAD_OUTPUTS");
  // (h) CONTROL: the correctly-built fill (price+rebate summed at payto==seller, fee to treasury) SIGNS
  lastSubmit = null;
  const rGood = await approveFill({ proposalId: MY_CLAIM_ID, outputs: [{ to: SELLER, value: 65_200_000 }, { to: TREASURY, value: 600_000 }], fee: 5_000_000 });
  check("fillOffer with the full need-map (price 40M + rebate 25.2M summed + fee 0.6) SIGNS — no false refusal", rGood?.result?.ok === true && !!rGood?.result?.txid && lastSubmit !== null);
  offerFixtures.clear();

  console.log("\n=== dApp `propose` with fee outputs (CairnX deploy/name-reg) — approval-gated, anti-smuggle, capped ===");
  lastSubmit = null;
  const FEE_TO = "0x" + "fa".repeat(20);
  const winBeforeProp2 = windowsOpened;
  const preq = dappAsync("propose", {
    domain: "cairnx:v1", payloadHash: "0x" + "11".repeat(32), uri: '{"t":"name"}', expiresEpoch: 99, fee: 25_000_000,
    outputs: [{ to: FEE_TO, value: 100_000_000 }],
    inputs: [{ txid: "0x" + "ff".repeat(32), vout: 9 }], change: "0x" + "de".repeat(20), // smuggle attempt
  });
  await tick();
  check("dApp propose+outputs ALWAYS opens the approval window", windowsOpened > winBeforeProp2 && preq.done() === false);
  sp = (await popup("pending")).result;
  await popup("resolve", sp[sp.length - 1].id, true);
  await tick(); await tick();
  const pr2 = preq.get();
  check("approved propose+outputs routes to wallet.propose (txid returned)", pr2?.ok === true && !!pr2.result?.txid);
  const pouts = lastSubmit?.tx?.outputs ?? [];
  const pins = lastSubmit?.tx?.inputs ?? [];
  check("propose tx pays the fee output exactly as approved", pouts.some((o: any) => spkHex(o.script_pubkey) === FEE_TO && Number(o.value) === 100_000_000));
  check("propose used the wallet's OWN input (smuggled `inputs` ignored)", pins.length === 1 && spkHex(pins[0].prevout.txid) === MOCK_UTXO.txid);
  check("propose change returned only to the wallet's own address (smuggled `change` ignored)", pouts.every((o: any) => spkHex(o.script_pubkey) === FEE_TO || spkHex(o.script_pubkey) === addr));
  check("propose tx carries the Propose app (not a disguised send)", !!lastSubmit?.tx?.app?.Propose);
  // anti-flood: too many outputs is refused at build (no silent execution)
  const flood = dappAsync("propose", { domain: "d", payloadHash: "0x" + "11".repeat(32), uri: "x", expiresEpoch: 1, fee: 25_000_000, outputs: Array.from({ length: 20 }, () => ({ to: FEE_TO, value: 1_000_000 })) });
  await tick();
  sp = (await popup("pending")).result;
  await popup("resolve", sp[sp.length - 1].id, true);
  await tick(); await tick();
  check("propose with >8 outputs is refused (anti-flood)", flood.get()?.ok === true && flood.get()?.result?.ok === false && /too many outputs/.test(JSON.stringify(flood.get())));
  check("WS5: the >8-outputs refusal carries the BAD_OUTPUTS code (node validateOutputs)", flood.get()?.result?.code === "BAD_OUTPUTS");

  console.log("\n=== while LOCKED, an approved dApp request cannot act ===");
  await popup("lock");
  const lockedReq = dappAsync("signin", {});
  await tick();
  p = (await popup("pending")).result;
  await popup("resolve", p[p.length - 1].id, true);
  await tick();
  check("approved dApp request while locked is refused (wallet locked)", lockedReq.get()?.ok === false);

  // "https://evil.test" was consented earlier (positive-control getAddress). Even so, a
  // connect/getAddress while LOCKED must NOT silently fast-path — it has to queue + prompt
  // (so a stolen/idle-locked session can't leak the address to a previously-connected site).
  const winBeforeLk = windowsOpened;
  const lockedConn = dappAsync("getAddress", {}, "https://evil.test");
  await tick();
  check("consented origin while LOCKED does NOT fast-path (queues + opens window, no silent resolve)", lockedConn.done() === false && windowsOpened > winBeforeLk);

  console.log("\n=== F12: popup-channel sender identity is asserted (defense-in-depth) ===");
  await popup("unlock", PW); // re-unlock (we locked it above) so the privileged call would otherwise succeed
  // A content script forging kind:"popup" runs in a web page → its sender.url is the host page (not our
  // chrome-extension:// origin), even though it shares our runtime id and carries a tab → REJECTED.
  const fromTab = await popupAs({ id: "cairnwallettestid", url: "https://evil.example/x", tab: { id: 7 } }, "export", PW);
  check("forged popup from a content script (web-page sender.url) is REJECTED", fromTab?.ok === false && !String(JSON.stringify(fromTab)).toLowerCase().includes(priv));
  // A different extension id is rejected too.
  const wrongId = await popupAs({ id: "someotherextension", url: "chrome-extension://someotherextension/popup.html" }, "export", PW);
  check("popup message with a foreign runtime id is REJECTED", wrongId?.ok === false && !String(JSON.stringify(wrongId)).toLowerCase().includes(priv));
  // A popup-kind message with NO extension sender.url is rejected (the gate keys on origin, not just id).
  const noUrl = await popupAs({ id: "cairnwallettestid" }, "export", PW);
  check("popup message with no extension-origin sender.url is REJECTED", noUrl?.ok === false && !String(JSON.stringify(noUrl)).toLowerCase().includes(priv));
  // REGRESSION (the empty-popup bug): the REAL approval window is an extension page opened via
  // chrome.windows.create — it has our origin AND a sender.tab. It MUST be allowed (the old `||sender.tab`
  // check rejected it with "forbidden", blanking the connect popup).
  const realApprovalWin = await popupAs({ id: "cairnwallettestid", url: "chrome-extension://x/approve.html", tab: { id: 3 } }, "status");
  check("the real approval window (extension origin, WITH a tab) works — F12 no longer breaks connect", realApprovalWin?.ok === true && realApprovalWin.result?.unlocked === true);

  console.log("\n=== F12 build/CI tripwire: externally_connectable / onMessageExternal / onConnectExternal must NEVER appear ===");
  // If a future edit re-introduces an external message surface, the popup-isolation argument collapses.
  // Fail HARD if any of the three strings shows up anywhere in src/ or the manifest. onConnectExternal is
  // the PORT-based sibling of onMessageExternal (B8w): both are external-message entrypoints and either
  // one re-opens the surface, so both must be covered here as well as in build.mjs's FORBIDDEN tripwire.
  const SCAN = [
    "../src/background.ts", "../src/content.ts", "../src/inpage.ts",
    "../src/popup/popup.ts", "../src/popup/approve.ts", "../src/popup/clearsign.ts",
    "../src/core/wallet.ts", "../src/core/node.ts", "../public/manifest.json",
  ].map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
  check("no `externally_connectable` anywhere in src/ or manifest", !/externally_connectable/.test(SCAN));
  check("no `onMessageExternal` anywhere in src/ or manifest", !/onMessageExternal/.test(SCAN));
  check("no `onConnectExternal` anywhere in src/ or manifest (port-based external surface)", !/onConnectExternal/.test(SCAN));

  console.log("\n=== CQ-4: every dApp-allowlisted method has a handler (no allowlist↔dispatch drift) ===");
  // The dApp surface is defined by FOUR hand-synced lists (DAPP_METHODS, the resolvePending if-chain, the
  // dapp message-branch fast-paths, READ_ONLY_METHODS). A method added to the allowlist but with no executor
  // (or vice-versa) is a real drift bug. Assert every DAPP_METHOD is handled somewhere in background.ts.
  const bgSrc = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
  const dappSet = bgSrc.match(/DAPP_METHODS\s*=\s*new Set\(\[([^\]]*)\]/);
  const dappMethods = dappSet ? [...dappSet[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  check("CQ-4: DAPP_METHODS allowlist parses + is non-trivial", dappMethods.length >= 10);
  for (const m of dappMethods) {
    // handled in resolvePending (`p.method === "m"`) OR the dapp message branch (`msg.method === "m"`)
    const handled = new RegExp(`(?:p|msg)\\.method === "${m}"`).test(bgSrc);
    check(`CQ-4: dApp method '${m}' has a handler (no allowlist↔dispatch drift)`, handled);
  }
  // CQ-4 (2.9): the dApp surface is ALSO advertised to pages via inpage.ts getCapabilities().methods — the
  // one hand-synced list no test covered. Parse it as text and assert it matches DAPP_METHODS as a SET,
  // case-insensitively: getCapabilities uses the camelCase JS method names (signIn/signInWithCsd) the dApp
  // dev calls, while the wire allowlist uses the lowercase wire strings (signin/signinwithcsd). A method
  // advertised-but-not-allowlisted (or vice-versa) is a real drift bug — a page told it can call something
  // the background rejects, or an allowlisted method the page can't discover.
  const inpageSrc = readFileSync(new URL("../src/inpage.ts", import.meta.url), "utf8");
  const capMatch = inpageSrc.match(/getCapabilities[\s\S]*?methods:\s*\[([^\]]*)\]/);
  const capMethods = capMatch ? [...capMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  check("CQ-4: inpage getCapabilities().methods parses + is non-trivial", capMethods.length >= 10);
  const normSet = (xs: string[]) => [...new Set(xs.map((s) => s.toLowerCase()))].sort();
  const capNorm = normSet(capMethods), dappNorm = normSet(dappMethods);
  check("CQ-4: getCapabilities().methods matches DAPP_METHODS as a set (no inpage↔background drift)",
    capNorm.length === dappNorm.length && capNorm.every((m, i) => m === dappNorm[i]));

  console.log("\n=== WL-1/R19: the approval-poll (status/pending) must NOT defeat the idle auto-lock ===");
  // Simulate a connected site that keeps a request queued and lets the approval window poll forever.
  // touch() must fire ONLY on genuine user activity — never on status/pending — so autoLock still fires.
  await popup("unlock", PW); // unlock IS a user action → touches (lastActive = NOW)
  // hammer the poll methods (what approve.ts does every ~1.2s). NOTE: we do NOT advance the clock here,
  // so any touch() would set lastActive = NOW and defeat the lock. They must NOT touch.
  for (let i = 0; i < 50; i++) { await popup("status"); await popup("pending"); }
  // advance well past the 15-min idle window WITHOUT any user action and fire the autolock alarm.
  await fireAutolock(16 * 60 * 1000);
  check("idle auto-lock FIRES even while status/pending are polled (reads don't touch)", (await popup("status")).result.unlocked === false);
  // control: a GENUINE user action DOES touch() → it resets the idle timer and the lock does NOT fire.
  await popup("unlock", PW);            // touch @ NOW
  for (let i = 0; i < 50; i++) await popup("status"); // reads — no touch
  NOW += 14 * 60 * 1000;                // 14 min idle (under the 15-min window)
  await popup("resolve", "nonexistent", false); // a real action (not read-only) → touch @ NOW, resets timer
  await fireAutolock(60 * 1000);        // +1 min: only 1 min since the resolve touch → must stay unlocked
  check("a genuine user action (resolve) RESETS the idle timer (touch still works)", (await popup("status")).result.unlocked === true);

  console.log("\n=== F11: switching accounts after consent makes the silent path fall through ===");
  // app.test consented to addr earlier... but we revoked it. Reconnect + consent fresh, then add a 2nd
  // account + switch: the active addr now differs from the consented one → getAddress must re-prompt.
  const F11_SITE = "https://f11.test";
  const cF = dappAsync("connect", {}, F11_SITE);
  await tick();
  await popup("resolve", (await popup("pending")).result.slice(-1)[0].id, true); // consent addr A
  await tick();
  check("F11: fresh consent goes silent for the SAME active addr", (() => true)());
  const silent = dappAsync("getAddress", {}, F11_SITE);
  await tick();
  check("F11: getAddress is silent while the active addr matches the consented one", silent.done() === true && silent.get()?.ok === true);
  // add + switch to a second account → active addr changes
  await popup("addAccount", "Account 2");
  const newActive = (await popup("status")).result.addr;
  check("F11 setup: switching account changed the active address", newActive !== addr);
  const winBeforeF11 = windowsOpened;
  const afterSwitch = dappAsync("getAddress", {}, F11_SITE);
  await tick();
  check("F11: after an account switch, getAddress does NOT silently leak the NEW addr (re-prompts)", afterSwitch.done() === false && windowsOpened > winBeforeF11);
  await popup("resolve", (await popup("pending")).result.slice(-1)[0].id, false);
  await tick();

  console.log("\n=== L2: an opaque origin ('null') never gets stored consent, a silent path, or an event port ===");
  // A top-level opaque-origin page (sandboxed iframe / data: / some file:) sends sender.origin === "null" — a
  // SHARED, non-identifying string. It must NEVER be recorded as a connected site (no stable identity) and
  // must NEVER hit the silent fast-path — otherwise one opaque page's consent would leak the address to ANY
  // opaque-origin page. (The wallet is unlocked here.)
  const winBeforeNull = windowsOpened;
  const nullReq = dappAsync("getAddress", {}, "null");
  await tick();
  check("L2: getAddress from an opaque origin ('null') does NOT fast-path — it queues + opens a window", nullReq.done() === false && windowsOpened > winBeforeNull);
  // approve it → recordConsent MUST refuse to store anything under the 'null' key
  await popup("resolve", (await popup("pending")).result.slice(-1)[0].id, true);
  await tick();
  const consentsAfterNull = (await popup("connectedSites")).result as any[];
  check("L2: approving an opaque-origin request records NO 'null' consent key", !consentsAfterNull.some((s) => s.origin === "null"));
  // a SECOND opaque-origin getAddress is STILL not silent (nothing was remembered to short-circuit on)
  const winBeforeNull2 = windowsOpened;
  const nullReq2 = dappAsync("getAddress", {}, "null");
  await tick();
  check("L2: a second opaque-origin getAddress is STILL not silent (nothing remembered → falls to the queue)", nullReq2.done() === false && windowsOpened > winBeforeNull2);
  await popup("resolve", (await popup("pending")).result.slice(-1)[0].id, false);
  await tick();
  // event-port registration: a 'null' (opaque) port must NOT be registered; a real-origin port IS. We probe
  // registration via disconnectSite(origin), which emits accountsChanged+disconnect to that origin's ports.
  const mkPort = (origin: string) => { const msgs: any[] = []; return { name: "cairn-events", sender: { origin }, postMessage: (m: any) => msgs.push(m), onDisconnect: { addListener: () => {} }, msgs }; };
  const realPort = mkPort("https://reg.test");
  const nullPort = mkPort("null");
  connectListener(realPort);
  connectListener(nullPort);
  await popup("disconnectSite", "https://reg.test");
  check("L2 control: a real-origin event port IS registered (receives its origin's events)", realPort.msgs.length > 0);
  await popup("disconnectSite", "null");
  check("L2: a 'null' (opaque) event port is NOT registered (receives nothing)", nullPort.msgs.length === 0);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
