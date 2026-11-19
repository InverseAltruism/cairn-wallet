// The fields the wallet signs for a dApp request, from the request's params: the defaults, the clamps and the routes the
// sign path applies, in one function per method. wallet.ts and background.ts build from these, and the approval window
// (clearsign.ts and approve.ts: what it paints and what it reads before the paint) shows these, so the window and the
// signer cannot read one request two ways (test/sign-display-parity.test.mjs). The engine (node.ts) still validates what
// it is given and refuses the rest.
import { defaultFeeFor, SCORE_FILL, CONF_TOKEN_FILL } from "./cairnx.js";
import { MAX_DOMAIN_BYTES, isWellFormedUtf16 } from "../vendor/cairnx-spv.js";

type Out = { to: string; value: number };
type Params = Record<string, any>;
const paramsOf = (p: unknown): Params => (p && typeof p === "object" ? (p as Params) : {});

// A page's params are JSON. Number() and String() throw on an object whose `toString` is not a function, and read a
// list as its elements' text, so a score, confidence or seal txid is read only from a scalar (null, a string, a number
// or a boolean). A reader returns for any JSON value: one of those fields that is present and not a scalar is named in
// `shape`, which background.ts refuses before the queue and the signer refuses after it, never read as a number. An id,
// address, amount or fee of the wrong type is refused by the engine's own checks (node.ts). The approval window paints
// every request that passes those checks (test/request-shape-fuzz.test.mjs).
const scalar = (v: unknown): boolean => v === null || typeof v !== "object";
const num = (v: unknown): number => (scalar(v) ? Number(v) : Number.NaN);
/** The first named field that is present and not a scalar, as the refusal text, or undefined. */
function shapeOf(fields: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(fields)) if (!scalar(v)) return `${k} must be a number, not an object or a list`;
  return undefined;
}

/** An attest at the token-fill confidence is signed as a fill (fillFields), never as a plain attest. */
const isTokenFillAttest = (confidence: unknown): boolean => (num(confidence ?? 100) >>> 0) === CONF_TOKEN_FILL;

/** A fill (fillOffer, or an attest at the token-fill confidence). The signed score is SCORE_FILL; a present score that
 *  is not SCORE_FILL is refused (`refused`), never coerced, since the resolver ignores any other score after the payment. */
export type FillFields = { proposalId: unknown; score: number; confidence: number; outputs: Out[]; fee: number; refused?: "score"; shape?: string };
export function fillFields(params: unknown): FillFields {
  const p = paramsOf(params);
  const shape = shapeOf({ score: p.score, confidence: p.confidence });
  const badScore = p.score != null && (num(p.score) >>> 0) !== SCORE_FILL;
  return {
    proposalId: p.proposalId, score: SCORE_FILL, confidence: num(p.confidence ?? 100) >>> 0,
    outputs: Array.isArray(p.outputs) ? p.outputs : [], fee: p.fee ?? defaultFeeFor("fillOffer"),
    ...(badScore ? { refused: "score" as const } : {}), ...(shape ? { shape } : {}),
  };
}

/** An attest: a token fill with no CSD outputs at the token-fill confidence, else a plain attest with its score and
 *  confidence clamped to u32 as they are serialized. */
export type AttestFields = { route: "fill"; fill: FillFields } | { route: "attest"; proposalId: unknown; score: number; confidence: number; fee: number; shape?: string };
export function attestFields(params: unknown): AttestFields {
  const p = paramsOf(params);
  if (isTokenFillAttest(p.confidence)) return { route: "fill", fill: fillFields({ proposalId: p.proposalId, score: p.score, confidence: p.confidence, fee: p.fee, outputs: [] }) };
  const shape = shapeOf({ score: p.score, confidence: p.confidence });
  return { route: "attest", proposalId: p.proposalId, score: num(p.score) >>> 0, confidence: num(p.confidence) >>> 0, fee: p.fee ?? defaultFeeFor("attest"), ...(shape ? { shape } : {}) };
}

/** The fill a request signs: a fillOffer, or an attest the signer signs as a fill; null for any other request. */
export function fillOf(method: unknown, params: unknown): FillFields | null {
  if (method === "fillOffer") return fillFields(params);
  if (method !== "attest") return null;
  const a = attestFields(params);
  return a.route === "fill" ? a.fill : null;
}
/** A token-priced fill: a fill (fillOf) at the token-fill confidence. */
export const isTokenFill = (method: unknown, params: unknown): boolean => fillOf(method, params)?.confidence === CONF_TOKEN_FILL;

export type ProposeFields = { domain: any; payloadHash: any; uri: any; expiresEpoch: any; fee: number; outputs: Out[] };
export function proposeFields(params: unknown): ProposeFields {
  const p = paramsOf(params);
  return { domain: p.domain, payloadHash: p.payloadHash, uri: p.uri, expiresEpoch: p.expiresEpoch, fee: p.fee ?? defaultFeeFor("propose"), outputs: Array.isArray(p.outputs) ? p.outputs : [] };
}

/** A send: `outputs` (sendMany) when the page passes an array, else one output from `to` and `amount`. */
export type SendFields = { many: boolean; outputs: Out[]; fee: number };
export function sendFields(params: unknown): SendFields {
  const p = paramsOf(params);
  const many = Array.isArray(p.outputs);
  return { many, outputs: many ? p.outputs : [{ to: p.to, value: p.amount }], fee: p.fee ?? defaultFeeFor("send") };
}

/** A reveal publishes the stored preimage of the seal `txid` (the request's params) and signs no transaction. */
export const revealFields = (params: unknown): { txid: string; shape?: string } =>
  scalar(params) ? { txid: String(params ?? "") } : { txid: "", shape: "the seal txid must be a string, not an object or a list" };

/** Why a text field the chain caps in UTF-8 bytes is refused (not a string, an unpaired surrogate, which UTF-8 cannot
 *  carry and the consensus codec refuses, or longer than `max`), or undefined. */
export function byteCapRefusal(field: string, v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return `${field} must be a string`;
  if (!isWellFormedUtf16(v)) return `${field} has an unpaired surrogate, a character UTF-8 cannot carry`;
  const n = new TextEncoder().encode(v).length;
  return n > max ? `${field} is ${n} UTF-8 bytes; the network takes at most ${max}` : undefined;
}

/** A sealed claim's commit: the trimmed domain (default csd:sealed) and the claim it hashes; a claim that is not a
 *  non-empty string, or a domain that is not a string or is past the consensus cap, is refused before any fee is spent
 *  (and by background.ts before the request is queued). */
export type SealFields = { domain: string; claim: string; fee: number; refused?: string };
export function sealFields(params: unknown): SealFields {
  const p = paramsOf(params);
  const domain = (typeof p.domain === "string" && p.domain.trim()) || "csd:sealed";
  const refused = typeof p.claim !== "string" || !p.claim ? "sealClaim: claim must be a non-empty string"
    : p.domain != null && typeof p.domain !== "string" ? "sealClaim: domain must be a string"
    : byteCapRefusal("sealClaim: domain", domain, MAX_DOMAIN_BYTES);
  return { domain, claim: typeof p.claim === "string" ? p.claim : "", fee: p.fee ?? defaultFeeFor("sealClaim"), ...(refused ? { refused } : {}) };
}
