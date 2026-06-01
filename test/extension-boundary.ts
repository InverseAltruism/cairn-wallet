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
  // Even APPROVED, these must be rejected by resolvePending's method whitelist.
  for (const m of ["export", "exportMnemonic", "restore", "send", "import", "reset", "setApi", "setRpc", "addAccount", "switchAccount", "removeAccount", "unlock", "lock", "create"]) {
    const req = dappAsync(m, m === "send" ? ["0x" + "cc".repeat(20), 1e8] : ["x"]);
    await tick();
    const pend = (await popup("pending")).result;
    const mine = pend[pend.length - 1];
    await popup("resolve", mine.id, true); // user APPROVES — should still be refused
    await tick();
    const r = req.get();
    const refused = r && r.ok === false;
    const noKey = !JSON.stringify(r ?? {}).toLowerCase().includes(priv);
    check(`dApp '${m}' is refused even when approved, and leaks no key`, refused && noKey);
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

  console.log("\n=== while LOCKED, an approved dApp request cannot act ===");
  await popup("lock");
  const lockedReq = dappAsync("signin", {});
  await tick();
  p = (await popup("pending")).result;
  await popup("resolve", p[p.length - 1].id, true);
  await tick();
  check("approved dApp request while locked is refused (wallet locked)", lockedReq.get()?.ok === false);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
