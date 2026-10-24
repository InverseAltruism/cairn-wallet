// popup.ts and approve.ts bind their listeners at module top level through `$(id)!`: one id missing from the page
// throws before any listener exists and leaves a dead popup or an approval window with no working buttons. The pages
// are restyled often; this checks the static HTML against the ids each script reads (scripts/popup-ids.mjs, shared
// with the in-browser scripts/ux-shots.mjs), and that the pages carry no inline script or handler, which the
// extension's CSP (script-src 'self') would block.
// Run: npx tsx test/popup-ids.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { idsFromSource, idsInHtml } from "../scripts/popup-ids.mjs";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("popup and approval window ids");

for (const [script, page] of [["popup.ts", "popup.html"], ["approve.ts", "approve.html"]]) {
  const want = idsFromSource(script);
  const have = idsInHtml(page);
  const missing = want.filter((id) => !have.has(id));
  check(`${page} holds every id ${script} reads (${want.length} ids; missing: ${missing.join(", ") || "none"})`, want.length > 0 && missing.length === 0);
  const html = readFileSync(join(import.meta.dirname, "..", "src", "popup", page), "utf8");
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\ssrc="/.test(m[1]) || m[2].trim() !== "");
  check(`${page}: every <script> loads a file (${inline.length} inline)`, inline.length === 0);
  const handlers = [...html.matchAll(/<[a-z][^>]*\son[a-z]+\s*=/gi)];
  check(`${page}: no inline event handler attribute (${handlers.length} found)`, handlers.length === 0);
}

done("popup-ids");
