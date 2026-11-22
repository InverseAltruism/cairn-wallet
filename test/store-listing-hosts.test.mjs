// The store listing justifies every host permission the manifest declares and names every host the wallet reaches
// in its network-scope sentence: clarvis.cairn-substrate.com was granted and fetched but missing from both, so the
// listing understated what the wallet talks to. The privacy policy names the off-chain content a post sends.
// The content script's broad match is host access as Chrome counts it (chrome.permissions.getAll() lists https://*/*,
// probe of 2026-11-22); the wallet's own requests are limited by the CSP's connect-src, and the note says so.
// Run: npx tsx test/store-listing-hosts.test.mjs   (offline)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checker } from "./helpers/check.mjs";

const { check, done } = checker("store listing and privacy policy cover what the wallet sends:");
const ROOT = join(import.meta.dirname, "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const manifest = JSON.parse(read("public/manifest.json"));
const listing = read("store/STORE-LISTING.md");
for (const host of manifest.host_permissions) check(`the listing justifies the host permission ${host}`, listing.includes(`Host permission \`${host}\``));
// The content-script note says what Chrome counts (the matches widen host access) and what limits the wallet's own
// requests: connect-src. It names every declared host and every remote connect-src host, so neither can drift.
const scope = /beside the declared host_permissions \(([^)]*)\)/.exec(listing)?.[1] ?? "";
for (const h of manifest.host_permissions.map((p) => new URL(p.replace(/\*$/, "")).hostname).filter((h) => h !== "127.0.0.1"))
  check(`the content-script note's host list names ${h} (${scope})`, scope.includes(h));
const connect = (manifest.content_security_policy.extension_pages.match(/connect-src([^;]*)/)?.[1] ?? "").trim().split(/\s+/).filter((x) => x.startsWith("https://") && !x.includes("localhost"));
const csp = /connect-src allows only (.*?), and the browser refuses/.exec(listing)?.[1] ?? "";
for (const h of connect) check(`the content-script note's connect-src names ${h}`, csp.includes(h));
check("the note no longer says host access is not broadened", !/NETWORK access is NOT broadened/.test(listing) && /lists https:\/\/\*\/\*/.test(listing));
check("the listing no longer says the only outbound traffic is a transaction or a signature", !/only outbound traffic is a/.test(listing) && /off-chain content of posts/.test(listing));
const policy = read("store/PRIVACY-POLICY.md");
check("the privacy policy names a post's off-chain content and where it goes", /off-chain content \(title, body, links\)/.test(policy) && /cairn-substrate\.com\/api\/content/.test(policy));
check("the privacy policy explains the content script", /\*\*Content script\*\*/.test(policy));
done("store-listing-hosts");
