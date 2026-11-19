# cairn-wallet

Guide for maintainers, coding agents and outside contributors; `README.md` is for users and integrators. `AGENTS.md`
is canonical and `CLAUDE.md` is a symlink to it. Production and operations specifics (hosting, deployment, keys) are
intentionally out of scope here and maintained privately by the maintainers.

The first non-custodial browser wallet for Compute Substrate (CSD): a Chrome MV3 extension (Chrome, Brave, Edge) that
generates a BIP-39 phrase on-device, derives accounts via BIP-32/44 at m/44'/7779'/0'/0/i (7779 is this wallet's own
coin-type convention), encrypts keys locally, and signs everything on-device. It is the fund-custody endpoint of the
ecosystem: CSD sends, CairnX token transfers, .csd name operations (renew, set-primary, send-to-name with in-wallet
SPV), sealed commit-reveal claims, Cairn posts, CairnX offer fills (the payment and the fill record in one
transaction; CairnX decides delivery, and a refused fill keeps the payment), the `window.cairn` dApp provider used by
cairn-substrate.com, and audience-bound Sign in with CSD (SIWC).

- Distribution: the Chrome Web Store (primary; extension id nnjiejlalkcfckfojhihbbcpfhimfemd) and reproducible GitHub
  release zips. The version is in `package.json` and the git tags. Public repo InverseAltruism/cairn-wallet, MIT.
- Security posture: non-custodial, no hand-rolled crypto (every primitive comes from the four exact-pinned @noble and
  @scure libraries). The threat model and what the wallet does and does not trust are public in `SECURITY.md`; read it
  before touching a money path. The ranked hardening roadmap is maintained privately with the other audit docs.

## Check

```bash
npm ci                        # CI uses --ignore-scripts
npm run typecheck
npm run lint                  # Biome, four rules only (biome.json; test/lint-config.test.mjs)
npm run check:dashes-paths    # em dashes in docs, sibling-checkout reads in code
npm test                      # test/run.mjs, sequential and offline; one file: npx tsx test/<file>
npm run build                 # tripwires run here -> dist/ (load it unpacked at chrome://extensions)
npm run verify:vendor         # vendor-freshness gate
npm run package               # deterministic zips + sha256
```

- New test files are discovered by the runner, not hand-listed; `COMMITTED_EXPECTED_MIN` in `test/run.mjs` is the
  floor that fails it if a gate file is dropped.
- Test files use the one shared helper `test/helpers/check.mjs` (`checker()`); files still on a local bare helper
  adopt it when touched.
- The in-Chrome tests (`test/*-chrome.test.mjs`) print SKIP without `PLAYWRIGHT_CORE` and `PLAYWRIGHT_CHROMIUM` (a
  full Chromium); `CAIRN_E2E_REQUIRED=1` turns a SKIP into a failure, and CI sets it.
- `node scripts/ux-shots.mjs` is the headless UI walk. `tsx scripts/live-e2e.ts` is maintainer-only: it spends about
  0.03 CSD of real mainnet funds.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, check:dashes-paths, the suite with its in-Chrome tests
  required, the build, verify:vendor and a gitleaks `secrets` job. The runner, the helpers, what the main test files
  cover and the CI pins: `docs/TESTING.md`.

## Cross-repo standard

This repo follows the maintainers' cross-repo engineering standard (a private document). The summary below is the
part that binds a contributor here:

- One home per concept: consensus rules and shared money math are imported from the vendored csd-sdk bundle, never
  re-declared. The one deliberate copy (`src/core/csdtx.ts`) is pinned by tests and is not to be extended.
- TypeScript `strict` with `noUncheckedIndexedAccess`, no `@ts-ignore`, `any` only at a parse boundary (`src/core`
  has no `as any`). Money is integer base units (`bigint`), never floats; conversion to display text happens in one
  helper. No empty `catch {}`; on money paths (signing, fills, claims, names, sends) no catch-and-continue that hides
  a failure from the user, and error text is honest ("may be in flight" only when something may have been broadcast).
- Tests check behaviour at boundaries. A fix ships with a test that fails without it, plus an assertion that the
  honest path still passes with the exact call shape production sends. A skipped test names its reason and when it
  un-skips. `npm test` is offline and deterministic.
