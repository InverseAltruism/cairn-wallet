// The Wallet "brain": holds an encrypted vault of ONE OR MORE accounts in a Store,
// keeps the unlocked accounts only in memory, and exposes the operations the UI /
// dApp provider need. One password unlocks all accounts. Each account has its own
// isolated transaction history and sealed-claim list (keyed by address) so switching
// never leaks one account's activity or secrets into another's view.
// Storage-injected so it runs in the service worker, a dev page, or a test.
import { generate, fromPriv, newMnemonic, deriveAccount, isValidMnemonic, normalizeMnemonic, type Account } from "./account.js";
import { sealNew, sealWith, openWith, deriveVaultKey, type Vault } from "./keystore.js";
import type { Store } from "./storage.js";
import * as node from "./node.js";
import { cairnPayloadHash } from "./csdtx.js";
import { buildTransfer, buildNameRenew, buildNameSet, nameRegFee, formatUnits, CAIRNX_DOMAIN, CAIRNX_PROPOSE_FEE, TREASURY_ADDR } from "./cairnx.js";
import { randomBytes, bytesToHex } from "@noble/hashes/utils";

export interface PubAcct { addr: string; label: string; imported?: boolean }
export interface WalletStatus { hasVault: boolean; unlocked: boolean; addr: string | null; accounts: PubAcct[]; active: number; rpc: string; api: string; tradeApi: string; hasMnemonic: boolean }

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

