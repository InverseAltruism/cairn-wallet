// The wallet's sentences on screen, keyed by the copy sheet's tags (cairn docs/Plans/91-evidence/
// wallet-copy-sheet-2026-11-22.md), so a change of wording is a change of this file. The sheet is a draft the owner
// signs; a line enters here when the code that shows it is built. No logic reads a text: the selectors below choose a
// key from a result's code and reason, and test/sentences-copy.test.mjs checks every entry against the copy rule.

export type Tone = "grey" | "amber" | "red";
export type Sentence = { text: string; tone: Tone; details: string };

/** [M11] grey, under the balance: the balance was read from Cairn's second server. */
export const M11_BACKUP_SERVER = "Using Cairn's backup server.";

// The results of a send and the coin checks before it (sheet sections 2 and 8). MR_* are drafts the sheet lacks: the
// main server refused and the backup server had not answered (core/hosts.ts MAIN_REFUSED_WAIT_MS), so the result is
// "may be in flight" with what is known first; the sheet's R4 to R6 say "Nothing was sent", which is not known there.
export const SENTENCES = {
  R1: { text: "Something went wrong, so nothing was sent. Try again, or see Details.", tone: "red", details: "The refusal's code, and the wallet's own reason." },
  R2: { text: "This may have been sent. Check your history before you send again.", tone: "amber", details: "SUBMIT_MAYBE_INFLIGHT: no server accepted it and one may hold it (no answer, a timeout, a 5xx, an unreadable answer)." },
  R3: { text: "This payment, or one using the same coins, is already on its way. Check your history once it confirms.", tone: "grey", details: "SUBMIT_DUPLICATE: already present or a conflict in the pending pool." },
  R4: { text: "Fee too low for the network right now. Nothing was sent.", tone: "red", details: "SUBMIT_REJECTED, classed as fee." },
  R5: { text: "Network busy, so nothing was sent. Try again in a minute.", tone: "red", details: "SUBMIT_REJECTED, classed as busy (a full pending pool, or HTTP 429)." },
  R6: { text: "The network did not accept this payment. Nothing was sent.", tone: "red", details: "SUBMIT_REJECTED, any other refusal (200 ok:false, 400, 413)." },
  R7: { text: "Rejected. Nothing was signed.", tone: "grey", details: "USER_REJECTED." },
  R8: { text: "The wallet locked before anything was signed, so nothing was sent. Unlock and try again.", tone: "red", details: "WALLET_LOCKED." },
  R9: { text: "You switched accounts after reviewing this. Nothing was sent; open it again and review it.", tone: "red", details: "ACCOUNT_CHANGED." },
  R10: { text: "This site can't use this kind of sign-in. Nothing was signed.", tone: "red", details: "FIRST_PARTY_ONLY: third-party sites must use signInWithCsd()." },
  R11: { text: "Could not sign you in. Try again.", tone: "grey", details: "The first-party sign-in verify answered not ok, or no nonce." },
  S9: { text: "Could not load your coins, so nothing was sent. Try again in a moment.", tone: "grey", details: "VERIFY_UNAVAILABLE: the coin list, the source transactions, or proofs for enough coins could not be read from the node." },
  S10: { text: "The server gave wrong details for your coins, so nothing was sent. Try again later.", tone: "red", details: "VERIFY_TAMPER: a coin's source transaction does not match the value the RPC reported." },
  S11: { text: "Some coins can't be used right now and the rest don't cover this. Nothing was sent; Max shows what you can send.", tone: "red", details: "VERIFY_HORIZON, VERIFY_UNREPRESENTABLE or GHOST_INPUTS_SKIPPED: some coins could not be checked and the rest are too few." },
  MR_FEE: { text: "Cairn's server refused this payment: the fee is too low. The backup server has not answered, so it may still go through: check your history.", tone: "amber", details: "SUBMIT_MAYBE_INFLIGHT: the main server refused (fee) and the backup server had not answered in 4 s." },
  MR_BUSY: { text: "Cairn's server refused this payment: the network is busy. The backup server has not answered, so it may still go through: check your history.", tone: "amber", details: "SUBMIT_MAYBE_INFLIGHT: the main server refused (busy) and the backup server had not answered in 4 s." },
  MR_OTHER: { text: "Cairn's server refused this payment. The backup server has not answered, so it may still go through: check your history.", tone: "amber", details: "SUBMIT_MAYBE_INFLIGHT: the main server refused and the backup server had not answered in 4 s." },
} as const satisfies Record<string, Sentence>;
export type SentenceKey = keyof typeof SENTENCES;

// The codes this slice words; any other code keeps the engine's own text until its slice words it.
const BY_CODE: Record<string, SentenceKey> = {
  SUBMIT_DUPLICATE: "R3", USER_REJECTED: "R7", WALLET_LOCKED: "R8", ACCOUNT_CHANGED: "R9", FIRST_PARTY_ONLY: "R10",
  VERIFY_UNAVAILABLE: "S9", VERIFY_TAMPER: "S10", VERIFY_HORIZON: "S11", VERIFY_UNREPRESENTABLE: "S11", GHOST_INPUTS_SKIPPED: "S11",
};
/** The sentence for a result's code and reason (core/submitverdict.ts RefusalReason), or null for a code this slice
 *  does not word. */
export function sentenceKeyOf(r: { code?: unknown; reason?: unknown } | null | undefined): SentenceKey | null {
  const code = String(r?.code ?? ""), reason = typeof r?.reason === "string" ? r.reason : "";
  if (code === "SUBMIT_REJECTED") return reason === "FEE" ? "R4" : reason === "BUSY" ? "R5" : "R6";
  if (code === "SUBMIT_MAYBE_INFLIGHT") return !reason ? "R2" : reason === "FEE" ? "MR_FEE" : reason === "BUSY" ? "MR_BUSY" : "MR_OTHER";
  return BY_CODE[code] ?? null;
}
/** The line, its tone and Details for a key; `code` is added to Details, never a server's text. */
export function sentenceOf(key: SentenceKey, code?: unknown): Sentence {
  const s: Sentence = SENTENCES[key];
  return code ? { ...s, details: `${s.details} (${String(code)})` } : s;
}
