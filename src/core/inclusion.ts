// Whether a transaction this wallet sent is included, derived from chain reads, not the clock. Used for
// display (the history markers and the merge line); the reconcile submits nothing (test/inclusion-chain.test.mjs).

/** A row still not included this many blocks past the tip at submit shows the standing notice. */
export const INCLUSION_NOTICE_BLOCKS = 10;
/** Input outpoints kept on a history row for the "spent" check. */
export const INCLUSION_INPUTS_KEPT = 8;
/** Status reads per reconcile, newest rows first. */
export const INCLUSION_READS_MAX = 8;
/** A row gone for more than this many blocks is no longer read (a utxo set showing its txid still settles it). */
export const INCLUSION_GONE_READ_BLOCKS = 100;

/**
 * One status read, as the RPC reports it (one source: the wallet cannot check it). `definite` (unknown only):
 * the source looked completely, so the tx is not mined there; without it the source could not look.
 */
export type TxInclusion = { state: "mined" | "pending" | "unknown"; height?: number; definite?: boolean };

/**
 * included: mined. spent: definitely not mined, and a kept input is missing from the MINED utxo set (`mined`,
 * `txid:vout` keys), so a different mined transaction spent it; our own pending tx leaves its inputs there.
 * noreading: no status, a status that could not look, or no mined set: says nothing either way.
 * open: anything else.
 */
export function inclusionVerdict(st: TxInclusion | null, inputs: unknown, mined: ReadonlySet<string> | null): "included" | "spent" | "open" | "noreading" {
  if (st?.state === "mined") return "included";
  if (!st) return "noreading";
  if (st.state !== "unknown") return "open";
  if (st.definite !== true || !mined) return "noreading";
  return Array.isArray(inputs) && inputs.some((op) => typeof op === "string" && !mined.has(op)) ? "spent" : "open";
}

/**
 * Applies one fresh reading at `tip` to a row: `gone` only once "spent" held at two different tips, and any
 * other fresh reading clears it, so a wrong or racing read is undone by the next one. Returns true on a change.
 */
export function goneStep(row: { goneTip?: number; gone?: boolean }, verdict: "spent" | "open", tip: number): boolean {
  if (verdict === "open") {
    if (row.goneTip === undefined && !row.gone) return false;
    delete row.goneTip; delete row.gone;
    return true;
  }
  if (!(Number(row.goneTip) > 0)) { row.goneTip = tip; return true; }
  if (tip > Number(row.goneTip) && !row.gone) { row.gone = true; return true; }
  return false;
}

/** The history marker for a row: null once included or for a row whose submit was answered. */
export function inclusionMark(row: { maybe?: unknown; stuck?: unknown; gone?: unknown }): "sent" | "stuck" | "gone" | null {
  if (row.gone) return "gone";
  if (!row.maybe) return null;
  return row.stuck ? "stuck" : "sent";
}
