// State several views read: the endpoints and the account from the last status read, the frozen review snapshots,
// and the generation counters that bind a drawn row or sheet to the account and list it was drawn for.
export let currentRpc = "";
export let currentExplorer = "cairn"; // selected block explorer (preset id or custom base) for activity/address links
export let siteApi = "";   // the Cairn site base (for the /trade deep-link in the names list)
// ── frozen review snapshots (WYSIWYS) ──────────────────────────────────────────────────────────
// ONE owner for every primed value-moving review: `reviewed` (token send; set when the confirm panel
// opens, signed verbatim on Confirm; `name` is the .csd name typed, re-resolved at confirm so it can't
// silently re-point), `reviewedSend` (CSD send; same symmetry: sign exactly what was reviewed), and
// `reviewedNameAct` (name renew / set-primary). The Confirm buttons sign EXACTLY these snapshots,
// never the live inputs. dropReviews() is the single teardown, used by clearSendDrafts (the lock
// boundary), closeAllPanels (any panel switch) and the flow handlers; panels are mutually exclusive
// via openPanel, so dropping all three is always equivalent to dropping the one that was armed.
export const reviewState: {
  reviewed: { to: string; base: string; name?: string | null; verified?: boolean; signer?: string | null } | null;
  reviewedSend: { to: string; amt: number; name?: string | null; verified?: boolean; signer?: string | null } | null;
  reviewedNameAct: { kind: "renew" | "primary"; name: string; total: number; fee: number; signer?: string | null } | null;
} = { reviewed: null, reviewedSend: null, reviewedNameAct: null };
export function dropReviews() { reviewState.reviewed = null; reviewState.reviewedSend = null; reviewState.reviewedNameAct = null; }

export let curAddr = "";

// What a row, a name's detail or a token send acts for. acctGen moves when a switch starts and when render() sees a
// new address; listGen moves on every write of the lists. An action whose binding no longer matches does nothing and
// closes the sheets: a row or a detail drawn for account A must not open a review that account B would sign.
let acctGen = 0, listGen = 0;
export type ViewBind = { acct: number; addr: string; list?: number };
export const bindView = (withList = false): ViewBind => ({ acct: acctGen, addr: curAddr, ...(withList ? { list: listGen } : {}) });
export const viewCurrent = (b: ViewBind | undefined) => !!b && b.acct === acctGen && b.addr === curAddr && (b.list === undefined || b.list === listGen);

export function setEndpoints(st: any) {
  currentRpc = st.rpc || "";
  currentExplorer = st.explorer || "cairn";
  siteApi = st.api || "";
}
export function setCurAddr(addr: string) { curAddr = addr; }
export function nextAccountGen() { acctGen++; listGen++; }
export function nextListGen() { listGen++; }

// The balance the hero shows (the last read for this account, null before one), and who repaints with it: the send
// sheet's estimate reads it instead of a read of its own. Here, in this leaf module, so a view can subscribe while
// the popup's module graph is still loading.
// `stale`: the latest read failed, so `last` is an earlier read.
export const balanceState: { last: number | null; stale: boolean; onChange: (() => void) | null } = { last: null, stale: false, onChange: null };
// The primary names this popup has read, per account (lower-cased address; null: read, and the account has none), so
// the account switcher draws an account with the avatar the header draws for it.
export const knownNames = new Map<string, string | null>();