- Comments state constraints and non-obvious invariants, not history or audit IDs; existing comment essays and audit
  IDs in `src/` are trimmed per module, not as drive-by edits. Removing code needs the same evidence as adding it,
  and on the signer path a second reviewer re-derives it.
- Docs: this file holds what stays true: no version tables and no "current state" snapshots (the version is in
  `package.json` and the tags; live state comes from a live query). History goes to `CHANGELOG.md`. Dates are
  absolute. No em dashes in any doc (`grep -cP '\x{2014}' <file>` prints 0; `npm run check:dashes-paths` checks every
  tracked .md outside docs/archive/); no AI-slop phrasing.

Known deviations (files over 800 lines, four copies kept in step by hand, empty blocks that lint only warns about,
comment essays in `src/`): `docs/ARCHITECTURE.md`, "Deviations from the cross-repo standard".

## Invariants and red lines

The mechanism behind each is in `docs/ARCHITECTURE.md` and the design notes; the store release's red lines are under
"Release and deploy".

Signing and funds:

- Local signing only. The wallet never signs a digest a server handed it. Inputs are always wallet-selected; change
  only returns to the wallet's own address. A dApp can pass outputs, never UTXOs or a change address.
- `assembleValueTx` (`src/core/node.ts`) is the single chokepoint for every value tx. Verify before sign, fail closed
  per class: tamper refuses the whole spend; transient is a retryable refusal; a ghost (notfound) coin is skipped,
  never spent unverified. Nothing is signed on any verify failure (test/ghostcoin.test.mjs).
- Fee caps refuse, never rebuild.
- What you see is what you sign: frozen review snapshots; confirm-time name re-resolve and verified-regression
  refusal; account-switch-mid-approval refusal (ACCOUNT_CHANGED); fee-gate crossing refusal (FEE_CHANGED); bidi- and
  zero-width-hardened escapeHtml. The approval window reads every request field it shows or uses from
  `src/core/signfields.ts`, which the sign path builds from (test/sign-display-parity.test.mjs), and it re-fetches
  the reservation and runs `finalizeWinnerCheck` before allowing a fee-burning finalize.
- No unattended transaction broadcast, in any form. Deferred finalize (sign upfront, broadcast later) was built and
  deliberately reverted; the wallet does not initiate a background broadcast. Automated flows may at most raise an
  approval prompt while the tab is visible.
