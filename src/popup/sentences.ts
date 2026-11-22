// The wallet's sentences on screen, keyed by the copy sheet's tags (cairn docs/Plans/91-evidence/
// wallet-copy-sheet-2026-11-22.md), so a change of wording is a change of this file. The sheet is a draft the owner
// signs; a line enters here when the code that shows it is built. No logic reads a text: the selectors below choose a
// key from a result's code and reason, and test/sentences-copy.test.mjs checks every entry against the copy rule.

export type Tone = "grey" | "amber" | "red";
export type Sentence = { text: string; tone: Tone; details: string };
/** The variable parts a line names, already formatted by the caller: `{amount}` and `{cap}` are "12.5 CSD" style,
 *  `{name}` is "alice.csd", `{pct}` is "" or " 65%". */
export type Vars = { amount?: string; cap?: string; name?: string; pct?: string };

/** [M11] grey, under the balance: the balance was read from Cairn's second server. */
export const M11_BACKUP_SERVER = "Using Cairn's backup server.";

// The results of a send and the coin checks before it (sheet sections 2 and 8). MR_* are not in the sheet's tables;
// the owner approved their words on 2026-11-22: the main server refused and the backup server had not answered
// (core/hosts.ts MAIN_REFUSED_WAIT_MS), so the result is "may be in flight" with what is known first; the sheet's R4
// to R6 say "Nothing was sent", which is not known there.
export const SENTENCES = {
  R1: { text: "Something went wrong, so nothing was sent. Try again, or see Details.", tone: "red", details: "The refusal's own text and code, or the thrown message." },
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
  S2: { text: "This is the zero address: anything sent there is lost. Enter another address.", tone: "red", details: "Recipient is the zero address (popup check; the token builder refuses it too)." },
  S4: { text: "Your confirmed balance doesn't cover this payment and its fee. Nothing was sent.", tone: "red", details: "INSUFFICIENT: verified coins do not cover amount plus fee." },
  S5: { text: "A coin merge of {amount} is still confirming. Try again once it is.", tone: "grey", details: "Added to INSUFFICIENT or TOO_MANY_INPUTS while a consolidation is pending." },
  S8: { text: "This amount needs more coins than one payment can use, so nothing was sent. Send less, or merge coins first.", tone: "red", details: "TOO_MANY_INPUTS: more than the 512-input per-transaction limit." },
  S12: { text: "The fee is above what the wallet allows ({cap} here). Nothing was sent.", tone: "red", details: "FEE_CAP: fee above max(1 CSD, 10% of the inputs)." },
  A3: { text: "{name} has expired, so nothing was sent. Send to the owner's 0x address, or ask them to renew it.", tone: "red", details: "The SPV check proves the lease lapsed." },
  A4: { text: "{name} may have expired; the wallet could not check. If it has, this address belongs to its last owner.", tone: "amber", details: "Served lapsed flag; the SPV check did not settle the lapse." },
  A9: { text: "Not verified. Check the address yourself.", tone: "amber", details: "The address came from the name service and could not be verified against the chain right now." },
  A10: { text: "Bought name: the wallet can only partly verify it. Check the address yourself.", tone: "amber", details: "Ownership set by a fill depends on state outside the name's own history; a name-scoped proof does not cover it." },
  A14: { text: "{name} now points to a different address. Nothing was sent; review it again.", tone: "red", details: "The confirm-time re-resolution returned a different address." },
  A15: { text: "Could not check {name} again. The address is the one you reviewed.", tone: "amber", details: "Confirm-time re-resolution failed on the network, or was verified at review and unverified now at the same address." },
  A16: { text: "Checking {name}...{pct}", tone: "grey", details: "Header sync progress of the name check." },
  A17: { text: "This name could not be checked. Make sure the address is right.", tone: "amber", details: "The SPV check had not finished when the user chose to go on." },
  A18: { text: "New name, only partly verified. Check the address before a large payment.", tone: "amber", details: "Registered after this release's newest table entry; Cairn's 2 servers agree and the wallet has no older record to check them against." },
  A19: { text: "{name} points to a different address than when you last paid it. Continue only if you expected this.", tone: "amber", details: "The address differs from the one in this wallet's last send to the name." },
  Q3: { text: "Could not publish the reveal. Try again later.", tone: "grey", details: "The core's code, or the content API's HTTP status." },
  Q4: { text: "This account has no matching sealed claim. Check you are on the account that sealed it.", tone: "red", details: "SEAL_UNKNOWN: no local seal with that txid in this account." },
  S9: { text: "Could not load your coins, so nothing was sent. Try again in a moment.", tone: "grey", details: "VERIFY_UNAVAILABLE: the coin list, the source transactions, or proofs for enough coins could not be read from the node." },
  S10: { text: "The server gave wrong details for your coins, so nothing was sent. Try again later.", tone: "red", details: "VERIFY_TAMPER: a coin's source transaction does not match the value the RPC reported." },
  S11: { text: "Some coins can't be used right now and the rest don't cover this. Nothing was sent; Max shows what you can send.", tone: "red", details: "VERIFY_HORIZON, VERIFY_UNREPRESENTABLE or GHOST_INPUTS_SKIPPED: some coins could not be checked and the rest are too few." },
  MR_FEE: { text: "Cairn's server refused this payment: the fee is too low. The backup server has not answered, so it may still go through: check your history.", tone: "amber", details: "SUBMIT_MAYBE_INFLIGHT: the main server refused (fee) and the backup server had not answered in 4 s." },
  MR_BUSY: { text: "Cairn's server refused this payment: the network is busy. The backup server has not answered, so it may still go through: check your history.", tone: "amber", details: "SUBMIT_MAYBE_INFLIGHT: the main server refused (busy) and the backup server had not answered in 4 s." },
  MR_OTHER: { text: "Cairn's server refused this payment. The backup server has not answered, so it may still go through: check your history.", tone: "amber", details: "SUBMIT_MAYBE_INFLIGHT: the main server refused and the backup server had not answered in 4 s." },
} as const satisfies Record<string, Sentence>;
export type SentenceKey = keyof typeof SENTENCES;
/** [A19]'s two buttons in a send review: the review's Confirm and Back, relabelled while the line is shown. */
export const REDIRECT_BUTTONS = { confirm: "Send to new address", back: "Cancel" } as const;
/** [A4]'s two buttons, the same way; [A15]'s at Confirm too. */
export const LAPSE_BUTTONS = { confirm: "Send anyway", back: "Cancel" } as const;
/** [A17]'s: Back is "Wait", which goes back to the check still running. */
export const UNCHECKED_BUTTONS = { confirm: "Send anyway", back: "Wait" } as const;
/** [A16]'s button, shown from D12's 10 s while the check runs and the name service has answered. */
export const SKIP_CHECK = "Send without check";
export type ReviewButtons = { readonly confirm: string; readonly back: string };

