// The wallet's user-visible text makes no claim the protocol does not back. A CSD-paid offer fill pays on chain while
// CairnX may still refuse the delivery (the payment is then not returned), so no fill is "atomic" or
// "delivery-versus-payment"; nothing is "trustless", "guaranteed" or "risk-free". Scans every source of shown text
// (the popup and approval-window modules and pages, the core modules whose errors the popup shows verbatim, and the
// store listing) with comments stripped, so a new string in the class fails here wherever it is added.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";

const ROOT = join(import.meta.dirname, "..");
const BANNED = /\batomic(ally)?\b|delivery[- ]versus[- ]payment|\bDvP\b|\btrustless(ly)?\b|\bguarantee[ds]?\b|\brisk[- ]free\b/i;
// Text that uses a word of the class to say less, not more.
const ALLOWED = [/a weaker guarantee/];
const t = checker("wallet claims");

// Code: block comments, then line comments (a `//` after start or whitespace; "https://" keeps its colon before it).
const stripCode = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/.*$/gm, "$1");
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
const files = (dir, ext) => readdirSync(join(ROOT, dir), { recursive: true }).map(String)
  .filter((f) => ext.some((e) => f.endsWith(e)) && !f.includes("vendor") && !f.includes("qr/")).map((f) => join(dir, f));
const sources = [...files("src/popup", [".ts", ".html"]), ...files("src/core", [".ts"]), "src/background.ts", "src/inpage.ts", "store/STORE-LISTING.md"];

export function hits(path, text) {
  const shown = path.endsWith(".ts") ? stripCode(text) : path.endsWith(".html") ? stripHtml(text) : text;
  return shown.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => BANNED.test(ALLOWED.reduce((x, a) => x.replace(a, ""), l))).map(([n, l]) => `${path}:${n}: ${l.trim().slice(0, 120)}`);
}

const found = sources.flatMap((p) => hits(p, readFileSync(join(ROOT, p), "utf8")));
t.check(`no shown text in ${sources.length} sources claims an atomic or guaranteed fill (${found.join(" | ") || "none"})`, sources.length > 40 && found.length === 0);
// PAIRED: the scan reads what it should and skips only comments
t.check("a claim inside a string is caught", hits("x.ts", 'lede("Pay and attest in one atomic transaction.")').length === 1);
t.check("the same words in a comment are not", hits("x.ts", "// Atomic fill (CairnX DvP)\n/* trustless */ const a = 1;").length === 0);
t.check("a URL in a string does not hide the rest of its line", hits("x.ts", 'const u = "https://x.example"; const m = "guaranteed delivery";').length === 1);
t.check("an allowed hedge passes, and a claim on the same line still fails", hits("x.ts", '"a weaker guarantee"').length === 0 && hits("x.ts", '"a weaker guarantee, but atomic"').length === 1);
t.check("the store listing is read as text", hits("store/STORE-LISTING.md", "The wallet's trustless name verification").length === 1);
t.done("wallet-claims");
