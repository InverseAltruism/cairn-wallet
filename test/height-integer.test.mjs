// A served tip or a stored floor counts only as a positive safe integer (chainbound.ts heightOf). A served tip that is
// not one (139263.5) was stored as the floor; a floor that is not one made lowestChainHeight return it, and
// feePricingTip then dropped both the floor and the bound, so the wallet's own renewal priced the served tip's tier.
//   A. The real liveSpvSource().prepare() on the repo's real-header fixture: /tip serving a fraction stores nothing; an
//      integer still stores as before.
//   B. The real Wallet with such a floor stored by an earlier version and /tip serving 39,000: "abc" is quoted and paid
//      1,500,000,000 base units, as with a floor of 0 or an honest integer floor.
//   C. The same stored floor lowers no other check: the offer-id sunset and expiry refusals and the approval window's
//      fee warning and fill card still see the release anchor.
// Run: TSX_DISABLE_CACHE=1 node --import tsx test/height-integer.test.mjs   (offline)
import { checker } from "./helpers/check.mjs";
import { serveFixture, memStore, legacyOf, FIX_ANCHORS, NEWEST } from "./helpers/spvfixture.mjs";
import { liveSpvSource, floorAdvance } from "../src/core/namespv.ts";
import { heightOf, lowestChainHeight } from "../src/core/chainbound.ts";
import { SPV_NEWEST_HEIGHT as ANCHOR } from "../src/core/spvnewest.ts";
import { buildNameRenew, nameRegFee, buildFeeHeight, CAIRNX_DOMAIN, TREASURY_ADDR, requiredFillOutputs } from "../src/core/cairnx.ts";
import { offerIdChainBound, fillOfferPreflight } from "../src/core/fillpreflight.ts";
import { Wallet } from "../src/core/wallet.ts";
import { memoryStore } from "../src/core/storage.ts";
import { describe, offerExpiryLine } from "../src/popup/clearsign.ts";
import { mkCoin, txReply } from "./_coin.ts";

const { check, done } = checker("served and stored heights count only as positive safe integers:");
const FRACT = [ANCHOR + 0.5, 150_000.5];
const PRICE = Number(nameRegFee("abc", buildFeeHeight(ANCHOR)));
check(`fixture: "abc" costs ${PRICE} at the anchor and ${Number(nameRegFee("abc", buildFeeHeight(39_000)))} at 39,000`, PRICE === 1_500_000_000 && Number(nameRegFee("abc", buildFeeHeight(39_000))) === 500_000_000);

// SECURITY.md's "cannot price a cheaper fee tier" rests on every name fee gate being below the release's anchor: the
// price at the anchor is the price at any later height.
check("every name fee tier is the same at the anchor and a million blocks later", ["a", "ab", "abc", "abcd", "alice", "satoshi", "longername"].every((n) => nameRegFee(n, buildFeeHeight(ANCHOR)) === nameRegFee(n, buildFeeHeight(ANCHOR + 1_000_000))));

// heightOf and the two functions built on it.
check("heightOf: a fraction, a negative, NaN, an infinity, 1e16 and a string are 0; an integer is kept", [ANCHOR + 0.5, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e16, "139300"].every((v) => heightOf(v) === 0) && heightOf(139_300) === 139_300);
check("lowestChainHeight of a non-integer floor is the anchor", FRACT.every((f) => lowestChainHeight(f) === ANCHOR));
check("floorAdvance: a fractional served tip advances nothing; an integer within the cushion still does", floorAdvance(0, ANCHOR + 0.5, ANCHOR) === 0 && floorAdvance(0, ANCHOR + 5, ANCHOR) === ANCHOR + 5);

// A. prepare() with /tip serving a fraction within the sync cushion of the verified tip.
const API = "https://cairn-substrate.test", RPC = `${API}/api/rpc`;
for (const [served, stores] of [[NEWEST + 0.5, 0], [NEWEST + 11.25, 0], [NEWEST + 5, NEWEST + 5]]) {
  const net = {};
  serveFixture(net);
  net.tip = served;
  const slot = { v: 0, sets: [] };
  const src = await liveSpvSource({ rpcBase: RPC, headersBase: API, anchors: FIX_ANCHORS, store: async () => memStore(), legacy: legacyOf(new Map()), floor: { get: async () => slot.v, set: async (x) => { slot.v = x; slot.sets.push(x); } } });
  await src.prepare(NEWEST - 50);
  check(`A. prepare() with /tip serving ${served}: the stored floor is ${slot.v} (${slot.sets.length} writes)`, slot.v === stores && slot.sets.length === (stores ? 1 : 0));
}

