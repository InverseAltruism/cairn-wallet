# Cairn Wallet: Publish Runbook (security-critical)

> **Why this exists.** The wallet's protections (SPV `.csd` name-verify, clear-signing, the dApp boundary) all
> run **inside the extension**. A malicious auto-update disables every one of them at once. The Chrome Web Store
> (CWS) publish credential is therefore the single highest-blast-radius asset in the project. The **Trust Wallet
> Dec-2025 incident** ($8.5M drained from ~2,520 wallets) was exactly this: a leaked CWS API key (scraped by the
> Shai-Hulud worm from GitHub secrets) auto-pushed a backdoored build that harvested mnemonics on every unlock,
> bypassing all human review. This runbook is the reproduce-then-publish procedure, and the post-publish check
> that detects an upload that did not come from it.

## Threat model (one line)
A leaked or abused credential that can push a build to all users is game over. The project has **one
maintainer**, so no control here is a second person. The controls keep the store credential out of CI, tie
every upload to a CI-attested build of a tag, and detect a store build that does not match it.

## Standing controls
1. **CWS upload is MANUAL and OFF CI.** There is **no** Web-Store API key, refresh token, or `webstore-upload`
   action anywhere in CI (`release.yml` builds, attests and creates a GitHub release; it never uploads to the
   store). Do **not** "modernize" this into CI auto-publish: that re-introduces the exact Trust-Wallet vector
   (a CI-resident store credential a worm can scrape).
2. **Hardware-2FA** on the CWS developer account (a phishing-resistant security key, not TOTP/SMS).
3. **Web-Store API keys (if ever used for a separate, audited pipeline): short-lived, rotated ≤ 90 days, with an
   overlap window, and NEVER co-located with CI/GitHub secrets.** Prefer not having one at all.
4. **Single maintainer.** One GitHub account can push a `v*` tag, which runs `release.yml`, and the same person
   holds the CWS account. There is no required-reviewer environment and no second approver. What stands in
   for a second person: the release is built by CI from the tag and attested (5 below), the uploaded zip must
   have the attested zip's sha256 (step 6), and the store's CRX is compared with it after publication (step 8).
5. **SLSA provenance** is produced for every release (`attest-build-provenance` in `release.yml`); the repo is
   public, so the step is required and a failed attestation fails the release.

## What the GitHub release carries
`release.yml` attaches four files to the release for tag `vX.Y.Z`, and attests the two zips:

| File | What it is |
|---|---|
| `cairn-wallet-store.zip` | the Chrome Web Store package (`manifest.json` at the zip root) |
| `cairn-wallet-store.zip.sha256` | its sha256 |
| `cairn-wallet.zip` | the load-unpacked package (everything under `cairn-wallet/`) |
| `cairn-wallet.zip.sha256` | its sha256 |

The version-stamped `cairn-wallet-store-X.Y.Z.zip` is **not** on the release. It is the local file
`npm run package` writes next to the others, byte-identical to `cairn-wallet-store.zip`; the version in its
name makes a stale local file self-evident.

## Release procedure (every version)
1. **Bump the version** in `package.json` only; `build.mjs` stamps it into `dist/manifest.json` and
   `window.cairn` (provider `version` and `getCapabilities().version`).
2. **SPV anchor table.** `src/core/spvanchors.ts` is generated, not edited by hand (`test/spvanchors.test.mjs` fails a file the generator would not write). Regenerate it for every
   release so its newest entry is the newest chunk top (height 4096k + 4095) at least 1,000 blocks below the tip.
   On the deploy host, ask the node, the miner and clarvis for that height's hash (cairn's
   `bump-swapguard-cp.mjs`, run from the cairn checkout; all three must say yes, there is no override), then walk
   the headers to it and rewrite the table:
   ```bash
   TIP=$(curl -fsS http://127.0.0.1:8789/tip | node -pe 'JSON.parse(require("fs").readFileSync(0)).height')
   T=$(( (TIP - 999) / 4096 * 4096 - 1 ))      # newest 4096k+4095 at or below TIP - 1000
   CSD_RPC3=https://clarvis.cairn-substrate.com/api/rpc node scripts/bump-swapguard-cp.mjs --emit-json --target $T > /tmp/anchor.json   # in cairn
   node scripts/update-spv-anchors.mjs /tmp/anchor.json            # dry run: prints the entry count
   node scripts/update-spv-anchors.mjs /tmp/anchor.json --write    # rewrites src/core/spvanchors.ts
   ```
   The generator refuses, and writes nothing, when the anchor JSON fails any check, a header page is short or
   out of order, the walk from the floor pin does not reach the corroborated hash, or the new table does not
   extend the committed one. Commit the table on its own and keep the anchor JSON line with the release record.
   The `anchors` job in `release.yml` runs on that PR and on the tag (the release job needs it): it re-walks the
   chain from clarvis's public `/api/headers`, requires every entry to equal the walk, requires
   `https://cairn-substrate.com/api/rpc/block/height/<h>` to answer with that hash at every entry, and requires
   the newest entry to be between 1,000 and 6,000 blocks below the public tip. When it fails:
   - `more than 6000 below the public tip`: the table is stale; regenerate it (this step) and tag the new commit.
   - `less than 1000 below the public tip`: the table is too shallow; regenerate it at a lower target.
   - `answers "unreachable"`, a 429 or a timeout: a source was down or rate limited; re-run the job.
   - `the walk from ... reaches` another hash, or `answers "no"`: a served chain contradicts a pinned entry (a reorg
     deeper than 1,000 blocks, a wrong entry or a compromised source). Do not release and do not regenerate over
     it; compare the hash at that height on the node, the miner and clarvis, and investigate first.
   - `does not match the generator's output`: the file was edited by hand; regenerate it with the script.
