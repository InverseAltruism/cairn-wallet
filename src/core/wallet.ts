// The Wallet "brain": holds an encrypted vault of ONE OR MORE accounts in a Store,
// keeps the unlocked accounts only in memory, and exposes the operations the UI /
// dApp provider need. One password unlocks all accounts. Each account has its own
// isolated transaction history and sealed-claim list (keyed by address) so switching
// never leaks one account's activity or secrets into another's view.
// Storage-injected so it runs in the service worker, a dev page, or a test.
import { generate, fromPriv, newMnemonic, deriveAccount, isValidMnemonic, normalizeMnemonic, type Account } from "./account.js";
import { sealNew, sealWith, openWith, deriveVaultKey, exportKeyRaw, importKeyRaw, type Vault } from "./keystore.js";
import type { Store } from "./storage.js";
import * as node from "./node.js";
import { cairnPayloadHash, signSighash } from "./csdtx.js";
import { buildSiwcMessage, siwcDigest, originToDomain, rfc3339, CSD_CHAIN_MAINNET, SIWC_VERSION, type SiwcFields } from "./siwc.js";
import { buildTransfer, buildNameRenew, buildNameSet, nameRegFee, buildFeeHeight, formatUnits, cairnxTradeFee, fillIsSafe, isOpenClaimLane, hasLiveClaim, requiredFillOutputs, verifyFillSpv, bindOfferTerms, FEE_BPS_V16, isPlainName, CAIRNX_DOMAIN, CAIRNX_PROPOSE_FEE, TREASURY_ADDR } from "./cairnx.js";
import type { CxOfferState, FillSpvIo, FillVerdict } from "../vendor/cairnx-spv.js";
import { verifyNameUnion, liveSpvSource, type NameVerification, type SpvSource, type ResolverSource } from "./namespv.js";
import { liveFillSpvSource, provenOfferPayto, type ProvenOfferTerms } from "./fillspv.js";

// F2 (amount leg): does the resolver-served offer's fee/rebate-relevant fields match the MERKLE-PROVEN offer?
// requiredFillOutputs sizes the treasury fee from feeBps (= feeBpsAt(creation height)), the maker rebate from
// height/taker/bid, and the payment from want.value; a lying resolver deflating any of them makes the wallet
// build an under-sized fill that resolve() (using the proven values) rejects AFTER the payment leg moved =
// pay-without-delivery burn (theft if the attacker is the seller). Bind the served fields to the proven ones.
// Plan 70 R2 Option B: delegate to the SINGLE vendored bindOfferTerms verdict (cairnx-core), retiring this
// repo's hand-copy. It binds height/feeBps/value/taker/bid AND the R1.1 `min` presence+value leg exactly as
// before (byte-identical behaviour, differential-locked by the WA-PARITY corpus across all three seams).
function provenTermsMismatch(offer: unknown, t: ProvenOfferTerms): boolean {
  return bindOfferTerms(offer, t);
}
import { randomBytes, bytesToHex } from "@noble/hashes/utils";

export interface PubAcct { addr: string; label: string; imported?: boolean }
export interface WalletStatus { hasVault: boolean; unlocked: boolean; addr: string | null; accounts: PubAcct[]; active: number; rpc: string; api: string; tradeApi: string; explorer: string; hasMnemonic: boolean }

// An in-memory account: its key + label, plus how it was created — `index` is its
// BIP-44 derivation index (HD accounts), `imported` marks a raw-key account that is
// NOT recoverable from the seed phrase.
type Acct = Account & { label: string; index?: number; imported?: boolean };
// Encrypted-vault document (the plaintext sealed under the password). v2 adds the
// HD seed phrase + the next free derivation index; v1 (no mnemonic) still opens.
interface StoredAcct { priv: string; label: string; index?: number; imported?: boolean }
interface VaultDoc { v: 1 | 2; mnemonic?: string; nextIndex?: number; accounts: StoredAcct[]; active: number }

const DEFAULT_RPC = "https://cairn-substrate.com/api/rpc";
const DEFAULT_API = "https://cairn-substrate.com";
// Public CairnX read API (resolved token/name state). READ-ONLY convenience: balances and
// names shown in the popup come from here, but every record the wallet SIGNS is built
// locally (core/cairnx.ts) — a hostile API can at worst show wrong numbers, never change
// what a signature commits to.
const DEFAULT_TRADE_API = "https://cairn-substrate.com/trade/api";
// Independent SECOND-SOURCE resolver for the NSPV-COMPLETE-1 cross-check (doc 36): clarvis runs its own
// node→indexer→cairnx (structurally independent — 0 non-local sockets), so unioning its name-history with
// the primary's defeats a withholding/MITM resolver (an attacker would have to make BOTH hosts withhold the
// SAME event). Fail-soft: if clarvis is unreachable the verify falls back to single-source (with caution).
const CLARVIS_TRADE_API = "https://clarvis.cairn-substrate.com/trade/api";

// The idle window shared by the wallet's auto-lock AND its session-rehydrate expiry, and by the
// background alarm that ENFORCES the lock. Exported so the decoy default here and background's
// AUTO_LOCK_MS can never drift out of one another (they were two independent 15-min literals).
export const AUTO_LOCK_MS = 15 * 60 * 1000; // 15 min

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

// L5 (CSP-LOCALHOST / setRpc validation): a custom RPC/API endpoint must be an https:// origin (or a
// loopback http for local dev) with NO embedded credentials — otherwise `setRpc("https://user:pass@evil")`
// or a plain-http remote could exfiltrate via the userinfo or be trivially MITM'd. The wallet still treats
// any custom RPC as UNTRUSTED (TXB-1 verifies values; namespv SPV-verifies names) — this just blocks the
// obviously-unsafe URL shapes before they're stored/used.
function validRpcUrl(u: string): boolean {
  let x: URL;
  try { x = new URL(String(u)); } catch { return false; }
  if (x.username || x.password) return false;                 // reject https://user:pass@host credential leak
  if (x.protocol === "https:") return true;
  if (x.protocol === "http:" && (x.hostname === "127.0.0.1" || x.hostname === "localhost")) return true; // loopback dev only
  return false;
}
const RPC_URL_ERR = "endpoint must be an https:// URL (or http://localhost for dev), with no embedded credentials";

// Per-account storage namespaces — keep each account's activity + secrets separate.
const histKey = (addr: string) => "txHistory:" + addr;
const sealKey = (addr: string) => "sealedClaims:" + addr;

// The frozen signing context captured before a flow's first await (A1, Plans/68): the account
// slot, its address, its key, and the history key entries must file under. Immutable snapshot —
// a later switchAccount cannot retro-change what was captured.
interface SignerCtx { active: number; addr: string; priv: string; histKey: string }
// Shared refusal for a signer mismatch detected at the sign tick (mirrors the background's
// pre-dispatch M5 guard copy; same machine code, WALLET-ERROR-CODES.md).
const ACCOUNT_CHANGED_REFUSAL = (): node.SubmitResult => ({
  ok: false, sighashMatch: false, code: "ACCOUNT_CHANGED",
  error: "the active account changed since you reviewed this request — reopen it and review again before approving",
});

// Epoch math + record-expiry windows (all in EPOCHS; one epoch = BLOCKS_PER_EPOCH blocks). BLOCKS_PER_EPOCH
// mirrors the vendored cairnx-core EPOCH_LEN (30) — kept as a named local because the wallet .d.ts does not
// yet export it. Each +N offset below sets a Propose's expiresEpoch = currentEpoch + window.
const BLOCKS_PER_EPOCH = 30;
const PROPOSE_EXPIRY_EPOCHS = 720;        // content post / token transfer / sealed claim — ample window to mine
const NAME_RENEW_EXPIRY_EPOCHS = 1000;    // .csd lease renewal propose
const SET_PRIMARY_EXPIRY_EPOCHS = 100000; // set-primary nset — a long-lived identity record
// Attest fee floor (0.05 CSD): the default fee for an atomic offer fill (Attest + payment in one tx).
const ATTEST_FLOOR = 5_000_000;
// Normalize a .csd name for lookup/verify: lowercase and strip a trailing ".csd".
const normName = (name: unknown): string => String(name || "").toLowerCase().replace(/\.csd$/, "");

// The first VALUE field on which two independent resolvers disagree about an offer, or null when they agree
// on every value-bearing field. The fclaim-lane 2nd-source (clarvis) cross-check refuses ONLY on a value
// divergence; availability gaps (a 404 on a brand-new fclaim txid, a timeout) are fail-soft PROCEED, so an
// honest buy is never blocked by clarvis lagging the primary. Display-only fields are deliberately ignored.
const fieldStr = (v: unknown): string => String(v ?? "").toLowerCase();
function divergentValueField(a: any, b: any): string | null {
  const aw = a?.want ?? {}, bw = b?.want ?? {}, ag = a?.give ?? {}, bg = b?.give ?? {};
  if (fieldStr(aw.payto) !== fieldStr(bw.payto)) return "recipient (want.payto)";
  if (fieldStr(aw.value) !== fieldStr(bw.value)) return "price (want.value)";
  if (fieldStr(aw.ticker) !== fieldStr(bw.ticker)) return "price token (want.ticker)";
  if (fieldStr(aw.amount) !== fieldStr(bw.amount)) return "price amount (want.amount)";
  if (fieldStr(ag.ticker) !== fieldStr(bg.ticker)) return "asset (give.ticker)";
  if (fieldStr(ag.amount) !== fieldStr(bg.amount)) return "amount (give.amount)";
  if (fieldStr(ag.name) !== fieldStr(bg.name)) return "asset (give.name)";
  if (fieldStr(a?.feeBps) !== fieldStr(b?.feeBps)) return "fee (feeBps)";
  if (fieldStr(a?.min) !== fieldStr(b?.min)) return "minimum (min)";
  if (fieldStr(a?.status) !== fieldStr(b?.status)) return "status";
  return null;
}

export class Wallet {
  // Unlocked state (memory only): the decrypted accounts, the active index, and the
  // derived AES key (so we can re-seal on changes without retaining the password).
  private accts: Acct[] | null = null;
  private active = 0;
  private vaultKey: CryptoKey | null = null;
  private salt = "";
  private iter = 0;
  // HD state (memory only, while unlocked): the seed phrase + next free derivation
  // index. null mnemonic = a legacy/import-only wallet with no recovery phrase.
  private mnemonic: string | null = null;
  private nextIndex = 0;
  rpc = DEFAULT_RPC;
  api = DEFAULT_API;
  tradeApi = DEFAULT_TRADE_API;
  explorer = DEFAULT_EXPLORER; // selected block explorer (preset id or custom https base) — navigation-only
  // Idle window for both auto-lock AND session-rehydrate expiry; background sets it to AUTO_LOCK_MS.
  idleMs = AUTO_LOCK_MS;
  // `session` is chrome.storage.session (in-RAM) when running as an extension, else null. It lets the
  // unlocked key survive an MV3 service-worker idle-kill so genuine activity within idleMs doesn't
  // keep re-prompting for the password. null ⇒ in-memory-only (the old behaviour).
  constructor(private store: Store, private session: Store | null = null) {}

  // Is `origin` the wallet's OWN first-party site (or a localhost dev origin)? Used to gate the
  // legacy no-arg signIn(), which authenticates against the wallet's CONFIGURED api (`this.api`,
  // default cairn-substrate.com) and returns that server's SESSION TOKEN. If any third-party page
  // could invoke it, an approved "prove your address" prompt would mint+leak a first-party session
  // to that page (confused-deputy → account takeover, finding AUTH-LEGACY-1). Third parties MUST use
  // the audience-bound signInWithCsd() instead, which never touches `this.api` and never mints a
  // session. `origin` is the browser-set, unforgeable sender.origin.
  isFirstPartyOrigin(origin: string): boolean {
    if (!origin || origin === "unknown") return false;
    try {
      const o = new URL(origin), apiO = new URL(this.api);
      if (o.origin === apiO.origin) return true; // exact first-party match (the configured api's origin)
      // Dev convenience: treat localhost as first-party ONLY when the wallet's OWN api is itself localhost
      // (audit NSPV-DAPP-LOCALHOST). In production api=cairn-substrate.com, so ANY localhost app is NOT
      // first-party — it must use the audience-bound signInWithCsd(), closing the broad confused-deputy
      // surface where any local app on any port could invoke the session-minting legacy signIn().
      const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
      return isLocal(o.hostname) && isLocal(apiO.hostname);
    } catch { return false; }
  }

