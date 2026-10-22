// Per-account transaction history (see TxHistory). The wallet records every signed flow here and the popup
// reads it back; nothing here signs.
import type { Store } from "./storage.js";
import * as node from "./node.js";
import { INCLUSION_NOTICE_BLOCKS, INCLUSION_INPUTS_KEPT, INCLUSION_READS_MAX, INCLUSION_GONE_READ_INTERVAL, inclusionVerdict, goneStep, type TxInclusion } from "./inclusion.js";

// Per-account storage namespaces; keep each account's activity + secrets separate.
export const histKey = (addr: string) => "txHistory:" + addr;
// A merge whose output is not yet seen and that is not known to be gone.
const isMergeCandidate = (x: any): boolean => x?.type === "consolidate" && !x.confirmed && !x.gone;
// A row pendingMerge still evaluates; `gone` stays here so a later reading can undo it.
const isOpenRow = (x: any): boolean => !!x && (x.maybe || isMergeCandidate(x) || x.gone || x.goneTip !== undefined);

// The wallet state a record store reads when it acts: whether the wallet is unlocked (a write waits for an
// unlock), whether reset() wiped it (nothing of the old wallet may land again), the active account and the node RPC.
export interface RecordHost { unlocked(): boolean; wiped(): boolean; addr(): string; rpc(): string }

// Per-account transaction history in the store under histKey(addr): the recording chokepoint (maybeRecord),
// its write chain, rows parked in RAM when a write fails or the wallet is locked, and the inclusion reconcile
// behind the popup's pending line.
export class TxHistory {
  constructor(private store: Store, private w: RecordHost) {}
  // Class A durability (P75-6): this write chain and the sealed-claims one follow the Wallet's persistChain idiom.
  // EVERY read-modify-write of a per-account history / sealed-claims list rides its chain, so two
  // writers can never interleave a get..set and clobber each other. The idiom's discipline is
  // load-bearing: both settle paths run the next work item, the chain field is reassigned to an
  // ALWAYS-RESOLVED promise (a rejection can never poison the queue), and the rejecting `run` is
  // returned so each caller still observes its own outcome.
  // Boundary rule: a chain callback contains STORAGE ops only, never a network await (send()
  // awaits maybeRecord, so anything inside histChain sits on the send hot path). WRITE callbacks
  // do not write while the wallet is locked (recordTx parks its row in RAM instead, except after reset());
  // DELETE callbacks do not bail (deletes are teardown and safe while locked).
  histChain: Promise<void> = Promise.resolve();
  inHistChain<T>(work: () => Promise<T>): Promise<T> {
    const run = this.histChain.then(work, work);
    this.histChain = run.then(() => {}, () => {});
    return run;
  }
  // Parked writes (PCD-2 / SEAL-WRITE-02): when a post-broadcast history/seal write fails, the
  // entry is parked here (RAM only), merged into history()/sealedClaims() reads so the user still
  // sees it, and retried on the next write to the same list. NOT durable across a service-worker
  // teardown; that residual is stated at the write sites. Cleared in lock()/doReset()/
  // removeAccount: the reset discipline is exactly "clear the array".
  pendingHist: { k: string; entry: Record<string, unknown> }[] = [];

