// The Wallet "brain": holds the encrypted vault in a Store, keeps the unlocked
// account only in memory, and exposes the operations the UI / dApp provider need.
// Storage-injected so it runs in the service worker, a dev page, or a test.
import { generate, fromPriv, type Account } from "./account.js";
import { seal, open, type Vault } from "./keystore.js";
import type { Store } from "./storage.js";
import * as node from "./node.js";
import { cairnPayloadHash } from "./csdtx.js";
import { randomBytes, bytesToHex } from "@noble/hashes/utils";

export interface WalletStatus { hasVault: boolean; unlocked: boolean; addr: string | null; rpc: string; api: string }

// Default to the public Cairn RPC proxy so the wallet works on any user's machine
// (there's no node at their localhost). Operators can point it at a local node in
// Settings (e.g. http://127.0.0.1:7777/api/rpc or http://127.0.0.1:8790).
const DEFAULT_RPC = "https://cairn-substrate.com/api/rpc";
const DEFAULT_API = "https://cairn-substrate.com";

// Public block explorer (static MPA): /tx.html?txid= · /address.html?addr= · /proposal.html?id=
export const EXPLORER = "https://explorer.computesubstrate.org";
export const explorerTx = (txid: string) => `${EXPLORER}/tx.html?txid=${encodeURIComponent(txid)}`;
export const explorerAddr = (addr: string) => `${EXPLORER}/address.html?addr=${encodeURIComponent(addr)}`;

export class Wallet {
  private acct: Account | null = null;
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
    return { hasVault: !!(await this.store.get("vault")), unlocked: !!this.acct, addr: (await this.store.get("addr")) ?? null, rpc: this.rpc, api: this.api };
  }

  private async persist(a: Account, password: string) {
    const vault: Vault = await seal(a.privkey, password);
    await this.store.set("vault", vault);
    await this.store.set("addr", a.addr);
  }

  async create(password: string): Promise<{ addr: string }> {
    if (await this.store.get("vault")) throw new Error("wallet already exists");
    const a = generate(); await this.persist(a, password); this.acct = a; return { addr: a.addr };
  }
  async importKey(priv: string, password: string): Promise<{ addr: string }> {
    const a = fromPriv(priv); await this.persist(a, password); this.acct = a; return { addr: a.addr };
  }
  async unlock(password: string): Promise<{ addr: string }> {
    const v = await this.store.get("vault");
    if (!v) throw new Error("no wallet — create or import one first");
    this.acct = fromPriv(await open(v, password)); // open() throws "bad password" on mismatch
    return { addr: this.acct.addr };
  }
  lock(): void { this.acct = null; }

  private must(): Account { if (!this.acct) throw new Error("locked"); return this.acct; }

  balance() { const a = this.must(); return node.balance(this.rpc, a.addr); }
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

  // ── sealed claims (commit-reveal) ────────────────────────────────────────
  // Commit: propose a SALTED hash of the claim now (content withheld) — the
  // on-chain tx timestamps that you knew it, without revealing what. Reveal:
  // publish the salted preimage later; the chain proves you committed it first.
  // The salt (nonce) is essential — without it a guessable claim could be
  // brute-forced from its hash before reveal. The preimage is kept locally so
  // the author can always reveal (lose it and the claim is unrevealable).
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
      const list: any[] = (await this.store.get("sealedClaims")) || [];
      if (!list.find((x) => x.txid === r.txid)) list.unshift({ txid: r.txid, domain, claim: p.claim, nonce, committedTs: Date.now(), revealed: false });
      await this.store.set("sealedClaims", list.slice(0, 500));
      await this.maybeRecord(r, { type: "seal", domain, fee });
    }
    return r;
  }
  async revealClaim(txid: string) {
    const list: any[] = (await this.store.get("sealedClaims")) || [];
    const rec = list.find((x) => x.txid === txid);
    if (!rec) return { ok: false, error: "no sealed claim with that txid in this wallet" };
    const r = await node.registerContent(this.api, { v: 1, sealed: 1, domain: rec.domain, claim: rec.claim, nonce: rec.nonce }, txid);
    if (r && r.ok) { rec.revealed = true; await this.store.set("sealedClaims", list); }
    return r;
  }
  sealedClaims(): Promise<any[]> { return this.store.get("sealedClaims").then((l: any[]) => l || []); }

  // ── transaction history ──────────────────────────────────────────────────
  // Every tx the wallet submits is recorded locally (newest-first, capped) so the
  // user can see their activity and jump to the on-chain explorer. We only record
  // what THIS wallet sends — it's an activity log, not a full chain index.
  private async maybeRecord(r: { ok?: boolean; txid?: string }, meta: Record<string, unknown>) {
    if (r && r.ok && r.txid) await this.recordTx({ txid: r.txid, ts: Date.now(), ...meta });
  }
  private async recordTx(entry: Record<string, unknown>) {
    const h: any[] = (await this.store.get("txHistory")) || [];
    if (h.find((x) => x.txid === entry.txid)) return; // idempotent
    h.unshift(entry);
    await this.store.set("txHistory", h.slice(0, 200));
  }
  history(): Promise<any[]> { return this.store.get("txHistory").then((h: any[]) => h || []); }

  // ── idle auto-lock ───────────────────────────────────────────────────────
  // The unlocked key lives only in this.acct (memory). We wipe it after a period
  // of inactivity so an unattended/unlocked extension can't be used. touch() is
  // called by the background worker on every user action; autoLock() is driven by
  // a periodic alarm. (Memory-only acct is also lost whenever the SW is killed.)
  private lastActive = Date.now();
  touch() { this.lastActive = Date.now(); }
  autoLock(maxIdleMs: number) { if (this.acct && Date.now() - this.lastActive > maxIdleMs) this.lock(); }

  // Off-chain content can only be registered once the proposal tx is MINED (~30-60s).
  // A fire-and-forget loop dies when the popup closes or the MV3 service worker is
  // idle-killed — silently losing the content so the item shows as a hash-only
  // placeholder. So we persist a pending queue and drain it from a background alarm
  // (which wakes the SW), making registration survive any shutdown.
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
        await node.registerContent(this.api, x.content, x.txid); // mined: register (server self-certifies vs hash);
        // success OR permanent rejection (hash mismatch) → drop either way (never succeeds on retry)
      } catch { keep.push(x); }                                  // transient/network error → retry later
    }
    await this.store.set("pendingContent", keep);
  }
  hasPending(): Promise<boolean> { return this.store.get("pendingContent").then((l: any[]) => !!(l && l.length)); }

  // Reveal the private key — requires re-entering the password (never exposed otherwise).
  async exportKey(password: string): Promise<string> {
    const v = await this.store.get("vault"); if (!v) throw new Error("no wallet");
    return open(v, password);
  }
  async reset(): Promise<void> { this.acct = null; await this.store.del("vault"); await this.store.del("addr"); }
}
