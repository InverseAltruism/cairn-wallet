// Whether a transaction this wallet sent is included, derived from chain reads, not the clock. Display only:
// nothing may gate a signature or a spend on it, and the reconcile submits nothing (test/inclusion-chain.test.mjs).

/** A row still not included this many blocks past the tip at submit shows the standing notice. */
export const INCLUSION_NOTICE_BLOCKS = 10;
/** Input outpoints kept on a history row; one input spent by another transaction is enough to say "gone". */
export const INCLUSION_INPUTS_KEPT = 8;

/** One status read: `definite` (unknown only) means every source answered completely. */
export type TxInclusion = { state: "mined" | "pending" | "unknown"; height?: number; definite?: boolean };

/**
 * included: mined. gone: no node holds or has mined it and an input it spent is no longer available, so a
 * different transaction spent that coin. open: anything else, including no read at all.
 * `available` holds `txid:vout` keys of the account's available utxo set.
 */
export function inclusionVerdict(st: TxInclusion | null, inputs: unknown, available: ReadonlySet<string>): "included" | "gone" | "open" {
  if (st?.state === "mined") return "included";
  if (st?.state === "unknown" && st.definite === true && Array.isArray(inputs)
    && inputs.some((op) => typeof op === "string" && !available.has(op))) return "gone";
  return "open";
}

/** The history marker for a row: null once included or for a row whose submit was answered. */
export function inclusionMark(row: { maybe?: unknown; stuck?: unknown; gone?: unknown }): "sent" | "stuck" | "gone" | null {
  if (row.gone) return "gone";
  if (!row.maybe) return null;
  return row.stuck ? "stuck" : "sent";
}
