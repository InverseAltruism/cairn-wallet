// A server's free text stays off the lines the user reads (copy sheet List 3; test/served-text-off-screen.test.mjs): a
// served value that is shown is first mapped onto a fixed list of the wallet's own words.

const OFFER_STATUS_WORDS: ReadonlySet<string> = new Set(["open", "filled", "cancelled", "expired", "locked", "closed"]);

/** The offer service's `status` as a word the wallet may show: one of the fixed list, else "not open". */
export function offerStatusWord(status: unknown): string {
  return typeof status === "string" && OFFER_STATUS_WORDS.has(status) ? status : "not open";
}