- Offer fills: every lane merkle-proves the offer and binds the served terms to it before signing; the remaining
  resolver trust (give-backing, the completeness of a partial offer's fill list on the offer-id lane) and the
  second-source reads with their gaps are in `docs/DESIGN-fill-lanes.md`. One fill request per fill target at a time:
  another is refused `FILL_IN_PROGRESS` before it is queued (test/fill-one-request-per-offer.test.mjs). After the
  first was sent, another CSD-paid fill of the same target refuses retryably while the first is recent (30 minutes),
  not gone and not seen applied, except a lost submit's retry that builds the same transaction; the rule is decided in
  one function, `fillpreflight.ts` `repeatedFillRefusal`, which for such a retry runs on the assembled transaction
  (test/fill-refill-after-send.test.mjs).
- Name sends stay on SPV name verification (`namespv`). A disagreeing second source is a warning, not a refusal (the
  warn-over-block rule; `SECURITY.md` states it).
- SPV headers (`docs/DESIGN-namespv-scaling.md`): the names floor 29,960 cannot move, since verifying a name event at
  height h needs the verified header at exactly h. Every anchor-table entry is a light-client checkpoint for the life
  of the release (an `anchors` prefix in tests narrows the newest anchor, never the checkpoint map,
  test/namespv-anchor-prefix.test.mjs); a served chain that contradicts one fails closed with no fallback to an older
  entry (test/namespv-store-pins.test.mjs). Do not adopt a stored header without its walk to the table, its forward
  verification, or its walk to the session pin (headers verified earlier in the same browser session): that check is
  the storage-poisoning defence. When the node tip cannot be read, `prepare` syncs nothing and reports
  `tipKnown: false`, and the fclaim fill lane refuses (test/spv-unknown-tip.test.mjs).
- Display-only reads never reach a signature: `src/core/market.ts` (the USD line; test/usd-line.test.mjs scans for
  other importers) and `src/core/cairnxview.ts`.
- An unrevealed sealed claim is never deleted except by `reset()`: the cap evicts revealed records only, and
  `removeAccount` keeps the account's unrevealed records (test/seal-remove-keep.test.mjs).
- `maybeRecord` (`src/core/history.ts`) is the single history chokepoint, and every sign flow captures its histKey
  before its first await so entries file under the account that signed.

Keys and the dApp boundary:

- The vault is AES-256-GCM under PBKDF2-SHA256, with a downgrade floor and a DoS ceiling on a stored iteration count
  (`src/core/keystore.ts`); the session key rehydrate fails closed. At start the background sets both
  `chrome.storage.local` and `chrome.storage.session` to `TRUSTED_CONTEXTS`, so content scripts cannot read or write
  the vault or the header snapshot (test/storage-access-level.test.mjs).
- Privileged methods (export, mnemonic, account management, settings, reset, consolidate) are popup-only, refused on
  the dApp channel even if approved. `reset` exists only as a background method; no screen offers it. The
  `DAPP_METHODS` allowlist is enforced twice: before a request is queued and in `resolvePending`
  (test/extension-boundary.ts, test/resolve-allowlist-second-line.test.mjs).
- export/exportMnemonic deliberately work while locked (password-gated direct vault decrypt); correct behaviour, do
  not "fix".
- An open approval window is brought forward only by `focusApprovalWindow`, the one `chrome.windows.update` in
  `src/`, which first asks the window to re-arm its buttons (test/approve-raise-rearm.test.mjs,
  test/approve-raise-chrome.test.mjs).
- Every new user-facing {ok:false} carries a machine code (`WALLET-ERROR-CODES.md`); codes are additive, never
  reused. `spentTxids` and `inputs` on a submit result are internal: `resolvePending` strips both before a page
  receives the result.

Vendored consensus, permissions and the build:

- Consensus rules are imported or vendored from csd-sdk, never re-declared in this repo. The deliberate copy stays a
  copy, never deduplicated into an import: `src/core/csdtx.ts` (server codec twin, pinned by the golden vectors in
  test/selftest.ts). Coin selection is csd-tx's `selectInputs` from the bundle, not a copy.
- The vendored bundle (`src/vendor/cairnx-spv.js` and its generated `cairnx-spv.d.ts`) changes only via
  `scripts/build-spv-vendor.sh` and `check-vendor-fresh.mjs --write`. `src/vendor/PROVENANCE.json` pins both files'
  sha256, each csd-sdk package's version and lockfile integrity, and the noble versions; `npm run verify:vendor` (CI
  and the release build) checks those pins and that a rebuild is byte-identical.
- Re-vendor csd-sdk by moving the exact `@inversealtruism/*` dev dependency pins in package.json to the published
  versions (`npm install --save-dev --save-exact` with the per-command cooldown exclusion for the scope), then
  `bash scripts/build-spv-vendor.sh`, then `node scripts/check-vendor-fresh.mjs --write`, and commit package.json,
  package-lock.json, the bundle, its `.d.ts` and PROVENANCE.json together. No csd-sdk checkout is read; esbuild runs
  from the wallet root, so the bytes do not depend on where the checkout sits.
- Dependencies: four runtime deps, exact-pinned (@noble/curves, @noble/hashes, @scure/bip32, @scure/bip39). Dev
  dependencies are exact-pinned too, each to the version package-lock.json installs (test/dep-pins.test.mjs). The
  csd-sdk packages are dev dependencies only: all trust-sensitive shared code ships as the vendored bundle built from
  them, and nothing in `dist/` imports a package at runtime.
- `public/manifest.json`: permissions only storage, alarms and unlimitedStorage (the SPV header store grows with the
  chain); CSP connect-src limited to cairn-substrate.com, clarvis and loopback; web_accessible_resources only
  inpage.js; no externally_connectable (test/pentest.ts section 10 pins the last two and the scope of
  host_permissions).
- Build tripwires are load-bearing (`build.mjs` aborts): no external message surface anywhere; adding a fetch host
  requires manifest CSP and host_permissions or the build fails; the `Wallet` class stays out of `popup.js` and
  `approve.js`, so `approve.ts` must not import `popup-bridge.ts`; the vendored cairn-ui files must match their
  PROVENANCE.json.
- Node RPC is the Cairn proxy or a loopback node only (`rpcAllowed`, `src/core/endpoints.ts`). Every outer timeout
  sits above its server-side worst case; do not lower one without re-deriving the inner chain.
