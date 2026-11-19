# Testing and CI

Status: as built, 2026-11-17. Moved out of `AGENTS.md`, which keeps the check commands and the rules; this file holds
the detail of the runner, the helpers, what the main test files cover and what CI runs.

## The runner

`npm test` is `test/run.mjs`, a glob runner that runs the files one after another: new test files are discovered, not
hand-listed, and `COMMITTED_EXPECTED_MIN` in `test/run.mjs` is the floor that fails the runner if a gate file is
dropped. Underscore-prefixed files (`test/_*`) and `.d.ts` files are helpers, not tests. Run one file with
`npx tsx test/<file>`.

`test/runner-guards.test.mjs` drives the real runner against throwaway sandboxes, including a three-file fixture whose
middle file fails: the remaining files still run and the exit is non-zero.

## Helpers

- Test files use the one shared helper `test/helpers/check.mjs` (`checker()`; `test/_check.ts` re-exports it for older
  importers). Its tripwire throws when `check()` gets a function or a promise instead of an evaluated condition, since
  both are always truthy (test/check-helper.test.mjs). Files still on a local bare helper adopt it when touched.
- Red-first mutation runs that drop a `MUTATE_` marker line load the Wallet through `test/helpers/mutant.mjs`, which
  finds the marker in `wallet.ts` or a module it imports.

## What the main files cover

| Test | Covers |
|---|---|
| `sig-vectors.test.mjs` | csd-vectors' signature encodings through both signature checks in `spvbind.ts`, the only ones in `src/` |
| `selftest.ts` | golden vectors, a real on-chain signature against a recomputed sighash, vault downgrade resistance, HD derivation, the fee-cap lock |
| `pentest.ts` | source-scan tripwires |
| `extension-boundary.ts` | the real background message gate |
| `cairnx.ts` | the record builders, byte for byte against cairnx-core |
| `namespv.test.mjs` | SPV name verification, with PoCs: union withholding, stale-tip lapse, srs escape, v23 burn guard |
| `ghostcoin.test.mjs` | the per-coin verify verdicts on the send path |
| `consolidate.test.mjs` | the maybe-inflight record, clear and reconcile matrix and account-switch filing |
| `resolve-fallback.test.mjs` | clarvis base-claim source selection |
| `persistvault-race.test.mjs` | concurrent account management cannot drop an imported key |
| `selectinputs-parity.ts` | runs the bundled csd-tx `selectInputs` and pins `spendableCoins` to it |
| `selectinputs-spelling.test.mjs` | a coin served in two txid spellings on the send and consolidate paths |
| `maxsendable.test.mjs` | Max against the engine |
| `identicon.test.ts` | the popup draws the vendored cairn-ui avatar |
| `mark-home.test.mjs`, `extension-icons.test.mjs` | the mark's one home |
| `sign-display-parity.test.mjs` | every request type the approval window paints, against the signed transaction; every decoded `cairnx:v1` record type from a third-party and the first-party origin; the raw card; signing from a site that never connected; a fill with an extra output on both lanes; the name record caution on a transfer or profile write, with the read held open; every name verdict recomputed when the signer shown changes |
| `propose-prequeue.test.mjs` | one table of proposal and seal parameters through the pre-queue check and the signer, the same verdict and text on both |
| `fill-refill-after-send.test.mjs` | a fill asked again after the first was sent, on the offer-id and reservation lanes (two coins), each limit of the rule, a lost submit's retry signed as the same transaction, the history row after each re-send, and what the page and the window are told |
| `send-fill-prequeue.test.mjs` | the same for sends and fills, the output caps at their boundaries, and that the refusal reads nothing and is the same locked or unlocked |
| `request-shape-prequeue.test.mjs` | attests, reveals and ids, addresses and scores of the wrong JSON type through the pre-queue check and the signer, and every documented shape queues |
| `request-shape-fuzz.test.mjs` | a grid and a seeded, time-bounded fuzz of every allowlisted method: no request that passes the pre-queue check makes the window's paint throw, in the pure formatters and the real window |
| `provider-discovery.test.mjs` | `cairn#initialized`, `csd:announceProvider` and its detail, the frozen provider and its members |

Also: `poc-signin-oracle.ts`, `multiwallet.ts`, `bruteforce.test.mjs`, `csdtx-boundary.test.mjs`, `clearsign.ts`,
`siwc.ts`, `events.test.ts`, `qr.test.ts`, `asset-tiles.test.mjs`. `ls test` is the full list; each file's header says
what it pins.

## In-Chrome tests

The in-Chrome tests (`test/*-chrome.test.mjs`) need playwright-core (`PLAYWRIGHT_CORE`, a package directory) and a
Chromium (`PLAYWRIGHT_CHROMIUM`, a full Chromium: `popup-font-chrome` loads an unpacked extension, which the headless
shell cannot); without them they print SKIP, and `CAIRN_E2E_REQUIRED=1` turns a SKIP into a failure. The page
measurements the approval window's layout tests share (`measure`, `settle`, the line's words) are in
`test/helpers/approve-measure.mjs`.

Not part of `npm test`:

- `node scripts/ux-shots.mjs`: the UI harness (a headless walk with zero-page-error and element-ID assertions).
- `tsx scripts/live-e2e.ts`: live mainnet E2E, maintainer-only: it spends about 0.03 CSD of real funds.

## CI

- `ci.yml`, job `test`: `npm ci --ignore-scripts`, typecheck, lint, `check:dashes-paths`, the suite with its in-Chrome
  tests required (a pinned playwright-core from its registry tarball, checked against the sha512 in cairn's lockfile,
  and its Chromium), the build, and `verify:vendor` (the byte-identity rebuild from the installed, pinned csd-sdk
  packages). The release build job installs the same playwright-core and Chromium.
- `ci.yml`, job `secrets`: a pinned, sha256-checked gitleaks over the full history of every ref with merge diffs and
  the repo's `.gitleaks.toml`. `.githooks/README.md` describes the matching pre-commit hook.
- `test/release-workflow-permissions.test.mjs` pins the release workflow's permission split and the shape of the
  `secrets` job.
- Every job of both workflows runs on `ubuntu-24.04`, not a moving `-latest` image, where the pinned playwright-core
  cannot install its Chromium (`test/ci-runner-image.test.mjs`).
- Every setup-node step names Node 26, the release host's runtime, which cairn's `scripts/ci-local.sh` compares with
  the host's major (`test/ci-node-version.test.mjs`).
- The tool versions and their checksums are in the two workflow files; read them there.

## The release workflow

`release.yml` runs three jobs on a tag push:

- `anchors`: re-walks `src/core/spvanchors.ts` from clarvis's public /api/headers and checks every entry against the
  front door's /api/rpc/block/height; the newest entry must be 1,000 to 6,000 below the public tip.
- `build`: npm ci, typecheck, test, verify:vendor (the byte-identity rebuild), package; the four files leave as one
  artifact.
- `release`, which needs the other two: it downloads the artifact, runs `sha256sum -c` on both zips, writes the SLSA
  attestation and runs the idempotent gh release create. Only `release` holds `contents: write`, `id-token: write`
  and `attestations: write`, and it checks nothing out and installs nothing, so tests and dev dependencies never run
  with the attestation token in reach (`test/release-workflow-permissions.test.mjs`).

`release.yml` also runs on pull requests that touch the table, `scripts/update-spv-anchors.mjs` or the vendored
bundle; there only `anchors` runs, the publish jobs are gated to tag pushes. The table is regenerated per
`store/PUBLISH-RUNBOOK.md` step 2. Both workflows default to `permissions: {}` with per-job grants and check out with
`persist-credentials: false`.
