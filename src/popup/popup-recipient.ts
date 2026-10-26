// A send's recipient: an address or a .csd name resolved and badged, the confirm-time re-check, and the first-time
// and look-alike reads.
import { isPlainName } from "../core/cairnx.js";
import { NAME_SAFE_DEPTH, reresolveUnchanged, recipientStatus, paidRecipients, isZeroAddr, short } from "./clearsign.js";
import { call } from "./popup-bridge.js";

// Resolve a send recipient: a 0x… address as-is, or a .csd name (nset addr else owner; refuse lapsed).
const looksLikeName = (s: string) => /\.csd$/i.test(s) || isPlainName(s.toLowerCase()); // L10: single-sourced NAME_RE
export async function resolveRecipient(raw: string): Promise<{ ok: boolean; addr?: string; name?: string | null; label?: string | null; badge?: string; lowDepth?: boolean; error?: string; verified?: boolean; sources?: number; disagree?: boolean; soleSource?: boolean; viaFill?: boolean }> {
  const r = (raw || "").trim();
  // Refuse the zero address outright: a send there is an irrecoverable burn. Defense-in-depth for the V23
  // transition: a wallet that CARRIES this guard but whose vendored core still lacked the v23 branch would
  // replay a cleared name to 0x000..0, and this blocks that burn. It does NOT cover releases predating this
  // guard (no 0x0 check -> they burn after V23); for those the only safeguard is the deploy discipline in
  // types.ts (set V23_HEIGHT only after wallet ADOPTION, not publication).
  // isZeroAddr is the shared (0x)?-optional guard from clearsign.ts; one test for all three former copies.
  if (/^0x[0-9a-fA-F]{40}$/.test(r)) {
    if (isZeroAddr(r)) return { ok: false, error: "That is the zero address: sends there are burned and unrecoverable." };
    return { ok: true, addr: r.toLowerCase(), name: null, label: null };
  }
  if (looksLikeName(r)) {
    const nm = r.toLowerCase().replace(/\.csd$/, "");
    const res = await call("resolveName", nm).catch(() => ({ ok: false, error: "Name lookup failed." }));
    // resolveName SPV-verifies the name over two name sources (primary and clarvis, same operator). A disagreeing
    // source warns rather than refuses: the target is the proven winner with `disagree` set, and an unprovable
    // name comes back verified:false for the badge to caution. res.ok is false only for an invalid, unregistered,
    // address-less or lapsed name, or a failed lookup.
    if (!res.ok) return { ok: false, error: res.error || `Couldn't resolve ${nm}.csd.` };
    if (isZeroAddr(res.addr)) return { ok: false, error: `${nm}.csd points at the zero address: refusing (sends would be burned)` };
    const verified = res.verified === true;
    const viaFill = res.viaFill === true;
    const conf = res.depth ? ` (${res.depth} conf)` : "";
    // C2 badge honesty (Plans/68 F2/F4): single-source is the EXACT posture where the documented
    // competing-claim withholding redirect is live, so it must read visibly weaker than 2-source
    // agreement, not like the same green check; and a barely-buried (1-2 conf) resolution gets a
    // reorg caution instead of a plain check. Both stay informational; never a block.
    const lowDepth = typeof res.depth === "number" && res.depth > 0 && res.depth < NAME_SAFE_DEPTH;
    const badge = !verified
      ? (viaFill ? "Purchased name: it can't be name-scope-proven, so confirm the address." : "Not chain-verified: confirm the address.")
      : res.soleSource ? `Only one name source could prove this address, and it isn't independently corroborated: confirm it out-of-band before sending${conf}.`
      : res.disagree ? `Chain-backed, but a name source disagreed (or hasn't indexed it yet): verify the address${conf}.`
      : (res.sources ?? 1) >= 2
        ? (lowDepth ? `Chain-backed, ${res.sources} servers agree, only${conf}: it could still reorg.` : `Chain-backed, ${res.sources} name servers agree (same operator)${conf}.`)
        : `Chain-backed, but only 1 source answered: the second server is unreachable, a weaker guarantee${conf}.`;
    return { ok: true, addr: res.addr, name: nm, verified, sources: res.sources, disagree: res.disagree, soleSource: res.soleSource, viaFill, lowDepth, label: `${nm}.csd → ${short(res.addr)} (via ${res.via ?? "owner"})`, badge };
  }
  return { ok: false, error: "Enter a 0x… address or a name.csd." };
}
// XREPO-1 confirm-time guard wrapper: re-ask the name service at sign-time and REFUSE unless it still
// returns EXACTLY the reviewed address. Fail-closed on any error / network failure. The equality +
// shape check lives in clearsign.reresolveUnchanged (pure, unit-tested); this only wires the live call.
export async function nameStillPointsTo(name: string, reviewed: string, reviewedVerified?: boolean): Promise<boolean> {
  const re = await call("confirmName", name).catch(() => ({ ok: false }));
  return reresolveUnchanged(reviewed, re, reviewedVerified); // L7: also refuses a verified→unverified regression
}

export function setNameRow(rowId: string, valId: string, label: string | null | undefined) {
  const row = document.getElementById(rowId), v = document.getElementById(valId);
  if (!row || !v) return;
  if (label) { v.textContent = label; (row as HTMLElement).hidden = false; }
  else { v.textContent = ""; (row as HTMLElement).hidden = true; }
}

// First-time-recipient + address-poisoning look-alike, computed by the same clearsign.recipientStatus
// as the approval window: paid recipients plus this wallet's own accounts (sending to your own other
// account is not a first send). History unavailable → treat as first time.
export async function recipientChecks(to: string): Promise<{ firstTime: boolean; lookalike: string | null }> {
  try {
    const [h, st] = await Promise.all([call("history"), call("status")]);
    return recipientStatus(to, paidRecipients(h), (st.accounts || []).map((a: any) => String(a.addr)));
  } catch { return { firstTime: true, lookalike: null }; }
}
