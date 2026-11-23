// The foreground comes first on the network. The requests a user waits on (a balance, the coins and the submit of a
// send, the node tip, a name's reads and a lookup's header pages) are counted while they are in flight; the background
// header sync starts a page only once none has been in flight for QUIET_MS, and a background page in flight when one
// starts is cancelled and asked again later (`onForeground`). One count per worker: the
// service worker is the wallet's one network user (the popup and the approval window read little of their own).
// docs/DESIGN-namespv-scaling.md, "The sync and its runner"; test/netgate.test.mjs.

/** A background page waits until no foreground request has been in flight for this long: the requests of one send
 *  follow each other within it (the coins, their source transactions, the submit), so a page does not slip between. */
export const QUIET_MS = 250;
/** A counted request stops counting after this, above the longest timeout a wallet request carries (a submit's 20 s),
 *  so a request that does not settle holds the background sync for at most this long (test/netgate.test.mjs 3). */
export const HOLD_MAX_MS = 30_000;

let inFlight = 0;
let lastEnd = -Infinity;
const wakers = new Set<() => void>();
const starts = new Set<() => void>();

const wakeAll = () => { for (const w of [...wakers]) w(); };

/** Runs `op` counted as foreground until it settles (or HOLD_MAX_MS). */
export async function foreground<T>(op: () => Promise<T>): Promise<T> {
  inFlight++;
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    inFlight--;
    lastEnd = performance.now();
    wakeAll();
  };
  const cap = setTimeout(release, HOLD_MAX_MS);
  (cap as { unref?: () => void }).unref?.();
  try {
    // The request goes out first; the background pages it cancels end after it.
    const p = op();
    for (const f of [...starts]) f();
    return await p;
  } finally { clearTimeout(cap); release(); }
}

/** Calls `f` whenever a foreground request starts, until the returned function is called. */
export function onForeground(f: () => void): () => void {
  starts.add(f);
  return () => { starts.delete(f); };
}

/** `fetch`, counted as foreground until the response's headers arrive or the request fails. */
export const foregroundFetch: typeof fetch = (input, init) => foreground(() => fetch(input, init));

/** True while a foreground request is in flight or ended less than QUIET_MS ago. */
export const foregroundBusy = (): boolean => inFlight > 0 || performance.now() - lastEnd < QUIET_MS;

/** Settles once the foreground has been quiet for QUIET_MS; rejects when `signal` aborts first. */
export function foregroundQuiet(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((done, fail) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (timer !== undefined) clearTimeout(timer); wakers.delete(check); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { stop(); fail(signal?.reason ?? new Error("aborted")); };
    function check() {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (inFlight > 0) return; // a release wakes it
      const left = QUIET_MS - (performance.now() - lastEnd);
      if (left <= 0) { stop(); done(); return; }
      timer = setTimeout(check, left);
    }
    if (signal?.aborted) { fail(signal.reason ?? new Error("aborted")); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    wakers.add(check);
    check();
  });
}
