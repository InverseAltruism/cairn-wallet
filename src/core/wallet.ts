// The Wallet "brain": holds an encrypted vault of ONE OR MORE accounts in a Store,
// keeps the unlocked accounts only in memory, and exposes the operations the UI /
// dApp provider need. One password unlocks all accounts. Each account has its own
// isolated transaction history and sealed-claim list (keyed by address) so switching
// never leaks one account's activity or secrets into another's view.
// Storage-injected so it runs in the service worker, a dev page, or a test.
import { generate, fromPriv, type Account } from "./account.js";
import { sealNew, sealWith, openWith, deriveVaultKey, type Vault } from "./keystore.js";
import type { Store } from "./storage.js";
import * as node from "./node.js";
import { cairnPayloadHash } from "./csdtx.js";
import { randomBytes, bytesToHex } from "@noble/hashes/utils";

export interface PubAcct { addr: string; label: string }
export interface WalletStatus { hasVault: boolean; unlocked: boolean; addr: string | null; accounts: PubAcct[]; active: number; rpc: string; api: string }

type Acct = Account & { label: string };
// Encrypted-vault document (the plaintext sealed under the password).
interface VaultDoc { v: 1; accounts: { priv: string; label: string }[]; active: number }

const DEFAULT_RPC = "https://cairn-substrate.com/api/rpc";
const DEFAULT_API = "https://cairn-substrate.com";

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
  rpc = DEFAULT_RPC;
  api = DEFAULT_API;
  constructor(private store: Store) {}

  async init(): Promise<void> {
    this.rpc = (await this.store.get("rpc")) || DEFAULT_RPC;
    this.api = (await this.store.get("api")) || DEFAULT_API;
  }
  async setRpc(u: string) { this.rpc = u; await this.store.set("rpc", u); }
  async setApi(u: string) { this.api = u; await this.store.set("api", u); }

  async status(): Promise<WalletStatus> {
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    const active = this.accts ? this.active : (((await this.store.get("active")) as number) ?? 0);
    const addr = this.accts ? (this.accts[this.active]?.addr ?? null) : (wallets[active]?.addr ?? null);
    return { hasVault: !!(await this.store.get("vault")), unlocked: !!this.accts, addr, accounts: wallets, active, rpc: this.rpc, api: this.api };
  }

  // Persist the in-memory accounts: re-seal the vault (fresh IV, same salt+key) and
  // mirror the public list (addresses + labels + active) in cleartext for the UI.
  private async persistVault() {
    if (!this.accts || !this.vaultKey) throw new Error("locked");
    const doc: VaultDoc = { v: 1, accounts: this.accts.map((a) => ({ priv: a.privkey, label: a.label })), active: this.active };
    const vault = await sealWith(JSON.stringify(doc), this.vaultKey, this.salt, this.iter);
    await this.store.set("vault", vault);
    await this.store.set("wallets", this.accts.map((a) => ({ addr: a.addr, label: a.label })));
    await this.store.set("active", this.active);
  }

  private acct(priv: string, label: string): Acct { return { ...fromPriv(priv), label }; }

  // ── vault lifecycle ────────────────────────────────────────────────────────
  async create(password: string): Promise<{ addr: string }> {
    if (await this.store.get("vault")) throw new Error("wallet already exists");
    const a = this.acct(generate().privkey, "Account 1");
    const doc: VaultDoc = { v: 1, accounts: [{ priv: a.privkey, label: a.label }], active: 0 };
    const { vault, key } = await sealNew(JSON.stringify(doc), password);
    this.vaultKey = key; this.salt = vault.salt; this.iter = vault.iter; this.accts = [a]; this.active = 0;
    await this.persistVault();
    return { addr: a.addr };
  }
  async importKey(priv: string, password: string): Promise<{ addr: string }> {
    if (await this.store.get("vault")) throw new Error("wallet already exists — reset first to replace the key");
    const a = this.acct(priv, "Account 1"); // fromPriv validates
    const doc: VaultDoc = { v: 1, accounts: [{ priv: a.privkey, label: a.label }], active: 0 };
    const { vault, key } = await sealNew(JSON.stringify(doc), password);
    this.vaultKey = key; this.salt = vault.salt; this.iter = vault.iter; this.accts = [a]; this.active = 0;
    await this.persistVault();
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
      this.accts = parsed.accounts.map((x) => this.acct(x.priv, x.label || "Account"));
      this.active = Math.min(Math.max(0, parsed.active ?? 0), this.accts.length - 1);
    } else {
      // LEGACY single-key vault (plaintext was a raw privkey). Migrate to the
      // multi-account format and move any global history/sealed list under this addr.
      const a = this.acct(doc, "Account 1");
      this.accts = [a]; this.active = 0;
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

  lock(): void { this.accts = null; this.vaultKey = null; this.salt = ""; this.iter = 0; }

  // ── account management (require unlocked) ──────────────────────────────────
  private mustUnlocked(): Acct[] { if (!this.accts || !this.vaultKey) throw new Error("locked"); return this.accts; }
  accounts(): PubAcct[] { return (this.accts ?? []).map((a) => ({ addr: a.addr, label: a.label })); }

  async addAccount(label?: string): Promise<{ addr: string; index: number }> {
    const accts = this.mustUnlocked();
    const a = this.acct(generate().privkey, (label && label.trim()) || `Account ${accts.length + 1}`);
    accts.push(a); this.active = accts.length - 1; await this.persistVault();
    return { addr: a.addr, index: this.active };
  }
  async importAccount(priv: string, label?: string): Promise<{ addr: string; index: number }> {
    const accts = this.mustUnlocked();
    const a = this.acct(priv, (label && label.trim()) || `Account ${accts.length + 1}`); // fromPriv validates
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
  async propose(p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number }) { const r = await node.propose(this.rpc, p, this.must().privkey); await this.maybeRecord(r, { type: "propose", domain: p.domain, fee: p.fee }); return r; }
  async attest(p: { proposalId: string; score: number; confidence: number; fee: number }) { const r = await node.attest(this.rpc, p, this.must().privkey); await this.maybeRecord(r, { type: "support", target: p.proposalId, fee: p.fee }); return r; }
  signIn() { return node.signIn(this.api, this.must().privkey); }

  // Plain CSD transfer to any address. fee default 0.01 CSD.
  async send(to: string, amount: number, fee = 1_000_000) { const r = await node.send(this.rpc, { to, amount, fee }, this.must().privkey); await this.maybeRecord(r, { type: "send", to, amount, fee }); return r; }

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

  // Wipe ALL wallet state — every account's vault, history, and sealed-claim
  // preimages — so a freshly-created wallet can't surface a prior owner's data.
  async reset(): Promise<void> {
    const wallets: PubAcct[] = (await this.store.get("wallets")) || [];
    this.lock();
    for (const w of wallets) { await this.store.del(histKey(w.addr)); await this.store.del(sealKey(w.addr)); }
    for (const k of ["vault", "wallets", "active", "addr", "txHistory", "sealedClaims", "pendingContent"]) await this.store.del(k);
  }
}