  async init(): Promise<void> {
    this.rpc = (await this.store.get("rpc")) || DEFAULT_RPC;
    this.api = (await this.store.get("api")) || DEFAULT_API;
    this.tradeApi = (await this.store.get("tradeApi")) || DEFAULT_TRADE_API;
    this.explorer = (await this.store.get("explorer")) || DEFAULT_EXPLORER;
    await this.rehydrateSession(); // restore an unlocked session across SW restarts (within idleMs)
  }
  async setRpc(u: string) { if (!validRpcUrl(u)) throw new Error("RPC " + RPC_URL_ERR); this.rpc = u; await this.store.set("rpc", u); }
  async setApi(u: string) { if (!validRpcUrl(u)) throw new Error("API " + RPC_URL_ERR); this.api = u; await this.store.set("api", u); }
  async setTradeApi(u: string) { if (u && !validRpcUrl(u)) throw new Error("trade API " + RPC_URL_ERR); this.tradeApi = u || DEFAULT_TRADE_API; await this.store.set("tradeApi", this.tradeApi); }
  // User-added custom RPC URLs (for the header RPC switcher). Plain config, no secrets.
  async rpcList(): Promise<string[]> { return (await this.store.get("customRpcs")) || []; }
  async addRpc(u: string): Promise<void> { if (!validRpcUrl(u)) throw new Error("RPC " + RPC_URL_ERR); const l = await this.rpcList(); if (!l.includes(u)) { l.push(u); await this.store.set("customRpcs", l.slice(0, 20)); } }
  async removeRpc(u: string): Promise<void> { await this.store.set("customRpcs", (await this.rpcList()).filter((x) => x !== u)); }
  // Block-explorer selection (navigation-only; preset id "cairn"/"official" or a custom https base).
  async setExplorer(v: string): Promise<void> {
    if (v === "cairn" || v === "official") { this.explorer = v; await this.store.set("explorer", v); return; }
    if (!validRpcUrl(v)) throw new Error("explorer must be a preset or an https:// URL (or http://localhost)");
    const norm = new URL(v).href; // canonicalize — encodes any href-breakout chars before it is ever rendered (defense-in-depth vs EXP-XSS)
    this.explorer = norm; await this.store.set("explorer", norm);
  }
  async explorerList(): Promise<string[]> { return (await this.store.get("customExplorers")) || []; }
  async addExplorer(u: string): Promise<void> { if (!validRpcUrl(u)) throw new Error("explorer " + RPC_URL_ERR); const norm = new URL(u).href; const l = await this.explorerList(); if (!l.includes(norm)) { l.push(norm); await this.store.set("customExplorers", l.slice(0, 20)); } }
  async removeExplorer(u: string): Promise<void> { await this.store.set("customExplorers", (await this.explorerList()).filter((x) => x !== u)); }

  async status(): Promise<WalletStatus> {
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    const active = this.accts ? this.active : (((await this.store.get("active")) as number) ?? 0);
    const addr = this.accts ? (this.accts[this.active]?.addr ?? null) : (wallets[active]?.addr ?? null);
    return { hasVault: !!(await this.store.get("vault")), unlocked: !!this.accts, addr, accounts: wallets, active, rpc: this.rpc, api: this.api, tradeApi: this.tradeApi, explorer: this.explorer, hasMnemonic: !!this.mnemonic };
  }

  // Persist the in-memory accounts: re-seal the vault (fresh IV, same salt+key, incl.
  // the HD seed + next index) and mirror the public list (addresses + labels + whether
  // each is an imported non-HD key) in cleartext for the UI.
  // Serialize the in-memory unlocked state into the encrypted-vault plaintext. Single source for the doc
  // shape shared by persistVault (re-seal) and sealFresh (first seal), so the two can't drift.
  private buildDoc(): VaultDoc {
    return {
      v: 2, mnemonic: this.mnemonic ?? undefined, nextIndex: this.nextIndex,
      accounts: (this.accts ?? []).map((a) => ({ priv: a.privkey, label: a.label, index: a.index, imported: a.imported })),
      active: this.active,
    };
  }

  // SERIALIZED (persistVault-race, fund-safety fresh-eyes): account-mgmt ops mutate this.accts
  // SYNCHRONOUSLY, then await persistVault. Without serialization two overlapping calls could each
  // seal a doc built at a different instant and let the STALE write land last — permanently dropping a
  // just-added IMPORTED (non-seed-recoverable) key. Chaining every persist behind one promise makes the
  // last write reflect the final account set (each queued persist re-reads this.accts, which by then
  // holds every prior synchronous mutation). The cleartext mirror is captured from the SAME pre-await
  // snapshot as the sealed doc, so the vault ciphertext and the mirror can never diverge intra-call.
  // Throw-safe: the chain always continues (both settle paths run the next persist; persistChain is
  // reset to an always-resolved promise) and each caller still observes its own rejection.
  private persistChain: Promise<void> = Promise.resolve();
  private persistVault(): Promise<void> {
    const run = this.persistChain.then(() => this.doPersistVault(), () => this.doPersistVault());
    this.persistChain = run.then(() => {}, () => {});
    return run;
  }
  private async doPersistVault(): Promise<void> {
    if (!this.accts || !this.vaultKey) throw new Error("locked");
    const doc = this.buildDoc();
    // capture the cleartext mirror from the SAME synchronous state as `doc`, BEFORE the async seal
    const mirror = this.accts.map((a) => ({ addr: a.addr, label: a.label, imported: a.imported }));
    const active = this.active;
    const vault = await sealWith(JSON.stringify(doc), this.vaultKey, this.salt, this.iter);
    await this.store.set("vault", vault);
    await this.store.set("wallets", mirror);
    await this.store.set("active", active);
  }

  private acct(priv: string, label: string, extra: { index?: number; imported?: boolean } = {}): Acct { return { ...fromPriv(priv), label, ...extra }; }

  // Seal a brand-new vault from an in-memory state already set on `this`.
  private async sealFresh(password: string) {
    const { vault, key } = await sealNew(JSON.stringify(this.buildDoc()), password);
    this.vaultKey = key; this.salt = vault.salt; this.iter = vault.iter;
    await this.persistVault();
    this.touch();
    await this.persistSession(); // a freshly created/restored wallet is unlocked → persist the session
  }

  // ── vault lifecycle ────────────────────────────────────────────────────────
  // New HD wallet: generate a 12-word seed phrase, derive account 0 from it. The
  // phrase is returned ONCE so the UI can show it for backup; it lives encrypted in
  // the vault and is re-shown only via exportMnemonic (password-gated).
  async create(password: string): Promise<{ addr: string; mnemonic: string; privkey: string }> {
    if (await this.store.get("vault")) throw new Error("wallet already exists");
    const mnemonic = newMnemonic();
    const a = { ...deriveAccount(mnemonic, 0), label: "Account 1", index: 0 } as Acct;
    this.mnemonic = mnemonic; this.nextIndex = 1; this.accts = [a]; this.active = 0;
    await this.sealFresh(password);
    // Return the account-0 private key too so the backup screen can show BOTH the
    // recovery phrase and the (portable) private key. Same trusted SW→popup channel
    // as the mnemonic; never crosses the dApp boundary.
    return { addr: a.addr, mnemonic, privkey: a.privkey };
  }
  // Restore an HD wallet from an existing seed phrase (derives account 0).
  async restore(mnemonic: string, password: string): Promise<{ addr: string }> {
    if (await this.store.get("vault")) throw new Error("wallet already exists — reset first to restore");
    if (!isValidMnemonic(mnemonic)) throw new Error("invalid recovery phrase (check the words and order)");
    const m = normalizeMnemonic(mnemonic);
    const a = { ...deriveAccount(m, 0), label: "Account 1", index: 0 } as Acct;
    this.mnemonic = m; this.nextIndex = 1; this.accts = [a]; this.active = 0;
    await this.sealFresh(password);
    return { addr: a.addr };
  }
  // Import a single raw private key (NOT part of any seed phrase → no recovery phrase).
  async importKey(priv: string, password: string): Promise<{ addr: string }> {
    if (await this.store.get("vault")) throw new Error("wallet already exists — reset first to replace the key");
    const a = this.acct(priv, "Account 1", { imported: true }); // fromPriv validates
    this.mnemonic = null; this.nextIndex = 0; this.accts = [a]; this.active = 0;
    await this.sealFresh(password);
    return { addr: a.addr };
  }

  // Brute-force throttle for the password-gated paths (unlock / exportKey / exportMnemonic). PBKDF2-600k
  // already costs ~200ms/guess; this adds an explicit lockout after 5 failures (audit BRUTE-UNLOCK). State
  // lives in the in-RAM session store, so it survives an MV3 SW idle-restart within the session; a full SW
  // teardown resets it, but the KDF cost and the offline-vault-brute threat are unchanged. In a non-extension
  // context (tests / Node) `this.session` is null, so the guard is inert and never gates correct usage.
  private async authGuardCheck(): Promise<void> {
    const g: any = (this.session ? await this.session.get("authGuard").catch(() => null) : null) || {};
    if (typeof g.until === "number" && Date.now() < g.until)
      throw new Error(`too many failed attempts — try again in ${Math.ceil((g.until - Date.now()) / 1000)}s`);
  }
  private async authGuardRecord(ok: boolean): Promise<void> {
    if (!this.session) return;
    if (ok) { await this.session.del("authGuard").catch(() => {}); return; }
    const g: any = (await this.session.get("authGuard").catch(() => null)) || { failed: 0, until: 0 };
    g.failed = (g.failed || 0) + 1;
    if (g.failed >= 5) g.until = Date.now() + Math.min(5 * 60_000, 5_000 * 2 ** (g.failed - 5)); // 5s,10s,20s,… cap 5min
    await this.session.set("authGuard", g).catch(() => {});
  }
  // Run a password check under the brute-force guard: fast-reject if locked out, else count the attempt
  // (success resets, failure increments). One helper used by unlock/exportKey/exportMnemonic so the
  // check-then-count logic lives in exactly one place (no per-call try/catch to drift out of sync).
  private async withAuthGuard<T>(verify: () => Promise<T>): Promise<T> {
    await this.authGuardCheck();
    try { const r = await verify(); await this.authGuardRecord(true); return r; }
    catch (e) { await this.authGuardRecord(false); throw e; }
  }

  // Derive the vault key under the brute-force guard, decrypt the vault, and parse the plaintext. Single
  // opener shared by unlock / exportKey / exportMnemonic. The caller fetches `v` first (each keeps its own
  // "no wallet" message). `raw` is the decrypted plaintext; `parsed` is the v2 multi-account doc (null for a
  // legacy single-key vault whose plaintext IS a raw privkey); `legacyPriv` is that plaintext 0x-normalized
  // (exportKey's legacy repair, kept here so every opener sees the same normalized legacy form). openWith
  // throws "bad password" on a GCM-tag mismatch — INSIDE the guard, so a wrong password is counted.
  private async openVaultDoc(v: Vault, password: string): Promise<{ key: CryptoKey; raw: string; parsed: VaultDoc | null; legacyPriv: string }> {
    const { key, raw } = await this.withAuthGuard(async () => {
      const key = await deriveVaultKey(password, v.salt, v.iter);
      return { key, raw: await openWith(v, key) };
    });
    let parsed: VaultDoc | null = null;
    try { const p = JSON.parse(raw); if (p && Array.isArray(p.accounts)) parsed = p; } catch { /* legacy raw-key vault */ }
    return { key, raw, parsed, legacyPriv: raw.startsWith("0x") ? raw : "0x" + raw };
  }

  async unlock(password: string): Promise<{ addr: string }> {
    const v: Vault | null = await this.store.get("vault");
    if (!v) throw new Error("no wallet — create or import one first");
    const { key, raw } = await this.openVaultDoc(v, password);
    this.vaultKey = key; this.salt = v.salt; this.iter = v.iter;
    await this.applyDoc(raw);
    await this.persistVault();
    this.touch();
    await this.persistSession(); // remember the unlocked key in chrome.storage.session (in-RAM)
    return { addr: this.accts![this.active].addr };
  }

  // Populate the in-memory unlocked state from a decrypted vault doc (multi-account v2 or a legacy
  // raw-key vault). Shared by unlock() and rehydrateSession().
  private async applyDoc(doc: string): Promise<void> {
    let parsed: VaultDoc | null = null;
    try { const p = JSON.parse(doc); if (p && Array.isArray(p.accounts)) parsed = p; } catch { /* legacy */ }
    if (parsed) {
      // A v2 doc with an empty accounts[] (corrupt/forged vault) would otherwise set active=-1 and crash
      // unlock on accts[-1].addr. Reject cleanly (audit KEY-7).
      if (parsed.accounts.length === 0) throw new Error("corrupt vault (no accounts)");
      this.mnemonic = parsed.mnemonic ?? null;
      this.accts = parsed.accounts.map((x) => this.acct(x.priv, x.label || "Account", { index: x.index, imported: x.imported }));
      this.active = Math.min(Math.max(0, parsed.active ?? 0), this.accts.length - 1);
      // next free derivation index = max stored HD index + 1 (covers older v2 vaults
      // written before nextIndex was tracked, and stays correct after removals).
      const maxIdx = this.accts.reduce((m, a) => (a.index != null && !a.imported ? Math.max(m, a.index) : m), -1);
      this.nextIndex = Math.max(parsed.nextIndex ?? 0, maxIdx + 1);
    } else {
      // LEGACY single-key vault (plaintext was a raw privkey, pre-multi-account). No
      // seed phrase exists for it → treat as an imported key. Migrate isolated data.
      const a = this.acct(doc, "Account 1", { imported: true });
      this.mnemonic = null; this.nextIndex = 0; this.accts = [a]; this.active = 0;
      await this.migrateLegacy(a.addr);
    }
  }

  // ── session persistence (survive MV3 service-worker idle-kills without re-prompting) ──
  // Persist the unlocked AES key (raw) + KDF params to chrome.storage.session (in-RAM, extension-
  // only, cleared on browser close). The at-rest vault stays AES-GCM encrypted in local storage; the
  // session only holds the decryption key, and only until lock / idle-expiry / browser close.
  private async persistSession(): Promise<void> {
    if (!this.session || !this.vaultKey) return;
    try {
      const keyRaw = await exportKeyRaw(this.vaultKey);
      await this.session.set("session", { keyRaw, salt: this.salt, iter: this.iter });
      await this.session.set("sessionTs", this.lastActive);
    } catch { /* session unavailable → in-memory-only; SW death will re-prompt (still correct) */ }
  }