  async maybeRecord(k: string, r: { ok?: boolean; txid?: string; code?: string; spentTxids?: string[]; inputs?: string[] }, meta: Record<string, unknown>) {
    // PCD-2: every branch below is non-rejecting (chained + guarded), so an awaiting flow can never report a succeeded broadcast as a failure.
    // Rows pendingMerge may settle keep a few input outpoints for its "gone" verdict.
    const inputs = Array.isArray(r?.inputs) && r.inputs.length ? { inputs: r.inputs.slice(0, INCLUSION_INPUTS_KEPT) } : {};
    if (r && r.ok && r.txid) await this.recordTx(k, { txid: r.txid, ts: Date.now(), ...meta, ...(meta.type === "consolidate" ? inputs : {}) });
    // Ambiguous outcome (0.2.56, review F1): the tx MAY be in the mempool; a timeout / gateway
    // 5xx / unreadable answer AFTER signing. Record it maybe:true under the LOCALLY computed txid
    // so the failure copy's "check history before resending" is actionable: this entry is what
    // stands between an ingested-but-unanswered send and a blind resend double-pay (a resend picks
    // DIFFERENT coins once the mempool-spent filter updates, so byte-identical dedupe does NOT
    // backstop it). Previously only consolidate() did this; every value flow gets it here at the
    // single chokepoint. Deliberate, accepted side-effect: the recipient joins paidRecipients
    // (clearsign.ts), muting the first-time-recipient warning for an address the user already
    // clear-signed once; entries only originate from the user's own reviewed sends, no poisoning
    // vector.
    else if (r && !r.ok && r.code === "SUBMIT_MAYBE_INFLIGHT" && r.txid) {
      await this.recordTx(k, { txid: r.txid, ts: Date.now(), ...meta, ...inputs, maybe: true });
    }
    // A duplicate answer RESOLVES an earlier ambiguity; a tx spending these coins IS pending, and
    // a deterministic retry of an ingested submit is byte-identical, so this is the common way a
    // maybe:true entry turns out to have landed. Clear the flag in place; never INSERT on a dup
    // (on the current node's conflated error a dup can also mean a DIFFERENT tx spends the coins,
    // and a fresh entry under the local txid would then claim a send that never landed).
    else if (r && !r.ok && r.code === "SUBMIT_DUPLICATE" && r.txid) {
      await this.clearMaybe(k, r.txid);
    }
    // Spending an output PROVES its source tx confirmed: latch any pending-merge entry whose txid
    // this spend just consumed (Plans/66 review finding; the final combining pass spends earlier
    // rounds' outputs with no balance refresh in between, which otherwise left those entries
    // deriving a false "merging" line until a balance refresh saw them).
    if (r && r.ok && Array.isArray(r.spentTxids) && r.spentTxids.length) await this.latchSpentMerges(k, r.spentTxids);
  }
  private clearMaybe(k: string, txid: string): Promise<void> {
    // a definitive record can also supersede a parked maybe twin for the same txid
    for (const p of this.pendingHist) if (p.k === k && p.entry.txid === txid) delete p.entry.maybe;
    return this.inHistChain(async () => {
      if (!this.w.unlocked()) return;
      try {
        const h: any[] = (await this.store.get(k)) || [];
        const e = h.find((x) => x?.txid === txid && x.maybe);
        if (e) { delete e.maybe; await this.store.set(k, h); }
      } catch { /* flag hygiene only: a stale maybe marker self-heals via the pendingMerge reconcile and the spend latch */ }
    });
  }
  private latchSpentMerges(k: string, spent: string[]): Promise<void> {
    return this.inHistChain(async () => {
      if (!this.w.unlocked()) return;
      try {
        const h: any[] = (await this.store.get(k)) || [];
        const set = new Set(spent.map((t) => String(t).toLowerCase()));
        let dirty = false;
        for (const e of h) {
          // spending the output proves the tx landed; that also RESOLVES a maybe flag (an entry can
          // otherwise sit {maybe:true, confirmed:true} showing a stale "may be in flight" marker)
          if (e?.type === "consolidate" && !e.confirmed && set.has(String(e.txid).toLowerCase())) { e.confirmed = true; delete e.maybe; dirty = true; }
        }
        if (dirty) await this.store.set(k, h);
      } catch { /* flag hygiene only: a stale maybe marker self-heals via the pendingMerge reconcile and the spend latch */ }
    });
  }
  private async doRecordTx(k: string, entry: Record<string, unknown>) {
    const h: any[] = (await this.store.get(k)) || [];
    const e = h.find((x) => x?.txid === entry.txid);
    if (e) {
      // Idempotent by txid; but a DEFINITIVE record for a txid first recorded maybe:true resolves
      // the ambiguity: clear the flag IN PLACE. Never re-insert or reorder; ts, position and the
      // consolidate confirmed-latch must survive (a replace would resurrect the pending-forever
      // bug the latch exists to prevent).
      if (e.maybe && !entry.maybe) { delete e.maybe; await this.store.set(k, h); }
      return;
    }
    h.unshift(entry);
    await this.store.set(k, h.slice(0, 200));
  }
  // PCD-2: recordTx NEVER rejects. send() awaits maybeRecord before returning, so a storage throw
  // AFTER a successful broadcast used to make send() throw and tell the user their send FAILED
  // when it succeeded, driving a real double-pay on retry. The RMW rides histChain (no interleaved
  // clobber); a failed write PARKS the entry for retry on the next recordTx and stays visible via
  // the history() merge. The drain rides BEHIND the caller's own write and is never awaited by it,
  // so a recovered store cannot make one legitimate send pay off the whole backlog.
  private recordTx(k: string, entry: Record<string, unknown>): Promise<void> {
    const own = this.inHistChain(async () => {
      if (!this.w.unlocked()) {
        // Locked mid-flight: the tx is already broadcast, so park the row (it is the double-pay backstop);
        // it is merged into history() and drains on the next history write after unlock. Reset drops it.
        if (!this.w.wiped()) this.pendingHist.push({ k, entry });
        return;
      }
      try {
        // a definitive record supersedes a parked maybe twin for the same txid
        this.pendingHist = this.pendingHist.filter(
          (p) => !(p.k === k && p.entry.txid === entry.txid && p.entry.maybe && !entry.maybe));
        await this.doRecordTx(k, entry);
      } catch { this.pendingHist.push({ k, entry }); }
    });
    if (this.pendingHist.length) void this.inHistChain(() => this.drainPendingHist()).catch(() => { /* drainPendingHist re-parks each row it fails to write; this keeps a rejection off the unhandled path */ });
    return own;
  }
  async drainPendingHist(): Promise<void> {
    if (!this.w.unlocked()) return;
    const parked = this.pendingHist; this.pendingHist = [];
    for (const p of parked) {
      try { await this.doRecordTx(p.k, p.entry); } catch { this.pendingHist.push(p); }
    }
  }
  history(): Promise<any[]> {
    if (!this.w.unlocked()) return Promise.resolve([]);
    const k = histKey(this.w.addr());
    return this.store.get(k).then((h: any[]) => {
      const stored = h || [];
      const parked = this.pendingHist
        .filter((p) => p.k === k && !stored.some((x: any) => x?.txid === p.entry.txid))
        .map((p) => p.entry);
      return parked.length ? [...parked, ...stored] : stored;
    });
  }