- Known accepted residuals: tx history and labels in chrome.storage.local are not additionally encrypted
  (sealed-claim preimages are vault-key-encrypted at rest, pinned by test/seal-encrypt.test.mjs; an OS-level
  compromise of the browser profile can read the remaining history, local-disk privacy only, never key material);
  PBKDF2-600k, with Argon2id on the roadmap; keys are hot in the service worker while unlocked (hardware-wallet
  support is on the roadmap); no external professional audit yet (it is the top roadmap item).

## Rules learned from incidents

The incidents behind these are in `CHANGELOG.md`.

- When a submit fails, tell "the front door refused the HTTP request" apart from "the node rejected the tx" before
  blaming the wallet, and show "may be in flight" only when the tx may have been broadcast.
- One unverifiable coin must not block every spend: verify verdicts are per coin.
- The unlocked key survives a service-worker idle kill through chrome.storage.session. The approval window runs in a
  tab, so the sender gate keys on the extension-origin `sender.url`, not on a missing tab.
- The version is written only in package.json; the PROVENANCE and rebuild gates stop a stale vendored bundle; the
  source-host tripwire stops a fetch host missing from the CSP.
- fillOffer's exact `bigint` need-map preflight and the fail-closed registered-versus-unregistered handling in the
  union path are load-bearing; keep them.
- rename/removeAccount take an address, not an index.
- `sighashMatch` in SubmitResult is vestigial but dApp-visible; keep it.
- A .csd recipient never reaches a URL unvalidated (NAME_RE first; test/names-check-before-url.test.mjs).
- Wallet distribution is the Chrome Web Store and GitHub releases only; the sites do not serve the zip.

## Release and deploy

Maintainers deploy and release. PRs should not assume deploy access, bump versions, or cut tags; propose the change
and a maintainer handles versioning and release.

1. Bump the version in package.json only (`npm version X.Y.Z --no-git-tag-version`, which also updates
   package-lock.json). build.mjs stamps it into dist/manifest.json and window.cairn.
2. Regenerate the SPV anchor table (`src/core/spvanchors.ts`) per store/PUBLISH-RUNBOOK.md step 2. Between releases,
   a table-only release is cut once the public tip is more than 14,400 blocks above the newest entry.
