// Block-explorer presets the wallet links to. Navigation-only — opened in a new tab, NEVER fetched — so this
// adds NO CSP / host_permission / fetch surface (the source-host tripwire only covers fetched *_RPC/*_API
// hosts). Default = the Cairn explorer (the indexer UI, hash-routed); the Official CSD explorer (a static MPA
// with a different URL scheme) is the alternative; a user may add a custom explorer (assumed indexer hash
// format). The selection is stored as a preset id ("cairn"|"official") or a custom https base URL.
export const EXPLORER_PRESETS = [
  { id: "cairn", label: "Cairn Explorer", base: "https://cairn-substrate.com/explorer" },
  { id: "official", label: "Official CSD Explorer", base: "https://explorer.computesubstrate.org" },
] as const;
export const DEFAULT_EXPLORER = "cairn";
/** Resolve an explorer setting (preset id | custom https base) + a tx/addr value into a link URL. */
export function explorerLink(setting: string, kind: "tx" | "addr", value: string): string {
  const v = encodeURIComponent(value);
  if (setting === "official") return `https://explorer.computesubstrate.org/${kind === "tx" ? `tx.html?txid=${v}` : `address.html?addr=${v}`}`;
  // "cairn" (default) and any custom base use the indexer explorer's hash route (#/tx/… , #/address/…)
  const base = !setting || setting === "cairn" ? "https://cairn-substrate.com/explorer" : setting.replace(/\/+$/, "");
  return `${base}#/${kind === "tx" ? "tx" : "address"}/${v}`;
}