  // Pending-merge line and inclusion reconcile (popup-only; test/inclusion-chain.test.mjs). Each open row is
  // settled from chain reads, not the clock: included once its txid is in a utxo set or reported mined;
  // `gone` (a different mined tx spent one of its inputs) only after two tips agree, cleared by any later
  // reading that disagrees (a read that could not look changes nothing), and read once per
  // INCLUSION_GONE_READ_INTERVAL blocks while gone; `stuck` INCLUSION_NOTICE_BLOCKS past `subTip`.
  // A merge latches `confirmed` because the next step spends its output. Cost per refresh: one tip read, at
  // most INCLUSION_READS_MAX status reads (each 2 to 4 node reads behind the proxy's caches), one per row per
  // block (`chkTip`), and one mined-utxo read when a status came back unknown. Reads stay OUTSIDE histChain
  // (a read inside it would park send()'s own history write behind a hung RPC); the chained step re-reads.
  async pendingMerge(utxos?: { txid: string; vout?: number }[]): Promise<{ pending: boolean; amount: number; maybe: boolean; stuck: boolean }> {
    const quiet = { pending: false, amount: 0, maybe: false, stuck: false };
    const addr = this.w.addr(), k = histKey(addr); // captured once (F5): history, latch and balance stay on ONE account
    // pre-read ONLY for the early return, the fetch decision and the read list; the chained work RE-READS fresh.
    const peek: any[] = (await this.store.get(k)) || [];
    const hasCandidates = peek.some(isMergeCandidate);
    // Nothing to derive AND nothing reconcilable against a caller-supplied utxo set: no network at all.
    if (!hasCandidates && !(utxos && peek.some(isOpenRow))) return quiet;
    let set = utxos;
    if (!set) { try { ({ utxos: set } = await node.balance(this.w.rpc(), addr)); } catch { return quiet; } }
    // filter hostile/degenerate elements (0.2.57, reviewer nit): a null utxo entry from a hostile RPC
    // used to throw here and land in the caller's ambiguous catch; a misleading "pending unknown".
    const present = new Set((set || []).filter((u) => u && u.txid != null).map((u) => String(u.txid).toLowerCase()));
    const open = peek.filter((x) => isOpenRow(x) && !present.has(String(x.txid).toLowerCase()));
    const reads = open.length ? await this.inclusionReads(open, addr) : { tip: null, states: new Map<string, TxInclusion>(), mined: null };
    return this.inHistChain(async () => {
      if (!this.w.unlocked()) return quiet;
      // RE-READ inside the chain: the pre-network read above is stale across the reads, and writing it
      // back clobbered anything recorded during them (P75-6 correction 1).
      const h: any[] = (await this.store.get(k)) || [];
      let dirty = false;
      for (const e of h) {
        if (!isOpenRow(e)) continue;
        const id = String(e.txid).toLowerCase();
        const st = reads.states.get(id) ?? null;
        const verdict = present.has(id) || reads.mined?.txids.has(id) ? "included" : inclusionVerdict(st, e.inputs, reads.mined?.ops ?? null);
        if (verdict === "included") {
          delete e.maybe; delete e.stuck; delete e.gone; delete e.goneTip;
          if (e.type === "consolidate") e.confirmed = true;
          dirty = true;
          continue;
        }
        if (reads.tip == null) continue;
        if (verdict !== "noreading" && goneStep(e, verdict, reads.tip)) dirty = true;
        if (!(Number(e.subTip) > 0)) { e.subTip = reads.tip; dirty = true; }
        if (st && e.chkTip !== reads.tip) { e.chkTip = reads.tip; dirty = true; }
        if (!e.stuck && reads.tip - Number(e.subTip) >= INCLUSION_NOTICE_BLOCKS) { e.stuck = true; dirty = true; }
      }
      let amount = 0, maybe = false, pending = false, stuck = false;
      for (const e of h) {
        if (!isMergeCandidate(e)) continue;
        // amount = what actually comes back once mined: the merge OUTPUT (inputs minus fee); the
        // recorded e.amount is the input total, which would overstate by the fee.
        pending = true; amount += Math.max(0, (Number(e.amount) || 0) - (Number(e.fee) || 0));
        maybe = maybe || !!e.maybe; stuck = stuck || !!e.stuck;
      }
      if (dirty) await this.store.set(k, h);
      return { pending, amount, maybe, stuck };
    }).catch(() => quiet);
  }
  // The tip once, a status read for each open row not yet read at this tip (newest first, capped), and the
  // mined utxo set once if any status came back unknown. No tip: no chain-derived step this pass.
  private async inclusionReads(open: any[], addr: string): Promise<{ tip: number | null; states: Map<string, TxInclusion>; mined: { ops: Set<string>; txids: Set<string> } | null }> {
    const states = new Map<string, TxInclusion>();
    const t = await node.tip(this.w.rpc()).catch(() => 0);
    if (!(Number.isSafeInteger(t) && t > 0)) return { tip: null, states, mined: null };
    const due = open.filter((x) => !(Number(x.chkTip) >= t) && !(x.gone && t - Number(x.chkTip) < INCLUSION_GONE_READ_INTERVAL)).slice(0, INCLUSION_READS_MAX);
    const got = await Promise.all(due.map((x) => node.txInclusion(this.w.rpc(), String(x.txid))));
    due.forEach((x, i) => { const st = got[i]; if (st) states.set(String(x.txid).toLowerCase(), st); });
    if (![...states.values()].some((st) => st.state === "unknown")) return { tip: t, states, mined: null };
    const list = await node.confirmedUtxos(this.w.rpc(), addr);
    const live = (list || []).filter((u) => u && u.txid != null);
    const mined = list ? { ops: new Set(live.map((u) => node.opKey(u.txid, u.vout))), txids: new Set(live.map((u) => String(u.txid).toLowerCase())) } : null;
    return { tip: t, states, mined };
  }
}