  // Re-open the unlocked state after a service-worker restart, IF a session key exists and the last
  // activity is within idleMs. Fail-closed: any error / expiry leaves the wallet locked.
  private async rehydrateSession(): Promise<boolean> {
    if (this.accts || !this.session) return false;
    let s: any, ts: number | null;
    try { s = await this.session.get("session"); ts = await this.session.get("sessionTs"); } catch { return false; }
    if (!s?.keyRaw) return false;
    if (Date.now() - Number(ts ?? 0) > this.idleMs) { await this.clearSession(); return false; }
    const v: Vault | null = await this.store.get("vault");
    if (!v) { await this.clearSession(); return false; }
    try {
      const key = await importKeyRaw(s.keyRaw);
      const doc = await openWith(v, key);            // re-decrypt the at-rest vault with the session key
      this.vaultKey = key; this.salt = v.salt; this.iter = v.iter;
      await this.applyDoc(doc);
      this.lastActive = Number(ts ?? Date.now());
      return true;
    } catch { await this.lock(); return false; }       // bad/forged session → stay locked + clear (await: wipe the key before returning)
  }

  private async clearSession(): Promise<void> {
    if (!this.session) return;
    try { await this.session.del("session"); await this.session.del("sessionTs"); } catch { /* best-effort */ }
  }

  private async migrateLegacy(addr: string) {
    for (const [from, to] of [["txHistory", histKey(addr)], ["sealedClaims", sealKey(addr)]] as const) {
      const old = await this.store.get(from);
      if (old != null) { if ((await this.store.get(to)) == null) await this.store.set(to, old); await this.store.del(from); }
    }
    await this.store.del("addr"); // legacy single-address key
  }

  async lock(): Promise<void> {
    this.accts = null; this.vaultKey = null; this.salt = ""; this.iter = 0; this.mnemonic = null; this.nextIndex = 0;
    await this.clearSession(); // wipe the in-RAM session key BEFORE returning, so "locked" can't race a still-persisted key (audit LOCK-ASYNC)
  }

  // ── account management (require unlocked) ──────────────────────────────────
  private mustUnlocked(): Acct[] { if (!this.accts || !this.vaultKey) throw new Error("locked"); return this.accts; }
  accounts(): PubAcct[] { return (this.accts ?? []).map((a) => ({ addr: a.addr, label: a.label, imported: a.imported })); }

  // Add an account. On an HD wallet, derive the next index from the seed phrase (so it
  // is recoverable from the phrase alone); otherwise fall back to a fresh random key.
  async addAccount(label?: string): Promise<{ addr: string; index: number }> {
    const accts = this.mustUnlocked();
    const a = this.mnemonic
      ? { ...deriveAccount(this.mnemonic, this.nextIndex), label: (label && label.trim()) || `Account ${accts.length + 1}`, index: this.nextIndex } as Acct
      : this.acct(generate().privkey, (label && label.trim()) || `Account ${accts.length + 1}`, { imported: true });
    if (this.mnemonic) this.nextIndex += 1;
    accts.push(a); this.active = accts.length - 1; await this.persistVault();
    return { addr: a.addr, index: this.active };
  }
  async importAccount(priv: string, label?: string): Promise<{ addr: string; index: number }> {
    const accts = this.mustUnlocked();
    const a = this.acct(priv, (label && label.trim()) || `Account ${accts.length + 1}`, { imported: true }); // fromPriv validates; raw key ⇒ not seed-recoverable
    if (accts.some((x) => x.addr.toLowerCase() === a.addr.toLowerCase())) throw new Error("that account is already in this wallet");
    accts.push(a); this.active = accts.length - 1; await this.persistVault();
    return { addr: a.addr, index: this.active };
  }
  async switchAccount(sel: number | string): Promise<{ addr: string }> {
    const accts = this.mustUnlocked();
    const i = typeof sel === "number" ? sel : accts.findIndex((a) => a.addr.toLowerCase() === String(sel).toLowerCase());
    if (i < 0 || i >= accts.length) throw new Error("no such account");
    this.active = i; await this.persistVault();
    return { addr: accts[i].addr };
  }
  async renameAccount(addr: string, label: string): Promise<void> {
    const accts = this.mustUnlocked();
    const a = accts.find((x) => x.addr.toLowerCase() === String(addr).toLowerCase());
    if (!a) throw new Error("no such account");
    a.label = label.trim() || a.label; await this.persistVault();
  }
  async removeAccount(addr: string, password?: string): Promise<void> {
    const accts = this.mustUnlocked();
    if (accts.length <= 1) throw new Error("cannot remove the last account — reset the wallet to start over");
    let i = accts.findIndex((x) => x.addr.toLowerCase() === String(addr).toLowerCase());
    if (i < 0) throw new Error("no such account");
    // A2 (Plans/68 F4): an IMPORTED raw key is NOT derivable from the recovery phrase, so removing it
    // without a backup is PERMANENT fund loss — and it was one click. Imported removal now requires a
    // password re-auth through the same brute-guarded gate as export (openVaultDoc; the decrypted doc
    // is discarded, nothing is revealed). HD accounts stay one-click: they re-derive from the phrase.
    // REMOVE_IMPORTED_REAUTH is a popup-handled sentinel (FEE_CHANGED precedent), not a dApp code —
    // removeAccount is popup-only (never in DAPP_METHODS).
    if (accts[i].imported) {
      if (!password) throw new Error("REMOVE_IMPORTED_REAUTH");
      const v: Vault | null = await this.store.get("vault"); if (!v) throw new Error("no wallet");
      await this.openVaultDoc(v, password); // throws "bad password" (and increments the guard) on failure
      // TOCTOU (fresh-eyes 0.2.57 finding 1): the KDF await above is the ONLY await between findIndex
      // and splice, and a concurrent removal can mutate accts while this call is parked — splicing the
      // pre-await index then removed the WRONG account (the next imported key, silently, history wiped).
      // Re-derive the index after the await; a target already removed by the racing call is done
      // (idempotent), and the last-account floor is re-asserted against the CURRENT list.
      i = accts.findIndex((x) => x.addr.toLowerCase() === String(addr).toLowerCase());
      if (i < 0) return;
      if (accts.length <= 1) throw new Error("cannot remove the last account — reset the wallet to start over");
    }
    const gone = accts[i].addr;
    accts.splice(i, 1);
    if (this.active >= accts.length) this.active = accts.length - 1;
    else if (this.active > i) this.active -= 1;
    // wipe the removed account's isolated data so it can't resurface.
    await this.store.del(histKey(gone)); await this.store.del(sealKey(gone));
    await this.persistVault();
  }

  private must(): Acct { if (!this.accts) throw new Error("locked"); return this.accts[this.active]; }
  private addr(): string { return this.must().addr; }

  // ── signing-context integrity (A1, Plans/68 FILL-RACE-1) ─────────────────────────────────────
  // Every signing method captures its key SYNCHRONOUSLY at entry — except fillOffer, whose
  // preflight awaits (offer fetch + tip) sit between validation and the key read, so a
  // switchAccount parked in those awaits made the preflight validate account A while account B
  // signed and paid (pay-without-delivery on a taker-bound offer; whole-payment loss on the
  // open-CSD lane). captureSigner freezes the reviewed signer BEFORE the first await;
  // signerUnchanged re-asserts it at the sign tick. Refusal-only: it can never widen what signs.
  private captureSigner(): SignerCtx {
    const a = this.must();
    return { active: this.active, addr: a.addr, priv: a.privkey, histKey: histKey(a.addr) };
  }
  private signerUnchanged(ctx: SignerCtx): boolean {
    const a = this.accts?.[ctx.active];
    return this.active === ctx.active && !!a && a.addr.toLowerCase() === ctx.addr.toLowerCase();
  }
  // The expectSigner backstop (same WYSIWYS class): a caller that DISPLAYED a signer passes it in;
  // a mismatch at the sign tick refuses instead of silently signing with the now-active account.
  // Optional everywhere so no internal caller regresses. Returns the shared refusal, or null.
  private expectSignerRefusal(expectSigner: string | undefined, actual: string): node.SubmitResult | null {
    if (expectSigner && expectSigner.toLowerCase() !== actual.toLowerCase()) return ACCOUNT_CHANGED_REFUSAL();
    return null;
  }
  // Throwing variant for the name/token methods that surface refusals as thrown errors (FEE_CHANGED
  // precedent) rather than a structured SubmitResult — same guard, single source for the copy.
  private throwOnSignerChange(expectSigner: string | undefined): void {
    if (expectSigner && expectSigner.toLowerCase() !== this.addr().toLowerCase()) throw new Error(ACCOUNT_CHANGED_REFUSAL().error);
  }

  // Timed GET against the CairnX read API. RETURNS the Response and NEVER throws on a non-2xx — every caller
  // discriminates status / parses / catches itself, so each keeps its own fail-soft (display reads) vs
  // fail-closed (fillOffer/resolveName money paths) posture exactly. A network error / timeout abort throws
  // out of fetch → the caller's own try/catch handles it. The 12s default sits ABOVE the /trade/api
  // proxy's 10s upstream wait (CAIRN_PROXY_TIMEOUT_MS) — the old 6s default aborted while the proxy
  // was still legitimately waiting on a slow-but-working resolver, turning a survivable stall into a
  // spurious fail-closed refusal on the fill/resolve money paths (timeout-inversion class, Plans/66 B1).
  private tradeGet(path: string, timeoutMs = 12000): Promise<Response> {
    return fetch(this.tradeApi + path, { signal: AbortSignal.timeout(timeoutMs) });
  }

  // Summarize payment outputs for a history entry: total value + a single-recipient addr or "N recipients".
  private summarizeOutputs(outs: { to: string; value: number }[]): { total: number; to: string } {
    const total = outs.reduce((a, o) => a + Number(o.value || 0), 0);
    return { total, to: outs.length === 1 ? outs[0]!.to : `${outs.length} recipients` };
  }

