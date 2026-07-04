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
import { buildTransfer, buildNameRenew, buildNameSet, nameRegFee, buildFeeHeight, formatUnits, cairnxTradeFee, fillIsSafe, FEE_BPS_V16, isPlainName, CAIRNX_DOMAIN, CAIRNX_PROPOSE_FEE, TREASURY_ADDR } from "./cairnx.js";
import type { CxOfferState } from "../vendor/cairnx-spv.js";
import { verifyNameUnion, liveSpvSource, type NameVerification, type SpvSource, type ResolverSource } from "./namespv.js";
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
  idleMs = 15 * 60 * 1000;
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
  private async persistVault() {
    if (!this.accts || !this.vaultKey) throw new Error("locked");
    const doc: VaultDoc = {
      v: 2, mnemonic: this.mnemonic ?? undefined, nextIndex: this.nextIndex,
      accounts: this.accts.map((a) => ({ priv: a.privkey, label: a.label, index: a.index, imported: a.imported })),
      active: this.active,
    };
    const vault = await sealWith(JSON.stringify(doc), this.vaultKey, this.salt, this.iter);
    await this.store.set("vault", vault);
    await this.store.set("wallets", this.accts.map((a) => ({ addr: a.addr, label: a.label, imported: a.imported })));
    await this.store.set("active", this.active);
  }

  private acct(priv: string, label: string, extra: { index?: number; imported?: boolean } = {}): Acct { return { ...fromPriv(priv), label, ...extra }; }

  // Seal a brand-new vault from an in-memory state already set on `this`.
  private async sealFresh(password: string) {
    const doc: VaultDoc = { v: 2, mnemonic: this.mnemonic ?? undefined, nextIndex: this.nextIndex, accounts: this.accts!.map((a) => ({ priv: a.privkey, label: a.label, index: a.index, imported: a.imported })), active: this.active };
    const { vault, key } = await sealNew(JSON.stringify(doc), password);
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

  async unlock(password: string): Promise<{ addr: string }> {
    const v: Vault | null = await this.store.get("vault");
    if (!v) throw new Error("no wallet — create or import one first");
    const { key, doc } = await this.withAuthGuard(async () => {
      const key = await deriveVaultKey(password, v.salt, v.iter);
      return { key, doc: await openWith(v, key) }; // openWith throws "bad password" on GCM-tag mismatch → counted
    });
    this.vaultKey = key; this.salt = v.salt; this.iter = v.iter;
    await this.applyDoc(doc);
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
  async removeAccount(addr: string): Promise<void> {
    const accts = this.mustUnlocked();
    if (accts.length <= 1) throw new Error("cannot remove the last account — reset the wallet to start over");
    const i = accts.findIndex((x) => x.addr.toLowerCase() === String(addr).toLowerCase());
    if (i < 0) throw new Error("no such account");
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

  balance() { return node.balance(this.rpc, this.addr()); }
  // Current epoch (= floor(tip/30), matching this wallet's own propose math) — lets the approval
  // window show a dApp-supplied expiresEpoch as a real "expires in N days from now". Best-effort:
  // returns null offline so the clear-signer just shows the raw epoch.
  async epoch(): Promise<number | null> { try { return Math.floor((await node.tip(this.rpc)) / 30); } catch { return null; } }
  // CLEARSIGN-FEE-1: exact tip for the clear-sign fee-sufficiency check on a dApp-built name registration/
  // renewal (epoch*30 is too coarse near a fee-gate boundary). Best-effort; null when offline.
  async tip(): Promise<number | null> { try { return await node.tip(this.rpc); } catch { return null; } }
  async propose(p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; outputs?: { to: string; value: number }[] }) { const r = await node.propose(this.rpc, p, this.must().privkey); await this.maybeRecord(r, { type: "propose", domain: p.domain, fee: p.fee }); return r; }
  async attest(p: { proposalId: string; score: number; confidence: number; fee: number }) { const r = await node.attest(this.rpc, p, this.must().privkey); await this.maybeRecord(r, { type: "support", target: p.proposalId, fee: p.fee }); return r; }
  // Atomic fill (Attest + payment in ONE tx — CairnX delivery-versus-payment). fee default 0.05 CSD (attest floor).
  async fillOffer(p: { proposalId: string; score?: number; confidence?: number; outputs: { to: string; value: number }[]; fee?: number }) {
    const q = { proposalId: p.proposalId, score: (p.score ?? 100) >>> 0, confidence: (p.confidence ?? 100) >>> 0, outputs: p.outputs, fee: p.fee ?? 5_000_000 };
    // ── fund-safety pre-flight (deep-review 2026-07-03 C2/C3/C4): the wallet's own fillOffer must NEVER
    // sign a payment tx the resolver will reject AFTER the CSD moves (no escrow → the payment is lost).
    // We re-fetch the CURRENT offer record and run the shared cairnx-core pre-flight over it. The check is
    // computed from the offer's OWN give/want/min/claim fields (not a resolver boolean), so even a hostile
    // resolver cannot induce a loss by lying about status. Failure posture is asymmetric BY DESIGN:
    //   • an OPEN (untaken) CSD offer uses claim-to-fill — a non-claimant fill loses the FULL payment, so we
    //     fail CLOSED (refuse) when the offer can't be fetched/parsed (mirrors the website's verifyClaimSPV).
    //   • a taker-bound / status-only fill keeps today's best-effort posture (proceed on 404/unreachable),
    //     so a very recent or cross-resolver offer the tradeApi hasn't scanned yet is not false-refused.
    if (/^0x[0-9a-fA-F]{64}$/.test(String(p.proposalId))) {
      let offer: CxOfferState | null = null;
      let fetchFailed = false;
      try {
        const r0 = await fetch(`${this.tradeApi}/cairnx/offer/${encodeURIComponent(p.proposalId)}`, { signal: AbortSignal.timeout(6000) });
        if (r0.ok) offer = (await r0.json().catch(() => null)) as any;
        else if (r0.status !== 404) fetchFailed = true;   // 5xx/garbled ≠ a definitive "gone"
      } catch { fetchFailed = true; }
      if (offer && typeof offer.status === "string") {
        if (offer.status !== "open") return { ok: false, error: `offer is ${offer.status} — refusing to pay into a no-op fill (review again)`, sighashMatch: false };
        const me = this.addr();
        // Exact per-recipient output sums, BigInt end-to-end (money never rides Number arithmetic here).
        // A non-integer or ≤0 value can never build a valid tx, so refuse with the structured error shape
        // instead of letting BigInt() throw raw out of the preflight.
        const sums = new Map<string, bigint>();
        for (const o of q.outputs ?? []) {
          if (typeof o.value !== "number" || !Number.isSafeInteger(o.value) || o.value <= 0)
            return { ok: false, error: "each output value must be a positive integer amount in base units — refusing to sign", sighashMatch: false };
          const k = String(o.to).toLowerCase();
          sums.set(k, (sums.get(k) ?? 0n) + BigInt(o.value));
        }
        // the seller payment is the output sum going to want.payto (what previewFill/fillIsSafe price against)
        const payto = String((offer.want as any)?.payto || "").toLowerCase();
        const pay = sums.get(payto) ?? 0n;
        const isCsdWant = !("ticker" in ((offer.want as any) ?? {}));
        // The open-CSD lane (untaken + CSD-priced) is the whole-payment-loss lane, and its claim gate NEEDS
        // the live tip. node.tip() reports an RPC failure as 0 (get() fails soft, never throws), and
        // fillIsSafe(…, 0) would silently DISARM the claim gate (0 < V13_HEIGHT) — so an unknown tip on
        // exactly this lane fails CLOSED with the same retryable posture as the unreachable-resolver branch
        // below. Taker-bound and token-priced lanes never consult the tip, so an RPC blip changes nothing
        // for them (no false refusal on the common lane).
        const tip = (await this.tip()) ?? 0;
        if (!(tip > 0) && offer.taker === undefined && isCsdWant)
          return { ok: false, error: "couldn't fetch the chain tip to verify your claim on this open offer — try again in a moment", sighashMatch: false };
        const verdict = fillIsSafe(offer, me, pay, tip);
        if (!verdict.safe) return { ok: false, error: `refusing to sign — ${verdict.reason}`, sighashMatch: false };
        // The resolver's value gate is a per-address SUM need-map (resolve.ts whole-fill: payto ≥ want,
        // TREASURY ≥ fee, seller ≥ rebate, SUMMED when recipients coincide — payto==seller is the common
        // case; partial fill: TREASURY ≥ fee on the clamped amount). A fill that underpays any of them is
        // rejected on-chain AFTER the payment moved (the same pay-without-delivery burn class), so mirror
        // the map and refuse before signing. Pure local math over data already in hand — no added I/O.
        if (isCsdWant) {
          const need = new Map<string, bigint>();
          const addNeed = (a: string, v: bigint) => { const k = a.toLowerCase(); if (v > 0n) need.set(k, (need.get(k) ?? 0n) + v); };
          const isPartial = offer.min !== undefined && !("name" in ((offer.give as any) ?? {}));
          if (!isPartial) addNeed(payto, BigInt((offer.want as { value: string }).value)); // whole fill: full price at payto
          addNeed(TREASURY_ADDR, verdict.preview.fee);
          if (verdict.preview.rebate > 0n) addNeed(String((offer as any).seller || ""), verdict.preview.rebate);
          for (const [a, v] of need) if ((sums.get(a) ?? 0n) < v) {
            const what = a === TREASURY_ADDR.toLowerCase() ? "protocol fee output" : a === payto ? "seller payment" : "maker rebate output";
            return { ok: false, error: `refusing to sign — the ${what} is missing or underpaid; the chain would take your payment and reject the fill. Rebuild the fill with the quoted fee/rebate outputs.`, sighashMatch: false };
          }
        }
      } else if (fetchFailed) {
        // GENUINE unreachability (5xx / timeout — NOT a 404). We cannot tell the lane without the offer, and
        // an open-CSD claim-lane fill by a non-claimant loses the WHOLE payment (C2/C4), so fail closed here.
        // This is narrow: it does not fire on a 404 (a very recent / cross-resolver offer the tradeApi hasn't
        // scanned yet still proceeds below), only when the resolver is actually down — a clear retryable
        // refusal instead of a possible silent loss.
        return { ok: false, error: "couldn't confirm this offer is still fillable by you (resolver unreachable) — try again in a moment", sighashMatch: false };
      }
      // offer === null via a clean 404 → proceed (a very recent/cross-resolver offer; clear-sign + node guard).
    }
    const r = await node.fillOffer(this.rpc, q, this.must().privkey);
    const outs = Array.isArray(q.outputs) ? q.outputs : [];
    const total = outs.reduce((a, o) => a + Number(o.value || 0), 0);
    const to = outs.length === 1 ? outs[0]!.to : `${outs.length} recipients`;
    await this.maybeRecord(r, { type: "fillOffer", target: q.proposalId, to, amount: total, fee: q.fee });
    return r;
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
  async send(to: string, amount: number, fee = 1_000_000) { const r = await node.send(this.rpc, { to, amount, fee }, this.must().privkey); await this.maybeRecord(r, { type: "send", to, amount, fee }); return r; }

  // Multi-output transfer (1→many). fee default 0.01 CSD. Inputs are chosen internally
  // by node.sendMany; callers never supply UTXOs. History records the total + primary
  // recipient (single-output sends record identically to send()).
  async sendMany(p: { outputs: { to: string; value: number }[]; fee?: number }) {
    const fee = p.fee ?? 1_000_000;
    const r = await node.sendMany(this.rpc, { outputs: p.outputs, fee }, this.must().privkey);
    const total = p.outputs.reduce((a, o) => a + Number(o.value || 0), 0);
    const to = p.outputs.length === 1 ? p.outputs[0]!.to : `${p.outputs.length} recipients`;
    await this.maybeRecord(r, { type: "send", to, amount: total, fee });
    return r;
  }

  // Post a Cairn item directly: propose on-chain + register the off-chain content
  // (the content only "takes" once the tx mines, so we register in the background).
  async cairnPost(p: { domain: string; title: string; body?: string; links?: string[]; fee: number }) {
    const priv = this.must().privkey;
    const content = { v: 1, domain: p.domain, title: p.title, body: p.body ?? "", links: p.links ?? [] };
    const ph = cairnPayloadHash(content);
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / 30) + 720;
    const r = await node.propose(this.rpc, { domain: p.domain, payloadHash: ph, uri: "cairn:v1:" + ph.slice(2, 14), expiresEpoch, fee: p.fee }, priv);
    if (r.ok && r.txid) { await this.addPending(content, r.txid); this.flushPending(); } // durable, alarm-driven
    await this.maybeRecord(r, { type: "post", domain: p.domain, title: p.title, fee: p.fee });
    return r;
  }
  async cairnSupport(proposalId: string, fee: number, score = 80, confidence = 70) { const r = await node.attest(this.rpc, { proposalId, score, confidence, fee }, this.must().privkey); await this.maybeRecord(r, { type: "support", target: proposalId, fee }); return r; }

  // ── CairnX tokens + .csd names ──────────────────────────────────────────────
  // READS go to the public CairnX resolver API and NEVER throw — the popup must keep
  // showing the CSD balance even when the token API is down ({ ok:false } → quiet retry).
  async cairnxAssets(): Promise<{ ok: boolean; balances?: Record<string, { available: string; locked: string }>; names?: string[]; nameDetails?: any[]; primaryName?: string | null }> {
    try {
      const r = await fetch(`${this.tradeApi}/cairnx/address/${this.addr()}`);
      if (!r.ok) return { ok: false };
      const j = await r.json();
      const balances = (j && typeof j.balances === "object" && j.balances) || {};
      const names = Array.isArray(j?.names) ? j.names.filter((n: unknown) => typeof n === "string") : [];
      // nameDetails (lease/expiry/addr per name) + the server-computed primary name (reverse record).
      // Older services omit these → empty/null, and the popup falls back to plain name chips.
      const nameDetails = Array.isArray(j?.nameDetails) ? j.nameDetails : [];
      const primaryName = typeof j?.primaryName === "string" ? j.primaryName : null;
      return { ok: true, balances, names, nameDetails, primaryName };
    } catch { return { ok: false }; }
  }
  // Forward resolution for "send to a .csd name". Fail-CLOSED on a lapsed/expired lease so the
  // popup never routes funds to a name's stale address. Returns the nset addr if set, else the
  // owner (so a name works as a recipient even before its holder sets a resolver record).
  async resolveName(name: string): Promise<{ ok: boolean; name?: string; addr?: string; via?: string; owner?: string; lapsed?: boolean; error?: string; verified?: boolean; verifyReason?: string; depth?: number; sources?: number; agreed?: number; disagree?: boolean; viaFill?: boolean }> {
    const nm = String(name || "").toLowerCase().replace(/\.csd$/, "");
    // XREPO-1 hardening (audit nit D): validate the name against the convention's NAME_RE BEFORE
    // interpolating it into the resolver URL — a name with `/`, `..`, `%`, or query chars must never
    // reach the path. (encodeURIComponent is belt-and-braces.) A non-name can't be a real .csd name.
    if (!isPlainName(nm)) return { ok: false, error: `${nm} is not a valid .csd name` };
    try {
      const r = await fetch(`${this.tradeApi}/cairnx/resolve/${encodeURIComponent(nm)}`);
      if (r.status === 404) return { ok: false, error: `${nm}.csd is not registered` };
      if (!r.ok) return { ok: false, error: "name lookup failed" };
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
      const r = await fetch(`${this.tradeApi}/cairnx/offer/${encodeURIComponent(proposalId)}`, { signal: AbortSignal.timeout(6000) });
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
    const nm = String(name || "").toLowerCase().replace(/\.csd$/, "");
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
  async cairnxNameRenew(name: string, reviewedFee?: number) {
    const priv = this.must().privkey;
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
    const expiresEpoch = Math.floor(tip / 30) + 1000;
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee: CAIRNX_PROPOSE_FEE, outputs: [{ to: TREASURY_ADDR, value: Number(fee) }] }, priv);
    await this.maybeRecord(r, { type: "propose", domain: CAIRNX_DOMAIN, fee: CAIRNX_PROPOSE_FEE, title: `renew ${name}.csd` });
    return r;
  }
  // Set a name you own as your PRIMARY identity = point it at your own address (nset → self).
  async cairnxSetPrimary(name: string) {
    const priv = this.must().privkey;
    const built = buildNameSet({ name, addr: this.addr() });
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / 30) + 100000;
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee: CAIRNX_PROPOSE_FEE }, priv);
    await this.maybeRecord(r, { type: "propose", domain: CAIRNX_DOMAIN, fee: CAIRNX_PROPOSE_FEE, title: `set ${name}.csd primary` });
    return r;
  }
  async cairnxTokens(): Promise<{ ok: boolean; tokens?: { ticker: string; decimals: number; name?: string }[] }> {
    try {
      const r = await fetch(`${this.tradeApi}/cairnx/tokens`);
      if (!r.ok) return { ok: false };
      const j = await r.json();
      return { ok: true, tokens: Array.isArray(j) ? j : [] };
    } catch { return { ok: false }; }
  }
  // Token transfer = a cairnx:v1 Propose whose uri is the canonical transfer record,
  // payload_hash = sha256(uri), fee 0.25 CSD, NO value outputs. The record is built
  // LOCALLY (core/cairnx.ts) and validated before signing; `amount` is base units.
  async cairnxTransfer(p: { ticker: string; amount: string; to: string; decimals?: number; fee?: number }) {
    const priv = this.must().privkey;
    const built = buildTransfer({ ticker: p.ticker, amount: p.amount, to: p.to }); // throws on invalid
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / 30) + 720;
    const fee = p.fee ?? CAIRNX_PROPOSE_FEE;
    if (fee < CAIRNX_PROPOSE_FEE) throw new Error("cairnx anchor fee must be ≥ 0.25 CSD");
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee }, priv);
    await this.maybeRecord(r, {
      type: "tokenSend", ticker: p.ticker, to: String(p.to).toLowerCase(), amount: p.amount,
      human: typeof p.decimals === "number" ? formatUnits(p.amount, p.decimals) : p.amount, fee,
    });
    return r;
  }

  // ── sealed claims (commit-reveal) — isolated per active account ─────────────
  async sealClaim(p: { domain?: string; claim: string; fee?: number }) {
    const priv = this.must().privkey;
    const domain = (p.domain && p.domain.trim()) || "csd:sealed";
    const nonce = bytesToHex(randomBytes(32));
    const content = { v: 1, sealed: 1, domain, claim: p.claim, nonce };
    const ph = cairnPayloadHash(content);
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / 30) + 720;
    const fee = p.fee ?? 25_000_000; // propose min 0.25 CSD
    const r = await node.propose(this.rpc, { domain, payloadHash: ph, uri: "cairn:seal:v1:" + ph.slice(2, 14), expiresEpoch, fee }, priv);
    if (r.ok && r.txid) {
      const k = sealKey(this.addr());
      const list: any[] = (await this.store.get(k)) || [];
      if (!list.find((x) => x.txid === r.txid)) list.unshift({ txid: r.txid, domain, claim: p.claim, nonce, committedTs: Date.now(), revealed: false });
      await this.store.set(k, list.slice(0, 500));
      await this.maybeRecord(r, { type: "seal", domain, fee });
    }
    return r;
  }
  async revealClaim(txid: string) {
    const k = sealKey(this.addr());
    const list: any[] = (await this.store.get(k)) || [];
    const rec = list.find((x) => x.txid === txid);
    if (!rec) return { ok: false, error: "no sealed claim with that txid in this account" };
    const r = await node.registerContent(this.api, { v: 1, sealed: 1, domain: rec.domain, claim: rec.claim, nonce: rec.nonce }, txid);
    if (r && r.ok) { rec.revealed = true; await this.store.set(k, list); }
    return r;
  }
  sealedClaims(): Promise<any[]> { if (!this.accts) return Promise.resolve([]); return this.store.get(sealKey(this.addr())).then((l: any[]) => l || []); }

  // ── transaction history — isolated per active account ──────────────────────
  private async maybeRecord(r: { ok?: boolean; txid?: string }, meta: Record<string, unknown>) {
    if (r && r.ok && r.txid) await this.recordTx({ txid: r.txid, ts: Date.now(), ...meta });
  }
  private async recordTx(entry: Record<string, unknown>) {
    const k = histKey(this.addr());
    const h: any[] = (await this.store.get(k)) || [];
    if (h.find((x) => x.txid === entry.txid)) return; // idempotent
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
  async flushPending(): Promise<void> {
    const list: any[] = (await this.store.get("pendingContent")) || [];
    if (!list.length) return;
    const keep: any[] = [];
    for (const x of list) {
      if (Date.now() - (x.ts || 0) > 86400000) continue;        // expire after 24h
      try {
        const p = await node.getProposal(this.rpc, x.txid);
        if (!(p && p.payload_hash)) { keep.push(x); continue; }  // not mined yet → retry later
        await node.registerContent(this.api, x.content, x.txid); // mined: register (server self-certifies vs hash)
      } catch { keep.push(x); }                                  // transient/network error → retry later
    }
    await this.store.set("pendingContent", keep);
  }
  hasPending(): Promise<boolean> { return this.store.get("pendingContent").then((l: any[]) => !!(l && l.length)); }

  // Reveal the ACTIVE account's private key — requires re-entering the password.
  async exportKey(password: string): Promise<string> {
    const v: Vault | null = await this.store.get("vault"); if (!v) throw new Error("no wallet");
    const doc = await this.withAuthGuard(async () => openWith(v, await deriveVaultKey(password, v.salt, v.iter)));
    let parsed: VaultDoc | null = null;
    try { const p = JSON.parse(doc); if (p && Array.isArray(p.accounts)) parsed = p; } catch { /* legacy raw key */ }
    if (!parsed) return doc.startsWith("0x") ? doc : "0x" + doc; // legacy single-key vault
    const i = this.accts ? this.active : (parsed.active ?? 0);
    return parsed.accounts[Math.min(i, parsed.accounts.length - 1)].priv;
  }

  // Reveal the wallet's recovery phrase (the master backup) — password-gated. Throws
  // for legacy/import-only wallets that have no seed phrase.
  async exportMnemonic(password: string): Promise<string> {
    const v: Vault | null = await this.store.get("vault"); if (!v) throw new Error("no wallet");
    const doc = await this.withAuthGuard(async () => openWith(v, await deriveVaultKey(password, v.salt, v.iter)));
    let parsed: VaultDoc | null = null;
    try { const p = JSON.parse(doc); if (p && Array.isArray(p.accounts)) parsed = p; } catch { /* legacy */ }
    if (!parsed?.mnemonic) throw new Error("this wallet has no recovery phrase (it was created from an imported key)");
    return parsed.mnemonic;
  }

  // Wipe ALL wallet state — every account's vault, history, and sealed-claim
  // preimages — so a freshly-created wallet can't surface a prior owner's data.
  async reset(): Promise<void> {
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    await this.lock();
    for (const w of wallets) { await this.store.del(histKey(w.addr)); await this.store.del(sealKey(w.addr)); }
    for (const k of ["vault", "wallets", "active", "addr", "txHistory", "sealedClaims", "pendingContent"]) await this.store.del(k);
  }
}
