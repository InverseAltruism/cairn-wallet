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
import { buildTransfer, buildNameRenew, buildNameSet, nameRegFee, buildFeeHeight, feePricingTip, formatUnits, cairnxTradeFee, CONF_TOKEN_FILL, SCORE_FILL, FEE_BPS_V16, isTicker, type TokenDisplayMeta, CAIRNX_DOMAIN, CAIRNX_PROPOSE_FEE, TREASURY_ADDR, defaultFeeFor } from "./cairnx.js";
import { EPOCH_LEN } from "../vendor/cairnx-spv.js";
import { liveSpvSource, type LiveSpvOpts, type NameVerification, type SpvSource } from "./namespv.js";
import type { SpvPin } from "./spvpin.js";
import { openHeaderStore } from "./headerstore.js";
import { liveFillSpvSource, provenOfferPayto } from "./fillspv.js";
import { refuse } from "./refuse.js";
import { fillOfferPreflight, type FillPreflightIo, type FillRefusal, type FillNotes, type FillSpvIoExt, type ProvenOfferPayto, type TokenFillQuote } from "./fillpreflight.js";
import { DEFAULT_EXPLORER } from "./explorer.js";
import { DEFAULT_RPC, DEFAULT_API, DEFAULT_TRADE_API, validRpcUrl, RPC_URL_ERR, rpcAllowed, RPC_LOCAL_ERR } from "./endpoints.js";
import type { HintSetEntry } from "./namecache.js";
import { TxHistory, histKey } from "./history.js";
import { SealedClaims, sealKey } from "./claims.js";
import { resolveName, verifyName, confirmName, type NameIo, type NameResolution } from "./names.js";
export { EXPLORER_PRESETS, DEFAULT_EXPLORER, explorerLink } from "./explorer.js";

import { randomBytes, bytesToHex } from "@noble/hashes/utils";

export interface PubAcct { addr: string; label: string; imported?: boolean }
export interface WalletStatus { hasVault: boolean; unlocked: boolean; addr: string | null; accounts: PubAcct[]; active: number; rpc: string; api: string; tradeApi: string; explorer: string; hasMnemonic: boolean; rpcMovedFrom: string | null }

// An in-memory account: its key + label, plus how it was created; `index` is its
// BIP-44 derivation index (HD accounts), `imported` marks a raw-key account that is
// NOT recoverable from the seed phrase.
type Acct = Account & { label: string; index?: number; imported?: boolean };
// The cleartext account list mirrored beside the vault for the locked UI (no key material).
const mirrorOf = (accts: Acct[]): PubAcct[] => accts.map((a) => ({ addr: a.addr, label: a.label, imported: a.imported }));
// Encrypted-vault document (the plaintext sealed under the password). v2 adds the
// HD seed phrase + the next free derivation index; v1 (no mnemonic) still opens.
interface StoredAcct { priv: string; label: string; index?: number; imported?: boolean }
interface VaultDoc { v: 1 | 2; mnemonic?: string; nextIndex?: number; accounts: StoredAcct[]; active: number }
// The in-memory unlocked state a vault doc is built from.
interface VaultState { mnemonic: string | null; nextIndex: number; accts: Acct[] | null; active: number }

// The idle window shared by the wallet's auto-lock AND its session-rehydrate expiry, and by the
// background alarm that ENFORCES the lock. Exported so the decoy default here and background's
// AUTO_LOCK_MS can never drift out of one another (they were two independent 15-min literals).
export const AUTO_LOCK_MS = 15 * 60 * 1000; // 15 min

// The frozen signing context captured before a flow's first await (A1, Plans/68): the account
// slot, its address, its key, and the history key entries must file under. Immutable snapshot:
// a later switchAccount cannot retro-change what was captured.
interface SignerCtx { active: number; addr: string; priv: string; histKey: string }
// Shared refusal for a signer mismatch detected at the sign tick (mirrors the background's
// pre-dispatch M5 guard copy; same machine code, WALLET-ERROR-CODES.md).
const ACCOUNT_CHANGED_REFUSAL = (): node.SubmitResult => refuse("ACCOUNT_CHANGED",
  "the active account changed since you reviewed this request — reopen it and review again before approving");
// XR-1/FL-1: a fill whose on-chain score is present but is not the marketplace-required SCORE_FILL (100).
// The real cairnx resolve() silently NO-OPS any other score AFTER the payment moved (the SCORE-BURN class),
// so we refuse (not coerce) a present-and-wrong caller score before signing. The site never passes a score
// (CSD lanes default; the token lane passes 100), so this declines no honest fill (WALLET-ERROR-CODES.md).
const SCORE_FILL_REFUSAL = (): node.SubmitResult => refuse("FILL_UNSAFE", "refusing to sign: this fill's score is not the value the marketplace requires, so the chain would ignore it and your payment would be lost. Retry the purchase from the site's Buy button.");

