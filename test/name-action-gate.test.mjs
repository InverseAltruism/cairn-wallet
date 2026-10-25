// The wallet's own renew and set primary re-read the name at the sign (src/core/namegate.ts via wallet.ts), so a
// review primed while the name was the user's cannot pay a fee the resolver ignores after the name turned pending,
// lapsed, unregistered or someone else's. Drives the real popup.ts (fake DOM) through a bridge that dispatches the
// name methods to a real Wallet exactly as background.ts runPopupMethod does; fetch answers the node and the trade API.
// The name service flips between Review and Confirm, which is the window the popup review leaves open.
// RED-FIRST: drop the two `if (refusal) throw` lines in wallet.ts and the refusal cases sign (submits grow).
// HONEST PATH: an owned live name renews and sets primary, an own name in grace renews; a name service that does not
// answer still signs.
// Run: node --import tsx test/name-action-gate.test.mjs   (offline)
import { installFakeDom, installBridge, flush } from "./_fakedom.mjs";
import { checker } from "./helpers/check.mjs";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { nameRegFee, buildFeeHeight, TREASURY_ADDR } from "../src/core/cairnx.ts";
import { mkCoin, txReply } from "./_coin.ts";

const t = checker("name actions re-read the name before they sign");
const { byId } = installFakeDom({ autoCreate: true });
const w = new Wallet(memoryStore());
await w.create("pw-name-gate-12345");
const ME = (await w.status()).addr;
const OTHER = "0x" + "c4".repeat(20);
const NAME = "alice";
const TIP = 67_500;
const coins = [mkCoin(1_000_00000000)];
const submits = [];
let nameState = "owned";
const nameReads = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/cairnx/name/")) {
    nameReads.push(u);
    const rec = {
      owned: { name: NAME, owner: ME }, pending: { name: NAME, owner: OTHER, pending: true }, lapsed: { name: NAME, owner: ME, expired: true }, other: { name: NAME, owner: OTHER },
      // the service's record of an own name in its grace period: paid through an epoch before the tip's, not expired
      grace: { name: NAME, owner: ME, paidThroughEpoch: 2_000 }, minePending: { name: NAME, owner: ME, pending: true },
    }[nameState];
    if (nameState === "throw") throw new TypeError("Failed to fetch");
    if (nameState === "down") return { ok: false, status: 503, json: async () => ({}) };
    if (!rec) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    return { ok: true, status: 200, json: async () => rec };
  }
  if (u.includes("/tx/submit")) { submits.push(JSON.parse(init?.body ?? "{}")); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
  if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: TIP }) };
  if (u.includes("/utxos/")) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coins.reduce((s, c) => s + c.coin.value, 0), utxos: coins.map((c) => c.coin) }) };
  return txReply(u, coins) ?? { ok: false, status: 404, json: async () => ({}) };
};

// background.ts runPopupMethod: cairnxNameRenew(args[0], args[1], args[2]), cairnxSetPrimary(args[0], args[1]).
installBridge({
  status: () => w.status(),
  balance: () => ({ confirmed: 1_000_00000000, utxos: [] }),
  pendingMerge: () => ({ pending: false, amount: 0, maybe: false }),
  cairnxAssets: () => ({ ok: true, balances: {}, names: [NAME], nameDetails: [{ name: NAME, leased: true, epochsLeft: 9000 }], primaryName: null, tipHeight: TIP }),
  cairnxTokens: () => ({ ok: true, tokens: [] }),
  prewarmSpv: () => ({ ok: true }),
  pending: () => [],
  history: () => [],
  sealedClaims: () => [],
  cairnxNameRenewFee: (...a) => w.cairnxNameRenewFee(a[0]),
  cairnxNameRenew: (...a) => w.cairnxNameRenew(a[0], a[1], a[2]),
  cairnxSetPrimary: (...a) => w.cairnxSetPrimary(a[0], a[1]),
});
globalThis.setInterval = () => 0;
await import("../src/popup/popup.ts");
await flush();

