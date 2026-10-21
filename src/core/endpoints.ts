// The endpoints the wallet talks to by default and the rules for the ones a user sets. The manifest CSP and
// host_permissions limit what is reachable; build.mjs fails when a hardcoded https host here is missing from them.
export const DEFAULT_RPC = "https://cairn-substrate.com/api/rpc";
export const DEFAULT_API = "https://cairn-substrate.com";
// Public CairnX read API (resolved token/name state). READ-ONLY convenience: balances and
// names shown in the popup come from here, but every record the wallet SIGNS is built
// locally (core/cairnx.ts); a hostile API can at worst show wrong numbers, never change
// what a signature commits to.
export const DEFAULT_TRADE_API = "https://cairn-substrate.com/trade/api";
// SECOND-SOURCE resolver for the NSPV-COMPLETE-1 cross-check (doc 36): clarvis runs its own
// node→indexer→cairnx (0 non-local sockets), so unioning its name-history with the primary's defeats a
// withholding/MITM resolver (an attacker would have to make BOTH hosts withhold the SAME event). It has the
// default primary's operator, so it is not independent of it: that operator, or whoever controls both hosts,
// can make both withhold (SECURITY.md). Fail-soft: if clarvis is unreachable the verify falls back to
// single-source (with caution).
export const CLARVIS_TRADE_API = "https://clarvis.cairn-substrate.com/trade/api";

// L5 (CSP-LOCALHOST / setRpc validation): a custom RPC/API endpoint must be an https:// origin (or a
// loopback http for local dev) with NO embedded credentials; otherwise `setRpc("https://user:pass@evil")`
// or a plain-http remote could exfiltrate via the userinfo or be trivially MITM'd. The wallet still treats
// any custom RPC as UNTRUSTED (TXB-1 verifies values; namespv SPV-verifies names); this just blocks the
// obviously-unsafe URL shapes before they're stored/used.
export function validRpcUrl(u: string): boolean {
  let x: URL;
  try { x = new URL(String(u)); } catch { return false; }
  if (x.username || x.password) return false;                 // reject https://user:pass@host credential leak
  if (x.protocol === "https:") return true;
  if (x.protocol === "http:" && (x.hostname === "127.0.0.1" || x.hostname === "localhost")) return true; // loopback dev only
  return false;
}
export const RPC_URL_ERR = "endpoint must be an https:// URL (or http://localhost for dev), with no embedded credentials";
// The node RPC is the Cairn proxy or a node on this computer: the manifest grants host access to nothing
// else, so a remote RPC could not be reached (remote RPCs are a future option). Ports are free.
export function rpcAllowed(u: string): boolean {
  if (u === DEFAULT_RPC) return true;
  let x: URL;
  try { x = new URL(String(u)); } catch { return false; }
  if (x.username || x.password) return false;
  if (x.protocol === "http:") return x.hostname === "127.0.0.1" || x.hostname === "localhost";
  return x.protocol === "https:" && x.hostname === "localhost";
}
export const RPC_LOCAL_ERR = "RPC must be the Cairn proxy or a node on this computer (http://127.0.0.1:<port> or http://localhost:<port>)";
