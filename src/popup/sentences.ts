// The wallet's sentences on screen, keyed by the copy sheet's tags (cairn docs/Plans/91-evidence/
// wallet-copy-sheet-2026-11-22.md), so a change of wording is a change of this file. The sheet is a draft the owner
// signs; a line enters here when the code that shows it is built.

/** [M11] grey, under the balance: the balance was read from Cairn's second server. */
export const M11_BACKUP_SERVER = "Using Cairn's backup server.";

// Draft, not in the sheet yet (the owner signs the words): Cairn's main server refused a send and the backup server
// had not answered (core/hosts.ts MAIN_REFUSED_WAIT_MS), so the result is "may be in flight" with what is known first.
// Keyed by the refusal's reason (core/submitverdict.ts RefusalReason).
export const MAIN_REFUSED_REASON: Record<string, string> = {
  FEE: "Cairn's server refused this payment: the fee is too low.",
  BUSY: "Cairn's server refused this payment: the network is busy.",
  SPENT: "Cairn's server refused this payment: its coins are already spent.",
  CONFLICT: "Cairn's server refused this payment: another payment uses its coins.",
  PROXY: "Cairn's server refused this payment.",
  INVALID: "Cairn's server refused this payment as invalid.",
  UNKNOWN: "Cairn's server refused this payment.",
};
export const BACKUP_NOT_ANSWERED = "The backup server has not answered, so it may still go through: check your history before you send again.";
