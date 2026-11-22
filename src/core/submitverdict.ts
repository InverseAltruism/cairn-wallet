// What one host's answer to POST /tx/submit says, and what the answers of every host the submit went to say together.
// Pure: no fetch, no clock. The node answers every verdict with HTTP 200 (compute-substrate src/api/mod.rs tx_submit);
// a non-2xx comes from the proxy in front of it or from the network. The reasons are prefix matches on the node's own
// refusal texts at the fork (cairn-node v0.1.17) and upstream (`test/submit-classify.test.mjs` holds each text).

/** Why a host refused a submit. CONFLICT: a different pending transaction spends these coins. PROXY: the proxy refused
 *  the request before forwarding it (its 400 or 413 body cap). UNKNOWN: a refusal text this wallet does not know. */
export type RefusalReason = "FEE" | "BUSY" | "SPENT" | "CONFLICT" | "PROXY" | "INVALID" | "UNKNOWN";

/** One host's answer. `text` is the answer's own error text (a server's words, for the result's `error` and the log),
 *  or a transport label when there was none. `txid` is the txid the host echoed on an acceptance. */
export type HostVerdict =
  | { kind: "accepted"; txid?: string }
  | { kind: "duplicate"; text: string }
  | { kind: "refused"; reason: RefusalReason; text: string }
  | { kind: "unclear"; text: string };

/** What the submit tells the sender. sent: a host accepted it. duplicate: a host already holds this transaction, or
 *  one spending the same coins. unclear: a host may hold it. refused: every host refused it. */
export type SubmitOutcome =
  | { kind: "sent" }
  | { kind: "duplicate" }
  | { kind: "unclear"; text: string }
  | { kind: "refused"; reason: RefusalReason; text: string };

// The node's duplicate text, "already present in mempool" at the fork and "already present or mempool conflict"
// upstream. The fork's conflict text, "mempool conflict: a different pending transaction spends these coins", does not
// contain it. A miss is the safe direction: a duplicate read as refused shows a refusal for a transaction whose resend
// is byte-identical.
export const isSubmitDuplicateErr = (err: unknown): boolean => /already present/i.test(String(err ?? ""));

const REASONS: readonly [RegExp, RefusalReason][] = [
  [/^mempool conflict/i, "CONFLICT"],
  [/^feerate too low|^fee too low for (propose|attest)/i, "FEE"],
  [/^mempool (full;|bytes full|spent index full|state inconsistent)/i, "BUSY"],
  [/^missing utxo/i, "SPENT"],
  [/^(tx too large|too many inputs|too many outputs|tx has no inputs|no inputs|no outputs|negative fee|coinbase not allowed|bad scriptsig len|duplicate input outpoint|expected 64-byte compact sig|expected 33-byte compressed pubkey|pubkey must be 33 bytes|pubkey hash mismatch|non-canonical signature|outputs exceed inputs|propose |attest )/i, "INVALID"],
];
export function refusalReason(text: string): RefusalReason {
  for (const [re, reason] of REASONS) if (re.test(text)) return reason;
  return "UNKNOWN";
}

// The node's text when the check of a submit panicked: the admission may or may not have run.
const NOT_FINISHED = /^submit validation did not finish/i;

/** The answer of one host: `thrown` when the request failed or timed out, else the HTTP status and the parsed body
 *  (`undefined` when it was not JSON). */
export type SubmitAnswer = { thrown: true } | { status: number; body: unknown };

// A field's text only when it is a string: a server's body is data, and String() of an object can throw.
const textOf = (j: Record<string, unknown> | null, k: string): string => (j && typeof j[k] === "string" ? (j[k] as string) : "");

/** Total: every answer, however hostile its body, gets a verdict, and an answer the wallet cannot read is unclear. */
export function classifyAnswer(a: SubmitAnswer, path = "/tx/submit"): HostVerdict {
  try { return classify(a, path); }
  catch { return { kind: "unclear", text: `${path} -> unreadable response` }; }
}
function classify(a: SubmitAnswer, path: string): HostVerdict {
  if ("thrown" in a) return { kind: "unclear", text: `${path} -> network error` };
  const { status, body } = a;
  const j = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (status < 200 || status > 299) {
    const served = textOf(j, "err") || textOf(j, "error");
    const text = served || `${path} -> ${status}`;
    // A 4xx carrying the duplicate text is read as the duplicate it names, as in 0.3.4.
    if (status < 500 && isSubmitDuplicateErr(served)) return { kind: "duplicate", text };
    // A proxy answers its body cap (400, 413) and its rate limit (429) before forwarding: this request reached no
    // node. Any other status, a 5xx and an unparseable body included, may follow a node taking the transaction.
    if (body !== undefined && (status === 400 || status === 413)) return { kind: "refused", reason: "PROXY", text };
    if (body !== undefined && status === 429) return { kind: "refused", reason: "BUSY", text };
    return { kind: "unclear", text };
  }
  if (body === undefined) return { kind: "unclear", text: `${path} -> non-JSON response` };
  if (!j) return { kind: "unclear", text: `${path} -> unreadable response` };
  const ok = Object.hasOwn(j, "ok") ? j.ok : undefined;
  if (ok === true) return { kind: "accepted", ...(textOf(j, "txid") ? { txid: textOf(j, "txid") } : {}) };
  const err = ok === false ? textOf(j, "err") : "";
  if (!err) return { kind: "unclear", text: `${path} -> answer without the node's verdict` };
  if (isSubmitDuplicateErr(err)) return { kind: "duplicate", text: err };
  if (NOT_FINISHED.test(err)) return { kind: "unclear", text: err };
  return { kind: "refused", reason: refusalReason(err), text: err };
}

/**
 * The outcome of a submit from each host's verdict, in host order (the main host first); `undefined` while a host has
 * not answered. Returns null while the outcome can still change. Only an acceptance decides before every host has
 * answered: any other answer could be followed by another host's acceptance, and reporting it first could prompt a
 * second payment. Once all have answered: a host that may hold it makes it unclear, then a duplicate, else refused
 * with the first refusing host's reason.
 */
export function decideSubmit(vs: readonly (HostVerdict | undefined)[]): SubmitOutcome | null {
  if (vs.some((v) => v?.kind === "accepted")) return { kind: "sent" };
  if (vs.some((v) => v === undefined)) return null;
  const all = vs as readonly HostVerdict[];
  const unclear = all.find((v) => v.kind === "unclear");
  if (unclear) return { kind: "unclear", text: unclear.text };
  if (all.some((v) => v.kind === "duplicate")) return { kind: "duplicate" };
  const r = all.find((v) => v.kind === "refused") as Extract<HostVerdict, { kind: "refused" }>;
  return { kind: "refused", reason: r.reason, text: r.text };
}
