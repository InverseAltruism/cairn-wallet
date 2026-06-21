# Cairn Wallet — Publish Runbook (security-critical)

> **Why this exists (H4 / WX-SUPPLY-PUBLISH-1).** The wallet's protections — SPV `.csd` name-verify,
> clear-signing, the dApp boundary — all run **inside the extension**. A malicious auto-update disables every
> one of them at once. The Chrome Web Store (CWS) publish credential is therefore the single highest-blast-radius
> asset in the project. The **Trust Wallet Dec-2025 incident** ($8.5M drained from ~2,520 wallets) was exactly
> this: a leaked CWS API key (scraped by the Shai-Hulud worm from GitHub secrets) auto-pushed a backdoored build
> that harvested mnemonics on every unlock — bypassing all human review. This runbook is the dual-control,
> reproduce-then-publish procedure that prevents it.

## Threat model (one line)
A single leaked/abused credential that can push a build to all users is game over. So: **no single credential,
held by no single party, resident in no CI, may publish unilaterally.**

## Standing controls
1. **CWS upload is MANUAL and OFF CI.** There is **no** Web-Store API key, refresh token, or `webstore-upload`
   action anywhere in CI (verified: `release.yml` builds + attests + creates a GitHub release, but never uploads
   to the store). Do **not** "modernize" this into CI auto-publish — that re-introduces the exact Trust-Wallet
   vector (a CI-resident store credential a worm can scrape).
2. **Hardware-2FA** on the CWS developer account (a phishing-resistant security key, not TOTP/SMS).
3. **Web-Store API keys (if ever used for a separate, audited pipeline): short-lived, rotated ≤ 90 days, with an
   overlap window, and NEVER co-located with CI/GitHub secrets.** Prefer not having one at all.
4. **Dual-control on what gets built/tagged.** The `release.yml` workflow runs from a pushed `v*` tag; protect
   the tag pattern and put the release job in a GitHub **environment with required reviewers** so one person
   cannot unilaterally produce the artifact. (Repo/branch protection + a 2-person review on release-relevant
   changes — GitHub's required-reviewer rule.)
5. **SLSA provenance** is produced automatically when the source repo is **public** (`attest-build-provenance`).
   On a private repo it is a documented no-op. Making the repo public (the wallet is already declared
   open-source and ships reproducible byte-identical zips) restores real, verifiable provenance.

## Release procedure (every version)
1. **Bump in lockstep** — `package.json`, `public/manifest.json`, and `src/inpage.ts` versions must agree
   (the `build.mjs` version-sync tripwire fails the build otherwise).
2. **Vendor freshness** — `npm run verify:vendor` must pass, including the full rebuild-vs-source byte-diff and
   the `csdSdkCommit` provenance match (set `ECOSYSTEM_RO_TOKEN` in CI so the cross-repo rebuild job runs;
   without it the full diff self-skips).
3. **Green gate** — `npm run typecheck && npm test` (full suite) must pass; CI must be green on the tag.
4. **Reproducible build** — `npm ci && npm run package`. This emits `cairn-wallet-store.zip` + its `.sha256`
   via a deterministic (fixed-timestamp, sorted, STORE) zip writer — byte-identical across machines.
5. **Cross-check the artifact** — an independent maintainer reproduces step 4 and confirms an **identical
   sha256** before anyone uploads (this is the dual-control checkpoint).
6. **Upload manually** to the CWS dashboard (hardware-2FA), from the reviewed `cairn-wallet-store.zip`.
7. **Post-publish hash verification** — once the new version is live, fetch the published CRX and confirm it
   corresponds to the reviewed/attested zip. Any divergence ⇒ an out-of-band/unauthorized upload ⇒ pull the
   listing + rotate credentials immediately.
8. **Publish the version + sha256** (GitHub release + the website) so users can verify the build they installed
   is the reviewed one.

## If a credential is suspected leaked
Immediately: unpublish/withdraw the listing, rotate the CWS account credentials + any API keys, audit recent
versions for an unauthorized upload, and notify users to verify their installed version hash against the last
known-good release before unlocking.
