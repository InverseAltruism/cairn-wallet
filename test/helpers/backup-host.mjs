// Imported (for its effect) by every test file that stubs globalThis.fetch while the wallet uses the default RPC. The
// wallet also sends every submit to the default RPC's second host (src/core/hosts.ts), and reads from it when the main
// host fails or is slow. The file's own stub keeps answering the main host only, so the file's counts stay counts of
// the main host's requests. This helper answers the second host itself:
//   - a submit with the main host's answer to the byte-equal body. A body the main host was never sent in this file is
//     a second signing: the file fails at exit, whatever its own tally says.
//   - a read as an unreachable host (a TypeError), so a read's outcome is the main host's alone.
// Files that route the second host themselves (the ones about it) do not import this; test/backup-host-guard.test.mjs
// fails when a file that stubs fetch does neither.
import { BACKUP_RPC } from "../../src/core/endpoints.js";

const WRAPPED = Symbol("backup-host");
const mainAnswers = new Map();   // the submitted body text -> the main host's answer (a promise)
const strays = [];
let current;

const bodyText = (init) => (typeof init?.body === "string" ? init.body : String(init?.body ?? ""));

function wrap(fn) {
  if (typeof fn !== "function" || fn[WRAPPED]) return fn;
  const w = async (url, init) => {
    const u = String(url);
    const submit = u.endsWith("/tx/submit");
    if (u.startsWith(BACKUP_RPC + "/")) {
      if (!submit) throw new TypeError("fetch failed (backup host unreachable in this test)");
      const answer = mainAnswers.get(bodyText(init));
      if (!answer) {
        strays.push(bodyText(init).slice(0, 120));
        throw new TypeError("fetch failed (backup host got a body the main host was never sent)");
      }
      const r = await answer;
      return typeof r?.clone === "function" ? r.clone() : r;
    }
    if (!submit) return fn(url, init);
    const p = Promise.resolve().then(() => fn(url, init));
    // the second host's copy is answered from a clone, so the wallet's read of the main answer stays untouched
    const kept = p.then((r) => (typeof r?.clone === "function" ? r.clone() : r));
    kept.catch(() => undefined);   // the main host's own caller sees the rejection; this copy only replays it
    mainAnswers.set(bodyText(init), kept);
    return p;
  };
  w[WRAPPED] = true;
  return w;
}

current = wrap(globalThis.fetch);
Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => current, set: (fn) => { current = wrap(fn); } });

process.on("exit", () => {
  if (!strays.length) return;
  console.error(`\n✗ backup-host: the second host was sent ${strays.length} submit bod${strays.length === 1 ? "y" : "ies"} the main host never received (a second signing):`);
  for (const s of strays) console.error("   " + s);
  process.exitCode = 1;
});
