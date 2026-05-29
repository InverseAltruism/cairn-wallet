// The Wallet "brain": holds the encrypted vault in a Store, keeps the unlocked
// account only in memory, and exposes the operations the UI / dApp provider need.
// Storage-injected so it runs in the service worker, a dev page, or a test.
import { generate, fromPriv, type Account } from "./account.js";
import { seal, open, type Vault } from "./keystore.js";
import type { Store } from "./storage.js";
import * as node from "./node.js";
import { cairnPayloadHash } from "./csdtx.js";

export interface WalletStatus { hasVault: boolean; unlocked: boolean; addr: string | null; rpc: string; api: string }

// Default to the public Cairn RPC proxy so the wallet works on any user's machine
// (there's no node at their localhost). Operators can point it at a local node in
// Settings (e.g. http://127.0.0.1:7777/api/rpc or http://127.0.0.1:8790).
const DEFAULT_RPC = "https://cairn-substrate.com/api/rpc";
const DEFAULT_API = "https://cairn-substrate.com";

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
  propose(p: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee: number }) { return node.propose(this.rpc, p, this.must().privkey); }
  attest(p: { proposalId: string; score: number; confidence: number; fee: number }) { return node.attest(this.rpc, p, this.must().privkey); }
  signIn() { return node.signIn(this.api, this.must().privkey); }

  // Plain CSD transfer to any address. fee default 0.01 CSD.
  send(to: string, amount: number, fee = 1_000_000) { return node.send(this.rpc, { to, amount, fee }, this.must().privkey); }

  // Post a Cairn item directly: propose on-chain + register the off-chain content
  // (the content only "takes" once the tx mines, so we register in the background).
  async cairnPost(p: { domain: string; title: string; body?: string; links?: string[]; fee: number }) {
    const priv = this.must().privkey;
    const content = { v: 1, domain: p.domain, title: p.title, body: p.body ?? "", links: p.links ?? [] };
    const ph = cairnPayloadHash(content);
    const expiresEpoch = Math.floor((await node.tip(this.rpc)) / 30) + 720;
    const r = await node.propose(this.rpc, { domain: p.domain, payloadHash: ph, uri: "cairn:v1:" + ph.slice(2, 14), expiresEpoch, fee: p.fee }, priv);
    if (r.ok && r.txid) { await this.addPending(content, r.txid); this.flushPending(); } // durable, alarm-driven
    return r;
  }
  cairnSupport(proposalId: string, fee: number, score = 80, confidence = 70) { return node.attest(this.rpc, { proposalId, score, confidence, fee }, this.must().privkey); }

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
