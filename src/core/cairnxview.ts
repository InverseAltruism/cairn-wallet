// Display reads of the CairnX resolver for the popup and the approval cards: balances and names, the token list,
// a token fill's quoted debit, a fill's listed asset, token decimals. Resolver-served and never bound to a
// signature; the fill preflight makes its own reads and binds what it signs (fillpreflight.ts).
import { cairnxTradeFee, FEE_BPS_V16, isTicker, type TokenDisplayMeta } from "./cairnx.js";
import { offerExpiryHeightOf } from "../vendor/cairnx-spv.js";

// The block at which the served offer expires, for the fill cards. Display only: the fill preflight checks the
// merkle-proven record's expiry before it signs.
function servedExpiryHeight(o: { expiresEpoch?: unknown; height?: unknown }): number | undefined {
  const e = Number(o?.expiresEpoch), h = Number(o?.height);
  return Number.isSafeInteger(e) && e >= 0 && Number.isSafeInteger(h) && h >= 0 ? offerExpiryHeightOf(e, h) : undefined;
}

// What the CairnX display reads use of the wallet: its read API and the active address.
export interface CairnxViewIo { tradeGet(path: string, timeoutMs?: number): Promise<Response>; addr(): string }

// READS go to the public CairnX resolver API and NEVER throw; the popup must keep
// showing the CSD balance even when the token API is down ({ ok:false } → quiet retry).
export async function cairnxAssets(wallet: CairnxViewIo): Promise<{ ok: boolean; balances?: Record<string, { available: string; locked: string }>; names?: string[]; nameDetails?: any[]; primaryName?: string | null; tipHeight?: number }> {
  try {
    const r = await wallet.tradeGet(`/cairnx/address/${wallet.addr()}`, 12000); // display read: 12s bounded (was untimed)
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const balances = (j && typeof j.balances === "object" && j.balances) || {};
    const names = Array.isArray(j?.names) ? j.names.filter((n: unknown) => typeof n === "string") : [];
    // nameDetails (lease/expiry/addr per name) + the server-computed primary name (reverse record).
    // Older services omit these → empty/null, and the popup falls back to plain name chips.
    const nameDetails = Array.isArray(j?.nameDetails) ? j.nameDetails : [];
    const primaryName = typeof j?.primaryName === "string" ? j.primaryName : null;
    // tip rides along so the popup can turn a pending reservation's finalizeBy into a live countdown
    const tipHeight = Number(j?.tipHeight) || 0;
    return { ok: true, balances, names, nameDetails, primaryName, tipHeight };
  } catch { return { ok: false }; }
}

// M3 (offline token-fill simulation): quote the actual token DEBIT for a token-priced fill (confidence
// ===1e6) so the clear-sign window shows what the user pays instead of "not visible here". Fetches the
// offer from the resolver and, IF it is an OPEN token-want offer, computes debit = ask + protocol fee
// (BigInt-exact, same cairnxTradeFee the convention uses). Returns ok:false on any unreachable/mismatch so
// the UI keeps its loud caution; never silently "free". This is RESOLVER-TRUSTED DISPLAY ONLY: it changes
// nothing the wallet signs (the attest bytes are unaffected); it only makes the debit visible for review.
export async function tokenFillQuote(wallet: CairnxViewIo, proposalId: string): Promise<{ ok: boolean; ticker?: string; amount?: string; fee?: string; total?: string; estimated?: boolean; error?: string; giveTicker?: string; giveAmount?: string; giveName?: string; wantDecimals?: number; giveDecimals?: number; wantDeployId?: string; giveDeployId?: string; expiresAt?: number }> {
  try {
    const so = await servedOpenOffer(wallet, proposalId);
    if (!so.ok) return so;
    const o = so.offer;
    const w = o.want;
    if (!w || typeof w.ticker !== "string" || w.amount === undefined) return { ok: false, error: "not a token-priced offer" };
    let amount: bigint;
    try { amount = BigInt(String(w.amount)); } catch { return { ok: false, error: "bad amount" }; }
    if (amount < 0n) return { ok: false, error: "bad amount" };
    // QA-4: if the resolver omits feeBps, default to the HIGHER current rate (V16, 150 bps) so the quote
    // never UNDER-states what will be debited (over-stating by ≤0.5% is the fail-safe direction) and mark
    // it estimated so the UI can say so. A supplied feeBps is used exactly.
    const hasBps = Number.isFinite(Number(o.feeBps));
    const bps = hasBps ? Number(o.feeBps) : FEE_BPS_V16;
    const fee = cairnxTradeFee(amount, bps);
    const g = (o as { give?: { ticker?: string; amount?: unknown; name?: string } }).give;
    const giveTicker = typeof g?.ticker === "string" ? g.ticker : undefined;
    // Served amount:null must stay absent; String(null) is "null", and the vendor give-leg
    // treats that present string as a mismatch against a proven missing amount (honest-fill refuse).
    const giveAmount = g?.amount != null ? String(g.amount) : undefined;
    const giveName = typeof g?.name === "string" ? g.name : undefined;
    const meta = await tokenDisplayMeta(wallet, [w.ticker, giveTicker]);
    return {
      ok: true, ticker: w.ticker, amount: amount.toString(), fee: fee.toString(), total: (amount + fee).toString(), estimated: !hasBps, giveTicker, giveAmount, giveName,
      wantDecimals: meta[w.ticker]?.decimals, wantDeployId: meta[w.ticker]?.deployId,
      giveDecimals: giveTicker ? meta[giveTicker]?.decimals : undefined, giveDeployId: giveTicker ? meta[giveTicker]?.deployId : undefined,
      expiresAt: servedExpiryHeight(o),
    };
  } catch { return { ok: false, error: "offer unavailable" }; }
}