  balance() { return node.balance(this.rpc, this.addr()); }
  // Current epoch (= floor(tip/30), matching this wallet's own propose math) — lets the approval
  // window show a dApp-supplied expiresEpoch as a real "expires in N days from now". Best-effort:
  // returns null offline so the clear-signer just shows the raw epoch.
  async epoch(): Promise<number | null> { try { return Math.floor((await node.tip(this.rpc)) / BLOCKS_PER_EPOCH); } catch { return null; } }
  // CLEARSIGN-FEE-1: exact tip for the clear-sign fee-sufficiency check on a dApp-built name registration/
  // renewal (epoch*30 is too coarse near a fee-gate boundary). Best-effort; null when offline.
  async tip(): Promise<number | null> { try { return await node.tip(this.rpc); } catch { return null; } }
  async propose(p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; outputs?: { to: string; value: number }[] }) { const hk = this.histKeyNow(); const r = await node.propose(this.rpc, p, this.must().privkey); await this.maybeRecord(hk, r, { type: "propose", domain: p.domain, fee: p.fee }); return r; }
  async attest(p: { proposalId: string; score: number; confidence: number; fee: number }) { const hk = this.histKeyNow(); const r = await node.attest(this.rpc, p, this.must().privkey); await this.maybeRecord(hk, r, { type: "support", target: p.proposalId, fee: p.fee }); return r; }
  // Atomic fill (Attest + payment in ONE tx — CairnX delivery-versus-payment). fee default 0.05 CSD (attest floor).
  // A1 (Plans/68 FILL-RACE-1): the ONLY signing method with awaits between validation and the key read.
  // Ordering is load-bearing: capture the signer BEFORE the preflight await (so the account the preflight
  // validates IS the account that signs), re-assert it AFTER the last await and immediately before the
  // sign, and sign/record with the CAPTURED key/histKey — a switchAccount parked in the preflight's offer
  // or tip await now refuses (ACCOUNT_CHANGED) instead of paying from the wrong account.
  async fillOffer(p: { proposalId: string; score?: number; confidence?: number; outputs: { to: string; value: number }[]; fee?: number; expectSigner?: string }) {
    const ctx = this.captureSigner();
    const early = this.expectSignerRefusal(p.expectSigner, ctx.addr);
    if (early) return early;
    const q = { proposalId: p.proposalId, score: (p.score ?? 100) >>> 0, confidence: (p.confidence ?? 100) >>> 0, outputs: p.outputs, fee: p.fee ?? ATTEST_FLOOR };
    const refusal = await this.fillOfferPreflight(q.proposalId, q.outputs, ctx.addr);
    if (refusal) return refusal;
    if (!this.signerUnchanged(ctx)) return ACCOUNT_CHANGED_REFUSAL();
    const r = await node.fillOffer(this.rpc, q, ctx.priv);
    const { total, to } = this.summarizeOutputs(Array.isArray(q.outputs) ? q.outputs : []);
    await this.maybeRecord(ctx.histKey, r, { type: "fillOffer", target: q.proposalId, to, amount: total, fee: q.fee });
    return r;
  }

  // ── fund-safety pre-flight (deep-review 2026-07-03 C2/C3/C4): the wallet's own fillOffer must NEVER sign a
  // payment tx the resolver will reject AFTER the CSD moves (no escrow → the payment is lost). Re-fetch the
  // CURRENT offer record and run the shared cairnx-core pre-flight over it. The check is computed from the
  // offer's OWN give/want/min/claim fields (not a resolver boolean), so even a hostile resolver cannot induce
  // a loss by lying about status. Returns a refusal SubmitResult, or null to PROCEED. Posture (since B1,
  // Plans/68): fail CLOSED unless the resolver POSITIVELY answers with a parseable open offer.
  //   • a clean 404 OR a status-less/garbled 200 → OFFER_UNKNOWN (retryable): filling a proposal the
  //     resolver will not settle burns the whole payment, so "no data" is never treated as "safe".
  //   • a 5xx / timeout → VERIFY_UNAVAILABLE (retryable).
  //   • a parsed open offer runs the shared cairnx-core preflight (fillIsSafe + the requiredFillOutputs
  //     need-map) and proceeds only if every leg holds. Honest cost: one retry on a brand-new offer
  //     inside the resolver's ~15s scan window. A coherently-lying resolver is the B3 fill-SPV item.
  // `me` is the CAPTURED signer address from fillOffer's SignerCtx (A1) — never read live here, so the
  // account this preflight validates is by construction the account whose key signs.
  private async fillOfferPreflight(proposalId: string, outputs: { to: string; value: number }[], me: string): Promise<node.SubmitResult | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(proposalId))) return null; // not a well-formed id → the node guard handles it
    let offer: CxOfferState | null = null;
    let fetchFailed = false;
    try {
      const r0 = await this.tradeGet(`/cairnx/offer/${encodeURIComponent(proposalId)}`); // 12s (tradeGet default): recipient path fails clean
      if (r0.ok) offer = (await r0.json().catch(() => null)) as any;
      else if (r0.status !== 404) fetchFailed = true;   // 5xx/garbled ≠ a definitive "gone"
    } catch { fetchFailed = true; }
    if (offer && typeof offer.status === "string") {
      if (offer.status !== "open") return { ok: false, error: `offer is ${offer.status} — refusing to pay into a no-op fill (review again)`, sighashMatch: false, code: "FILL_UNSAFE" };
      // Exact per-recipient output sums, BigInt end-to-end (money never rides Number arithmetic here).
      // A non-integer or ≤0 value can never build a valid tx, so refuse with the structured error shape
      // instead of letting BigInt() throw raw out of the preflight.
      const sums = new Map<string, bigint>();
      for (const o of outputs ?? []) {
        if (typeof o.value !== "number" || !Number.isSafeInteger(o.value) || o.value <= 0)
          return { ok: false, error: "each output value must be a positive integer amount in base units — refusing to sign", sighashMatch: false, code: "BAD_OUTPUTS" };
        const k = String(o.to).toLowerCase();
        sums.set(k, (sums.get(k) ?? 0n) + BigInt(o.value));
      }
      // the seller payment is the output sum going to want.payto (what previewFill/fillIsSafe price against)
      const payto = String((offer.want as any)?.payto || "").toLowerCase();
      const pay = sums.get(payto) ?? 0n;
      const isCsdWant = !("ticker" in ((offer.want as any) ?? {}));
      // ── V28 open-lane (fclaim) STRUCTURAL routing to the grant-replay SPV boundary ─────────────────────
      // The fill ATTESTS the fclaim txid, NEVER the offer id, so `proposalId !== offer.id` STRUCTURALLY IS a
      // fclaim-lane fill and MUST clear the SPV boundary (verifyFillSpv). Crucially this does NOT trust the
      // resolver-echoed `fclaimId`: a hostile primary that WITHHOLDS or alters fclaimId (while still echoing the
      // linked offer id) would otherwise steer the fill into the resolver-trusted LEGACY lane and burn a denied
      // fclaim. It is also tip-INDEPENDENT so a deflated node tip cannot steer the lane: below V28 every legit
      // fill targets `offer.id` (this never mis-fires on an honest fill), and a below-V28 fill mis-served with
      // `proposalId !== offer.id` fails CLOSED in verifyFillSpv (no fclaim exists below the gate).
      // fclaimLanePreflight already fails closed on any unprovable/fabricated fclaim (it must be merkle-proven in
      // the scan AND reference this offer). This makes the mandatory grant replay actually mandatory at V28.
      if (String(proposalId).toLowerCase() !== String(offer.id ?? "").toLowerCase())
        return await this.fclaimLanePreflight(offer, proposalId, me, sums, payto, pay);
      // The open-CSD lane (untaken + CSD-priced) is the whole-payment-loss lane, and its claim gate NEEDS
      // a live tip. this.tip() yields null on RPC failure (→ 0) and a degenerate 200-without-height reads
      // as 0. But the disarm is NOT just tip==0: fillIsSafe only runs the claim check when
      // isOpenClaimLane(offer, tip) is true, which requires tip >= V13_HEIGHT — so ANY reported tip in
      // (0, V13_HEIGHT) (a grossly-stale or hostile RPC) silently SKIPS the claim gate and would let a
      // non-claimant's open-CSD fill through, while the real chain (tip ~47k) no-ops it and the whole
      // payment is lost (C2/C4). So: for this lane, if the claim gate is NOT active at the reported tip
      // (isOpenClaimLane false — which, given taker===undefined && CSD want, can only be a too-low tip),
      // fail CLOSED with the retryable posture. Red-team 2026-07-06 hardened the guard from `!(tip > 0)`
      // to cover the full (0, V13) band. Taker-bound / token lanes never consult the tip (unaffected).
      const tip = (await this.tip()) ?? 0;
      // Correction 1 (RT3) mirror: reaching here means `proposalId === offer.id` (the fclaim lane already
      // returned above). An offer-id fill DURING a live fclaim hold burns — the V28 resolver routes fills to the
      // fclaim, so an offer-id attest mines with NO delivery, and fillIsSafe/hasLiveClaim PASS for the holder.
      // `claimTxid` is set only at V28, so this is V28-scoped WITHOUT a deflatable tip gate; a deflated tip only
      // makes hasLiveClaim MORE likely true (fires -> refuse), so it fails safe. A pre-V28 hold honored in the
      // sunset has claimTxid undefined -> legacy path (correct, no false-refuse).
      if (offer.claimTxid !== undefined && hasLiveClaim(offer, me, tip))
        return { ok: false, error: "this offer has a live reservation — fill its reservation (fclaim) target, not the offer id; paying the offer id now would be rejected on-chain and the funds lost", sighashMatch: false, code: "FILL_WRONG_TARGET" };
      if (offer.taker === undefined && isCsdWant && !isOpenClaimLane(offer, tip))
        return { ok: false, error: "couldn't fetch the chain tip to verify your claim on this open offer — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
      const verdict = fillIsSafe(offer, me, pay, tip);
      if (!verdict.safe) return { ok: false, error: `refusing to sign — ${verdict.reason}`, sighashMatch: false, code: "FILL_UNSAFE" };
      // The resolver's value gate is a per-address SUM need-map (whole fill: payto ≥ want, TREASURY ≥
      // fee, seller ≥ rebate, SUMMED when recipients coincide; partial: clamped pay + fee). A fill that
      // underpays any leg is rejected on-chain AFTER the payment moved (the pay-without-delivery burn
      // class). The map itself is the VENDORED requiredFillOutputs (cairnx-core 0.1.35) — the same
      // resolver-locked function the cairnx service and the trade UI size fills with; until 2026-07-06
      // this block hand-mirrored it. Pure local math over data already in hand — no added I/O.
      if (isCsdWant) {
        // F2-legacy: this SPV-less LEGACY / dApp lane (window.cairn.fillOffer, no swapguard in the loop) sizes the
        // payment against the resolver-served want.payto and the rebate against the served seller, so a lying read-
        // path redirects the payment (theft) or mis-sizes the rebate so resolve() rejects the fill (burn). Bind both
        // to the MERKLE-PROVEN offer author (prevout-owner, txid-committed). Fail CLOSED-RETRYABLE on an unprovable /
        // transient read (never a hard decline on an honest fill), FILL_UNSAFE on a proven mismatch. Honest offers
        // default payto/seller to the author, so no honest fill declines. // MUTATE_LEGACY_PAYTO_GUARD
        const proven = await this.makeProvenOfferPayto(String(offer.id).toLowerCase(), Number(offer.height));
        if (!proven || !/^0x[0-9a-f]{40}$/.test(proven.payto) || !/^0x[0-9a-f]{40}$/.test(proven.seller))
          return { ok: false, error: "couldn't prove this offer's on-chain payment recipient yet; try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
        // WANT-TYPE bind (mirrors the fclaim lane's isTokenWant rejection in verifyFillSpv): the MERKLE-PROVEN
        // offer must actually be CSD-priced to take this CSD-fill branch. A token-priced offer carries no
        // want.value, so provenOfferPayto leaves terms.value undefined and bindOfferTerms skips the value leg;
        // without this a lying resolver could serve a token-priced offer as CSD-priced (drop want.ticker, add a
        // fake want.value) and the wallet would sign a CSD payment that resolve() rejects (no delivery) =
        // pay-without-delivery burn/theft. A genuine CSD offer always carries want.value, so no honest fill declines.
        if (proven.terms.value === undefined)
          return { ok: false, error: "refusing to sign: the on-chain offer is not CSD-priced (a lying resolver may be presenting a token-priced offer as a CSD sale)", sighashMatch: false, code: "FILL_UNSAFE" };
        if (payto !== proven.payto || String((offer as { seller?: string }).seller ?? "").toLowerCase() !== proven.seller)
          return { ok: false, error: "refusing to sign: the seller payment recipient does not match the offer's on-chain author (a lying resolver may be redirecting your payment)", sighashMatch: false, code: "FILL_UNSAFE" };
        // F2 (amount leg): bind the fee/rebate/value fields to the merkle-proven offer (same as the fclaim lane).
        if (provenTermsMismatch(offer, proven.terms))
          return { ok: false, error: "refusing to sign: the offer's fee/rebate terms do not match its on-chain record (a lying resolver could under-size the fee, and the chain would reject the fill after your payment moved)", sighashMatch: false, code: "FILL_UNSAFE" };
        const need = requiredFillOutputs(offer, pay);
        if (need === null)
          return { ok: false, error: "refusing to sign — this payment would not be accepted by the resolver (undeliverable fill)", sighashMatch: false, code: "FILL_UNSAFE" };
        for (const { to, value } of need) if ((sums.get(to) ?? 0n) < value) {
          const what = to === TREASURY_ADDR.toLowerCase() ? "protocol fee output" : to === payto ? "seller payment" : "maker rebate output";
          return { ok: false, error: `refusing to sign — the ${what} is missing or underpaid; the chain would take your payment and reject the fill. Rebuild the fill with the quoted fee/rebate outputs.`, sighashMatch: false, code: "FILL_UNSAFE" };
        }
      }
    } else if (fetchFailed) {
      // GENUINE unreachability (5xx / timeout — NOT a 404). We cannot tell the lane without the offer, and
      // an open-CSD claim-lane fill by a non-claimant loses the WHOLE payment (C2/C4), so fail closed here.
      return { ok: false, error: "couldn't confirm this offer is still fillable by you (resolver unreachable) — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
    } else {
      // B1 (Plans/68 M-MKT-5 + N-1; the Plan 63 B2 flip, operator-approved): fail CLOSED unless the
      // resolver POSITIVELY answered with a parseable CairnX offer. A clean 404 (a valid, unexpired L1
      // proposal that is NOT an open CairnX offer — a board post, or a record resolve() rejected) and a
      // 200 whose body lacks a parseable status (MITM / garbling proxy) both used to PROCEED here; the
      // wallet signed Attest+payment, L1 moved the CSD, and resolve() ignored the attest — the whole
      // payment burned to attacker-directed outputs. Honest cost: a brand-new offer inside the
      // resolver's ~15s scan poll refuses ONCE with retryable copy. This closes the honest-resolver and
      // MITM hole; a coherently LYING resolver is the B3 proof-bound fill-SPV item, not this guard.
      return { ok: false, error: "this offer is not known to your resolver yet — retry in a few seconds (a brand-new offer appears after the resolver's next scan)", sighashMatch: false, code: "OFFER_UNKNOWN" };
    }
    // a positively-parsed OPEN offer that cleared every check above → proceed to sign
    return null;
  }

  // ── V28 open-lane (fclaim) fill fund boundary ───────────────────────────────────────────────────────
  // A resolver-DENIED fclaim is an L0-valid but delivery-less attest target, so a fill built on it BURNS the
  // whole payment. This is a faithful resolve() mirror the STRONG way: it re-derives the ENTIRE grant + hold
  // from PoW-buried, merkle-proven events (the vendored verifyFillSpv) and fails CLOSED on anything unproven —
  // it only ever REJECTS MORE than resolve(), never accepts something resolve() would reject.
  private async fclaimLanePreflight(offer: any, fclaimTxid: string, me: string, sums: Map<string, bigint>, payto: string, pay: bigint): Promise<node.SubmitResult | null> {
    const offerId = String(offer?.id ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(offerId))
      return { ok: false, error: "refusing to sign — the resolver did not link this reservation to a well-formed offer", sighashMatch: false, code: "FILL_UNSAFE" };
    // 2nd-source (clarvis) VALUE cross-check. Fail-soft: a 404 (clarvis has not indexed this brand-new fclaim
    // txid yet), an unreachable host, or a timeout PROCEEDS; ONLY a value-field divergence refuses.
    const divergence = await this.clarvisFclaimDivergence(fclaimTxid, offer);
    if (divergence) return divergence;
    // Build the fail-closed SPV seam (PoW-verified tip + merkle-proven offer/fclaim/hold events + the computed
    // cross-offer hold count). Any unverifiable read throws → refuse retryably (never proceed on an unproven grant).
    let io: FillSpvIo & { myLiveHoldsAtGrant?: number; provenPayto?: string; provenSeller?: string; provenTerms?: ProvenOfferTerms };
    try {
      io = await this.makeFillSpvIo(offerId, fclaimTxid, me, Number(offer?.height));
    } catch {
      return { ok: false, error: "couldn't verify this reservation against the chain yet (SPV source unavailable) — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
    }
    // myLiveHoldsAtGrant is COMPUTED by the SPV source: a CONSERVATIVE OVER-count of my OTHER-offer fclaim holds
    // live at this fclaim's grant height, from the same PoW-verified [fclaimHeight - MAX_SCAN, tip] scan. It is
    // the cap defense: the lane-scoped replay cannot see other-offer holds, so an under-count would fail-OPEN the
    // cross-offer MAX_ACTIVE_CLAIMS cap and BURN (a resolver that D2-aliases a cap-denied fclaim as "granted"
    // would pass). Over-count only false-refuses (retryable). There is NO wallet create-side cap guard, and 0 is
    // NEVER assumed — if the source could not compute the count, fail CLOSED here. The DEADLINE guard likewise
    // rides INSIDE verifyFillSpv from the fclaim's OWN confirmed expiry epoch (fclaimHoldEnd), never epochOf(tip+45).
    if (!Number.isInteger(io.myLiveHoldsAtGrant))
      return { ok: false, error: "couldn't count your other open reservations to verify this one against the claim cap — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
    let verdict: FillVerdict;
    try {
      verdict = await verifyFillSpv(offerId, fclaimTxid, me, io, { myLiveHoldsAtGrant: io.myLiveHoldsAtGrant as number, pay });
    } catch {
      return { ok: false, error: "couldn't verify this reservation against the chain yet — try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
    }
    if (!verdict.safe) return { ok: false, error: `refusing to sign — ${verdict.reason}`, sighashMatch: false, code: "FILL_UNSAFE" }; // MUTATE_FCLAIM_GUARD
    // F2: bind the PAYMENT recipients to the MERKLE-PROVEN offer author. verifyFillSpv proves DELIVERY (the give)
    // but not payment: requiredFillOutputs sizes the seller-payment leg to the resolver-served offer.want.payto
    // and the rebate leg to the resolver-served offer.seller. A lying read-path swaps want.payto so the buyer
    // pays an attacker while resolve() rejects the zero-recipient fill (theft), or swaps offer.seller so the
    // rebate mis-sizes and resolve() rejects the fill (burn). The SPV source already re-derived both from the
    // proven offer event. Fail CLOSED-retryable if unprovable, FILL_UNSAFE on a proven mismatch. An honest
    // offer's payto/seller default to the author, so no honest fill is ever declined. // MUTATE_PAYTO_GUARD
    const provenPayto = String((io as { provenPayto?: string }).provenPayto ?? "").toLowerCase();
    const provenSeller = String((io as { provenSeller?: string }).provenSeller ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(provenPayto) || !/^0x[0-9a-f]{40}$/.test(provenSeller))
      return { ok: false, error: "couldn't prove this offer's on-chain payment recipient yet; try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
    if (payto !== provenPayto || String(offer?.seller ?? "").toLowerCase() !== provenSeller)
      return { ok: false, error: "refusing to sign: the seller payment recipient does not match the offer's on-chain author (a lying resolver may be redirecting your payment)", sighashMatch: false, code: "FILL_UNSAFE" };
    // F2 (amount leg): bind the fee/rebate/value fields to the merkle-proven offer so a deflated feeBps/height/
    // value/taker cannot under-size a leg (which resolve() would reject AFTER payment = pay-without-delivery burn).
    const terms = (io as { provenTerms?: ProvenOfferTerms }).provenTerms;
    if (!terms)
      return { ok: false, error: "couldn't prove this offer's on-chain fee terms yet; try again in a moment", sighashMatch: false, code: "VERIFY_UNAVAILABLE" };
    if (provenTermsMismatch(offer, terms))
      return { ok: false, error: "refusing to sign: the offer's fee/rebate terms do not match its on-chain record (a lying resolver could under-size the fee, and the chain would reject the fill after your payment moved)", sighashMatch: false, code: "FILL_UNSAFE" };
    // verifyFillSpv proves delivery >= 1 on the offer terms; the wallet ALSO pins its OWN outputs to the exact
    // resolver need-map (payto >= want, treasury >= fee, seller >= rebate), identical to the legacy lane.
    const need = requiredFillOutputs(offer, pay);
    if (need === null)
      return { ok: false, error: "refusing to sign — this payment would not be accepted by the resolver (undeliverable fill)", sighashMatch: false, code: "FILL_UNSAFE" };
    for (const { to, value } of need) if ((sums.get(to) ?? 0n) < value) {
      const what = to === TREASURY_ADDR.toLowerCase() ? "protocol fee output" : to === payto ? "seller payment" : "maker rebate output";
      return { ok: false, error: `refusing to sign — the ${what} is missing or underpaid; the chain would take your payment and reject the fill. Rebuild the fill with the quoted fee/rebate outputs.`, sighashMatch: false, code: "FILL_UNSAFE" };
    }
    return null;
  }

  // Optional 2nd-source (clarvis) value cross-check for an fclaim-lane fill. Returns a refusal ONLY on a
  // value-field divergence; a clarvis 404 on the fclaim txid (not yet indexed / no D2 alias there), an
  // unreachable host, a timeout, or an unparseable body are all fail-soft PROCEED (availability, not a value
  // conflict) — the honest buy must never decline because the 2nd source lags. (B6-scoped to the fclaim lane;
  // the A2 track generalizes the 2-source offer cross-check to the legacy lane.)
  private async clarvisFclaimDivergence(fclaimTxid: string, primary: any): Promise<node.SubmitResult | null> {
    let c: any = null;
    try {
      const r = await fetch(`${CLARVIS_TRADE_API}/cairnx/offer/${encodeURIComponent(fclaimTxid)}`, { signal: AbortSignal.timeout(12000) });
      if (r.status === 404 || !r.ok) return null;  // brand-new/not-indexed, or unreachable/5xx → PROCEED
      c = await r.json().catch(() => null);
    } catch { return null; }                        // timeout / network → PROCEED
    if (!c || typeof c !== "object") return null;   // unparseable 2nd source → single-source PROCEED
    if (!c.want && !c.give) return null;            // reachable clarvis with NO comparable offer terms (error/degraded/aliased body) → single-source PROCEED, never a false value conflict (keeps clarvis a strictly-OPTIONAL 2nd source)
    const field = divergentValueField(primary, c);
    if (field) return { ok: false, error: `your two independent resolvers disagree on this offer's ${field} — refusing to sign until they agree (possible hostile source)`, sighashMatch: false, code: "SOURCE_DIVERGENCE" };
    return null;
  }

  // Test seam (fill-SPV fund boundary): production leaves this undefined and builds the LIVE PoW-verified
  // FillSpvIo; tests inject a synthetic (PoW/merkle pre-satisfied) io so the vendored verifyFillSpv boundary
  // is exercised through the real preflight without a chain. The io carries the computed cap over-count.
  fillSpvIoForTest?: (offerId: string, fclaimTxid: string, me: string) => (FillSpvIo & { myLiveHoldsAtGrant?: number; provenPayto?: string; provenSeller?: string; provenTerms?: ProvenOfferTerms }) | Promise<FillSpvIo & { myLiveHoldsAtGrant?: number; provenPayto?: string; provenSeller?: string; provenTerms?: ProvenOfferTerms }>;
  private async makeFillSpvIo(offerId: string, fclaimTxid: string, me: string, offerHeight: number): Promise<FillSpvIo & { myLiveHoldsAtGrant?: number; provenPayto?: string; provenSeller?: string; provenTerms?: ProvenOfferTerms }> {
    if (this.fillSpvIoForTest) return await this.fillSpvIoForTest(offerId, fclaimTxid, me);
    return await liveFillSpvSource({
      rpcBase: this.rpc, headersBase: this.api,
      cache: { get: () => this.store.get("spvHeaderChain"), set: (s) => this.store.set("spvHeaderChain", s) },
      floor: { get: async () => Number(await this.store.get("spvNodeTipFloor")) || 0, set: (v) => this.store.set("spvNodeTipFloor", v) },
      hints: { offerId, fclaimTxid, me, offerHeight },
    });
  }

  // Test seam (F2-legacy payment-recipient bind): production leaves this undefined and merkle-proves the offer
  // author over the LIVE light client; tests inject the proven { payto, seller } (or null to exercise the
  // fail-closed-retryable path) so the legacy-lane bind is exercised without a chain.
  provenPaytoForTest?: (offerId: string, offerHeight: number) => ({ payto: string; seller: string; terms: ProvenOfferTerms } | null) | Promise<{ payto: string; seller: string; terms: ProvenOfferTerms } | null>;
  private async makeProvenOfferPayto(offerId: string, offerHeight: number): Promise<{ payto: string; seller: string; terms: ProvenOfferTerms } | null> {
    if (this.provenPaytoForTest) return await this.provenPaytoForTest(offerId, offerHeight);
    return await provenOfferPayto({
      rpcBase: this.rpc, headersBase: this.api,
      cache: { get: () => this.store.get("spvHeaderChain"), set: (s) => this.store.set("spvHeaderChain", s) },
      floor: { get: async () => Number(await this.store.get("spvNodeTipFloor")) || 0, set: (v) => this.store.set("spvNodeTipFloor", v) },
      offerId, offerHeight,
    });
  }

  signIn() { return node.signIn(this.api, this.must().privkey); }

  // Audience-bound "Sign in with CSD" (SIWC) for THIRD-PARTY sites — the secure replacement for the
  // legacy first-party-only signIn(). The wallet builds a CAIP-122-style message binding the
  // requesting site's domain (derived from the UNFORGEABLE sender.origin, NEVER a dApp-asserted
  // string), the RP's single-use nonce, the chain id, and an issued-at/expiration window; signs the
  // domain-separated SIWC digest; and returns ONLY the signed artifact. It NEVER talks to cairn's
  // /auth and NEVER mints a session — the dApp's own server verifies (verifySiwc) and issues its own
  // session. `origin` is supplied by the background from sender.origin (browser-set, unforgeable).
  async signInWithCsd(
    params: { nonce?: unknown; statement?: unknown; uri?: unknown; domain?: unknown; expirationSecs?: unknown; notBeforeSecs?: unknown; requestId?: unknown; resources?: unknown },
    origin: string,
  ): Promise<{ account: string; pub33: string; sig64: string; message: string; chainId: string }> {
    const a = this.must();
    const domain = originToDomain(origin);
    if (!domain) throw new Error("sign-in: unknown requesting origin");
    const p = params || {};
    // The page MAY pass its domain, but it is only cross-checked against the real origin — never trusted.
    if (p.domain !== undefined && String(p.domain) !== domain) throw new Error("sign-in: declared domain does not match the requesting site");
    // uri defaults to the origin root; if supplied it MUST be on the requesting site.
    let uri: string;
    if (p.uri === undefined || p.uri === null) uri = origin.replace(/\/+$/, "") + "/";
    else { let h: string | null; try { h = new URL(String(p.uri)).host; } catch { h = null; } if (h !== domain) throw new Error("sign-in: uri must be on the requesting site"); uri = String(p.uri); }
    const nonce = String(p.nonce ?? "");
    if (!/^[A-Za-z0-9]{8,}$/.test(nonce)) throw new Error("sign-in: a server-issued nonce (>=8 alphanumeric chars) is required");
    const statement = p.statement != null && String(p.statement) !== "" ? String(p.statement) : undefined;
    if (statement !== undefined && /[\r\n]/.test(statement)) throw new Error("sign-in: statement must be a single line");
    const expSecs = Math.min(3600, Math.max(60, Math.floor(Number(p.expirationSecs) || 600))); // clamp 60s..1h, default 10m
    const now = Date.now();
    // Cap dApp-supplied resources (audit SIWC-RESOURCES): the user now sees them in the approval popup,
    // and we bound count + per-entry length and reject embedded newlines so a dApp can neither bloat the
    // signed credential nor inject extra SIWC lines via a multi-line resource entry.
    if (p.resources !== undefined && !Array.isArray(p.resources)) throw new Error("sign-in: resources must be an array");
    if (Array.isArray(p.resources) && p.resources.length > 10) throw new Error("sign-in: too many resources (max 10)");
    const resources = Array.isArray(p.resources) ? p.resources.map((x) => {
      const s = String(x);
      if (s.length > 256) throw new Error("sign-in: a resource entry exceeds 256 chars");
      if (/[\r\n]/.test(s)) throw new Error("sign-in: resources must be single-line");
      return s;
    }) : undefined;
    // Reject (don't silently truncate) an over-long/multi-line requestId: the popup shows the full value,
    // so truncating only the SIGNED copy would break what-you-see-is-what-you-sign.
    const requestId = p.requestId != null ? String(p.requestId) : undefined;
    if (requestId !== undefined && (requestId.length > 256 || /[\r\n]/.test(requestId))) throw new Error("sign-in: requestId too long or multi-line");
    const fields: SiwcFields = {
      domain, account: a.addr, statement, uri, version: SIWC_VERSION, chainId: CSD_CHAIN_MAINNET,
      nonce, issuedAt: rfc3339(now), expirationTime: rfc3339(now + expSecs * 1000),
      // Only emit notBefore for a POSITIVE offset — a 0/negative value is a no-op "valid from now-or-past"
      // constraint that the clear-sign window (clearsign.ts) does NOT display, so signing it would mean
      // committing a field the user never saw (audit SDS-1). Matching the conditions keeps WYSIWYS exact.
      notBefore: p.notBeforeSecs != null && Number(p.notBeforeSecs) > 0 ? rfc3339(now + Math.floor(Number(p.notBeforeSecs)) * 1000) : undefined,
      requestId,
      resources,
    };
    const message = buildSiwcMessage(fields);
    const { sig64, pub33 } = signSighash(siwcDigest(message), a.privkey);
    return { account: a.addr, pub33, sig64, message, chainId: CSD_CHAIN_MAINNET };
  }

  // Plain CSD transfer to any address. fee default 0.01 CSD.
  async send(to: string, amount: number, fee = 1_000_000, expectSigner?: string) {
    const ctx = this.captureSigner();
    const early = this.expectSignerRefusal(expectSigner, ctx.addr);
    if (early) return early;
    const r = await node.send(this.rpc, { to, amount, fee }, ctx.priv);
    await this.maybeRecord(ctx.histKey, r, { type: "send", to, amount, fee });
    return r;
  }
  // Merge small coins into one self-output (see node.consolidate for the full posture note).
  // Popup-only — deliberately NOT reachable from the dApp channel (not in DAPP_METHODS).
  // Ambiguous outcomes (SUBMIT_MAYBE_INFLIGHT) are ALSO recorded, flagged maybe:true — the popup's
  // pending-merge indicator derives from this history entry, and it must not be blind exactly when
  // the merge was ingested but the answer was lost (that is when the balance dips with no
  // explanation). The txid is the locally computed consensus txid (Plans/66 B4).
  async consolidate(fee = 1_000_000) {
    const hk = this.histKeyNow();
    const r = await node.consolidate(this.rpc, { fee }, this.must().privkey);
    // maybeRecord is the single chokepoint for ok / maybe-inflight / duplicate recording (0.2.56);
    // the explicit maybe:true block that used to live here moved into it.
    await this.maybeRecord(hk, r, { type: "consolidate", merged: r.merged, amount: r.total, fee });
    return r;
  }
  consolidatePreview(fee = 1_000_000) { return node.consolidatePreview(this.rpc, this.addr(), fee); }

  // Pending-merge detection (popup-only, Plans/66 B4). The moment a merge enters the mempool the
  // node's available-utxo view drops its inputs AND doesn't yet show its output, so the balance
  // hero visibly loses the whole merged amount until the next block — the single most alarming
  // moment in the consolidate flow. This derives "a merge is confirming" from data the popup
  // ALREADY holds (history + the utxo set from its balance fetch — zero extra requests, no
  // dependency on the node's expensive /tx/:id not-found scan):
  //   pending  = a consolidate history entry <60min whose merge-output txid is NOT in the utxos;
  //   confirmed = the txid APPEARS in the utxos → latch `confirmed:true` ON the entry (persisted:
  //     the designed next step SPENDS that output, and without the latch its later absence would
  //     re-derive "pending" forever after a popup reopen);
  //   stale    = >60min unconfirmed → stop claiming (a dropped merge returns its coins anyway).
  // Multi-round aware: sums every in-flight round. `maybe` marks rounds whose submit answer was
  // lost (recorded maybe:true) so the copy can hedge.
  async pendingMerge(utxos?: { txid: string }[]): Promise<{ pending: boolean; amount: number; maybe: boolean }> {
    const addr = this.addr(), k = histKey(addr); // captured once (F5): history, latch and balance stay on ONE account
    const h: any[] = (await this.store.get(k)) || [];
    const candidates = h.filter((x) => x?.type === "consolidate" && !x.confirmed && Date.now() - (x.ts || 0) <= 3_600_000);
    const maybes = h.filter((x) => x?.maybe);
    // Nothing to derive AND nothing reconcilable against a caller-supplied utxo set → done. The
    // maybe-reconcile below never triggers its own fetch: this method's zero-extra-requests
    // property is load-bearing (B4), and flag hygiene is not worth a network call.
    if (!candidates.length && !(maybes.length && utxos)) return { pending: false, amount: 0, maybe: false };
    let set = utxos;
    if (!set) { try { ({ utxos: set } = await node.balance(this.rpc, addr)); } catch { return { pending: false, amount: 0, maybe: false }; } }
    // filter hostile/degenerate elements (0.2.57, reviewer nit): a null utxo entry from a hostile RPC
    // used to throw here and land in the caller's ambiguous catch — a misleading "pending unknown".
    const present = new Set((set || []).filter((u) => u && u.txid != null).map((u) => String(u.txid).toLowerCase()));
    let amount = 0, maybe = false, pending = false, dirty = false;
    // Generic maybe-reconcile (0.2.56, review F2): an entry recorded maybe:true is RESOLVED the
    // moment its txid shows up in the utxo set — a send's change output and a merge's self-output
    // both carry the tx's own txid, so presence proves the ambiguous submit landed. (Blind spot,
    // accepted: a change-less send never reconciles this way; the popup time-bounds its marker
    // rather than trusting this pass.)
    for (const e of maybes) if (present.has(String(e.txid).toLowerCase())) { delete e.maybe; dirty = true; }
    for (const e of candidates) {
      if (present.has(String(e.txid).toLowerCase())) {
        // merge output visible on-chain → latch confirmed IN PLACE (persisted below; the designed
        // next step SPENDS that output, and without the latch its later absence would re-derive
        // "pending" forever after a popup reopen)
        if (!e.confirmed) { e.confirmed = true; dirty = true; }
        continue;
      }
      // amount = what actually comes back next block: the merge OUTPUT (inputs minus fee) — the
      // recorded e.amount is the input total, which would overstate by the fee.
      pending = true; amount += Math.max(0, (Number(e.amount) || 0) - (Number(e.fee) || 0)); maybe = maybe || !!e.maybe;
    }
    if (dirty) await this.store.set(k, h);
    return { pending, amount, maybe };
  }

  // Multi-output transfer (1→many). fee default 0.01 CSD. Inputs are chosen internally
  // by node.sendMany; callers never supply UTXOs. History records the total + primary
  // recipient (single-output sends record identically to send()).
  async sendMany(p: { outputs: { to: string; value: number }[]; fee?: number; expectSigner?: string }) {
    const fee = p.fee ?? 1_000_000;
    const ctx = this.captureSigner();
    const early = this.expectSignerRefusal(p.expectSigner, ctx.addr);
    if (early) return early;
    const r = await node.sendMany(this.rpc, { outputs: p.outputs, fee }, ctx.priv);
    const { total, to } = this.summarizeOutputs(p.outputs);
    await this.maybeRecord(ctx.histKey, r, { type: "send", to, amount: total, fee });
    return r;
  }

  // Post a Cairn item directly: propose on-chain + register the off-chain content
  // (the content only "takes" once the tx mines, so we register in the background).
  async cairnPost(p: { domain: string; title: string; body?: string; links?: string[]; fee: number }) {
    const priv = this.must().privkey;
    const hk = this.histKeyNow(); // captured with the signer (F5): the tip fetch below is an await
    const content = { v: 1, domain: p.domain, title: p.title, body: p.body ?? "", links: p.links ?? [] };
    const ph = cairnPayloadHash(content);
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / BLOCKS_PER_EPOCH) + PROPOSE_EXPIRY_EPOCHS;
    const r = await node.propose(this.rpc, { domain: p.domain, payloadHash: ph, uri: "cairn:v1:" + ph.slice(2, 14), expiresEpoch, fee: p.fee }, priv);
    // Queue the off-chain content on the ambiguous path too (0.2.56, review F13): a maybe-inflight
    // propose that MINES would otherwise lose its body forever — the user paid, the content never
    // lands, no error. flushPending already handles a never-mined txid safely (polls getProposal,
    // registers only once mined, 7-day expiry bounds the queue), so queueing is harmless when the
    // tx truly died.
    if (r.txid && (r.ok || r.code === "SUBMIT_MAYBE_INFLIGHT")) { await this.addPending(content, r.txid); this.flushPending(); } // durable, alarm-driven
    await this.maybeRecord(hk, r, { type: "post", domain: p.domain, title: p.title, fee: p.fee });
    return r;
  }
  async cairnSupport(proposalId: string, fee: number, score = 80, confidence = 70) { const hk = this.histKeyNow(); const r = await node.attest(this.rpc, { proposalId, score, confidence, fee }, this.must().privkey); await this.maybeRecord(hk, r, { type: "support", target: proposalId, fee }); return r; }

  // ── CairnX tokens + .csd names ──────────────────────────────────────────────
  // READS go to the public CairnX resolver API and NEVER throw — the popup must keep
  // showing the CSD balance even when the token API is down ({ ok:false } → quiet retry).
  async cairnxAssets(): Promise<{ ok: boolean; balances?: Record<string, { available: string; locked: string }>; names?: string[]; nameDetails?: any[]; primaryName?: string | null; tipHeight?: number }> {
    try {
      const r = await this.tradeGet(`/cairnx/address/${this.addr()}`, 12000); // display read: 12s bounded (was untimed)
      if (!r.ok) return { ok: false };
      const j = await r.json();
      const balances = (j && typeof j.balances === "object" && j.balances) || {};
      const names = Array.isArray(j?.names) ? j.names.filter((n: unknown) => typeof n === "string") : [];
      // nameDetails (lease/expiry/addr per name) + the server-computed primary name (reverse record).
      // Older services omit these → empty/null, and the popup falls back to plain name chips.
      const nameDetails = Array.isArray(j?.nameDetails) ? j.nameDetails : [];
      const primaryName = typeof j?.primaryName === "string" ? j.primaryName : null;
      // tip rides along so the popup can turn a pending reservation's finalizeBy into a live countdown
      const tipHeight = Number(j?.tipHeight) || 0;
      return { ok: true, balances, names, nameDetails, primaryName, tipHeight };
    } catch { return { ok: false }; }
  }
  // Forward resolution for "send to a .csd name". Fail-CLOSED on a lapsed/expired lease so the
  // popup never routes funds to a name's stale address. Returns the nset addr if set, else the
  // owner (so a name works as a recipient even before its holder sets a resolver record).
  async resolveName(name: string): Promise<{ ok: boolean; name?: string; addr?: string; via?: string; owner?: string; lapsed?: boolean; error?: string; verified?: boolean; verifyReason?: string; depth?: number; sources?: number; agreed?: number; disagree?: boolean; viaFill?: boolean }> {
    const nm = normName(name);
    // XREPO-1 hardening (audit nit D): validate the name against the convention's NAME_RE BEFORE
    // interpolating it into the resolver URL — a name with `/`, `..`, `%`, or query chars must never
    // reach the path. (encodeURIComponent is belt-and-braces.) A non-name can't be a real .csd name.
    if (!isPlainName(nm)) return { ok: false, error: `${nm} is not a valid .csd name` };
    try {
      // Base-claim fetch with clarvis FALLBACK (2026-07-09): a primary-resolver outage used to block
      // EVERY name send with "name lookup failed" even though the independent clarvis source could
      // answer — and the SPV verifyName below is the trust anchor either way (the base answer is
      // UNTRUSTED no matter which source served it, so falling back is no weaker). Only a definitive
      // 404 from the source that answered short-circuits; network/5xx tries the second source.
      let r: Response | null = null;
      try { r = await this.tradeGet(`/cairnx/resolve/${encodeURIComponent(nm)}`); } catch { r = null; } // 12s (> the proxy's 10s upstream): recipient path fails clean
      if (r && r.status === 404) return { ok: false, error: `${nm}.csd is not registered` };
      if (!r || !r.ok) {
        try {
          // 12s like the primary: clarvis fronts the same cairn proxy shape (10s upstream wait).
          const c = await fetch(`${CLARVIS_TRADE_API}/cairnx/resolve/${encodeURIComponent(nm)}`, { signal: AbortSignal.timeout(12000) });
          // Only accept a POSITIVE answer from the fallback; a 404 from a degraded/withholding second
          // source is NOT trustworthy enough to definitively claim "not registered" (fail-closed to the
          // retryable "name lookup failed" below instead — the primary being down is transient).
          if (c.ok) r = c;
        } catch { /* both sources down — fall through to the honest failure */ }
      }
      if (!r || !r.ok) return { ok: false, error: "name lookup failed" };
      const j = await r.json();
      if (j?.lapsed) return { ok: false, error: `${nm}.csd lease has lapsed — can't send to it` };
      if (!j?.addr || !/^0x[0-9a-f]{40}$/.test(String(j.addr).toLowerCase())) return { ok: false, error: `${nm}.csd has no address` };
      const base = { ok: true as const, name: nm, addr: String(j.addr).toLowerCase(), via: j.via, owner: j.owner, lapsed: false };
      // XREPO-1 cure: independently SPV-verify the name → address against the chain. The resolver's
      // answer above is UNTRUSTED until this confirms it. Best-effort + fail-closed: a PROVEN mismatch
      // (the chain says a different address) REFUSES; an unavailable verifier returns the address with a
      // caution flag (today's behaviour + a signal), never silently "verified".
      const v = await this.verifyName(nm).catch(() => null);
      if (v?.verified && v.addr) return { ...base, addr: v.addr, verified: true, depth: v.depth, sources: v.sources, agreed: v.agreed, disagree: v.disagree };
      if (v && /does NOT match|hostile/i.test(v.reason ?? ""))
        return { ok: false, error: `${nm}.csd: the resolver's address contradicts the chain — refusing (possible hostile resolver)`, verified: false };
      // Surface viaFill (NSPV-CLAIMCAP-1 / H1) so the UI shows the specific "acquired by fill — not name-scope
      // provable" caution rather than the generic "couldn't verify" one. Still verified:false (fail-closed).
      return { ...base, verified: false, verifyReason: v?.reason ?? "on-chain verification unavailable", viaFill: v?.viaFill === true };
    } catch { return { ok: false, error: "name lookup failed" }; }
  }

  // M3 (offline token-fill simulation): quote the actual token DEBIT for a token-priced fill (confidence
  // ===1e6) so the clear-sign window shows what the user pays instead of "not visible here". Fetches the
  // offer from the resolver and, IF it is an OPEN token-want offer, computes debit = ask + protocol fee
  // (BigInt-exact, same cairnxTradeFee the convention uses). Returns ok:false on any unreachable/mismatch so
  // the UI keeps its loud caution — never silently "free". This is RESOLVER-TRUSTED DISPLAY ONLY: it changes
  // nothing the wallet signs (the attest bytes are unaffected); it only makes the debit visible for review.
  async tokenFillQuote(proposalId: string): Promise<{ ok: boolean; ticker?: string; amount?: string; fee?: string; total?: string; estimated?: boolean; error?: string }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(proposalId))) return { ok: false, error: "bad offer id" };
    try {
      const r = await this.tradeGet(`/cairnx/offer/${encodeURIComponent(proposalId)}`); // 12s (tradeGet default): fill-quote read
      if (!r.ok) return { ok: false, error: "offer not found" };
      const o: any = await r.json().catch(() => null);
      if (!o || o.status !== "open") return { ok: false, error: o?.status ? `offer ${o.status}` : "offer unavailable" };
      const w = o.want;
      if (!w || typeof w.ticker !== "string" || w.amount === undefined) return { ok: false, error: "not a token-priced offer" };
      let amount: bigint;
      try { amount = BigInt(String(w.amount)); } catch { return { ok: false, error: "bad amount" }; }
      if (amount < 0n) return { ok: false, error: "bad amount" };
      // QA-4: if the resolver omits feeBps, default to the HIGHER current rate (V16, 150 bps) so the quote
      // never UNDER-states what will be debited (over-stating by ≤0.5% is the fail-safe direction) and mark
      // it estimated so the UI can say so. A supplied feeBps is used exactly.
      const hasBps = Number.isFinite(Number(o.feeBps));
      const bps = hasBps ? Number(o.feeBps) : FEE_BPS_V16;
      const fee = cairnxTradeFee(amount, bps);
      return { ok: true, ticker: w.ticker, amount: amount.toString(), fee: fee.toString(), total: (amount + fee).toString(), estimated: !hasBps };
    } catch { return { ok: false, error: "offer unavailable" }; }
  }

  // XREPO-1: trustlessly SPV-verify a .csd name → address against a PoW header chain the wallet verifies
  // itself, replaying the AUDITED resolver over merkle-verified records (see core/namespv.ts). Returns the
  // fail-closed tri-state. Exposed to dApps (popup "verifyName") so a recipient can be confirmed before a send.
  async verifyName(name: string): Promise<NameVerification & { name: string }> {
    const nm = normName(name);
    if (!isPlainName(nm)) return { verified: false, reason: `${nm} is not a valid .csd name`, scope: "as-shown", name: nm };
    try {
      // Cross-check the user's configured primary resolver against the independent clarvis second source
      // (NSPV-COMPLETE-1 cure, doc 36 Part B). verifyNameUnion fetches name-history from each, unions the
      // SPV-verified events, and resolves to the chain-proven winner — defeating a withholding resolver.
      const sources: ResolverSource[] = [{ label: "primary", base: this.tradeApi }, { label: "clarvis", base: CLARVIS_TRADE_API }];
      const res = await verifyNameUnion(nm, sources, await this.spvSource());
      return { ...res, name: nm };
    } catch (e) {
      return { verified: false, reason: `on-chain verification unavailable (${(e as Error)?.message ?? e})`, scope: "as-shown", name: nm };
    }
  }

  // Lazily built PoW-verified-header SPV source (singleton per wallet), with the header-chain snapshot
  // persisted in the wallet store so only the FIRST verify pays the cold-sync cost. Rebuilt on failure.
  private _spvSrc: Promise<SpvSource> | null = null;
  private spvSource(): Promise<SpvSource> {
    if (!this._spvSrc) {
      this._spvSrc = liveSpvSource({
        rpcBase: this.rpc, headersBase: this.api,
        cache: { get: () => this.store.get("spvHeaderChain"), set: (s) => this.store.set("spvHeaderChain", s) },
        // NAME-4: persist the node-tip high-water so the lapse floor survives a service-worker restart.
        floor: { get: async () => Number(await this.store.get("spvNodeTipFloor")) || 0, set: (v) => this.store.set("spvNodeTipFloor", v) },
      }).catch((e) => { this._spvSrc = null; throw e; });
    }
    return this._spvSrc;
  }
  // v1.8: the height-gated renewal fee priced at the CURRENT tip — for the popup's pre-spend estimate, so
  // the displayed cost matches what cairnxNameRenew will actually sign (WL-V18-1). Returns base units.
  async cairnxNameRenewFee(name: string): Promise<number> {
    const fee = nameRegFee(name, buildFeeHeight(await node.tip(this.rpc)));
    return fee > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(fee);
  }
  // Renew a .csd lease (+1 year) — built on-device, pays the registration fee to the treasury.
  async cairnxNameRenew(name: string, reviewedFee?: number, expectSigner?: string) {
    const priv = this.must().privkey;
    const hk = this.histKeyNow(); // captured with the signer (F5)
    // A1 backstop: this method throws on refusal (FEE_CHANGED precedent), so the mismatch throws too.
    this.throwOnSignerChange(expectSigner);
    const built = buildNameRenew({ name });
    const tip = await node.tip(this.rpc);
    const liveFee = nameRegFee(name, buildFeeHeight(tip));  // v1.8: height-gated; V18-1 boundary-safe build pricing
    if (liveFee > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("renewal fee too large for the UI");
    // WL-FEE-FREEZE-1 (WYSIWYS): sign EXACTLY the fee the user reviewed. If the chain tip crossed a fee-gate
    // boundary (V18/V24…) between Review and Confirm so the live fee no longer matches what was shown, REFUSE
    // rather than silently sign a different (higher) amount — the popup re-opens the review at the new price.
    // Never sign more than was displayed, never sign a now-underpaying fee (which the resolver would no-op).
    if (reviewedFee !== undefined && BigInt(reviewedFee) !== liveFee) throw new Error(`FEE_CHANGED:${Number(liveFee)}`);
    const fee = reviewedFee !== undefined ? BigInt(reviewedFee) : liveFee;
    const expiresEpoch = Math.floor(tip / BLOCKS_PER_EPOCH) + NAME_RENEW_EXPIRY_EPOCHS;
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee: CAIRNX_PROPOSE_FEE, outputs: [{ to: TREASURY_ADDR, value: Number(fee) }] }, priv);
    await this.maybeRecord(hk, r, { type: "propose", domain: CAIRNX_DOMAIN, fee: CAIRNX_PROPOSE_FEE, title: `renew ${name}.csd` });
    return r;
  }
  // Set a name you own as your PRIMARY identity = point it at your own address (nset → self).
  async cairnxSetPrimary(name: string, expectSigner?: string) {
    const priv = this.must().privkey;
    const hk = this.histKeyNow(); // captured with the signer (F5)
    this.throwOnSignerChange(expectSigner);
    const built = buildNameSet({ name, addr: this.addr() });
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / BLOCKS_PER_EPOCH) + SET_PRIMARY_EXPIRY_EPOCHS;
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee: CAIRNX_PROPOSE_FEE }, priv);
    await this.maybeRecord(hk, r, { type: "propose", domain: CAIRNX_DOMAIN, fee: CAIRNX_PROPOSE_FEE, title: `set ${name}.csd primary` });
    return r;
  }
  async cairnxTokens(): Promise<{ ok: boolean; tokens?: { ticker: string; decimals: number; name?: string }[] }> {
    try {
      const r = await this.tradeGet(`/cairnx/tokens`, 12000); // display read: 12s bounded (was untimed)
      if (!r.ok) return { ok: false };
      const j = await r.json();
      return { ok: true, tokens: Array.isArray(j) ? j : [] };
    } catch { return { ok: false }; }
  }
  // Token transfer = a cairnx:v1 Propose whose uri is the canonical transfer record,
  // payload_hash = sha256(uri), fee 0.25 CSD, NO value outputs. The record is built
  // LOCALLY (core/cairnx.ts) and validated before signing; `amount` is base units.
  async cairnxTransfer(p: { ticker: string; amount: string; to: string; decimals?: number; fee?: number; expectSigner?: string }) {
    const priv = this.must().privkey;
    const hk = this.histKeyNow(); // captured with the signer (F5)
    this.throwOnSignerChange(p.expectSigner);
    const built = buildTransfer({ ticker: p.ticker, amount: p.amount, to: p.to }); // throws on invalid
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / BLOCKS_PER_EPOCH) + PROPOSE_EXPIRY_EPOCHS;
    const fee = p.fee ?? CAIRNX_PROPOSE_FEE;
    if (fee < CAIRNX_PROPOSE_FEE) throw new Error("cairnx anchor fee must be ≥ 0.25 CSD");
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee }, priv);
    await this.maybeRecord(hk, r, {
      type: "tokenSend", ticker: p.ticker, to: String(p.to).toLowerCase(), amount: p.amount,
      human: typeof p.decimals === "number" ? formatUnits(p.amount, p.decimals) : p.amount, fee,
    });
    return r;
  }

  // ── sealed claims (commit-reveal) — isolated per active account ─────────────
  // L5: the {claim, nonce} pair is the reveal PREIMAGE + salt — a force-revealable front-running lever if it
  // is readable at rest. The vault key already lives only in memory (chrome.storage.session, not cold-disk-
  // readable), so encrypt ONLY these two fields under it (fresh IV per seal) before persisting; txid/domain/
  // committedTs/revealed/maybe stay plaintext (already on-chain / not the lever). Reuses the AES-GCM vault
  // primitives (keystore sealWith/openWith) — no new crypto. history/labels stay the documented local-disk
  // residual (we do NOT encrypt all of chrome.storage.local; §5 constraint).
  private async sealPreimage(claim: string, nonce: string): Promise<Vault> {
    if (!this.vaultKey) throw new Error("locked");
    return sealWith(JSON.stringify({ claim, nonce }), this.vaultKey, this.salt, this.iter);
  }
  // Recover a record's preimage: a v-L5 record carries an encrypted `enc` blob; a LEGACY plaintext record
  // (pre-L5) still carries claim/nonce inline and keeps working (lazy migration re-encrypts it on next write).
  private async openPreimage(rec: { enc?: Vault; claim?: string; nonce?: string }): Promise<{ claim: string; nonce: string }> {
    if (rec?.enc) {
      if (!this.vaultKey) throw new Error("locked");
      const p = JSON.parse(await openWith(rec.enc, this.vaultKey));
      return { claim: String(p.claim ?? ""), nonce: String(p.nonce ?? "") };
    }
    return { claim: String(rec?.claim ?? ""), nonce: String(rec?.nonce ?? "") };
  }
  // Lazy migration (L5): re-encrypt any legacy plaintext records in a list on the next write of that list, so
  // an existing sealed claim keeps revealing but stops sitting in cleartext. No-op when locked or already
  // encrypted. Mutates in place.
  private async reencryptLegacyPreimages(list: { enc?: Vault; claim?: string; nonce?: string }[]): Promise<void> {
    if (!this.vaultKey) return;
    for (const rec of list) {
      if (rec && !rec.enc && (rec.claim !== undefined || rec.nonce !== undefined)) {
        rec.enc = await this.sealPreimage(String(rec.claim ?? ""), String(rec.nonce ?? ""));
        delete rec.claim; delete rec.nonce;
      }
    }
  }
  async sealClaim(p: { domain?: string; claim: string; fee?: number }) {
    const priv = this.must().privkey;
    const hk = this.histKeyNow(), sk = sealKey(this.addr()); // captured with the signer (F5)
    const domain = (p.domain && p.domain.trim()) || "csd:sealed";
    const nonce = bytesToHex(randomBytes(32));
    const content = { v: 1, sealed: 1, domain, claim: p.claim, nonce };
    const ph = cairnPayloadHash(content);
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / BLOCKS_PER_EPOCH) + PROPOSE_EXPIRY_EPOCHS;
    const fee = p.fee ?? CAIRNX_PROPOSE_FEE; // propose min 0.25 CSD
    const r = await node.propose(this.rpc, { domain, payloadHash: ph, uri: "cairn:seal:v1:" + ph.slice(2, 14), expiresEpoch, fee }, priv);
    // A maybe-inflight seal may still MINE: persist the reveal preimage (claim+nonce) on the
    // ambiguous path too, or a landed commit becomes forever unrevealable (0.2.56, same class as
    // the cairnPost content fix). Saving locally is harmless when the tx never landed.
    if (r.txid && (r.ok || r.code === "SUBMIT_MAYBE_INFLIGHT")) {
      const list: any[] = (await this.store.get(sk)) || [];
      // maybe-path seals are FLAGGED (0.2.57, reviewer nit) so the sealed-claims UI can say the
      // anchor may not have landed instead of listing it like a confirmed commit.
      // L5: persist the {claim, nonce} preimage ENCRYPTED at rest (fresh IV) — the front-running lever.
      if (!list.find((x) => x.txid === r.txid)) {
        const enc = await this.sealPreimage(p.claim, nonce);
        list.unshift({ txid: r.txid, domain, enc, committedTs: Date.now(), revealed: false, ...(r.ok ? {} : { maybe: true }) });
      }
      await this.reencryptLegacyPreimages(list); // migrate any pre-L5 plaintext record on this write
      await this.store.set(sk, list.slice(0, 500));
    }
    await this.maybeRecord(hk, r, { type: "seal", domain, fee });
    return r;
  }
  async revealClaim(txid: string) {
    const k = sealKey(this.addr());
    const list: any[] = (await this.store.get(k)) || [];
    const rec = list.find((x) => x.txid === txid);
    if (!rec) return { ok: false, error: "no sealed claim with that txid in this account" };
    // L5: decrypt the preimage with the unlocked vault key (a legacy plaintext record still reveals).
    const { claim, nonce } = await this.openPreimage(rec);
    const r = await node.registerContent(this.api, { v: 1, sealed: 1, domain: rec.domain, claim, nonce }, txid);
    if (r && r.ok) {
      rec.revealed = true;
      await this.reencryptLegacyPreimages(list); // lazy-migrate any legacy plaintext record on this write
      await this.store.set(k, list);
    }
    return r;
  }
  // Display view for the popup: decrypt the claim TEXT for the sealed-claims preview (unlocked, trusted UI)
  // while the on-disk record stays encrypted; the nonce (reveal salt) is never surfaced to the list. A
  // decrypt failure degrades to "no preview" rather than throwing (the list never breaks).
  async sealedClaims(): Promise<any[]> {
    if (!this.accts) return [];
    const list: any[] = (await this.store.get(sealKey(this.addr()))) || [];
    const out: any[] = [];
    for (const rec of list) {
      if (rec?.enc) { try { const { claim } = await this.openPreimage(rec); out.push({ ...rec, claim }); } catch { out.push({ ...rec }); } }
      else out.push(rec);
    }
    return out;
  }

  // ── transaction history — isolated per active account ──────────────────────
  // Pre-await key capture (0.2.56, review F5): every recording path must file under the account
  // that SIGNED. Flows capture this in the same synchronous tick as their privkey read, BEFORE
  // the awaited submit — the user can switch accounts while the network call is in flight, and a
  // post-await histKey(this.addr()) would file the entry (and everything the pending-merge line
  // derives from it) under the switched-to account.
  private histKeyNow() { return histKey(this.addr()); }
  private async maybeRecord(k: string, r: { ok?: boolean; txid?: string; code?: string; spentTxids?: string[] }, meta: Record<string, unknown>) {
    if (r && r.ok && r.txid) await this.recordTx(k, { txid: r.txid, ts: Date.now(), ...meta });
    // Ambiguous outcome (0.2.56, review F1): the tx MAY be in the mempool — a timeout / gateway
    // 5xx / unreadable answer AFTER signing. Record it maybe:true under the LOCALLY computed txid
    // so the failure copy's "check history before resending" is actionable: this entry is what
    // stands between an ingested-but-unanswered send and a blind resend double-pay (a resend picks
    // DIFFERENT coins once the mempool-spent filter updates, so byte-identical dedupe does NOT
    // backstop it). Previously only consolidate() did this; every value flow gets it here at the
    // single chokepoint. Deliberate, accepted side-effect: the recipient joins paidRecipients
    // (clearsign.ts), muting the first-time-recipient warning for an address the user already
    // clear-signed once — entries only originate from the user's own reviewed sends, no poisoning
    // vector.
    else if (r && !r.ok && r.code === "SUBMIT_MAYBE_INFLIGHT" && r.txid) {
      await this.recordTx(k, { txid: r.txid, ts: Date.now(), ...meta, maybe: true });
    }
    // A duplicate answer RESOLVES an earlier ambiguity — a tx spending these coins IS pending, and
    // a deterministic retry of an ingested submit is byte-identical, so this is the common way a
    // maybe:true entry turns out to have landed. Clear the flag in place; never INSERT on a dup
    // (on the current node's conflated error a dup can also mean a DIFFERENT tx spends the coins,
    // and a fresh entry under the local txid would then claim a send that never landed).
    else if (r && !r.ok && r.code === "SUBMIT_DUPLICATE" && r.txid) {
      await this.clearMaybe(k, r.txid);
    }
    // Spending an output PROVES its source tx confirmed: latch any pending-merge entry whose txid
    // this spend just consumed (Plans/66 review finding — the final combining pass spends earlier
    // rounds' outputs with no balance refresh in between, which otherwise left those entries
    // deriving a false "merging" line for up to an hour).
    if (r && r.ok && Array.isArray(r.spentTxids) && r.spentTxids.length) await this.latchSpentMerges(k, r.spentTxids);
  }
  private async clearMaybe(k: string, txid: string) {
    const h: any[] = (await this.store.get(k)) || [];
    const e = h.find((x) => x?.txid === txid && x.maybe);
    if (e) { delete e.maybe; await this.store.set(k, h); }
  }
  private async latchSpentMerges(k: string, spent: string[]) {
    const h: any[] = (await this.store.get(k)) || [];
    const set = new Set(spent.map((t) => String(t).toLowerCase()));
    let dirty = false;
    for (const e of h) {
      // spending the output proves the tx landed — that also RESOLVES a maybe flag (an entry can
      // otherwise sit {maybe:true, confirmed:true} showing a stale "may be in flight" marker)
      if (e?.type === "consolidate" && !e.confirmed && set.has(String(e.txid).toLowerCase())) { e.confirmed = true; delete e.maybe; dirty = true; }
    }
    if (dirty) await this.store.set(k, h);
  }
  private async recordTx(k: string, entry: Record<string, unknown>) {
    const h: any[] = (await this.store.get(k)) || [];
    const e = h.find((x) => x?.txid === entry.txid);
    if (e) {
      // Idempotent by txid — but a DEFINITIVE record for a txid first recorded maybe:true resolves
      // the ambiguity: clear the flag IN PLACE. Never re-insert or reorder — ts, position and the
      // consolidate confirmed-latch must survive (a replace would resurrect the pending-forever
      // bug the latch exists to prevent).
      if (e.maybe && !entry.maybe) { delete e.maybe; await this.store.set(k, h); }
      return;
    }
    h.unshift(entry);
    await this.store.set(k, h.slice(0, 200));
  }
  history(): Promise<any[]> { if (!this.accts) return Promise.resolve([]); return this.store.get(histKey(this.addr())).then((h: any[]) => h || []); }

  // ── idle auto-lock ───────────────────────────────────────────────────────
  private lastActive = Date.now();
  touch() {
    this.lastActive = Date.now();
    // mirror the activity stamp into chrome.storage.session so the idle window is tracked across
    // SW restarts (genuine activity extends the unlocked session; pure reads never call touch()).
    if (this.session) this.session.set("sessionTs", this.lastActive).catch(() => {});
  }
  async autoLock(maxIdleMs: number) { if (this.accts && Date.now() - this.lastActive > maxIdleMs) await this.lock(); } // await: the idle-lock race LOCK-ASYNC targets

  // ── durable off-chain content registration (account-agnostic) ──────────────
  private async addPending(content: unknown, txid: string) {
    const list: any[] = (await this.store.get("pendingContent")) || [];
    if (!list.find((x) => x.txid === txid)) list.push({ content, txid, ts: Date.now() });
    await this.store.set("pendingContent", list);
  }
  // F-QUEUE-2 (Plans/68 A3): flushPending is a read-modify-write over pendingContent with awaits in
  // between, and it fires from THREE triggers (startup, the 1-minute alarm, cairnPost's un-awaited
  // kick) — two overlapping flushes, or a flush racing addPending, could clobber a just-queued entry
  // with a stale list. The in-flight latch collapses overlaps; the final RE-READ + union-by-txid
  // merge keeps any entry added while this flush was running.
  private flushInFlight = false;
  async flushPending(): Promise<void> {
    if (this.flushInFlight) return;
    this.flushInFlight = true;
    try {
      const list: any[] = (await this.store.get("pendingContent")) || [];
      if (!list.length) return;
      const keep: any[] = [];
      const processed = new Set<string>();
      for (const x of list) {
        processed.add(String(x.txid).toLowerCase());
        // 7 days, not 24h: content registration follows a PAID Propose/name tx, and the old 24h
        // window silently dropped the content of anyone offline a day — user paid, body never
        // landed, no error (Plans/66 B8). Content is self-certifying and re-POSTable, so a long
        // retry window costs nothing; expiry still bounds the queue.
        if (Date.now() - (x.ts || 0) > 7 * 86400000) continue;
        try {
          const p = await node.getProposal(this.rpc, x.txid);
          if (!(p && p.payload_hash)) { keep.push(x); continue; }  // not mined yet → retry later
          // F-QUEUE-1 (Plans/68 A3): registerContent NEVER throws — it resolves {ok:false} on any
          // refusal/outage (node.ts). Dropping the entry on that path silently lost the body of a
          // tx the user PAID to anchor. Registration is idempotent and self-certifying, so a
          // failed register keeps the entry for the next alarm tick instead.
          const rr = await node.registerContent(this.api, x.content, x.txid);
          if (!(rr && (rr as any).ok)) keep.push(x);
        } catch { keep.push(x); }                                  // transient/network error → retry later
      }
      // re-read + merge (union by txid): entries queued DURING this flush survive the write-back.
      const now: any[] = (await this.store.get("pendingContent")) || [];
      const merged = [...keep, ...now.filter((x) => !processed.has(String(x.txid).toLowerCase()))];
      await this.store.set("pendingContent", merged);
    } finally { this.flushInFlight = false; }
  }
  hasPending(): Promise<boolean> { return this.store.get("pendingContent").then((l: any[]) => !!(l && l.length)); }

  // Reveal the ACTIVE account's private key — requires re-entering the password.
  async exportKey(password: string): Promise<string> {
    const v: Vault | null = await this.store.get("vault"); if (!v) throw new Error("no wallet");
    const { parsed, legacyPriv } = await this.openVaultDoc(v, password);
    if (!parsed) return legacyPriv; // legacy single-key vault (plaintext IS the raw privkey, 0x-normalized)
    const i = this.accts ? this.active : (parsed.active ?? 0);
    return parsed.accounts[Math.min(i, parsed.accounts.length - 1)].priv;
  }

  // Reveal the wallet's recovery phrase (the master backup) — password-gated. Throws
  // for legacy/import-only wallets that have no seed phrase.
  async exportMnemonic(password: string): Promise<string> {
    const v: Vault | null = await this.store.get("vault"); if (!v) throw new Error("no wallet");
    const { parsed } = await this.openVaultDoc(v, password);
    if (!parsed?.mnemonic) throw new Error("this wallet has no recovery phrase (it was created from an imported key)");
    return parsed.mnemonic;
  }

  // Wipe ALL wallet state — every account's vault, history, and sealed-claim
  // preimages — so a freshly-created wallet can't surface a prior owner's data.
  async reset(): Promise<void> {
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    await this.lock();
    // RESET-RESURRECT (fund-safety red-team): the wipe must not race a persist parked at its store.set —
    // a STALE persist landing AFTER the deletes would resurrect the (still-encrypted) vault + the cleartext
    // account mirror, silently defeating "wipe everything" and locking out create/restore. Serialize the
    // wipe behind the SAME chain persistVault uses, so it runs only after every queued persist's writes
    // have landed; lock() above already nulled this.accts, so no NEW persist can write (doPersistVault
    // throws "locked"), making these deletes the last store ops.
    const wipe = () => this.doReset(wallets);
    const run = this.persistChain.then(wipe, wipe);
    this.persistChain = run.then(() => {}, () => {});
    return run;
  }
  private async doReset(wallets: PubAcct[]): Promise<void> {
    for (const w of wallets) { await this.store.del(histKey(w.addr)); await this.store.del(sealKey(w.addr)); }
    for (const k of ["vault", "wallets", "active", "addr", "txHistory", "sealedClaims", "pendingContent"]) await this.store.del(k);
  }
}