// B. The wallet's own renewal with a non-integer floor stored by an earlier version, /tip serving 39,000.
const coin = mkCoin(5_000_000_000);
const hexOf = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
for (const floor of [0, ANCHOR + 5, ...FRACT]) {
  const st = memoryStore(); const w = new Wallet(st);
  const { addr } = await w.create("pw-int-floor-12345");
  if (floor) await st.set("spvNodeTipFloor", floor);
  const submitted = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/tip")) return { ok: true, status: 200, json: async () => ({ height: 39_000 }) };
    if (u.includes("/tx/submit")) { submitted.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, txid: "0x" + "aa".repeat(32) }) }; }
    if (u.match(/\/utxos\//)) return { ok: true, status: 200, json: async () => ({ confirmed_balance: coin.coin.value, utxos: [coin.coin] }) };
    if (u.includes("/cairnx/name/")) return { ok: true, status: 200, json: async () => ({ name: "abc", owner: addr, addr, pending: false }) };
    const t = txReply(u, [coin]);
    if (t) return t;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const quoted = await w.cairnxNameRenewFee("abc");
  const r = await w.cairnxNameRenew("abc", quoted);
  const paid = submitted.flatMap((b) => b?.tx?.outputs ?? []).filter((o) => hexOf(o.script_pubkey).toLowerCase() === TREASURY_ADDR.toLowerCase()).reduce((a, o) => a + Number(o.value), 0);
  check(`B. stored floor ${floor}, served tip 39,000: "abc" quoted ${quoted} and signed paying ${paid}`, quoted === PRICE && r?.ok === true && paid === PRICE);
}

// C. The same stored floor in every other check.
{
  const st = memoryStore(); const w = new Wallet(st);
  await w.create("pw-int-floor-c-12345");
  await st.set("spvNodeTipFloor", ANCHOR + 0.5);
  const tf = await w.tipFloor();
  check(`C. Wallet.tipFloor() reads a stored ${ANCHOR + 0.5} as 0, and the offer-id bound at a served tip of 50,000 is the anchor (${offerIdChainBound(50_000, tf)})`, tf === 0 && offerIdChainBound(50_000, tf) === ANCHOR && offerIdChainBound(50_000, ANCHOR + 0.5) === ANCHOR);
}
{
  // The real preflight, its floor read answering the stored value unread (as an older store would hand it over).
  const ME = "0x" + "ab".repeat(20), OID = "0x" + "5e".repeat(32), PAYTO = "0x" + "ce".repeat(20), SELLER = "0x" + "cd".repeat(20);
  const run = async (offer, terms, expiresEpoch) => {
    const outs = requiredFillOutputs(offer, 5_000_000n).map(({ to, value }) => ({ to, value: Number(value) }));
    const io = {
      tradeGet: async () => new Response(JSON.stringify(offer), { status: 200 }), tip: async () => 50_000, tipFloor: async () => ANCHOR + 0.5,
      makeProvenOfferPayto: async () => ({ payto: PAYTO, seller: SELLER, expiresEpoch, height: 47_000, terms }), recentOwnFills: async () => [],
      makeFillSpvIo: async () => { throw new Error("not the reservation lane"); },
    };
    return fillOfferPreflight(io, OID, outs, ME, undefined, undefined, { notes: [] });
  };
  const terms = { height: 47_000, feeBps: 150, value: "5000000", taker: undefined, bid: undefined, giveTicker: "TKN", giveAmount: "5", giveName: undefined, wantType: "csd" };
  const open = { id: OID, seller: SELLER, give: { ticker: "TKN", amount: "5" }, want: { value: "5000000", payto: PAYTO }, status: "open", expiresEpoch: 9e15, height: 47_000, feeBps: 150, claimedBy: ME, claimUntilHeight: 50_030 };
  const r1 = await run(open, terms, 9e15);
  check(`C. sunset: an open CSD offer-id fill at a served tip of 50,000 with that floor is refused (${r1?.code})`, r1?.code === "FILL_LEGACY_SUNSET");
  const E = Math.floor(ANCHOR / 30) - 2;
  const taker = { ...open, taker: ME, expiresEpoch: E, claimedBy: undefined, claimUntilHeight: undefined };
  const r2 = await run(taker, { ...terms, taker: ME }, E);
  check(`C. expiry: a taker-bound offer that expired before the anchor is refused (${r2?.code})`, r2?.code === "FILL_UNSAFE" && /expires at block/.test(String(r2?.error)));
}
{
  const abc = buildNameRenew({ name: "abc" });
  const card = (paid) => describe({ method: "propose", currentTip: 39_000, tipFloor: ANCHOR + 0.5, params: { domain: CAIRNX_DOMAIN, uri: abc.uri, payloadHash: abc.payloadHash, fee: 25_000_000, expiresEpoch: 9_000, outputs: [{ to: TREASURY_ADDR, value: paid }] } });
  check("C. window: with that floor and a served tip of 39,000 a site renewal paying 5 CSD is warned, one paying 15 CSD is not", /below the current price/.test(card(500_000_000)) && !/below the current price/.test(card(PRICE)));
  check("C. window: the fill card at that floor refuses an offer that expired before the anchor", /Offer expired at block/.test(offerExpiryLine(ANCHOR - 10, 39_000, lowestChainHeight(ANCHOR + 0.5))));
}

done("height-integer");