// The resolver's OPEN offer behind a fill target (an offer id, or a reservation txid the resolver links to
// its offer). Display reads only; the fill preflight does its own read and binds what it signs.
async function servedOpenOffer(wallet: CairnxViewIo, proposalId: string): Promise<{ ok: true; offer: any } | { ok: false; error: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(proposalId))) return { ok: false, error: "bad offer id" };
  const r = await wallet.tradeGet(`/cairnx/offer/${encodeURIComponent(proposalId)}`); // 12s (tradeGet default)
  if (!r.ok) return { ok: false, error: "offer not found" };
  const o: any = await r.json().catch(() => null);
  if (!o || o.status !== "open") return { ok: false, error: o?.status ? `offer ${o.status}` : "offer unavailable" };
  return { ok: true, offer: o };
}

// What a CSD-paid fill card shows beside the signed outputs: the listing id (which differs from the
// attested id on the reservation lane) and the asset the offer service lists as received. Display only.
export async function fillOfferView(wallet: CairnxViewIo, proposalId: string): Promise<{ ok: boolean; error?: string; offerId?: string; giveTicker?: string; giveAmount?: string; giveName?: string; giveDecimals?: number; expiresAt?: number }> {
  try {
    const so = await servedOpenOffer(wallet, proposalId);
    if (!so.ok) return so;
    const o = so.offer;
    const offerId = String(o.id ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(offerId)) return { ok: false, error: "offer unavailable" };
    const g = (o as { give?: { ticker?: string; amount?: unknown; name?: string } }).give;
    const giveTicker = typeof g?.ticker === "string" ? g.ticker : undefined;
    const giveAmount = g?.amount != null ? String(g.amount) : undefined;
    const giveName = typeof g?.name === "string" ? g.name : undefined;
    const meta = giveTicker ? await tokenDisplayMeta(wallet, [giveTicker]) : {};
    return { ok: true, offerId, giveTicker, giveAmount, giveName, giveDecimals: giveTicker ? meta[giveTicker]?.decimals : undefined, expiresAt: servedExpiryHeight(o) };
  } catch { return { ok: false, error: "offer unavailable" }; }
}

// Decimals + deploy id per ticker for the approval cards (human units, look-alike warning). Fail-soft: a
// failed read leaves that ticker absent and the card shows base units only. Display only.
export async function tokenDisplayMeta(wallet: CairnxViewIo, tickers: unknown): Promise<TokenDisplayMeta> {
  const list = [...new Set((Array.isArray(tickers) ? tickers : []).filter(isTicker))].slice(0, 4);
  const meta: TokenDisplayMeta = {};
  await Promise.all(list.map(async (tk) => {
    try {
      const tr = await wallet.tradeGet(`/cairnx/token/${encodeURIComponent(tk)}`, 8000);
      const t: any = tr.ok ? await tr.json().catch(() => null) : null;
      if (t && t.ticker === tk) meta[tk] = { decimals: Number.isInteger(t.decimals) ? t.decimals : undefined, deployId: typeof t.deployId === "string" ? t.deployId : undefined };
    } catch { /* display only: the card falls back to base units */ }
  }));
  return meta;
}

export async function cairnxTokens(wallet: CairnxViewIo): Promise<{ ok: boolean; tokens?: { ticker: string; decimals: number; name?: string }[] }> {
  try {
    const r = await wallet.tradeGet(`/cairnx/tokens`, 12000); // display read: 12s bounded (was untimed)
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, tokens: Array.isArray(j) ? j : [] };
  } catch { return { ok: false }; }
}