// Record-expiry windows, in epochs of the vendored EPOCH_LEN blocks. Each +N offset below sets a Propose's
// expiresEpoch = currentEpoch + window.
const PROPOSE_EXPIRY_EPOCHS = 720;        // content post / token transfer / sealed claim; ample window to mine
const NAME_RENEW_EXPIRY_EPOCHS = 1000;    // .csd lease renewal propose
const SET_PRIMARY_EXPIRY_EPOCHS = 100000; // set-primary nset; a long-lived identity record
// Attest fee floor (0.05 CSD): the default fee for an atomic offer fill (Attest + payment in one tx).
// B9: single-sourced into core/cairnx.ts defaultFeeFor("attest"); the same table the clear-sign
// display reads, so the screen and the signer can never disagree again (the local literal was the twin).
// The app-layer confidence SENTINEL for a token-priced fill. NOT consensus math - it is the value the trade
// UI stamps so a fill against a token-want offer is distinguishable from a board-support attest (70/80). W4
// (B5d) routes on it. B7e: SINGLE-SOURCED from the vendored cairnx-core (imported above) instead of a local
// literal, so the wallet, the clearsign/approve popup formatters and the resolver all read the same value.

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
  explorer = DEFAULT_EXPLORER; // selected block explorer (preset id or custom https base); navigation-only
  // Idle window for auto-lock and session-rehydrate expiry.
  idleMs = AUTO_LOCK_MS;
  // 0.2.70: in-memory hint-set cache for confirm-time skip (background Wallet, never the popup).
  // Dropped on SW death → next confirm full-verifies (safe). Never persisted.
  private nameHints = new Map<string, HintSetEntry>();
  /** Test seam: inject a synthetic SpvSource (hashAt / confirm skip). */
  nameSpvForTest?: SpvSource;
  /** Test seam: replaces liveSpvSource as the singleton's builder (the singleton and the setters stay real). */
  spvBuildForTest?: (opts: LiveSpvOpts) => Promise<SpvSource>;
  // Bumped on every endpoint change. A name verification or confirm that started under an older value is
  // superseded: it may finish, but it never writes or reads the hint-set cache.
  private spvGen = 0;
  /** Test seam: inspect / seed the hint-set cache. */
  nameHintCacheForTest(): Map<string, HintSetEntry> { return this.nameHints; }
  // `session` is chrome.storage.session (in-RAM) when running as an extension, else null. It lets the
  // unlocked key survive an MV3 service-worker idle-kill so genuine activity within idleMs doesn't
  // keep re-prompting for the password. null ⇒ in-memory-only (the old behaviour).
  private hist: TxHistory;
  private claims: SealedClaims;
  constructor(private store: Store, private session: Store | null = null) {
    this.hist = new TxHistory(store, { unlocked: () => !!this.accts, wiped: () => this.wiped, addr: () => this.addr(), rpc: () => this.rpc });
    this.claims = new SealedClaims(store, {
      unlocked: () => !!this.accts, wiped: () => this.wiped, addr: () => this.addr(), rpc: () => this.rpc,
      api: () => this.api, vaultKey: () => this.vaultKey, salt: () => this.salt, iter: () => this.iter,
    });
  }

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
      // first-party; it must use the audience-bound signInWithCsd(), closing the broad confused-deputy
      // surface where any local app on any port could invoke the session-minting legacy signIn().
      const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
      return isLocal(o.hostname) && isLocal(apiO.hostname);
    } catch { return false; }
  }

  async init(): Promise<void> {
    const savedRpc: string = (await this.store.get("rpc")) || DEFAULT_RPC;
    this.rpc = rpcAllowed(savedRpc) ? savedRpc : DEFAULT_RPC;
    if (this.rpc !== savedRpc) {
      // A saved remote RPC moves to the Cairn proxy; the popup says so once (rpcNotice, dismissRpcNotice).
      await this.store.set("rpc", DEFAULT_RPC);
      await this.store.set("rpcMovedFrom", savedRpc);
    }
    const customs = await this.rpcList();
    if (customs.some((u) => !rpcAllowed(u))) await this.store.set("customRpcs", customs.filter(rpcAllowed));
    this.api = (await this.store.get("api")) || DEFAULT_API;
    this.tradeApi = (await this.store.get("tradeApi")) || DEFAULT_TRADE_API;
    this.explorer = (await this.store.get("explorer")) || DEFAULT_EXPLORER;
    await this.rehydrateSession(); // restore an unlocked session across SW restarts (within idleMs)
  }
  // The SPV source reads block bodies from `rpc` and headers from `api`, so a changed endpoint drops it, and the
  // hint-set cache, whose header hashes came from it.
  async setRpc(u: string) { if (!rpcAllowed(u)) throw new Error(RPC_LOCAL_ERR); if (u !== this.rpc) this.endpointChanged(); this.rpc = u; await this.store.set("rpc", u); }
  async setApi(u: string) { if (!validRpcUrl(u)) throw new Error("API " + RPC_URL_ERR); if (u !== this.api) this.endpointChanged(); this.api = u; await this.store.set("api", u); }
  private endpointChanged(): void { this._spvSrc = null; this.spvGen++; this.nameHints.clear(); }
  async setTradeApi(u: string) { if (u && !validRpcUrl(u)) throw new Error("trade API " + RPC_URL_ERR); this.tradeApi = u || DEFAULT_TRADE_API; await this.store.set("tradeApi", this.tradeApi); }
  // User-added custom RPC URLs (for the header RPC switcher). Plain config, no secrets.
  async rpcList(): Promise<string[]> { return (await this.store.get("customRpcs")) || []; }
  async addRpc(u: string): Promise<void> { if (!rpcAllowed(u)) throw new Error(RPC_LOCAL_ERR); const l = await this.rpcList(); if (!l.includes(u)) { l.push(u); await this.store.set("customRpcs", l.slice(0, 20)); } }
  async removeRpc(u: string): Promise<void> { await this.store.set("customRpcs", (await this.rpcList()).filter((x) => x !== u)); }
  // status().rpcMovedFrom carries the remote RPC init() replaced until the popup has shown the notice once.
  async dismissRpcNotice(): Promise<void> { await this.store.del("rpcMovedFrom"); }
  // Block-explorer selection (navigation-only; preset id "cairn"/"official" or a custom https base).
  async setExplorer(v: string): Promise<void> {
    if (v === "cairn" || v === "official") { this.explorer = v; await this.store.set("explorer", v); return; }
    if (!validRpcUrl(v)) throw new Error("explorer must be a preset or an https:// URL (or http://localhost)");
    const norm = new URL(v).href; // canonicalize; encodes any href-breakout chars before it is ever rendered (defense-in-depth vs EXP-XSS)
    this.explorer = norm; await this.store.set("explorer", norm);
  }
  async explorerList(): Promise<string[]> { return (await this.store.get("customExplorers")) || []; }
  async addExplorer(u: string): Promise<void> { if (!validRpcUrl(u)) throw new Error("explorer " + RPC_URL_ERR); const norm = new URL(u).href; const l = await this.explorerList(); if (!l.includes(norm)) { l.push(norm); await this.store.set("customExplorers", l.slice(0, 20)); } }
  async removeExplorer(u: string): Promise<void> { await this.store.set("customExplorers", (await this.explorerList()).filter((x) => x !== u)); }

  async status(): Promise<WalletStatus> {
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    const active = this.accts ? this.active : (((await this.store.get("active")) as number) ?? 0);
    const addr = this.accts ? (this.accts[this.active]?.addr ?? null) : (wallets[active]?.addr ?? null);
    return { hasVault: !!(await this.store.get("vault")), unlocked: !!this.accts, addr, accounts: wallets, active, rpc: this.rpc, api: this.api, tradeApi: this.tradeApi, explorer: this.explorer, hasMnemonic: !!this.mnemonic, rpcMovedFrom: (await this.store.get("rpcMovedFrom")) || null };
  }

  // Persist the in-memory accounts: re-seal the vault (fresh IV, same salt+key, incl.
  // the HD seed + next index) and mirror the public list (addresses + labels + whether
  // each is an imported non-HD key) in cleartext for the UI.
  // Serialize the in-memory unlocked state into the encrypted-vault plaintext. Single source for the doc
  // shape shared by persistVault (re-seal) and sealFresh (first seal), so the two can't drift.
  private buildDoc(s: VaultState = { mnemonic: this.mnemonic, nextIndex: this.nextIndex, accts: this.accts, active: this.active }): VaultDoc {
    return {
      v: 2, mnemonic: s.mnemonic ?? undefined, nextIndex: s.nextIndex,
      accounts: (s.accts ?? []).map((a) => ({ priv: a.privkey, label: a.label, index: a.index, imported: a.imported })),
      active: s.active,
    };
  }

  // SERIALIZED (persistVault-race, fund-safety fresh-eyes): account-mgmt ops mutate this.accts
  // SYNCHRONOUSLY, then await persistVault. Without serialization two overlapping calls could each
  // seal a doc built at a different instant and let the STALE write land last; permanently dropping a
  // just-added IMPORTED (non-seed-recoverable) key. Chaining every persist behind one promise makes the
  // last write reflect the final account set (each queued persist re-reads this.accts, which by then
  // holds every prior synchronous mutation). The cleartext mirror is captured from the SAME pre-await
  // snapshot as the sealed doc, so the vault ciphertext and the mirror can never diverge intra-call.
  // Throw-safe: the chain always continues (both settle paths run the next persist; persistChain is
  // reset to an always-resolved promise) and each caller still observes its own rejection.
  private persistChain: Promise<void> = Promise.resolve();
  private persistVault(write: () => Promise<void> = () => this.doPersistVault()): Promise<void> {
    const run = this.persistChain.then(write, write);
    this.persistChain = run.then(() => {}, () => {});
    return run;
  }
  private async doPersistVault(): Promise<void> {
    if (!this.accts || !this.vaultKey) throw new Error("locked");
    const doc = this.buildDoc();
    // capture the cleartext mirror from the SAME synchronous state as `doc`, BEFORE the async seal
    const mirror = mirrorOf(this.accts);
    const active = this.active;
    const vault = await sealWith(JSON.stringify(doc), this.vaultKey, this.salt, this.iter);
    await this.writeVault(vault, mirror, active);
  }
  private async writeVault(vault: Vault, mirror: PubAcct[], active: number): Promise<void> {
    await this.store.set("vault", vault);
    await this.store.set("wallets", mirror);
    await this.store.set("active", active);
  }

  // Set by reset(), cleared when a new vault is sealed. `!this.accts` alone cannot tell an ordinary lock
  // (the signed tx's history must survive it) from a reset (nothing of the old wallet may land again).
  private wiped = false;

  private acct(priv: string, label: string, extra: { index?: number; imported?: boolean } = {}): Acct { return { ...fromPriv(priv), label, ...extra }; }

  // Seal and store a brand-new vault for `next`, then adopt `next` as the unlocked state. Nothing on
  // `this` changes until the seal (password check included) and the store write have succeeded, so a
  // refused password or a failed write leaves the wallet exactly as it was.
  private async sealFresh(password: string, next: VaultState) {
    const { vault, key } = await sealNew(JSON.stringify(this.buildDoc(next)), password);
    await this.persistVault(() => this.writeVault(vault, mirrorOf(next.accts ?? []), next.active));
    this.mnemonic = next.mnemonic; this.nextIndex = next.nextIndex; this.accts = next.accts; this.active = next.active;
    this.vaultKey = key; this.salt = vault.salt; this.iter = vault.iter;
    this.wiped = false;
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
    await this.sealFresh(password, { mnemonic, nextIndex: 1, accts: [a], active: 0 });
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
    await this.sealFresh(password, { mnemonic: m, nextIndex: 1, accts: [a], active: 0 });
    return { addr: a.addr };
  }
  // Import a single raw private key (NOT part of any seed phrase → no recovery phrase).
  async importKey(priv: string, password: string): Promise<{ addr: string }> {
    if (await this.store.get("vault")) throw new Error("wallet already exists — reset first to replace the key");
    const a = this.acct(priv, "Account 1", { imported: true }); // fromPriv validates
    await this.sealFresh(password, { mnemonic: null, nextIndex: 0, accts: [a], active: 0 });
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
  // throws "bad password" on a GCM-tag mismatch; INSIDE the guard, so a wrong password is counted.
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
    // Rows parked while locked are written now rather than waiting for the next write of their kind.
    if (this.hist.pendingHist.length) await this.hist.inHistChain(() => this.hist.drainPendingHist());
    if (this.claims.pendingSeals.length) await this.claims.persistSeal();
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
    // W4 (AW-SEAL-LOCK-1): lock() no longer wipes the parked arrays. `pendingSeals` holds a PAID commit's
    // reveal nonce (already vault ciphertext at the park site) and `pendingHist` holds the parked history
    // rows behind the double-pay backstop; both are the only copy after a failed storage write, so an idle
    // auto-lock destroyed a paid commit's only reveal secret. Neither carries key material, so surviving a
    // lock leaks nothing. doReset() still clears both independently (its own comment calls that the belt for
    // a park that raced lock), so reset discipline is unchanged. HONESTY: both arrays are RAM on the MV3
    // service worker and die at SW idle kill regardless, so this buys survival across lock/unlock inside ONE
    // service-worker lifetime, and is not durability.
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
    // without a backup is PERMANENT fund loss; and it was one click. Imported removal now requires a
    // password re-auth through the same brute-guarded gate as export (openVaultDoc; the decrypted doc
    // is discarded, nothing is revealed). HD accounts stay one-click: they re-derive from the phrase.
    // REMOVE_IMPORTED_REAUTH is a popup-handled sentinel (FEE_CHANGED precedent), not a dApp code:
    // removeAccount is popup-only (never in DAPP_METHODS).
    if (accts[i].imported) {
      if (!password) throw new Error("REMOVE_IMPORTED_REAUTH");
      const v: Vault | null = await this.store.get("vault"); if (!v) throw new Error("no wallet");
      await this.openVaultDoc(v, password); // throws "bad password" (and increments the guard) on failure
      // TOCTOU (fresh-eyes 0.2.57 finding 1): the KDF await above is the ONLY await between findIndex
      // and splice, and a concurrent removal can mutate accts while this call is parked; splicing the
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
    // P75-6: ride the chains so a parked write for this account cannot land AFTER these deletes
    // and resurrect a removed account's history or sealed preimages; purge its parked retries too.
    const hk2 = histKey(gone), sk2 = sealKey(gone);
    await this.hist.inHistChain(async () => { this.hist.pendingHist = this.hist.pendingHist.filter((p) => p.k !== hk2); await this.store.del(hk2); });
    await this.claims.inSealChain(async () => { this.claims.pendingSeals = this.claims.pendingSeals.filter((p) => p.k !== sk2); await this.store.del(sk2); });
    await this.persistVault();
  }

  private must(): Acct { if (!this.accts) throw new Error("locked"); return this.accts[this.active]; }
  private addr(): string { return this.must().addr; }

  // ── signing-context integrity (A1, Plans/68 FILL-RACE-1) ─────────────────────────────────────
  // Every signing method captures its key SYNCHRONOUSLY at entry; except fillOffer, whose
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
  // precedent) rather than a structured SubmitResult; same guard, single source for the copy.
  private throwOnSignerChange(expectSigner: string | undefined): void {
    if (expectSigner && expectSigner.toLowerCase() !== this.addr().toLowerCase()) throw new Error(ACCOUNT_CHANGED_REFUSAL().error);
  }

  // Timed GET against the CairnX read API. RETURNS the Response and NEVER throws on a non-2xx; every caller
  // discriminates status / parses / catches itself, so each keeps its own fail-soft (display reads) vs
  // fail-closed (fillOffer/resolveName money paths) posture exactly. A network error / timeout abort throws
  // out of fetch → the caller's own try/catch handles it. The 12s default sits ABOVE the /trade/api
  // proxy's 10s upstream wait (CAIRN_PROXY_TIMEOUT_MS); the old 6s default aborted while the proxy
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
  // Current epoch (= floor(tip/30), matching this wallet's own propose math); lets the approval
  // window show a dApp-supplied expiresEpoch as a real "expires in N days from now". Best-effort:
  // returns null offline so the clear-signer just shows the raw epoch.
  async epoch(): Promise<number | null> { try { return Math.floor((await node.tip(this.rpc)) / EPOCH_LEN); } catch { return null; } }
  // CLEARSIGN-FEE-1: exact tip for the clear-sign fee-sufficiency check on a dApp-built name registration/
  // renewal (epoch*30 is too coarse near a fee-gate boundary). Best-effort; null when offline.
  async tip(): Promise<number | null> { try { return await node.tip(this.rpc); } catch { return null; } }
  // M9/M11/W5 (B5b): the persisted PoW-backed tip floor (advanced only by namespv floorAdvance after a
  // successful sync; see B5a). Guards clamp the raw served tip UP with it so a deflating RPC cannot roll
  // the wallet's view of the chain backwards. Fresh install = 0 (guards disarmed, fail-open-SAFE; stated
  // coverage limit, not assumed away). Popup-only read; never a dApp method.
  async tipFloor(): Promise<number> { try { return Number(await this.store.get("spvNodeTipFloor")) || 0; } catch { return 0; } }
  async propose(p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee?: number; outputs?: { to: string; value: number }[] }) {
    // B9: an omitted fee signs defaultFeeFor("propose"); the node-enforced MIN_FEE_PROPOSE floor the
    // clear-sign screen displayed (was: the build ERRORED BadFee AFTER the user approved a screen that
    // showed a 0.01 CSD the node would have rejected anyway). An explicit sub-floor fee still refuses.
    const fee = p.fee ?? defaultFeeFor("propose");
    const hk = this.histKeyNow(); const r = await node.propose(this.rpc, { ...p, fee }, this.must().privkey); await this.hist.maybeRecord(hk, r, { type: "propose", domain: p.domain, fee }); return r;
  }
  async attest(p: { proposalId: string; score: number; confidence: number; fee?: number; expectSigner?: string; tokenQuote?: TokenFillQuote }) {
    // W4 (B5d): a token-fill-confidence attest is BYTE-IDENTICAL on-chain to a token fillOffer (the same
    // App=Attest expression, outputs:[]), so an attest(score, confidence=CONF_TOKEN_FILL) was the fill
    // path stripped of its preflight - no OFFER_UNKNOWN gate, no captureSigner, paying into a proposal the
    // resolver may never settle. Route on the ARTIFACT SHAPE, never the method name: any token-fill-
    // confidence attest goes through the SAME gated fill path fillOffer uses (which runs fillOfferPreflight
    // + signer capture and files a truthful `fillOffer` history entry). A board-support attest (confidence
    // 70/80) is untouched. This is the cheap half of W1; it does not depend on W2's term binds.
    //
    // OUTPUTS FORCED EMPTY (G8 Opus-B HIGH): the attest method must NEVER carry CSD outputs. A token fill's
    // payment is the off-ledger token debit; its on-chain tx is the Attest with outputs:[] (requiredFill-
    // Outputs returns [] for a token want). Threading a caller's `outputs` through here would let a dApp
    // pay arbitrary CSD to any address via the attest method, whose clear-sign window renders NO outputs
    // and whose debit line counts only the fee (a WYSIWYS bypass -> silent CSD theft). So the route hardcodes
    // outputs:[] and the method does not accept an outputs param at all - a token fill never has CSD outputs.
    if ((Number(p.confidence ?? 100) >>> 0) === CONF_TOKEN_FILL)
      return this.fillOffer({ proposalId: p.proposalId, outputs: [], score: p.score, confidence: p.confidence, fee: p.fee, expectSigner: p.expectSigner, tokenQuote: p.tokenQuote });
    // B9: an omitted fee signs defaultFeeFor("attest"); the node-enforced MIN_FEE_ATTEST floor the
    // clear-sign screen displayed (was: the build ERRORED BadFee AFTER approval of a self-contradictory
    // screen: fee row "0 CSD", cost row "0.05 CSD"). fillOffer has always defaulted the same floor.
    const fee = p.fee ?? defaultFeeFor("attest");
    const hk = this.histKeyNow(); const r = await node.attest(this.rpc, { ...p, fee }, this.must().privkey); await this.hist.maybeRecord(hk, r, { type: "support", target: p.proposalId, fee }); return r;
  }
  // Atomic fill (Attest + payment in ONE tx; CairnX delivery-versus-payment). fee default 0.05 CSD (attest floor).
  // A1 (Plans/68 FILL-RACE-1): the ONLY signing method with awaits between validation and the key read.
  // Ordering is load-bearing: capture the signer BEFORE the preflight await (so the account the preflight
  // validates IS the account that signs), re-assert it AFTER the last await and immediately before the
  // sign, and sign/record with the CAPTURED key/histKey; a switchAccount parked in the preflight's offer
  // or tip await now refuses (ACCOUNT_CHANGED) instead of paying from the wrong account.
  async fillOffer(p: { proposalId: string; score?: number; confidence?: number; outputs: { to: string; value: number }[]; fee?: number; expectSigner?: string; tokenQuote?: TokenFillQuote; reservationAck?: string }) {
    const ctx = this.captureSigner();
    const early = this.expectSignerRefusal(p.expectSigner, ctx.addr);
    if (early) return early;
    // XR-1/FL-1: a fill's on-chain score MUST be SCORE_FILL (100). The real cairnx resolve() silently
    // NO-OPS any other score AFTER the payment moved (the SCORE-BURN class). The site never passes a
    // score (CSD lanes use the default; the token lane passes 100), so refusing a caller score that is
    // present-and-not-100 breaks no honest fill. Refuse, do not coerce, so a mis-built dApp fill fails
    // loudly instead of burning; the SIGNED score is hardcoded below regardless.
    // W3 (N-05): `!= null` covers BOTH undefined and null. `!== undefined` alone caught null, and
    // `null >>> 0` is 0 != SCORE_FILL, so a caller passing an explicit `score: null` (a shape store
    // 0.2.64 accepted, since this guard has never shipped) was refused for no reason. Absent means
    // absent, however it is spelled; a score that is PRESENT and not 100 is still refused.
    if (p.score != null && (p.score >>> 0) !== SCORE_FILL) return SCORE_FILL_REFUSAL(); // MUTATE_SCORE_GUARD
    const q = { proposalId: p.proposalId, score: SCORE_FILL, confidence: (p.confidence ?? 100) >>> 0, outputs: p.outputs, fee: p.fee ?? defaultFeeFor("attest") };
    const notes: FillNotes = {};
    const refusal = await this.fillOfferPreflight(q.proposalId, q.outputs, ctx.addr, p.tokenQuote, p.reservationAck, notes);
    if (refusal) return refusal;
    if (!this.signerUnchanged(ctx)) return ACCOUNT_CHANGED_REFUSAL();
    const r = await node.fillOffer(this.rpc, q, ctx.priv);
    const { total, to } = this.summarizeOutputs(Array.isArray(q.outputs) ? q.outputs : []);
    await this.hist.maybeRecord(ctx.histKey, r, { type: "fillOffer", target: q.proposalId, to, amount: total, fee: q.fee });
    return r.ok && notes.secondSource ? { ...r, secondSource: notes.secondSource } : r;
  }

  // The reads the fill preflight makes through this wallet. Each one calls the wallet method when it runs, so the
  // endpoints in force and the test seams (fillSpvIoForTest, provenPaytoForTest) apply.
  private fillIo: FillPreflightIo = {
    tradeGet: (path) => this.tradeGet(path),
    tip: () => this.tip(),
    tipFloor: () => this.tipFloor(),
    makeProvenOfferPayto: (offerId, offerHeight) => this.makeProvenOfferPayto(offerId, offerHeight),
    makeFillSpvIo: (offerId, fclaimTxid, me, offerHeight) => this.makeFillSpvIo(offerId, fclaimTxid, me, offerHeight),
  };
  private fillOfferPreflight(proposalId: string, outputs: { to: string; value: number }[], me: string, reviewedQuote?: TokenFillQuote, reservationAck?: string, notes?: FillNotes): Promise<FillRefusal | null> {
    return fillOfferPreflight(this.fillIo, proposalId, outputs, me, reviewedQuote, reservationAck, notes);
  }

  // Test seam (fill-SPV fund boundary): production leaves this undefined and builds the LIVE PoW-verified
  // FillSpvIo; tests inject a synthetic (PoW/merkle pre-satisfied) io so the vendored verifyFillSpv boundary
  // is exercised through the real preflight without a chain. The io carries the computed cap over-count.
  fillSpvIoForTest?: (offerId: string, fclaimTxid: string, me: string) => FillSpvIoExt | Promise<FillSpvIoExt>;
  private async makeFillSpvIo(offerId: string, fclaimTxid: string, me: string, offerHeight: number): Promise<FillSpvIoExt> {
    if (this.fillSpvIoForTest) return await this.fillSpvIoForTest(offerId, fclaimTxid, me);
    // BP4/N11: reuse the wallet's ONE PoW light client (its restored + synced header chain) instead of building
    // a fresh one per fill attempt (each fresh build re-pays the O(chain) snapshot restore). Same rpc/api/cache/
    // floor as the singleton, so this only changes transport, never what is verified. The source's prepare()
    // serializes LC.sync, so sharing it with a concurrent name verify cannot interleave ingests.
    return await liveFillSpvSource({
      ...this.spvOpts(),
      hints: { offerId, fclaimTxid, me, offerHeight }, spvSource: await this.spvSource(),
      // Served height only selects the block the source merkle-proves the other offer in.
      offerHeightOf: async (id) => {
        const r = await this.tradeGet(`/cairnx/offer/${encodeURIComponent(id)}`);
        if (!r.ok) return null;
        const h = Number(((await r.json()) as { height?: unknown } | null)?.height);
        return Number.isSafeInteger(h) && h >= 0 ? h : null;
      },
    });
  }

  // Test seam (F2-legacy payment-recipient bind): production leaves this undefined and merkle-proves the offer
  // author over the LIVE light client; tests inject the proven { payto, seller } (or null to exercise the
  // fail-closed-retryable path) so the legacy-lane bind is exercised without a chain.
  provenPaytoForTest?: (offerId: string, offerHeight: number) => (ProvenOfferPayto | null) | Promise<ProvenOfferPayto | null>;
  private async makeProvenOfferPayto(offerId: string, offerHeight: number): Promise<ProvenOfferPayto | null> {
    if (this.provenPaytoForTest) return await this.provenPaytoForTest(offerId, offerHeight);
    // BP4/N11: reuse the shared light client (see makeFillSpvIo). Transport only.
    return await provenOfferPayto({
      ...this.spvOpts(),
      offerId, offerHeight, spvSource: await this.spvSource(),
    });
  }

  signIn() { return node.signIn(this.api, this.must().privkey); }

  // Audience-bound "Sign in with CSD" (SIWC) for THIRD-PARTY sites; the secure replacement for the
  // legacy first-party-only signIn(). The wallet builds a CAIP-122-style message binding the
  // requesting site's domain (derived from the UNFORGEABLE sender.origin, NEVER a dApp-asserted
  // string), the RP's single-use nonce, the chain id, and an issued-at/expiration window; signs the
  // domain-separated SIWC digest; and returns ONLY the signed artifact. It NEVER talks to cairn's
  // /auth and NEVER mints a session; the dApp's own server verifies (verifySiwc) and issues its own
  // session. `origin` is supplied by the background from sender.origin (browser-set, unforgeable).
  async signInWithCsd(
    params: { nonce?: unknown; statement?: unknown; uri?: unknown; domain?: unknown; expirationSecs?: unknown; notBeforeSecs?: unknown; requestId?: unknown; resources?: unknown },
    origin: string,
  ): Promise<{ account: string; pub33: string; sig64: string; message: string; chainId: string }> {
    const a = this.must();
    const domain = originToDomain(origin);
    if (!domain) throw new Error("sign-in: unknown requesting origin");
    const p = params || {};
    // The page MAY pass its domain, but it is only cross-checked against the real origin; never trusted.
    if (p.domain !== undefined && String(p.domain) !== domain) throw new Error("sign-in: declared domain does not match the requesting site");
    // uri defaults to the origin root; if supplied it MUST be on the requesting site.
    let uri: string;
    if (p.uri === undefined || p.uri === null) uri = origin.replace(/\/+$/, "") + "/";
    else { let h: string | null; try { h = new URL(String(p.uri)).host; } catch { h = null; } if (h !== domain) throw new Error("sign-in: uri must be on the requesting site"); uri = String(p.uri); }
    const nonce = String(p.nonce ?? "");
    if (!/^[A-Za-z0-9]{8,}$/.test(nonce)) throw new Error("sign-in: a server-issued nonce (>=8 alphanumeric chars) is required");
    const statement = p.statement != null && String(p.statement) !== "" ? String(p.statement) : undefined;
    if (statement !== undefined && /[\r\n]/.test(statement)) throw new Error("sign-in: statement must be a single line");
    // Rejected, not truncated, for the same WYSIWYS reason as requestId below.
    if (statement !== undefined && statement.length > 256) throw new Error("sign-in: statement exceeds 256 chars");
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
      // Only emit notBefore for a POSITIVE offset; a 0/negative value is a no-op "valid from now-or-past"
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
  async send(to: string, amount: number, fee?: number, expectSigner?: string) {
    const f = fee ?? defaultFeeFor("send"); // B9: the table, not a local literal (was a param default)
    const ctx = this.captureSigner();
    const early = this.expectSignerRefusal(expectSigner, ctx.addr);
    if (early) return early;
    const r = await node.send(this.rpc, { to, amount, fee: f }, ctx.priv);
    await this.hist.maybeRecord(ctx.histKey, r, { type: "send", to, amount, fee: f });
    return r;
  }
  // Merge small coins into one self-output (see node.consolidate for the full posture note).
  // Popup-only; deliberately NOT reachable from the dApp channel (not in DAPP_METHODS).
  // Ambiguous outcomes (SUBMIT_MAYBE_INFLIGHT) are ALSO recorded, flagged maybe:true; the popup's
  // pending-merge indicator derives from this history entry, and it must not be blind exactly when
  // the merge was ingested but the answer was lost (that is when the balance dips with no
  // explanation). The txid is the locally computed consensus txid (Plans/66 B4).
  async consolidate(fee = 1_000_000) {
    const hk = this.histKeyNow();
    const r = await node.consolidate(this.rpc, { fee }, this.must().privkey);
    // maybeRecord is the single chokepoint for ok / maybe-inflight / duplicate recording (0.2.56);
    // the explicit maybe:true block that used to live here moved into it.
    await this.hist.maybeRecord(hk, r, { type: "consolidate", merged: r.merged, amount: r.total, fee });
    return r;
  }
  consolidatePreview(fee = 1_000_000) { return node.consolidatePreview(this.rpc, this.addr(), fee); }

  pendingMerge(utxos?: { txid: string; vout?: number }[]): Promise<{ pending: boolean; amount: number; maybe: boolean; stuck: boolean }> { return this.hist.pendingMerge(utxos); }

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
    await this.hist.maybeRecord(ctx.histKey, r, { type: "send", to, amount: total, fee });
    return r;
  }

  // Post a Cairn item directly: propose on-chain + register the off-chain content
  // (the content only "takes" once the tx mines, so we register in the background).
  async cairnPost(p: { domain: string; title: string; body?: string; links?: string[]; fee: number }) {
    const priv = this.must().privkey;
    const hk = this.histKeyNow(); // captured with the signer (F5): the tip fetch below is an await
    const content = { v: 1, domain: p.domain, title: p.title, body: p.body ?? "", links: p.links ?? [] };
    const ph = cairnPayloadHash(content);
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / EPOCH_LEN) + PROPOSE_EXPIRY_EPOCHS;
    const r = await node.propose(this.rpc, { domain: p.domain, payloadHash: ph, uri: "cairn:v1:" + ph.slice(2, 14), expiresEpoch, fee: p.fee }, priv);
    // Queue the off-chain content on the ambiguous path too (0.2.56, review F13): a maybe-inflight
    // propose that MINES would otherwise lose its body forever; the user paid, the content never
    // lands, no error. flushPending already handles a never-mined txid safely (polls getProposal,
    // registers only once mined, 7-day expiry bounds the queue), so queueing is harmless when the
    // tx truly died.
    if (r.txid && (r.ok || r.code === "SUBMIT_MAYBE_INFLIGHT")) {
      // PCD-2 class (P75-6 F5): a content-queue write failure after a PAID, broadcast propose must not
      // make cairnPost reject and skip the history record below. The propose is broadcast and recorded;
      // the body can be re-posted (registration is idempotent).
      try { await this.addPending(content, r.txid); } catch { /* content queue write failed; propose is broadcast + recorded below */ }
      this.flushPending();
    } // durable, alarm-driven
    await this.hist.maybeRecord(hk, r, { type: "post", domain: p.domain, title: p.title, fee: p.fee });
    return r;
  }
  // D8 (register §3, 2026-09-12): cairnSupport DELETED; dead (no dApp/popup/inpage caller; not in
  // DAPP_METHODS) and worse, a guard-free twin of attest() (it bypassed the CONF_TOKEN_FILL WYSIWYS
  // routing guard). Board support goes through attest().

  // ── CairnX tokens + .csd names ──────────────────────────────────────────────
  // READS go to the public CairnX resolver API and NEVER throw; the popup must keep
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
  // Name resolution reads through this wallet (names.ts); each read calls the wallet when it runs.
  private nameIo: NameIo = {
    tradeGet: (path) => this.tradeGet(path),
    tip: () => this.tip(),
    spvSource: () => this.spvSource(),
    verifyName: (name) => this.verifyName(name),
    tradeApi: () => this.tradeApi,
    spvGen: () => this.spvGen,
    nameHints: () => this.nameHints,
  };
  resolveName(name: string): Promise<NameResolution> { return resolveName(this.nameIo, name); }
  verifyName(name: string): Promise<NameVerification & { name: string }> { return verifyName(this.nameIo, name); }
  confirmName(name: string): Promise<NameResolution> { return confirmName(this.nameIo, name); }

  // M3 (offline token-fill simulation): quote the actual token DEBIT for a token-priced fill (confidence
  // ===1e6) so the clear-sign window shows what the user pays instead of "not visible here". Fetches the
  // offer from the resolver and, IF it is an OPEN token-want offer, computes debit = ask + protocol fee
  // (BigInt-exact, same cairnxTradeFee the convention uses). Returns ok:false on any unreachable/mismatch so
  // the UI keeps its loud caution; never silently "free". This is RESOLVER-TRUSTED DISPLAY ONLY: it changes
  // nothing the wallet signs (the attest bytes are unaffected); it only makes the debit visible for review.
  async tokenFillQuote(proposalId: string): Promise<{ ok: boolean; ticker?: string; amount?: string; fee?: string; total?: string; estimated?: boolean; error?: string; giveTicker?: string; giveAmount?: string; giveName?: string; wantDecimals?: number; giveDecimals?: number; wantDeployId?: string; giveDeployId?: string }> {
    try {
      const so = await this.servedOpenOffer(proposalId);
      if (!so.ok) return so;
      const o = so.offer;
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
      const g = (o as { give?: { ticker?: string; amount?: unknown; name?: string } }).give;
      const giveTicker = typeof g?.ticker === "string" ? g.ticker : undefined;
      // Served amount:null must stay absent; String(null) is "null", and the vendor give-leg
      // treats that present string as a mismatch against a proven missing amount (honest-fill refuse).
      const giveAmount = g?.amount != null ? String(g.amount) : undefined;
      const giveName = typeof g?.name === "string" ? g.name : undefined;
      const meta = await this.tokenDisplayMeta([w.ticker, giveTicker]);
      return {
        ok: true, ticker: w.ticker, amount: amount.toString(), fee: fee.toString(), total: (amount + fee).toString(), estimated: !hasBps, giveTicker, giveAmount, giveName,
        wantDecimals: meta[w.ticker]?.decimals, wantDeployId: meta[w.ticker]?.deployId,
        giveDecimals: giveTicker ? meta[giveTicker]?.decimals : undefined, giveDeployId: giveTicker ? meta[giveTicker]?.deployId : undefined,
      };
    } catch { return { ok: false, error: "offer unavailable" }; }
  }

  // The resolver's OPEN offer behind a fill target (an offer id, or a reservation txid the resolver links to
  // its offer). Display reads only; the fill preflight does its own read and binds what it signs.
  private async servedOpenOffer(proposalId: string): Promise<{ ok: true; offer: any } | { ok: false; error: string }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(proposalId))) return { ok: false, error: "bad offer id" };
    const r = await this.tradeGet(`/cairnx/offer/${encodeURIComponent(proposalId)}`); // 12s (tradeGet default)
    if (!r.ok) return { ok: false, error: "offer not found" };
    const o: any = await r.json().catch(() => null);
    if (!o || o.status !== "open") return { ok: false, error: o?.status ? `offer ${o.status}` : "offer unavailable" };
    return { ok: true, offer: o };
  }

  // What a CSD-paid fill card shows beside the signed outputs: the listing id (which differs from the
  // attested id on the reservation lane) and the asset the offer service lists as received. Display only.
  async fillOfferView(proposalId: string): Promise<{ ok: boolean; error?: string; offerId?: string; giveTicker?: string; giveAmount?: string; giveName?: string; giveDecimals?: number }> {
    try {
      const so = await this.servedOpenOffer(proposalId);
      if (!so.ok) return so;
      const o = so.offer;
      const offerId = String(o.id ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(offerId)) return { ok: false, error: "offer unavailable" };
      const g = (o as { give?: { ticker?: string; amount?: unknown; name?: string } }).give;
      const giveTicker = typeof g?.ticker === "string" ? g.ticker : undefined;
      const giveAmount = g?.amount != null ? String(g.amount) : undefined;
      const giveName = typeof g?.name === "string" ? g.name : undefined;
      const meta = giveTicker ? await this.tokenDisplayMeta([giveTicker]) : {};
      return { ok: true, offerId, giveTicker, giveAmount, giveName, giveDecimals: giveTicker ? meta[giveTicker]?.decimals : undefined };
    } catch { return { ok: false, error: "offer unavailable" }; }
  }

  // Decimals + deploy id per ticker for the approval cards (human units, look-alike warning). Fail-soft: a
  // failed read leaves that ticker absent and the card shows base units only. Display only.
  async tokenDisplayMeta(tickers: unknown): Promise<TokenDisplayMeta> {
    const list = [...new Set((Array.isArray(tickers) ? tickers : []).filter(isTicker))].slice(0, 4);
    const meta: TokenDisplayMeta = {};
    await Promise.all(list.map(async (tk) => {
      try {
        const tr = await this.tradeGet(`/cairnx/token/${encodeURIComponent(tk)}`, 8000);
        const t: any = tr.ok ? await tr.json().catch(() => null) : null;
        if (t && t.ticker === tk) meta[tk] = { decimals: Number.isInteger(t.decimals) ? t.decimals : undefined, deployId: typeof t.deployId === "string" ? t.deployId : undefined };
      } catch { /* display only: the card falls back to base units */ }
    }));
    return meta;
  }

  // The SPV source's storage: the IndexedDB header store, the legacy chrome.storage.local snapshot it migrates
  // and then deletes, (NAME-4) the node-tip high-water that keeps the lapse floor across worker restarts, and the
  // session pin in chrome.storage.session that lets a worker restart walk the stored suffix instead of re-verifying it.
  private spvOpts(): LiveSpvOpts {
    const session = this.session;
    return {
      rpcBase: this.rpc, headersBase: this.api,
      store: () => openHeaderStore(),
      legacy: {
        get: () => this.store.get("spvHeaderChain"),
        del: () => this.store.del("spvHeaderChain"),
        bytes: async () => (this.store.bytesInUse ? await this.store.bytesInUse("spvHeaderChain") : null),
        attempts: { get: async () => Number(await this.store.get("spvMigrateAttempts")) || 0, set: (n) => (n ? this.store.set("spvMigrateAttempts", n) : this.store.del("spvMigrateAttempts")) },
      },
      floor: { get: async () => Number(await this.store.get("spvNodeTipFloor")) || 0, set: (v) => this.store.set("spvNodeTipFloor", v) },
      ...(session ? { pin: { get: () => session.get("spvPin"), set: (p: SpvPin) => session.set("spvPin", p) } } : {}),
    };
  }
  // Lazily built SPV source (singleton per wallet), restored from the header store. Rebuilt on failure and after
  // setRpc/setApi change an endpoint; a failed build clears only itself, never a newer one.
  private _spvSrc: Promise<SpvSource> | null = null;
  private spvSource(): Promise<SpvSource> {
    if (this.nameSpvForTest) return Promise.resolve(this.nameSpvForTest);
    if (!this._spvSrc) {
      const built: Promise<SpvSource> = (this.spvBuildForTest ?? liveSpvSource)(this.spvOpts()).catch((e) => { if (this._spvSrc === built) this._spvSrc = null; throw e; });
      this._spvSrc = built;
    }
    return this._spvSrc;
  }
  // Prewarm the shared light client off the click path (popup open): the first fill/name verify then skips the
  // O(chain) snapshot restore. Fire-and-forget; a failed BUILD clears the singleton via spvSource()'s own catch
  // so the real call rebuilds rather than inheriting a rejected promise. Popup-only + in READ_ONLY_METHODS, so
  // it never extends the idle-lock (opening the popup is not a spend gesture).
  prewarmSpv(): void {
    void this.spvSource().catch(() => { /* best-effort; the real call retries and spvSource() self-resets on a build failure */ });
  }
  // v1.8: the height-gated renewal fee priced at the CURRENT tip; for the popup's pre-spend estimate, so
  // the displayed cost matches what cairnxNameRenew will actually sign (WL-V18-1). Returns base units.
  async cairnxNameRenewFee(name: string): Promise<number> {
    // M11 (B5b): price from the floor-CLAMPED tip (feePricingTip); a deflated RPC tip must not price an
    // obsolete cheaper tier the resolver rejects (fee burns). Same clamp at BOTH build sites + the
    // clearsign review warning, through the ONE shared helper, so build and review can never disagree.
    // W5 (Q-02): feePricingTip returns null when NEITHER the served tip nor the persisted floor is a
    // usable height. Refuse rather than price: a zero tip does NOT throw inside the vendored fee-height
    // helper, it prices the CHEAPEST tier, so a norm-to-0 would quote (and, at the sign site below,
    // build) an underpaid record whose fee LEAVES the wallet while the resolver no-ops it. This is the
    // same refusal class the vendored helper already throws for a non-integer tip.
    const tip = feePricingTip(await node.tip(this.rpc), await this.tipFloor());
    if (tip == null) throw new RangeError("cannot price this renewal: no usable chain tip (the node returned no valid height). Nothing was signed.");
    const fee = nameRegFee(name, buildFeeHeight(tip));
    return fee > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(fee);
  }
  // Renew a .csd lease (+1 year); built on-device, pays the registration fee to the treasury.
  async cairnxNameRenew(name: string, reviewedFee?: number, expectSigner?: string) {
    const priv = this.must().privkey;
    const hk = this.histKeyNow(); // captured with the signer (F5)
    // A1 backstop: this method throws on refusal (FEE_CHANGED precedent), so the mismatch throws too.
    this.throwOnSignerChange(expectSigner);
    const built = buildNameRenew({ name });
    // M11 (B5b): same floor-clamped pricing as cairnxNameRenewFee; the ONE shared helper (see there).
    const tip = feePricingTip(await node.tip(this.rpc), await this.tipFloor());
    // W5 (Q-02): the null refusal at the BUILD site is the one that matters. Without it a degenerate tip
    // read prices the cheapest tier and this method signs a treasury output the resolver rejects: the fee
    // burns. See cairnxNameRenewFee above and the helper's own comment for why 0 is not an option.
    if (tip == null) throw new RangeError("cannot price this renewal: no usable chain tip (the node returned no valid height). Nothing was signed.");
    const liveFee = nameRegFee(name, buildFeeHeight(tip));  // v1.8: height-gated; V18-1 boundary-safe build pricing
    if (liveFee > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("renewal fee too large for the UI");
    // WL-FEE-FREEZE-1 (WYSIWYS): sign EXACTLY the fee the user reviewed. If the chain tip crossed a fee-gate
    // boundary (V18/V24…) between Review and Confirm so the live fee no longer matches what was shown, REFUSE
    // rather than silently sign a different (higher) amount; the popup re-opens the review at the new price.
    // Never sign more than was displayed, never sign a now-underpaying fee (which the resolver would no-op).
    if (reviewedFee !== undefined && BigInt(reviewedFee) !== liveFee) throw new Error(`FEE_CHANGED:${Number(liveFee)}`);
    const fee = reviewedFee !== undefined ? BigInt(reviewedFee) : liveFee;
    const expiresEpoch = Math.floor(tip / EPOCH_LEN) + NAME_RENEW_EXPIRY_EPOCHS;
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee: CAIRNX_PROPOSE_FEE, outputs: [{ to: TREASURY_ADDR, value: Number(fee) }] }, priv);
    await this.hist.maybeRecord(hk, r, { type: "propose", domain: CAIRNX_DOMAIN, fee: CAIRNX_PROPOSE_FEE, title: `renew ${name}.csd` });
    return r;
  }
  // Set a name you own as your PRIMARY identity = point it at your own address (nset → self).
  async cairnxSetPrimary(name: string, expectSigner?: string) {
    const priv = this.must().privkey;
    const hk = this.histKeyNow(); // captured with the signer (F5)
    this.throwOnSignerChange(expectSigner);
    const built = buildNameSet({ name, addr: this.addr() });
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / EPOCH_LEN) + SET_PRIMARY_EXPIRY_EPOCHS;
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee: CAIRNX_PROPOSE_FEE }, priv);
    await this.hist.maybeRecord(hk, r, { type: "propose", domain: CAIRNX_DOMAIN, fee: CAIRNX_PROPOSE_FEE, title: `set ${name}.csd primary` });
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
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / EPOCH_LEN) + PROPOSE_EXPIRY_EPOCHS;
    const fee = p.fee ?? CAIRNX_PROPOSE_FEE;
    if (fee < CAIRNX_PROPOSE_FEE) throw new Error("cairnx anchor fee must be ≥ 0.25 CSD");
    const r = await node.propose(this.rpc, { domain: CAIRNX_DOMAIN, payloadHash: built.payloadHash, uri: built.uri, expiresEpoch, fee }, priv);
    await this.hist.maybeRecord(hk, r, {
      type: "tokenSend", ticker: p.ticker, to: String(p.to).toLowerCase(), amount: p.amount,
      human: typeof p.decimals === "number" ? formatUnits(p.amount, p.decimals) : p.amount, fee,
    });
    return r;
  }

  // ── sealed claims (commit-reveal); isolated per active account ─────────────
  async sealClaim(p: { domain?: string; claim: string; fee?: number }) {
    // CSDTX-SIWC-01: a non-string claim would be hashed as-is into the on-chain commitment but
    // String()-normalized on reveal, so the paid commit could never be revealed. dApp-reachable,
    // so the .d.ts type cannot be trusted at runtime. Refuse BEFORE any fee is spent.
    if (typeof p?.claim !== "string" || !p.claim) throw new Error("sealClaim: claim must be a non-empty string");
    const priv = this.must().privkey;
    const hk = this.histKeyNow(), sk = sealKey(this.addr()); // captured with the signer (F5)
    const domain = (p.domain && p.domain.trim()) || "csd:sealed";
    const nonce = bytesToHex(randomBytes(32));
    // The reveal preimage is encrypted BEFORE the commit is broadcast (no await since must() above, so the
    // vault key is still loaded): after the broadcast nothing needs the key, and a lock there cannot lose it.
    const enc = await this.claims.sealPreimage(p.claim, nonce);
    const content = { v: 1, sealed: 1, domain, claim: p.claim, nonce };
    const ph = cairnPayloadHash(content);
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / EPOCH_LEN) + PROPOSE_EXPIRY_EPOCHS;
    const fee = p.fee ?? CAIRNX_PROPOSE_FEE; // propose min 0.25 CSD
    const r = await node.propose(this.rpc, { domain, payloadHash: ph, uri: "cairn:seal:v1:" + ph.slice(2, 14), expiresEpoch, fee }, priv);
    // A maybe-inflight seal may still MINE: persist the reveal preimage (claim+nonce) on the
    // ambiguous path too, or a landed commit becomes forever unrevealable (0.2.56, same class as
    // the cairnPost content fix). Saving locally is harmless when the tx never landed.
    if (r.txid && (r.ok || r.code === "SUBMIT_MAYBE_INFLIGHT")) {
      // maybe-path seals are FLAGGED (0.2.57, reviewer nit) so the sealed-claims UI can say the
      // anchor may not have landed instead of listing it like a confirmed commit.
      // L5: the {claim, nonce} preimage is stored ENCRYPTED at rest (`enc`, fresh IV), so a parked
      // record is a pure store write needing no key.
      const rec = { txid: r.txid, domain, enc, committedTs: Date.now(), revealed: false, ...(r.ok ? {} : { maybe: true }) };
      await this.claims.persistSeal({ k: sk, rec });
    }
    await this.hist.maybeRecord(hk, r, { type: "seal", domain, fee });
    return r;
  }
  revealClaim(txid: string) { return this.claims.revealClaim(txid); }
  sealedClaims(): Promise<any[]> { return this.claims.sealedClaims(); }

  // ── transaction history; isolated per active account ──────────────────────
  // Pre-await key capture (0.2.56, review F5): every recording path must file under the account
  // that SIGNED. Flows capture this in the same synchronous tick as their privkey read, BEFORE
  // the awaited submit; the user can switch accounts while the network call is in flight, and a
  // post-await histKey(this.addr()) would file the entry (and everything the pending-merge line
  // derives from it) under the switched-to account.
  private histKeyNow() { return histKey(this.addr()); }
  history(): Promise<any[]> { return this.hist.history(); }

  // ── idle auto-lock ───────────────────────────────────────────────────────
  private lastActive = Date.now();
  touch() {
    this.lastActive = Date.now();
    // mirror the activity stamp into chrome.storage.session so the idle window is tracked across
    // SW restarts (genuine activity extends the unlocked session; pure reads never call touch()).
    if (this.session) this.session.set("sessionTs", this.lastActive).catch(() => {});
  }
  async autoLock(maxIdleMs: number) {
    // CLK-1: a backward wall-clock jump (NTP/manual) leaves lastActive in the future, making
    // now - lastActive negative forever and the vault never auto-locks. Clamp: a backward jump
    // RESTARTS the idle window (never locks instantly, no UX regression; never extends the
    // window beyond maxIdleMs of post-jump time).
    if (Date.now() < this.lastActive) this.lastActive = Date.now();
    if (this.accts && Date.now() - this.lastActive > maxIdleMs) await this.lock(); // await: the idle-lock race LOCK-ASYNC targets
  }

  // ── durable off-chain content registration (account-agnostic) ──────────────
  private async addPending(content: unknown, txid: string) {
    const list: any[] = (await this.store.get("pendingContent")) || [];
    if (!list.find((x) => x.txid === txid)) list.push({ content, txid, ts: Date.now() });
    await this.store.set("pendingContent", list);
  }
  // F-QUEUE-2 (Plans/68 A3): flushPending is a read-modify-write over pendingContent with awaits in
  // between, and it fires from THREE triggers (startup, the 1-minute alarm, cairnPost's un-awaited
  // kick); two overlapping flushes, or a flush racing addPending, could clobber a just-queued entry
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
        // window silently dropped the content of anyone offline a day; user paid, body never
        // landed, no error (Plans/66 B8). Content is self-certifying and re-POSTable, so a long
        // retry window costs nothing; expiry still bounds the queue.
        if (Date.now() - (x.ts || 0) > 7 * 86400000) continue;
        try {
          const p = await node.getProposal(this.rpc, x.txid);
          if (!(p && p.payload_hash)) { keep.push(x); continue; }  // not mined yet → retry later
          // F-QUEUE-1 (Plans/68 A3): registerContent NEVER throws; it resolves {ok:false} on any
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

  // Reveal the ACTIVE account's private key; requires re-entering the password.
  async exportKey(password: string): Promise<string> {
    const v: Vault | null = await this.store.get("vault"); if (!v) throw new Error("no wallet");
    const { parsed, legacyPriv } = await this.openVaultDoc(v, password);
    if (!parsed) return legacyPriv; // legacy single-key vault (plaintext IS the raw privkey, 0x-normalized)
    const i = this.accts ? this.active : (parsed.active ?? 0);
    return parsed.accounts[Math.min(i, parsed.accounts.length - 1)].priv;
  }

  // Reveal the wallet's recovery phrase (the master backup); password-gated. Throws
  // for legacy/import-only wallets that have no seed phrase.
  async exportMnemonic(password: string): Promise<string> {
    const v: Vault | null = await this.store.get("vault"); if (!v) throw new Error("no wallet");
    const { parsed } = await this.openVaultDoc(v, password);
    if (!parsed?.mnemonic) throw new Error("this wallet has no recovery phrase (it was created from an imported key)");
    return parsed.mnemonic;
  }

  // Wipe ALL wallet state; every account's vault, history, and sealed-claim
  // preimages; so a freshly-created wallet can't surface a prior owner's data.
  // RESET-RESURRECT (fund-safety red-team + P75-6): the wipe must not race ANY parked write. It is
  // serialized behind ALL THREE write chains (vault, history, seals); lock() above nulled
  // this.accts, and every chained WRITE callback bails on !this.accts, so nothing queued after this
  // point can land, and everything queued before it settles before the deletes run. doReset() below
  // clears the parked arrays itself. (W4: lock() no longer clears them, because an idle auto-lock is
  // not a reset and destroying a PAID commit's only reveal nonce was the defect; the reset path's
  // clear was already independent, which is why the deletion did not touch this property.)
  async reset(): Promise<void> {
    this.wiped = true;
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    await this.lock();
    const wipe = () => this.doReset(wallets);
    const run = Promise.allSettled([this.persistChain, this.hist.histChain, this.claims.sealChain]).then(wipe);
    const settled = run.then(() => {}, () => {});
    this.persistChain = settled; this.hist.histChain = settled; this.claims.sealChain = settled;
    return run;
  }
  private async doReset(wallets: PubAcct[]): Promise<void> {
    this.hist.pendingHist = []; this.claims.pendingSeals = []; // belt: a park that raced lock
    for (const w of wallets) { await this.store.del(histKey(w.addr)); await this.store.del(sealKey(w.addr)); }
    for (const k of ["vault", "wallets", "active", "addr", "txHistory", "sealedClaims", "pendingContent"]) await this.store.del(k);
  }
}
