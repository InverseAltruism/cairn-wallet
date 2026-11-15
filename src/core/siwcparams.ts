// The wallet's rules for a dApp's signInWithCsd parameters and the SIWC message they make, built from the browser-
// attested origin, never from what the page claims. The canonical builder and digest are siwc.ts (lockstep with
// csd-siwc); this is the policy on top: origin binding, the nonce shape, the caps and the expiry clamp.
import { buildSiwcMessage, originToDomain, rfc3339, CSD_CHAIN_MAINNET, SIWC_VERSION, type SiwcFields } from "./siwc.js";

export type SiwcParams = { nonce?: unknown; statement?: unknown; uri?: unknown; domain?: unknown; expirationSecs?: unknown; notBeforeSecs?: unknown; requestId?: unknown; resources?: unknown };

/** The message the wallet signs for these params, for `account` at `now` (ms). Throws "sign-in: ..." on a parameter it
 *  refuses. */
export function siwcMessageFor(params: SiwcParams | null | undefined, origin: string, account: string, now: number): string {
  return buildSiwcMessage(siwcFieldsFor(params, origin, account, now).fields);
}

/** The fields of that message, with the expiry and not-before offsets (seconds) they were built from: what the approval
 *  window shows. Throws as siwcMessageFor does. */
export function siwcFieldsFor(params: SiwcParams | null | undefined, origin: string, account: string, now: number): { fields: SiwcFields; expSecs: number; notBeforeSecs?: number } {
  const domain = originToDomain(origin);
  if (!domain) throw new Error("sign-in: unknown requesting origin");
  const p = params || {};
  // The page MAY pass its domain, but it is only cross-checked against the real origin; never trusted.
  if (p.domain !== undefined && String(p.domain) !== domain) throw new Error("sign-in: declared domain does not match the requesting site");
  // uri defaults to the origin root; if supplied it MUST be on the requesting site.
  let uri: string;
  if (p.uri === undefined || p.uri === null) uri = origin.replace(/\/+$/, "") + "/";
  else { let h: string | null; try { h = new URL(String(p.uri)).host; } catch { h = null; } if (h !== domain) throw new Error("sign-in: uri must be on the requesting site"); uri = String(p.uri); }
  const nonce = String(p.nonce ?? "");
  if (!/^[A-Za-z0-9]{8,}$/.test(nonce)) throw new Error("sign-in: a server-issued nonce (>=8 alphanumeric chars) is required");
  const statement = p.statement != null && String(p.statement) !== "" ? String(p.statement) : undefined;
  if (statement !== undefined && /[\r\n]/.test(statement)) throw new Error("sign-in: statement must be a single line");
  // Rejected, not truncated, for the same WYSIWYS reason as requestId below.
  if (statement !== undefined && statement.length > 256) throw new Error("sign-in: statement exceeds 256 chars");
  const expSecs = Math.min(3600, Math.max(60, Math.floor(Number(p.expirationSecs) || 600))); // clamp 60s..1h, default 10m
  // Cap dApp-supplied resources (audit SIWC-RESOURCES): the user now sees them in the approval popup,
  // and we bound count + per-entry length and reject embedded newlines so a dApp can neither bloat the
  // signed credential nor inject extra SIWC lines via a multi-line resource entry.
  if (p.resources !== undefined && !Array.isArray(p.resources)) throw new Error("sign-in: resources must be an array");
  if (Array.isArray(p.resources) && p.resources.length > 10) throw new Error("sign-in: too many resources (max 10)");
  const resources = Array.isArray(p.resources) ? p.resources.map((x) => {
    const s = String(x);
    if (s.length > 256) throw new Error("sign-in: a resource entry exceeds 256 chars");
    if (/[\r\n]/.test(s)) throw new Error("sign-in: resources must be single-line");
    return s;
  }) : undefined;
  // Reject (don't silently truncate) an over-long/multi-line requestId: the popup shows the full value,
  // so truncating only the SIGNED copy would break what-you-see-is-what-you-sign.
  const requestId = p.requestId != null ? String(p.requestId) : undefined;
  if (requestId !== undefined && (requestId.length > 256 || /[\r\n]/.test(requestId))) throw new Error("sign-in: requestId too long or multi-line");
  const notBeforeSecs = p.notBeforeSecs != null && Number(p.notBeforeSecs) > 0 ? Math.floor(Number(p.notBeforeSecs)) : undefined;
  const fields: SiwcFields = {
    domain, account, statement, uri, version: SIWC_VERSION, chainId: CSD_CHAIN_MAINNET,
    nonce, issuedAt: rfc3339(now), expirationTime: rfc3339(now + expSecs * 1000),
    // Only emit notBefore for a POSITIVE offset; a 0/negative value is a no-op "valid from now-or-past"
    // constraint that the clear-sign window (clearsign.ts) does NOT display, so signing it would mean
    // committing a field the user never saw (audit SDS-1). Matching the conditions keeps WYSIWYS exact.
    notBefore: notBeforeSecs !== undefined ? rfc3339(now + notBeforeSecs * 1000) : undefined,
    requestId,
    resources,
  };
  buildSiwcMessage(fields);   // the builder's own field checks refuse here too, so a returned set always builds
  return { fields, expSecs, ...(notBeforeSecs !== undefined ? { notBeforeSecs } : {}) };
}

// An address for the pre-queue check and the window's fields: the account line only has to be an address there, and the
// signer's own replaces it.
export const ANY_ACCOUNT = "0x" + "00".repeat(20);
/** Why the wallet would refuse these params once the user approved, or null: background.ts refuses before queueing, so a
 *  page learns it before the user is asked (BAD_REQUEST). The same function runs again at the sign. */
export function siwcParamsRefusal(params: unknown, origin: string): string | null {
  try { siwcMessageFor(params as SiwcParams, origin, ANY_ACCOUNT, Date.now()); return null; }
  catch (e) { return e instanceof Error ? e.message : String(e); }
}
