// Which host answers the wallet's node reads and takes its submits. The default RPC (Cairn's proxy) has a second host,
// BACKUP_RPC, a constant of the release; any other RPC (a node on this computer) is the only host. The second host is
// chosen here only, never from a setting or a page: rpcAllowed refuses it as an RPC (endpoints.ts).
import { DEFAULT_RPC, BACKUP_RPC } from "./endpoints.js";
import { decideSubmit, mainRefusedOr, type HostVerdict, type SubmitOutcome } from "./submitverdict.js";

/** A read goes to the second host when the first has not answered this long after it was asked. */
export const HEDGE_MS = 1_500;
/** After the main host's definite refusal, the other host is waited for this long, then the result is unclear. */
export const MAIN_REFUSED_WAIT_MS = 4_000;
/** After the main host failed a read, or the second host answered one first, reads ask the second host first for this
 *  long. */
export const BACKUP_FIRST_MS = 60_000;

// Module state dies with the service worker, so a fresh worker asks the main host first again.
let backupFirstUntil = 0;

export function hostsFor(rpc: string): readonly string[] {
  return rpc === DEFAULT_RPC ? [DEFAULT_RPC, BACKUP_RPC] : [rpc];
}
export const isBackup = (host: string): boolean => host === BACKUP_RPC;

/**
 * The first answer of `read` from the hosts of `rpc`, and the host that gave it. The preferred host is asked at once,
 * the other HEDGE_MS later or as soon as the preferred one fails, whichever comes first. A slow request is not cut
 * short: its own timeout ends it, and its answer still wins if it comes first. A read fails when it throws; when every
 * host failed, this throws the preferred host's error. With one host it is `read(rpc)`.
 */
export function firstAnswer<T>(rpc: string, read: (host: string) => Promise<T>): Promise<{ value: T; host: string }> {
  const hosts = hostsFor(rpc);
  if (hosts.length === 1) return read(rpc).then((value) => ({ value, host: rpc }));
  const order = Date.now() < backupFirstUntil ? [BACKUP_RPC, DEFAULT_RPC] : [DEFAULT_RPC, BACKUP_RPC];
  return new Promise((resolve, reject) => {
    const errors = new Map<string, unknown>();
    let started = 0, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startNext = () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      const host = order[started++]!;
      read(host).then((value) => {
        if (host === DEFAULT_RPC) backupFirstUntil = 0;
        if (settled) return;
        settled = true;
        // the second host answered while the main host, asked first, had not: later reads ask the second host first,
        // so they do not each wait HEDGE_MS; a main answer, even this one arriving late, ends that window
        if (host === BACKUP_RPC && order[0] === DEFAULT_RPC) backupFirstUntil = Date.now() + BACKUP_FIRST_MS;
        if (timer !== undefined) clearTimeout(timer);
        resolve({ value, host });
      }, (e: unknown) => {
        if (host === DEFAULT_RPC) backupFirstUntil = Date.now() + BACKUP_FIRST_MS;
        errors.set(host, e);
        if (settled) return;
        if (started < order.length) return startNext();
        if (errors.size === order.length) { settled = true; reject(errors.get(DEFAULT_RPC)); }
      });
    };
    startNext();
    timer = setTimeout(() => { timer = undefined; if (!settled && started < order.length) startNext(); }, HEDGE_MS);
  });
}

export type HostAnswer = { host: string; verdict: HostVerdict };
/**
 * One signed transaction sent to every host of `rpc` at once, and its outcome (submitverdict.ts decideSubmit) as soon
 * as it is decided: at the first acceptance, else once every host has answered (each POST ends at its own timeout).
 * `answers` holds the verdicts known at that moment, in host order. A host that answers later is passed to `onLate`
 * only: it never changes the outcome. A `send` that rejects counts as that host's unclear answer. Once the main host
 * has refused, the others get `capMs`: then the outcome is unclear, carrying the main host's refusal, and `capped`.
 */
export function submitEach(rpc: string, send: (host: string) => Promise<HostVerdict>, onLate?: (a: HostAnswer, capped: boolean) => void, capMs = MAIN_REFUSED_WAIT_MS): Promise<{ outcome: SubmitOutcome; answers: HostAnswer[]; capped: boolean }> {
  const hosts = hostsFor(rpc);
  const verdicts: (HostVerdict | undefined)[] = hosts.map(() => undefined);
  return new Promise((resolve) => {
    let decided = false, capped = false;
    let cap: ReturnType<typeof setTimeout> | undefined;
    const answered = () => hosts.flatMap((h, k) => (verdicts[k] ? [{ host: h, verdict: verdicts[k]! }] : []));
    hosts.forEach((host, i) => {
      // a send that rejects is that host's unclear answer, so no failure can leave its slot empty and the send waiting
      void send(host).catch((): HostVerdict => ({ kind: "unclear", text: "/tx/submit -> unreadable response" })).then((v) => {
        if (decided) { onLate?.({ host, verdict: v }, capped); return; }
        verdicts[i] = v;
        const outcome = decideSubmit(verdicts);
        if (!outcome) {
          if (i === 0 && v.kind === "refused") cap = setTimeout(() => {
            if (decided) return;
            decided = capped = true;
            resolve({ outcome: mainRefusedOr(v, { kind: "unclear", text: v.text }), answers: answered(), capped: true });
          }, capMs);
          return;
        }
        decided = true;
        if (cap !== undefined) clearTimeout(cap);
        resolve({ outcome, answers: answered(), capped: false });
      });
    });
  });
}
