// BEHAVIORAL test of the extension trust boundary — the Freighter (CVE-2023-40580)
// and Frontier class, where a crafted page message reached a UI-privileged handler
// and leaked the seed with zero user interaction. We load the REAL background service
// worker with a mock `chrome`, capture its onMessage listener, and drive the actual
// message path: a website can only reach the wallet via the content-script relay,
// which stamps kind:"dapp" — so we fire dApp requests for privileged methods and
// prove they are rejected (not executed), even after the user approves.
import { sha256 } from "@noble/hashes/sha256"; // (force module init parity w/ background)

declare const process: { exit(code: number): void };
declare const setTimeout: (f: () => void, ms: number) => void;
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };
const PW = "correct horse battery staple";
void sha256;

// ── mock chrome (storage-backed, captures the message listener + window opens) ──
const mem = new Map<string, any>();
let listener: (m: any, s: any, r: (v: any) => void) => any = () => {};
let windowsOpened = 0;
(globalThis as any).chrome = {
  runtime: {
    id: "cairnwallettestid",
    lastError: undefined,
    getURL: (p: string) => "chrome-extension://x/" + p,
    onMessage: { addListener: (fn: any) => { listener = fn; } },
  },
  storage: { local: {
    get: async (k: string) => ({ [k]: mem.get(k) }),
    set: async (o: any) => { for (const k of Object.keys(o)) mem.set(k, o[k]); },
    remove: async (k: string) => { mem.delete(k); },
  } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: { setBadgeText: () => {} },
  windows: { create: () => { windowsOpened++; } },
};

// ── mock the node RPC so an approved `send` actually builds + "submits" a tx we can
//    inspect (one confirmed UTXO worth 10 CSD; /tx/submit captures the tx). ──
const MOCK_UTXO = { txid: "0x" + "aa".repeat(32), vout: 0, value: 1_000_000_000, confirmations: 10, coinbase: false };
let lastSubmit: any = null;
(globalThis as any).fetch = async (url: string, init?: any) => {
  const u = String(url);
  if (u.includes("/utxos/")) return { ok: true, json: async () => ({ ok: true, confirmed_balance: MOCK_UTXO.value, utxos: [MOCK_UTXO] }) };
  if (u.includes("/tx/submit")) { lastSubmit = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, txid: "0x" + "55".repeat(32) }) }; }
  return { ok: true, json: async () => ({ ok: true }) };
};
const spkHex = (a: any) => "0x" + (a as number[]).map((b) => b.toString(16).padStart(2, "0")).join("");

// popup-channel call (privileged, used only by the extension's own pages)
const popup = (method: string, ...args: any[]) => new Promise<any>((res) => listener({ kind: "popup", method, args }, { id: "cairnwallettestid" }, res));
// a website's request always arrives via the content-script relay as kind:"dapp"
const dappAsync = (method: string, params: any, origin = "https://evil.test") => {
  let resp: any; let done = false;
  listener({ kind: "dapp", method, params }, { origin }, (r: any) => { resp = r; done = true; });
  return { get: () => resp, done: () => done };
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function main() {
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

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