3. **Vendor freshness:** `npm run verify:vendor` must pass. The load-bearing arm is the rebuild byte-diff: with a
   csd-sdk checkout at `PROVENANCE.json`'s `csdSdkCommit` (`CSD_SDK_DIR=<path>`), the script rebuilds the
   bundle and requires byte-identity. Without a csd-sdk checkout it skips that arm and runs only the cheap
   checks (bundle sha256 equals `PROVENANCE.json`, `@noble` pins agree). The line comparing csd-sdk's HEAD with
   `csdSdkCommit` is advisory and does not fail the gate. In CI the byte-diff runs in the `vendor-fresh-full` job,
   which needs the `ECOSYSTEM_RO_TOKEN` secret and skips its steps without it.
4. **Green gate:** `npm run typecheck && npm test` (full suite) must pass; CI must be green on the tag.
5. **Reproducible build.** Run `npm ci && npm run package`. This writes the version-stamped upload file
   `cairn-wallet-store-X.Y.Z.zip` + its `.sha256`, the byte-identical `cairn-wallet-store.zip`, and
   `cairn-wallet.zip`, via a deterministic (fixed-timestamp, sorted, STORE) zip writer, byte-identical across
   machines. The packager also HARD-FAILS if the manifest baked into the zip does not match `package.json`, so
   a stale `dist/` is not packaged silently. `node_modules` must be the real directory `npm ci` creates: a
   symlinked one makes esbuild write different source-path comments, and the hash no longer matches.
6. **Cross-check the artifact:** after `release.yml` finishes for the tag, the sha256 of the local
   `cairn-wallet-store-X.Y.Z.zip` must equal the release's `cairn-wallet-store.zip.sha256`. Two builds made on
   different machines (CI and yours) agreeing is the check; a mismatch stops the release.
   ```bash
   gh release download vX.Y.Z -R InverseAltruism/cairn-wallet -p 'cairn-wallet-store.zip.sha256' -O - | cut -d' ' -f1
   sha256sum cairn-wallet-store-X.Y.Z.zip | cut -d' ' -f1      # must print the same hash
   ```
7. **Upload manually** to the CWS dashboard (hardware-2FA): the local `cairn-wallet-store-X.Y.Z.zip` checked in
   step 6, never an unversioned copy.
8. **Post-publish CRX check.** Once the store serves the new version, download the CRX it serves and compare it
   with the attested `cairn-wallet-store.zip`. The store adds two things: an `update_url` key in `manifest.json`
   and a `_metadata/` folder. Everything else must be identical.
   ```bash
   V=X.Y.Z
   ID=nnjiejlalkcfckfojhihbbcpfhimfemd
   mkdir crx-check && cd crx-check
   curl -fsSL -o store.crx "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0&acceptformat=crx2,crx3&x=id%3D${ID}%26uc"
   gh release download "v$V" -R InverseAltruism/cairn-wallet -p 'cairn-wallet-store.zip*'
   sha256sum -c cairn-wallet-store.zip.sha256
   gh attestation verify cairn-wallet-store.zip --repo InverseAltruism/cairn-wallet
   # A CRX3 file is a "Cr24" header followed by the zip: strip the header.
   node -e 'const fs=require("fs");const b=fs.readFileSync("store.crx");if(b.toString("latin1",0,4)!=="Cr24"||b.readUInt32LE(4)!==3)throw new Error("not a CRX3 file");fs.writeFileSync("from-store.zip",b.subarray(12+b.readUInt32LE(8)))'
   mkdir served attested
   unzip -q from-store.zip -d served && unzip -q cairn-wallet-store.zip -d attested
   node -p 'require("./served/manifest.json").version'      # must print $V; an older version means the store has not switched yet
   diff -r -x _metadata -x manifest.json served attested && echo "files identical"
   node -e 'const r=(f)=>JSON.parse(require("fs").readFileSync(f,"utf8"));const s=r("served/manifest.json");delete s.update_url;process.exit(JSON.stringify(s)===JSON.stringify(r("attested/manifest.json"))?0:1)' && echo "manifest identical apart from update_url"
   ```
   Any other difference means the store serves something that is not the attested build: follow "If a
   credential is suspected leaked" below.
9. **Publish the version + sha256** (GitHub release + the website) so users can verify the build they installed
   is the reviewed one.

## If a credential is suspected leaked
Immediately: unpublish/withdraw the listing, rotate the CWS account credentials + any API keys, audit recent
versions for an unauthorized upload, and notify users to verify their installed version hash against the last
known-good release before unlocking.