3. `npm test && npm run package` green. scripts/package.mjs emits byte-reproducible zips and sha256s (the store
   upload file `cairn-wallet-store-X.Y.Z.zip` and the two the release carries; the runbook's step 5). node_modules
   must be a real `npm ci` directory: a symlinked one changes esbuild's path comments and the hash.
4. Tag and push (maintainers only). release.yml runs `anchors` (re-walks the table against the public chain; the
   newest entry must be 1,000 to 6,000 below the public tip), `build` (npm ci, typecheck, test, verify:vendor,
   package) and `release` (checks the zips' sha256, writes the SLSA attestation, creates the GitHub release). Only
   `release` holds write permissions, and it checks nothing out and installs nothing, so tests and dev dependencies
   never run with the attestation token in reach (`test/release-workflow-permissions.test.mjs`). Both workflows
   default to `permissions: {}` with per-job grants and check out with `persist-credentials: false`. The jobs in
   full: `docs/TESTING.md`.
5. Chrome Web Store: manual, per store/PUBLISH-RUNBOOK.md (upload the local `cairn-wallet-store-X.Y.Z.zip` to the
   [Developer Dashboard](https://chrome.google.com/webstore/devconsole) after its sha256 matches the release, then the
   post-publish CRX check). Never automate it.
6. The website links the Chrome Web Store and releases/latest and restates no version or sha256, so a release needs
   no site change.

Red lines: the Chrome Web Store upload stays manual and off CI (store/PUBLISH-RUNBOOK.md; supply-chain rationale from
the Shai-Hulud incident class). No store API key or webstore-upload action enters CI. Single maintainer, so no dual
control: reproduce-then-publish (the local stamped zip's sha256 must equal the CI-attested `cairn-wallet-store.zip`),
hardware 2FA, and a post-publish CRX check against the attested zip (commands in the runbook).

## Working rules

1. Security fixes must not regress UX: no added latency, no declines on legitimate sends or buys, no
   over-engineering. Prefer warn over block, honesty over machinery. Fail-closed without an availability valve counts
   as a UX regression. Ideas already considered and declined as over-engineering include EIP-55-style checksums,
   hard-blocking unverified sends, and forced argon2id migration.
2. When scope is ambiguous, open an issue or short design note first rather than a large speculative diff.

## Cross-repo contract

- The wallet is the signer for the whole app layer. It talks to the cairn web front door at
  https://cairn-substrate.com (/api/rpc/* proxying to the node RPC with rate limiting and body caps,
  /trade/api/cairnx/* to the CairnX resolver, /api/headers for SPV, /api/content, /auth) and to clarvis
  (https://clarvis.cairn-substrate.com) as the second source for name verification (same operator and same
  registrable domain as the first, so not independent). Related public surfaces: the csd-sdk packages on npm
  (@inversealtruism/*) and the csd-indexer block explorer.
- Consensus math arrives only via the vendored csd-sdk bundle (csd-tx is bundled like the other packages, for its
  `selectInputs`); there is no dependency on cairn-sdk.
- Downstream: cairn-sdk (`mapProviderError`) and the cairn site's trade UI consume the machine error codes.
- The chain: Rust node, 120 s blocks, UTXO P2PKH, no script VM, no finality below app-layer confirmation depths.

## Where code lives

Everything ships bundled by esbuild from `src/` into `dist/` (gitignored). `docs/ARCHITECTURE.md` has the per-module
detail and the runtime footprint (timeouts, fan-out, storage, consensus caps, the post retry schedule).

- `build.mjs`, `scripts/`: the build and its tripwires; vendor build and checks, packaging, the anchor table
  generator, icons.
- `src/background.ts`: the MV3 service worker (the unlocked key, the dApp approval queue, per-origin consent, the
  method allowlist, auto-lock). `src/content.ts`, `src/inpage.ts`: the frozen `window.cairn` provider and its relay.
- `src/core/`: keys (`keystore.ts`, `account.ts`), the tx codec twin (`csdtx.ts`), the send engine (`node.ts`), the
  `Wallet` class and its sign flows (`wallet.ts`), the signed fields per request (`signfields.ts`), offer fills
  (`fillpreflight.ts`, `fillspv.ts`), name verification and SPV (`names.ts`, `namespv.ts`, `spvbind.ts`, the header
  store and the anchor table), history and sealed claims (`history.ts`, `claims.ts`), CairnX record builders
  (`cairnx.ts`), endpoints and sign-in rules.
- `src/popup/`: `popup.ts` and one `popup-*.ts` module per view, `approve.ts` (the clear-signing window),
  `clearsign.ts` (pure formatters). `tiles.ts` draws the Cairn mark only for the pinned CAIRN deploy.
- `src/vendor/`: the csd-sdk bundle, and cairn-ui (avatar, theme, fonts, logos; the mark's one home is `mark.svg`)
  with its own PROVENANCE.json, checked by scripts/check-ui-vendor.mjs.
- `public/`: the manifest and the generated icons. `store/`: the Chrome Web Store kit.

## Docs

- `README.md` (users and integrators), `SECURITY.md` (threat model, trust boundaries, how to report),
  `CHANGELOG.md` (release notes, including the history and incident notes moved out of this file).
- `WALLET-ERROR-CODES.md`: the dApp error-code contract (codes are the contract, strings are UX copy; read by
  `test/wallet-0270-hygiene.test.mjs`; stays at the root). `docs/PROVIDER.md`: the rest of the provider contract for
  application developers; its last section names the file that holds each number it states.
- `docs/ARCHITECTURE.md` (per-module detail, runtime footprint, deviations) and `docs/TESTING.md` (runner, helpers,
  CI, the release workflow).
- Design notes: `docs/DESIGN-namespv-scaling.md` (header store, anchor table, name verification),
  `docs/DESIGN-fill-lanes.md` (what each fill lane proves, what stays resolver-trusted),
  `docs/DESIGN-inclusion-reconcile.md` (how sent transactions settle), `docs/DESIGN-viafill.md` (names bought
  through the market; open).
- `store/README.md` indexes the store package: `store/PUBLISH-RUNBOOK.md` (the release procedure,
  security-critical), `store/STORE-LISTING.md`, `store/PRIVACY-POLICY.md`. `.githooks/README.md`: the secret-scan
  pre-commit hook.
- `docs/archive/`: superseded docs, indexed in `docs/archive/README.md`; moved with `git mv`, basenames kept.
