// Per-account sealed claims (see SealedClaims): the commit-reveal records whose preimages the wallet keeps
// encrypted until reveal. sealClaim, which signs the commit, is a Wallet method.
import type { Store } from "./storage.js";
import { sealWith, openWith, type Vault } from "./keystore.js";
import * as node from "./node.js";
import type { RecordHost } from "./history.js";
import { refuse } from "./refuse.js";

// Per-account storage namespace for sealed claims (the history's is histKey in history.ts).
export const sealKey = (addr: string) => "sealedClaims:" + addr;

// SEAL-EVICT-01 (P75-6 F2): the sealed-claims cap must never evict an UNREVEALED preimage; it is the only
// copy of the reveal nonce for a PAID commit (unrecoverable from phrase or chain). Evict oldest REVEALED
// entries first; an all-unrevealed list is kept whole (bounded in practice by the 0.25 CSD per-commit fee).
const SEAL_CAP = 500;
function capSeals(list: any[]): any[] {
  if (list.length <= SEAL_CAP) return list;
  let over = list.length - SEAL_CAP;
  const out: any[] = [];
  for (let i = list.length - 1; i >= 0; i--) {  // walk oldest to newest (list is newest-first)
    if (over > 0 && list[i]?.revealed) { over--; continue; }
    out.unshift(list[i]);
  }
  return out;
}

// The record store also reads the vault key, which seals each reveal preimage at rest; null while locked.
export interface ClaimsHost extends RecordHost { api(): string; vaultKey(): CryptoKey | null; salt(): string; iter(): number }

// Per-account sealed claims in the store under sealKey(addr): the reveal preimages, encrypted under the vault
// key, the write chain, records parked in RAM when a write fails or the wallet is locked, reveal and the list.
export class SealedClaims {
  constructor(private store: Store, private w: ClaimsHost) {}
  // Write chain and parked records: the same discipline as TxHistory.histChain and TxHistory.pendingHist.
  sealChain: Promise<void> = Promise.resolve();
  inSealChain<T>(work: () => Promise<T>): Promise<T> {
    const run = this.sealChain.then(work, work);
    this.sealChain = run.then(() => {}, () => {});
    return run;
  }
  pendingSeals: { k: string; rec: any }[] = [];

