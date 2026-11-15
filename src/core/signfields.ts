// The fields the wallet signs for a dApp request, from the request's params: the defaults, the clamps and the routes the
// sign path applies, in one function per method. wallet.ts and background.ts build from these, and the approval window
// (clearsign.ts describe, debitOf, costBlock) shows these, so the window and the signer cannot read one request two ways
// (test/sign-display-parity.test.mjs). The engine (node.ts) still validates what it is given and refuses the rest.
import { defaultFeeFor, SCORE_FILL, CONF_TOKEN_FILL } from "./cairnx.js";

type Out = { to: string; value: number };
type Params = Record<string, any>;
const paramsOf = (p: unknown): Params => (p && typeof p === "object" ? (p as Params) : {});

/** An attest at the token-fill confidence is signed as a fill (fillFields), never as a plain attest. */
export const isTokenFillAttest = (confidence: unknown): boolean => (Number(confidence ?? 100) >>> 0) === CONF_TOKEN_FILL;

/** A fill (fillOffer, or an attest at the token-fill confidence). The signed score is SCORE_FILL; a present score that
 *  is not SCORE_FILL is refused (`refused`), never coerced, since the resolver ignores any other score after the payment. */
export type FillFields = { proposalId: unknown; score: number; confidence: number; outputs: Out[]; fee: number; refused?: "score" };
export function fillFields(params: unknown): FillFields {
  const p = paramsOf(params);
  const badScore = p.score != null && (Number(p.score) >>> 0) !== SCORE_FILL;
  return {
    proposalId: p.proposalId, score: SCORE_FILL, confidence: Number(p.confidence ?? 100) >>> 0,
    outputs: Array.isArray(p.outputs) ? p.outputs : [], fee: p.fee ?? defaultFeeFor("fillOffer"),
    ...(badScore ? { refused: "score" as const } : {}),
  };
}

/** An attest: a token fill with no CSD outputs at the token-fill confidence, else a plain attest with its score and
 *  confidence clamped to u32 as they are serialized. */
export type AttestFields = { route: "fill"; fill: FillFields } | { route: "attest"; proposalId: unknown; score: number; confidence: number; fee: number };
export function attestFields(params: unknown): AttestFields {
  const p = paramsOf(params);
  if (isTokenFillAttest(p.confidence)) return { route: "fill", fill: fillFields({ proposalId: p.proposalId, score: p.score, confidence: p.confidence, fee: p.fee, outputs: [] }) };
  return { route: "attest", proposalId: p.proposalId, score: Number(p.score) >>> 0, confidence: Number(p.confidence) >>> 0, fee: p.fee ?? defaultFeeFor("attest") };
}

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

/** A sealed claim's commit: the trimmed domain (default csd:sealed) and the claim it hashes; a claim that is not a
 *  non-empty string, or a domain that is not a string, is refused before any fee is spent. */
export type SealFields = { domain: string; claim: string; fee: number; refused?: string };
export function sealFields(params: unknown): SealFields {
  const p = paramsOf(params);
  const refused = typeof p.claim !== "string" || !p.claim ? "sealClaim: claim must be a non-empty string"
    : p.domain != null && typeof p.domain !== "string" ? "sealClaim: domain must be a string" : undefined;
  const domain = (typeof p.domain === "string" && p.domain.trim()) || "csd:sealed";
  return { domain, claim: typeof p.claim === "string" ? p.claim : "", fee: p.fee ?? defaultFeeFor("sealClaim"), ...(refused ? { refused } : {}) };
}
