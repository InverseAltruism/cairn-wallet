// The store listing justifies every host permission the manifest declares and names every host the wallet reaches
// in its network-scope sentence: clarvis.cairn-substrate.com was granted and fetched but missing from both, so the
// listing understated what the wallet talks to. The privacy policy names the off-chain content a post sends.
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
const scope = /host_permissions stays scoped to the node\/proxy \(([^)]*)\)/.exec(listing)?.[1] ?? "";
for (const h of manifest.host_permissions.map((p) => new URL(p.replace(/\*$/, "")).hostname).filter((h) => h !== "127.0.0.1"))
  check(`the content-script note's network scope names ${h} (${scope})`, scope.includes(h));
check("the listing no longer says the only outbound traffic is a transaction or a signature", !/only outbound traffic is a/.test(listing) && /off-chain content of posts/.test(listing));
const policy = read("store/PRIVACY-POLICY.md");
check("the privacy policy names a post's off-chain content and where it goes", /off-chain content \(title, body, links\)/.test(policy) && /cairn-substrate\.com\/api\/content/.test(policy));
check("the privacy policy explains the content script", /\*\*Content script\*\*/.test(policy));
done("store-listing-hosts");