  // L5: the {claim, nonce} pair is the reveal PREIMAGE + salt; a force-revealable front-running lever if it
  // is readable at rest. The vault key already lives only in memory (chrome.storage.session, not cold-disk-
  // readable), so encrypt ONLY these two fields under it (fresh IV per seal) before persisting; txid/domain/
  // committedTs/revealed/maybe stay plaintext (already on-chain / not the lever). Reuses the AES-GCM vault
  // primitives (keystore sealWith/openWith); no new crypto. history/labels stay the documented local-disk
  // residual (we do NOT encrypt all of chrome.storage.local; §5 constraint).
  async sealPreimage(claim: string, nonce: string): Promise<Vault> {
    const key = this.w.vaultKey();
    if (!key) throw new Error("locked");
    return sealWith(JSON.stringify({ claim, nonce }), key, this.w.salt(), this.w.iter());
  }
  // Recover a record's preimage: a v-L5 record carries an encrypted `enc` blob; a LEGACY plaintext record
  // (pre-L5) still carries claim/nonce inline and keeps working (lazy migration re-encrypts it on next write).
  private async openPreimage(rec: { enc?: Vault; claim?: string; nonce?: string }): Promise<{ claim: string; nonce: string }> {
    if (rec?.enc) {
      const key = this.w.vaultKey();
      if (!key) throw new Error("locked");
      const p = JSON.parse(await openWith(rec.enc, key));
      return { claim: String(p.claim ?? ""), nonce: String(p.nonce ?? "") };
    }
    return { claim: String(rec?.claim ?? ""), nonce: String(rec?.nonce ?? "") };
  }
  // Lazy migration (L5): re-encrypt any legacy plaintext records in a list on the next write of that list, so
  // an existing sealed claim keeps revealing but stops sitting in cleartext. No-op when locked or already
  // encrypted. Mutates in place.
  private async reencryptLegacyPreimages(list: { enc?: Vault; claim?: string; nonce?: string }[]): Promise<void> {
    if (!this.w.vaultKey()) return;
    for (const rec of list) {
      if (rec && !rec.enc && (rec.claim !== undefined || rec.nonce !== undefined)) {
        rec.enc = await this.sealPreimage(String(rec.claim ?? ""), String(rec.nonce ?? ""));
        delete rec.claim; delete rec.nonce;
      }
    }
  }
  // Every sealed-claim record passes through pendingSeals: parked first, removed once its list write
  // succeeds. A record parked while locked (or after a failed write: the commit fee is paid and this is
  // the only copy of the nonce) is merged into sealedClaims(), is revealable, and is written on unlock or
  // with the next seal write. After reset() a new record is dropped. Never throws.
  persistSeal(add?: { k: string; rec: any }): Promise<void> {
    return this.inSealChain(async () => {
      if (add && !this.pendingSeals.some((p) => p.k === add.k && p.rec.txid === add.rec.txid)) {
        if (this.w.wiped()) return;
        this.pendingSeals.push(add);
      }
      if (!this.w.unlocked()) return;
      for (const sk of new Set(this.pendingSeals.map((p) => p.k))) {
        try {
          const list: any[] = (await this.store.get(sk)) || [];
          for (const p of this.pendingSeals) if (p.k === sk && !list.find((x) => x.txid === p.rec.txid)) list.unshift(p.rec);
          await this.reencryptLegacyPreimages(list); // migrate any pre-L5 plaintext record on this write
          await this.store.set(sk, capSeals(list));
          this.pendingSeals = this.pendingSeals.filter((p) => p.k !== sk);
        } catch { /* SEAL-WRITE-02: stays parked and visible; the next seal write or unlock retries */ }
      }
    });
  }
  async revealClaim(txid: string) {
    const k = sealKey(this.w.addr());
    const list: any[] = (await this.store.get(k)) || [];
    const rec = list.find((x) => x.txid === txid)
      ?? this.pendingSeals.find((p) => p.k === k && p.rec.txid === txid)?.rec; // a parked seal is revealable too
    if (!rec) return { ok: false, error: "no sealed claim with that txid in this account" };
    // The preimage goes public only once the commit is mined (flushPending's getProposal rule): a reveal
    // against a commit still in the mempool, or one that never lands, would publish the claim uncommitted.
    const commit = await node.getProposal(this.w.rpc(), txid);
    if (!(commit && commit.payload_hash))
      return refuse("SEAL_NOT_MINED", "this seal is not mined yet, or the node could not confirm it; nothing was revealed. Try again once it is mined");
    // L5: decrypt the preimage with the unlocked vault key (a legacy plaintext record still reveals).
    const { claim, nonce } = await this.openPreimage(rec);
    const r = await node.registerContent(this.w.api(), { v: 1, sealed: 1, domain: rec.domain, claim, nonce }, txid);
    if (r && r.ok) {
      // Chained write-back on a FRESH read (the list above is stale across the registerContent
      // network await; writing it back would erase a seal recorded meanwhile). A storage failure
      // is swallowed: the reveal itself succeeded and registration is idempotent.
      await this.inSealChain(async () => {
        if (!this.w.unlocked()) return;
        try {
          for (const p of this.pendingSeals) if (p.k === k && p.rec.txid === txid) p.rec.revealed = true;
          const fresh: any[] = (await this.store.get(k)) || [];
          const fr = fresh.find((x) => x.txid === txid);
          if (fr) {
            fr.revealed = true;
            await this.reencryptLegacyPreimages(fresh); // lazy-migrate any legacy plaintext record on this write
            await this.store.set(k, fresh);
          }
        } catch { /* revealed flag is display state; a later reveal or seal write retries it */ }
      });
    }
    return r;
  }
  // Display view for the popup: decrypt the claim TEXT for the sealed-claims preview (unlocked, trusted UI)
  // while the on-disk record stays encrypted; the nonce (reveal salt) is never surfaced to the list. A
  // decrypt failure degrades to "no preview" rather than throwing (the list never breaks).
  async sealedClaims(): Promise<any[]> {
    if (!this.w.unlocked()) return [];
    const kk = sealKey(this.w.addr());
    const stored: any[] = (await this.store.get(kk)) || [];
    // merge parked (write-failed) seals so a paid-but-unpersisted commit still shows in the list
    const parked = this.pendingSeals.filter((p) => p.k === kk && !stored.some((x) => x?.txid === p.rec.txid)).map((p) => p.rec);
    const list = parked.length ? [...parked, ...stored] : stored;
    const out: any[] = [];
    for (const rec of list) {
      if (rec?.enc) { try { const { claim } = await this.openPreimage(rec); out.push({ ...rec, claim }); } catch { out.push({ ...rec }); } }
      else out.push(rec);
    }
    return out;
  }
}
