// How a page finds the provider (docs/PROVIDER.md, "Finding the provider"), through the real src/inpage.ts on a window
// that is a real EventTarget: `cairn#initialized` fires once at inject with window.cairn already set;
// `csd:announceProvider` fires at inject and again on every `csd:requestProvider`; its detail carries info.rdns
// "com.cairn-substrate.wallet", info.name, a uuid that is the same within a page load and new on the next, and the
// provider, which is window.cairn. The provider, the detail and its info are frozen, window.cairn cannot be replaced,
// and the provider's members are the documented ones.
//   RED-FIRST: drop the cairn#initialized dispatch, the csd:requestProvider listener, the rdns value, or the
//   Object.freeze around the provider from inpage.ts and a check below fails for each.
// Run: npx tsx test/provider-discovery.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("provider discovery through the real inpage script:");
globalThis.__WALLET_VERSION__ = "0.0.0-test";

// One page load: a fresh window, listeners registered before the script runs (as a page's own script would be when it
// loads first), then the script. `?load=` makes each import a separate module instance, as a reload is.
async function pageLoad(n) {
  const win = new EventTarget();
  win.location = { origin: "https://site.example" };
  win.postMessage = () => undefined;
  const seen = { initialized: [], announced: [] };
  win.addEventListener("cairn#initialized", (e) => seen.initialized.push({ type: e.type, cairnSet: !!win.cairn?.isCairn }));
  win.addEventListener("csd:announceProvider", (e) => seen.announced.push(e.detail));
  globalThis.window = win;
  await import(`../src/inpage.ts?load=${n}`);
  return { win, seen };
}

const { win, seen } = await pageLoad(1);
const cairn = win.cairn;
check("setup: window.cairn is installed", cairn?.isCairn === true);

// cairn#initialized
check(`cairn#initialized fires once at inject (${seen.initialized.length})`, seen.initialized.length === 1);
check("cairn#initialized fires after window.cairn is set", seen.initialized[0]?.cairnSet === true);

// csd:announceProvider at inject and on each csd:requestProvider
check(`csd:announceProvider fires once at inject (${seen.announced.length})`, seen.announced.length === 1);
win.dispatchEvent(new Event("csd:requestProvider"));
check(`csd:requestProvider makes it announce again (${seen.announced.length})`, seen.announced.length === 2);
win.dispatchEvent(new Event("csd:requestProvider"));
check(`...on every request (${seen.announced.length})`, seen.announced.length === 3);

// the announce detail
const d = seen.announced[0];
check(`info.rdns is com.cairn-substrate.wallet (${d?.info?.rdns})`, d?.info?.rdns === "com.cairn-substrate.wallet");
check(`info.name is Cairn Wallet (${d?.info?.name})`, d?.info?.name === "Cairn Wallet");
check("info.icon is an SVG data URI", typeof d?.info?.icon === "string" && d.info.icon.startsWith("data:image/svg+xml;base64,"));
check(`info.uuid is a UUID (${d?.info?.uuid})`, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(d?.info?.uuid)));
check("detail.provider is window.cairn", d?.provider === cairn);
check("every announce carries the same detail (one uuid per page load)", seen.announced.every((x) => x === d && x.info.uuid === d.info.uuid));
check("info has exactly uuid, name, icon and rdns", JSON.stringify(Object.keys(d.info).sort()) === JSON.stringify(["icon", "name", "rdns", "uuid"]));

// frozen
check("the provider is frozen", Object.isFrozen(cairn));
check("the announce detail and its info are frozen", Object.isFrozen(d) && Object.isFrozen(d.info));
let replaced = false;
try { cairn.send = () => "swapped"; replaced = cairn.send() === "swapped"; } catch { /* a frozen object throws in strict code */ }
check("a page script cannot replace a provider method", !replaced);
const desc = Object.getOwnPropertyDescriptor(win, "cairn");
check("window.cairn is not writable and not configurable", desc?.writable === false && desc?.configurable === false);
try { win.cairn = {}; } catch { /* non-writable: throws in strict code */ }
check("assigning window.cairn leaves the provider in place", win.cairn === cairn);

// the provider's members: the method names are part of the contract
const MEMBERS = ["attest", "connect", "fillOffer", "getAddress", "getCapabilities", "getPermissions", "isCairn", "on", "propose", "removeListener", "requestPermissions", "revealClaim", "revokePermissions", "sealClaim", "send", "signIn", "signInWithCsd", "version"];
check(`the provider's members are the documented ones (${Object.keys(cairn).length})`, JSON.stringify(Object.keys(cairn).sort()) === JSON.stringify(MEMBERS));
const caps = await cairn.getCapabilities();
check(`getCapabilities() resolves without an envelope: ${JSON.stringify({ ...caps, methods: caps.methods.length })}`,
  caps.version === "0.0.0-test" && caps.siwc === "1" && caps.discovery === "csd" && JSON.stringify(caps.events) === JSON.stringify(["accountsChanged", "disconnect"]) && !("ok" in caps));
check("getCapabilities().methods is every provider method that reaches the wallet except signIn", JSON.stringify([...caps.methods].sort()) === JSON.stringify(MEMBERS.filter((m) => !["getCapabilities", "isCairn", "on", "removeListener", "signIn", "version"].includes(m))));

// a new page load announces a new uuid
const next = await pageLoad(2);
const d2 = next.seen.announced[0];
check(`a new page load announces a new uuid (${d2?.info?.uuid})`, typeof d2?.info?.uuid === "string" && d2.info.uuid !== d.info.uuid && d2.provider === next.win.cairn);

done("provider-discovery");
