// A send Review's wait for the name check (D12): from 0.3 s the sheet says "Checking alice.csd..." ([A16]) with the
// header sync's share while headers sync, and from 10 s, once the name service has answered, it offers "Send without
// check". The check is the one resolveName call; the line reads the background's memory only (`nameCheck`), so the
// wait adds no request. A check that answers inside 0.3 s shows nothing.
import { call } from "./popup-bridge.js";
import { $ } from "./popup-dom.js";
import { SKIP_CHECK, sentenceOf } from "./sentences.js";

export const STATUS_AFTER_MS = 300;
export const CHOICE_AFTER_MS = 10_000;
const POLL_MS = 250;

/** The sheet's line, its text and its button (popup.html). */
export type CheckUi = { line: string; text: string; skip: string };
export const CSD_CHECK_UI: CheckUi = { line: "s-check", text: "s-check-text", skip: "s-check-skip" };
export const TOKEN_CHECK_UI: CheckUi = { line: "ts-check", text: "ts-check-text", skip: "ts-check-skip" };

/** One resolveName call, kept across "Wait" so going back to the check sends nothing again. `settled` is set when it
 *  answers; the Confirm of a review armed before that reads it (popup-sendflow.ts). */
export type NameCheck = { name: string; startedAt: number; result: Promise<any>; settled: { value: any } | null };
export function startNameCheck(name: string): NameCheck {
  const c: NameCheck = { name, startedAt: Date.now(), result: Promise.resolve(null), settled: null };
  c.result = call("resolveName", name).catch(() => ({ ok: false, error: "Name lookup failed." })).then((v: any) => { c.settled = { value: v }; return v; });
  return c;
}

export type Served = { addr: string; lapsed: boolean };
export type CheckWait = { kind: "done"; res: any } | { kind: "chose"; served: Served } | { kind: "left" };
let owner = 0;   // the wait that owns each sheet's line: a newer Review's line is not hidden by an older wait ending

/** Waits for the check, showing the line and the choice on the sheet; `left` true (the Review was left) ends it. The
 *  times count from the check's start, so after "Wait" the line and the choice are back at once. */
export function awaitCheck(c: NameCheck, ui: CheckUi, left: () => boolean): Promise<CheckWait> {
  const me = ++owner;
  const line = $(ui.line) as HTMLElement, text = $(ui.text), skip = $(ui.skip) as HTMLButtonElement;
  let served: Served | null = null, shown = false, offered = false, done = false;
  const t0 = c.startedAt;
  return new Promise<CheckWait>((resolve) => {
    const end = (w: CheckWait) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      skip.onclick = null;
      if (line.dataset.owner === String(me)) { line.hidden = true; skip.hidden = true; }
      resolve(w);
    };
    const paint = (pct: string) => { text.textContent = sentenceOf("A16", undefined, { name: `${c.name}.csd`, pct }).text; };
    const tick = async () => {
      if (done) return;
      if (left()) return end({ kind: "left" });
      const at = Date.now() - t0;
      if (at >= STATUS_AFTER_MS) {
        const st = await call("nameCheck", c.name).catch(() => null);
        if (done) return;
        if (st?.served?.addr) served = { addr: String(st.served.addr), lapsed: st.served.lapsed === true };
        const p = st?.progress;
        const pct = p && p.total > 0 ? ` ${Math.min(99, Math.floor((p.done / p.total) * 100))}%` : "";
        if (!shown) { shown = true; line.dataset.owner = String(me); line.hidden = false; skip.hidden = true; skip.textContent = SKIP_CHECK; }
        if (line.dataset.owner === String(me)) paint(pct);
        if (!offered && served && at >= CHOICE_AFTER_MS && line.dataset.owner === String(me)) {
          offered = true;
          skip.hidden = false;
          skip.onclick = () => { if (served) end({ kind: "chose", served }); };
        }
      }
      timer = setTimeout(tick, at < STATUS_AFTER_MS ? STATUS_AFTER_MS - at : POLL_MS);
    };
    let timer = setTimeout(tick, Math.max(0, STATUS_AFTER_MS - (Date.now() - t0)));
    c.result.then((res) => end({ kind: "done", res }));
  });
}