const status = () => String(byId("msg").textContent || "");
// Review with the name in `atReview`, flip it to `atConfirm`, press Confirm; returns how many txs were submitted and
// how many name reads the Confirm made.
let lastReads = 0;
async function act(sel, atReview, atConfirm) {
  nameState = atReview;
  const before = submits.length;
  await byId("names-list").querySelectorAll("[data-name]")[0].click(); await flush(40);
  await byId("nd-actions").querySelectorAll(sel)[0].click(); await flush(40);
  nameState = atConfirm;
  const reads = nameReads.length;
  await byId("btn-name-confirm").click(); await flush(60);
  lastReads = nameReads.length - reads;
  return submits.length - before;
}
const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toTreasury = (sub) => (sub?.tx?.outputs ?? []).filter((o) => hex(o.script_pubkey).toLowerCase() === TREASURY_ADDR.toLowerCase()).reduce((a, o) => a + Number(o.value), 0);
const RENEW = "[data-nrenew]", PRIMARY = "[data-nprimary]";
const fee = Number(nameRegFee(NAME, buildFeeHeight(TIP)));

console.log("renew");
{
  const n = await act(RENEW, "owned", "owned");
  t.check(`honest: an owned live name renews (${status()})`, n === 1 && /^Renewed: alice\.csd/.test(status()));
  t.check(`honest: Confirm read the name once (${lastReads})`, lastReads === 1);
  t.check(`honest: the renewal pays the reviewed fee to the treasury (${toTreasury(submits.at(-1))} = ${fee})`, toTreasury(submits.at(-1)) === fee);
}
{
  const n = await act(RENEW, "owned", "pending");
  t.check(`a name that turned pending after review is not renewed (${status()})`, n === 0 && /pending reservation/.test(status()) && /Nothing was sent/.test(status()));
}
{
  const n = await act(RENEW, "owned", "lapsed");
  t.check(`a name that lapsed after review is not renewed, and the reason is the resolver's: claimed again, not renewed (${status()})`, n === 0 && /grace period are over/.test(status()) && /claimed again, not renewed/.test(status()));
}
{
  const n = await act(RENEW, "owned", "missing");
  t.check(`a name the service no longer knows is not renewed (${status()})`, n === 0 && /not registered/.test(status()) && /^Refusing to sign/.test(status()));
  t.check("...and the refusal says the service may still be catching up", /may still be catching up: try again later/.test(status()));
}
{
  const n = await act(RENEW, "owned", "down");
  t.check(`fail-open: a name service answering 503 does not block the renewal (${status()})`, n === 1 && /^Renewed/.test(status()));
  const m = await act(RENEW, "owned", "throw");
  t.check(`fail-open: a name service that cannot be reached does not block the renewal (${status()})`, m === 1 && /^Renewed/.test(status()));
}
{
  const n = await act(RENEW, "owned", "other");
  t.check(`honest: anyone may renew a live lease, so a live name now owned elsewhere still renews (${status()})`, n === 1);
}
{
  const n = await act(RENEW, "owned", "grace");
  t.check(`honest: an own name in its grace period still renews (${status()})`, n === 1 && /^Renewed/.test(status()));
}

console.log("set primary");
{
  const n = await act(PRIMARY, "owned", "owned");
  t.check(`honest: an owned name is set as primary (${status()})`, n === 1 && /^Set primary: alice\.csd/.test(status()));
}
{
  const n = await act(PRIMARY, "owned", "other");
  t.check(`a name now owned by another address is not set as primary (${status()})`, n === 0 && /owned by a different address/.test(status()));
}
{
  const n = await act(PRIMARY, "owned", "missing");
  t.check(`a name the service no longer knows is not set as primary (${status()})`, n === 0 && /not registered/.test(status()) && /may still be catching up/.test(status()));
}
{
  const n = await act(PRIMARY, "owned", "minePending");
  t.check(`an own name that is a pending reservation is not set as primary (the resolver's nset rejects it) (${status()})`, n === 0 && /pending reservation/.test(status()) && /anchor fee/.test(status()));
}
{
  const n = await act(PRIMARY, "owned", "lapsed");
  t.check(`an own name that lapsed is not set as primary (the resolver's nset rejects it) (${status()})`, n === 0 && /has lapsed/.test(status()) && /anchor fee/.test(status()));
}
{
  const n = await act(PRIMARY, "owned", "down");
  t.check(`fail-open: a name service answering 503 does not block set primary (${status()})`, n === 1);
}

globalThis.fetch = origFetch;
t.done("name-action-gate");
