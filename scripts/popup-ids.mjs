// The element ids popup.ts and approve.ts read, derived from their source. Each script binds its listeners at
// module top level through `$(id)!`, so one id missing from the page stops the whole script. Used by
// scripts/ux-shots.mjs (in the browser) and test/popup-ids.test.mjs (against the static HTML).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Ids that exist only after a script writes them with innerHTML, never in the static HTML.
export const DYNAMIC_IDS = new Set([
  "assets-retry", "rpc-add-input", "rpc-add-btn", "exp-add-input", "exp-add-btn", // popup menus and assets
  "cost", "bal-after", "send-warn", "token-sim", "fill-view", "reveal-preview", // approve window, injected by clearsign describe()
  "nfin-note", // approve window, the finalize-window verdict line approve.ts inserts while a finalize request is open
]);

/** The ids `src/popup/<file>` reads that must be in its page's static HTML. */
export function idsFromSource(file) {
  const src = readFileSync(join(ROOT, "src", "popup", file), "utf8");
  const ids = new Set();
  for (const m of src.matchAll(/(?:\$\(|getElementById\()\s*"([\w-]+)"\s*\)/g)) ids.add(m[1]); // `)` required: skips concatenations like $("view-" + v)
  // the view switcher builds "view-" + name
  if (/show\(view: string\)|"view-" \+/.test(src)) for (const v of ["setup", "backup", "locked", "main"]) ids.add("view-" + v);
  // the PANELS accordion array
  const pm = src.match(/const PANELS = \[([^\]]+)\]/);
  if (pm) for (const s of pm[1].matchAll(/"([\w-]+)"/g)) ids.add(s[1]);
  for (const d of DYNAMIC_IDS) ids.delete(d);
  return [...ids].sort();
}

/** The ids declared in a static HTML file under src/popup/. */
export function idsInHtml(file) {
  const html = readFileSync(join(ROOT, "src", "popup", file), "utf8");
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}