// The codes worded wherever they appear; any other code keeps the engine's own text in a flow whose lines are not built
// yet (names, merges, posts, seals, fills).
const BY_CODE: Record<string, SentenceKey> = {
  SUBMIT_DUPLICATE: "R3", USER_REJECTED: "R7", WALLET_LOCKED: "R8", ACCOUNT_CHANGED: "R9", FIRST_PARTY_ONLY: "R10",
  VERIFY_UNAVAILABLE: "S9", VERIFY_TAMPER: "S10", VERIFY_HORIZON: "S11", VERIFY_UNREPRESENTABLE: "S11", GHOST_INPUTS_SKIPPED: "S11",
  SEAL_UNKNOWN: "Q4",
};
// A send's refusals (the popup's CSD and token sends, a page's send): its own lines, then R1 for every other refusal.
// INSUFFICIENT is a send's here only: a merge's INSUFFICIENT means the coins are smaller than the fee.
const SEND_CODES: Record<string, SentenceKey> = { INSUFFICIENT: "S4", TOO_MANY_INPUTS: "S8", ZERO_ADDR_REFUSED: "S2", FEE_CAP: "S12" };
/** "send" for a send's result, where every refusal is worded (R1 at the end); "other" for any other flow. */
export type Flow = "send" | "other";
/** The sentence for a result's code and reason (core/submitverdict.ts RefusalReason); null in an "other" flow for a code
 *  not worded yet, and in a "send" flow only for a result that is not a refusal. */
// A code is read only as a string and only as an own key of a table, so a code named like an Object.prototype member
// or one that is not a string takes the default (test/sentences-copy.test.mjs (6)).
const own = (t: Record<string, SentenceKey>, code: string): SentenceKey | null => Object.hasOwn(t, code) ? t[code]! : null;
export function sentenceKeyOf(r: { ok?: unknown; code?: unknown; reason?: unknown; feeCap?: unknown } | null | undefined, flow: Flow = "other"): SentenceKey | null {
  const code = typeof r?.code === "string" ? r.code : "", reason = typeof r?.reason === "string" ? r.reason : "";
  if (code === "SUBMIT_REJECTED") return reason === "FEE" ? "R4" : reason === "BUSY" ? "R5" : "R6";
  if (code === "SUBMIT_MAYBE_INFLIGHT") return !reason ? "R2" : reason === "FEE" ? "MR_FEE" : reason === "BUSY" ? "MR_BUSY" : "MR_OTHER";
  const key = own(BY_CODE, code);
  if (key || flow !== "send" || r?.ok === true) return key;
  // S12 names the cap, so a FEE_CAP without one (none reaches a send) reads as R1
  if (code === "FEE_CAP" && !Number.isSafeInteger(r?.feeCap)) return "R1";
  return own(SEND_CODES, code) ?? "R1";
}
/** The line, its tone and Details for a key, with its variable parts filled; `code` is added to Details when it has a
 *  machine code's shape, never a server's text. */
export function sentenceOf(key: SentenceKey, code?: unknown, vars: Vars = {}): Sentence {
  const s: Sentence = SENTENCES[key];
  const text = s.text.replace(/\{(amount|cap|name|pct)\}/g, (_m, k: keyof Vars) => vars[k] ?? "?");
  return { ...s, text, details: typeof code === "string" && CODE_SHAPE.test(code) ? `${s.details} (${code})` : s.details };
}
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,47}$/;