// Public block explorer (static MPA): /tx.html?txid= · /address.html?addr= · /proposal.html?id=
export const EXPLORER = "https://explorer.computesubstrate.org";
export const explorerTx = (txid: string) => `${EXPLORER}/tx.html?txid=${encodeURIComponent(txid)}`;
export const explorerAddr = (addr: string) => `${EXPLORER}/address.html?addr=${encodeURIComponent(addr)}`;

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
  constructor(private store: Store) {}

  async init(): Promise<void> {
    this.rpc = (await this.store.get("rpc")) || DEFAULT_RPC;
    this.api = (await this.store.get("api")) || DEFAULT_API;
    this.tradeApi = (await this.store.get("tradeApi")) || DEFAULT_TRADE_API;
  }
  async setRpc(u: string) { this.rpc = u; await this.store.set("rpc", u); }
  async setApi(u: string) { this.api = u; await this.store.set("api", u); }
  async setTradeApi(u: string) { this.tradeApi = u || DEFAULT_TRADE_API; await this.store.set("tradeApi", this.tradeApi); }
  // User-added custom RPC URLs (for the header RPC switcher). Plain config, no secrets.
  async rpcList(): Promise<string[]> { return (await this.store.get("customRpcs")) || []; }
  async addRpc(u: string): Promise<void> { const l = await this.rpcList(); if (!l.includes(u)) { l.push(u); await this.store.set("customRpcs", l.slice(0, 20)); } }
  async removeRpc(u: string): Promise<void> { await this.store.set("customRpcs", (await this.rpcList()).filter((x) => x !== u)); }

  async status(): Promise<WalletStatus> {
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    const active = this.accts ? this.active : (((await this.store.get("active")) as number) ?? 0);
    const addr = this.accts ? (this.accts[this.active]?.addr ?? null) : (wallets[active]?.addr ?? null);
    return { hasVault: !!(await this.store.get("vault")), unlocked: !!this.accts, addr, accounts: wallets, active, rpc: this.rpc, api: this.api, tradeApi: this.tradeApi, hasMnemonic: !!this.mnemonic };
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

  async unlock(password: string): Promise<{ addr: string }> {
    const v: Vault | null = await this.store.get("vault");
    if (!v) throw new Error("no wallet — create or import one first");
    const key = await deriveVaultKey(password, v.salt, v.iter);
    const doc = await openWith(v, key); // throws "bad password" on mismatch (GCM tag)
    this.vaultKey = key; this.salt = v.salt; this.iter = v.iter;
    let parsed: VaultDoc | null = null;
    try { const p = JSON.parse(doc); if (p && Array.isArray(p.accounts)) parsed = p; } catch { /* legacy */ }
    if (parsed) {
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
    await this.persistVault();
    this.touch();
    return { addr: this.accts[this.active].addr };
  }

  private async migrateLegacy(addr: string) {
    for (const [from, to] of [["txHistory", histKey(addr)], ["sealedClaims", sealKey(addr)]] as const) {
      const old = await this.store.get(from);
      if (old != null) { if ((await this.store.get(to)) == null) await this.store.set(to, old); await this.store.del(from); }
    }
    await this.store.del("addr"); // legacy single-address key
  }

  lock(): void { this.accts = null; this.vaultKey = null; this.salt = ""; this.iter = 0; this.mnemonic = null; this.nextIndex = 0; }

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
  async propose(p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number; outputs?: { to: string; value: number }[] }) { const r = await node.propose(this.rpc, p, this.must().privkey); await this.maybeRecord(r, { type: "propose", domain: p.domain, fee: p.fee }); return r; }
  async attest(p: { proposalId: string; score: number; confidence: number; fee: number }) { const r = await node.attest(this.rpc, p, this.must().privkey); await this.maybeRecord(r, { type: "support", target: p.proposalId, fee: p.fee }); return r; }
  // Atomic fill (Attest + payment in ONE tx — CairnX delivery-versus-payment). fee default 0.05 CSD (attest floor).
  async fillOffer(p: { proposalId: string; score?: number; confidence?: number; outputs: { to: string; value: number }[]; fee?: number }) {
    const q = { proposalId: p.proposalId, score: (p.score ?? 100) >>> 0, confidence: (p.confidence ?? 100) >>> 0, outputs: p.outputs, fee: p.fee ?? 5_000_000 };
    const r = await node.fillOffer(this.rpc, q, this.must().privkey);
    const outs = Array.isArray(q.outputs) ? q.outputs : [];
    const total = outs.reduce((a, o) => a + Number(o.value || 0), 0);
    const to = outs.length === 1 ? outs[0]!.to : `${outs.length} recipients`;
    await this.maybeRecord(r, { type: "fillOffer", target: q.proposalId, to, amount: total, fee: q.fee });
    return r;
  }
  signIn() { return node.signIn(this.api, this.must().privkey); }

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
  async resolveName(name: string): Promise<{ ok: boolean; name?: string; addr?: string; via?: string; owner?: string; lapsed?: boolean; error?: string }> {
    const nm = String(name || "").toLowerCase().replace(/\.csd$/, "");
    try {
      const r = await fetch(`${this.tradeApi}/cairnx/resolve/${nm}`);
      if (r.status === 404) return { ok: false, error: `${nm}.csd is not registered` };
      if (!r.ok) return { ok: false, error: "name lookup failed" };
      const j = await r.json();
      if (j?.lapsed) return { ok: false, error: `${nm}.csd lease has lapsed — can't send to it` };
      if (!j?.addr || !/^0x[0-9a-f]{40}$/.test(String(j.addr).toLowerCase())) return { ok: false, error: `${nm}.csd has no address` };
      return { ok: true, name: nm, addr: String(j.addr).toLowerCase(), via: j.via, owner: j.owner, lapsed: false };
    } catch { return { ok: false, error: "name lookup failed" }; }
  }
  // Renew a .csd lease (+1 year) — built on-device, pays the registration fee to the treasury.
  async cairnxNameRenew(name: string) {
    const priv = this.must().privkey;
    const built = buildNameRenew({ name });
    const fee = nameRegFee(name);
    if (fee > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("renewal fee too large for the UI");
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / 30) + 1000;
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
  touch() { this.lastActive = Date.now(); }
  autoLock(maxIdleMs: number) { if (this.accts && Date.now() - this.lastActive > maxIdleMs) this.lock(); }

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
    const doc = await openWith(v, await deriveVaultKey(password, v.salt, v.iter)); // throws "bad password"
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
    const doc = await openWith(v, await deriveVaultKey(password, v.salt, v.iter)); // throws "bad password"
    let parsed: VaultDoc | null = null;
    try { const p = JSON.parse(doc); if (p && Array.isArray(p.accounts)) parsed = p; } catch { /* legacy */ }
    if (!parsed?.mnemonic) throw new Error("this wallet has no recovery phrase (it was created from an imported key)");
    return parsed.mnemonic;
  }

  // Wipe ALL wallet state — every account's vault, history, and sealed-claim
  // preimages — so a freshly-created wallet can't surface a prior owner's data.
  async reset(): Promise<void> {
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    this.lock();
    for (const w of wallets) { await this.store.del(histKey(w.addr)); await this.store.del(sealKey(w.addr)); }
    for (const k of ["vault", "wallets", "active", "addr", "txHistory", "sealedClaims", "pendingContent"]) await this.store.del(k);
  }
}
