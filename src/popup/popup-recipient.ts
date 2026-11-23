// A send's recipient: an address or a .csd name resolved and badged, the confirm-time re-check, and the first-time
// and look-alike reads.
import { isPlainName } from "../core/cairnx.js";
import { NAME_SAFE_DEPTH, recheckOutcome, type Recheck, recipientStatus, paidRecipients, lastPaidTo, isZeroAddr, short } from "./clearsign.js";
import { call } from "./popup-bridge.js";
import { SPV_NEWEST_HEIGHT } from "../core/spvnewest.js";
import { sentenceOf, type Sentence } from "./sentences.js";
import { sentenceHtml } from "./popup-outcome.js";
import { awaitCheck, startNameCheck, type CheckUi, type NameCheck, type Served } from "./popup-namecheck.js";

// Resolve a send recipient: a 0x… address as-is, or a .csd name (nset addr else owner; refuse lapsed).
const looksLikeName = (s: string) => /\.csd$/i.test(s) || isPlainName(s.toLowerCase()); // L10: single-sourced NAME_RE
export type Recipient = { ok: boolean; addr?: string; name?: string | null; label?: string | null; badge?: string; lowDepth?: boolean; error?: string; verified?: boolean; sources?: number; disagree?: boolean; soleSource?: boolean; viaFill?: boolean; partly?: boolean; lapseUnconfirmed?: boolean; linesHtml?: string[]; unchecked?: NameCheck };
/** A Review's wait for a name: the sheet's line ([A16]) and whether the Review was left; `check` is the running check
 *  "Wait" goes back to. Without it the lookup is awaited as one call (the token and CSD reviews pass it). */
export type ReviewWait = { ui: CheckUi; left: () => boolean; check?: NameCheck | null };
export async function resolveRecipient(raw: string, wait?: ReviewWait): Promise<Recipient> {
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
    let res: any;
    if (wait) {
      const check = wait.check?.name === nm ? wait.check : startNameCheck(nm);
      const w = await awaitCheck(check, wait.ui, wait.left);
      if (w.kind === "left") return { ok: false, error: "" };
      if (w.kind === "chose") return uncheckedRecipient(nm, w.served, check);
      res = w.res;
    } else res = await call("resolveName", nm).catch(() => ({ ok: false, error: "Name lookup failed." }));
    // resolveName SPV-verifies the name over two name sources (primary and clarvis, same operator). A disagreeing
    // source warns rather than refuses: the target is the proven winner with `disagree` set, and an unprovable
    // name comes back verified:false for the badge to caution. res.ok is false only for an invalid, unregistered,
    // address-less or proven-lapsed name, or a failed lookup.
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
    // D20 ([A18]): a holding completed above this release's newest table entry rests on the header chain above it,
    // which the servers that answered also serve; it takes the line the agreeing servers would get.
    const partly = verified && !viaFill && !res.soleSource && !res.disagree && (res.sources ?? 1) >= 2
      && typeof res.completedAt === "number" && res.completedAt > SPV_NEWEST_HEIGHT;
    // [A4]: the name service or the served tip says the lease ran out and the wallet could not settle it. It stands
    // alone only on the address the name's verified records gave (`addrProven`); on the served one [A9] (or [A10] for a
    // bought name) comes first, since that address was not checked at all.
    const lapseUnconfirmed = res.lapseUnconfirmed === true;
    const lapseLines = lapseUnconfirmed ? [...(res.addrProven === true ? [] : [sentenceOf(viaFill ? "A10" : "A9")]), sentenceOf("A4", undefined, { name: `${nm}.csd` })] : [];
    // These lines and [A18] stand in place of the name's paragraph, each with its Details.
    const lines: Sentence[] = lapseUnconfirmed ? lapseLines : partly ? [sentenceOf("A18")] : [];
    const badge = lines.length ? lines.map((l) => l.text).join(" ") : !verified
      ? (viaFill ? "Purchased name: it can't be name-scope-proven, so confirm the address." : "Not chain-verified: confirm the address.")
      : res.soleSource ? `Only one name source could prove this address, and it isn't independently corroborated: confirm it out-of-band before sending${conf}.`
      : res.disagree ? `Chain-backed, but a name source disagreed (or hasn't indexed it yet): verify the address${conf}.`
      : (res.sources ?? 1) >= 2
        ? (lowDepth ? `Chain-backed, ${res.sources} servers agree, only${conf}: it could still reorg.` : `Chain-backed, ${res.sources} name servers agree (same operator)${conf}.`)
        : `Chain-backed, but only 1 source answered: the second server is unreachable, a weaker guarantee${conf}.`;
    return { ok: true, addr: res.addr, name: nm, verified, sources: res.sources, disagree: res.disagree, soleSource: res.soleSource, viaFill, lowDepth, partly, lapseUnconfirmed, ...(lines.length ? { linesHtml: lines.map(sentenceHtml) } : {}), label: `${nm}.csd → ${short(res.addr)}`, badge };
  }
  return { ok: false, error: "Enter a 0x… address or a name.csd." };
}
// "Send without check": the review on the name service's answer, unverified, with [A17] in place of the name's paragraph,
// and [A4] after it when the service calls the name expired; `unchecked` is the check still running, which Confirm reads.
function uncheckedRecipient(nm: string, served: Served, check: NameCheck): Recipient {
  if (isZeroAddr(served.addr)) return { ok: false, error: `${nm}.csd points at the zero address: refusing (sends would be burned)` };
  const lines = [sentenceOf("A17"), ...(served.lapsed ? [sentenceOf("A4", undefined, { name: `${nm}.csd` })] : [])];
  return { ok: true, addr: served.addr, name: nm, verified: false, unchecked: check, lapseUnconfirmed: served.lapsed, linesHtml: lines.map(sentenceHtml), badge: lines.map((l) => l.text).join(" "), label: `${nm}.csd → ${short(served.addr)}` };
}

// XREPO-1 confirm-time guard wrapper: re-ask the name service at sign-time; the outcome is clearsign.recheckOutcome's
// (pure, unit-tested) over the answer, and a call that failed is a look-up that did not answer. This only wires the call.
export async function nameRecheck(name: string, reviewed: string, reviewedVerified?: boolean, reviewedLapse?: boolean): Promise<Recheck> {
  const re = await call("confirmName", name).catch(() => ({ ok: false }));
  return recheckOutcome(reviewed, re, reviewedVerified, reviewedLapse);
}

export function setNameRow(rowId: string, valId: string, label: string | null | undefined) {
  const row = document.getElementById(rowId), v = document.getElementById(valId);
  if (!row || !v) return;
  if (label) { v.textContent = label; (row as HTMLElement).hidden = false; }
  else { v.textContent = ""; (row as HTMLElement).hidden = true; }
}

// First-time-recipient + address-poisoning look-alike, computed by the same clearsign.recipientStatus
// as the approval window: paid recipients plus this wallet's own accounts (sending to your own other
// account is not a first send). History unavailable → treat as first time. For a send to a name, `redirected` is the
// address this account last paid the name at when it now resolves elsewhere ([A19]), from the same history read.
export async function recipientChecks(to: string, name?: string | null): Promise<{ firstTime: boolean; lookalike: string | null; redirected: string | null }> {
  try {
    const [h, st] = await Promise.all([call("history"), call("status")]);
    const before = name ? lastPaidTo(h, name) : null;
    return { ...recipientStatus(to, paidRecipients(h), (st.accounts || []).map((a: any) => String(a.addr))), redirected: before && before !== to.toLowerCase() ? before : null };
  } catch { return { firstTime: true, lookalike: null, redirected: null }; }
}
