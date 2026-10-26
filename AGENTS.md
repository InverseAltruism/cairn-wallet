# cairn-wallet

> Onboarding briefing for coding agents and outside contributors. `AGENTS.md` is canonical; `CLAUDE.md` is a symlink to it.
> Production and operations specifics (hosting, deployment, keys) are intentionally out of scope here and maintained privately by the maintainers.

The first non-custodial browser wallet for Compute Substrate (CSD): a Chrome MV3 extension (Chrome/Brave/Edge) that generates a BIP-39 phrase on-device, derives accounts via BIP-32/44 at m/44'/7779'/0'/0/i (7779 is this wallet's own coin-type convention), encrypts keys locally, and signs everything on-device. It is the fund-custody endpoint of the ecosystem: CSD sends, CairnX token transfers, .csd name operations (renew, set-primary, send-to-name with in-wallet SPV), sealed commit-reveal claims, Cairn posts, atomic offer fills (DvP), the `window.cairn` dApp provider used by cairn-substrate.com, and audience-bound Sign in with CSD (SIWC).

Distribution: Chrome Web Store (primary; extension id nnjiejlalkcfckfojhihbbcpfhimfemd) + reproducible GitHub release zips. The version is in `package.json` and the git tags. Public repo InverseAltruism/cairn-wallet, MIT.

Security posture: non-custodial, no hand-rolled crypto (every primitive comes from the four exact-pinned @noble/@scure libraries). The threat model and what the wallet does and does not trust are public in `SECURITY.md`; read it before touching a money path. (The ranked hardening roadmap is maintained privately with the other audit docs.) No external professional audit yet (it is the top roadmap item).

## Cross-repo standard

This repo follows the maintainers' cross-repo engineering standard (a private document). The rules that matter for a contributor here:

- One home per concept: consensus rules and shared money math are imported from the vendored csd-sdk bundle, never re-declared. The one deliberate copy (`src/core/csdtx.ts`) is pinned by tests and is not to be extended.
- TypeScript `strict` with `noUncheckedIndexedAccess`, no `@ts-ignore`, `any` only at a parse boundary (`src/core` has no `as any`). Money is integer base units (`bigint`), never floats; conversion to display text happens in one helper. No empty `catch {}`; on money paths (signing, fills, claims, names, sends) no catch-and-continue that hides a failure from the user, and error text is honest ("may be in flight" only when something may have been broadcast).
- Tests check behaviour at boundaries. A fix ships with a test that fails without it, plus an assertion that the honest path still passes with the exact call shape production sends. A skipped test names its reason and when it un-skips. `npm test` is offline and deterministic.
- Comments state constraints and non-obvious invariants, not history or audit IDs. Removing code needs the same evidence as adding it, and on the signer path a second reviewer re-derives it.
- Docs: this file holds what stays true: no version tables and no "current state" snapshots (the version is in `package.json` and the tags; live state comes from a live query). History goes to `CHANGELOG.md`. Dates are absolute, no em dashes.

Known deviations (checked 2026-10-22, not exhaustive):

- Over 800 lines: `src/core/wallet.ts` (1,091, about a third of it comments), `src/core/namespv.ts` (977), `src/core/node.ts` (905), and the third-party `src/popup/qr/qrcodegen.ts` (1,010), which tsc does not check (`@ts-nocheck` in its local banner: `noUncheckedIndexedAccess` would need edits to upstream code).
- Copies kept in step by hand, each with a KEEP-IN-SYNC comment where the standard prefers an import: the fee cap in `src/core/node.ts`; the field checks `src/core/siwc.ts` shares with csd-siwc. `src/core/csdtx.ts` calls itself the browser twin of the server codec and carries no marker; the golden vectors in `test/selftest.ts` pin it. `toChainEvent` in `src/core/spvbind.ts` mirrors the event shapes of the cairnx scanner, which lives in another repo; test/namespv.test.mjs replays them through the vendored resolver.
- `npm run lint` (Biome, `biome.json`) reports 97 empty blocks as warnings (12 in `src/`, 85 in `test/`), so that rule does not fail CI yet.
- Comment essays and audit IDs in `src/` are trimmed per module, not as drive-by edits.

## The stack around it

The wallet is the signer for the whole app layer. It talks to: the cairn web front door at https://cairn-substrate.com (/api/rpc/* proxying to the node RPC, /trade/api/cairnx/* to the CairnX resolver, /api/headers for SPV, /api/content, /auth), and clarvis (https://clarvis.cairn-substrate.com) as the second source for name verification (same operator and same registrable domain as the first, so not independent). Related public surfaces: the csd-sdk packages on npm (@inversealtruism/*) and the csd-indexer block explorer. Consensus math arrives only via the vendored csd-sdk bundle. The chain: Rust node, 120s blocks, UTXO P2PKH, no script VM, no finality below app-layer confirmation depths.

## Build and test

```bash
npm ci                        # CI uses --ignore-scripts
npm test                      # test/run.mjs glob runner, sequential
npm run typecheck
npm run lint                  # Biome, four rules only (biome.json; test/lint-config.test.mjs)
npm run check:dashes-paths    # em dashes in docs, sibling-checkout reads in code (CI runs both)
npm run build                 # tripwires run here -> dist/
npm run package               # deterministic zips + sha256
npm run verify:vendor         # vendor-freshness gate
```

- Load dist/ unpacked at chrome://extensions.
- Re-vendor csd-sdk by moving the exact `@inversealtruism/*` dev dependency pins in package.json to the published versions (`npm install --save-dev --save-exact` with the per-command cooldown exclusion for the scope), then `bash scripts/build-spv-vendor.sh`, then `node scripts/check-vendor-fresh.mjs --write`, and commit package.json, package-lock.json, the bundle, its `.d.ts` and PROVENANCE.json together. No csd-sdk checkout is read; esbuild runs from the wallet root, so the bytes do not depend on where the checkout sits.
- UI harness: `node scripts/ux-shots.mjs` (headless walk, zero-page-error and element-ID assertions).
- Live mainnet E2E (maintainer-only, spends about 0.03 CSD of real funds): `tsx scripts/live-e2e.ts`.

Tests:

- Test files use the one shared helper `test/helpers/check.mjs` (`checker()`; `test/_check.ts` re-exports it for older importers). Its tripwire throws when `check()` gets a function or a promise instead of an evaluated condition, since both are always truthy (test/check-helper.test.mjs). Files still on a local bare helper adopt it when touched.
- Red-first mutation runs that drop a `MUTATE_` marker line load the Wallet through `test/helpers/mutant.mjs`, which finds the marker in `wallet.ts` or a module it imports.
- `npm test` is `test/run.mjs`, a glob runner: new test files are discovered, not hand-listed; `COMMITTED_EXPECTED_MIN` in test/run.mjs is the floor that fails the runner if a gate file is dropped. Run one file with `npx tsx test/<file>`.
- `test/runner-guards.test.mjs` drives the real runner against throwaway sandboxes, including a three-file fixture whose middle file fails: the remaining files still run and the exit is non-zero.
- Highlights: selftest.ts (golden vectors, a real on-chain signature against a recomputed sighash, vault downgrade resistance, HD derivation, fee-cap lock), pentest.ts (source-scan tripwires), extension-boundary.ts (the real background message gate), poc-signin-oracle.ts, multiwallet.ts, bruteforce, csdtx-boundary, clearsign.ts, cairnx.ts (byte-for-byte against cairnx-core), siwc.ts, events.test.ts, namespv.test.mjs (with PoCs: union withholding, stale-tip lapse, srs escape, v23 burn guard), ghostcoin.test.mjs, consolidate.test.mjs (the maybe-inflight record, clear and reconcile matrix and account-switch filing), resolve-fallback.test.mjs (clarvis base-claim source selection), persistvault-race.test.mjs (concurrent account management cannot drop an imported key), selectinputs-parity.ts (runs the bundled csd-tx selectInputs and pins spendableCoins to it), selectinputs-spelling.test.mjs (a coin served in two txid spellings on the send and consolidate paths), identicon (the popup draws the vendored cairn-ui avatar), qr, maxsendable.test.mjs (Max against the engine), mark-home.test.mjs and extension-icons.test.mjs (the mark's one home), asset-tiles.test.mjs.
- CI: typecheck, lint, check:dashes-paths, the suite, build, verify:vendor (the byte-identity rebuild from the installed, pinned csd-sdk packages) and the `secrets` job (gitleaks 8.18.4, sha256-checked, over the full history of every ref with merge diffs and the repo's `.gitleaks.toml`). `test/release-workflow-permissions.test.mjs` pins the release workflow's permission split and the shape of the `secrets` job.

## Architecture

Everything ships bundled by esbuild from src/ into dist/ (gitignored), zero runtime npm imports (all four deps inlined).

- `build.mjs`: build plus two tripwires that abort it: (1) a forbidden external message surface (externally_connectable or onMessageExternal anywhere), (2) source-host coverage (every hardcoded https fetch host must be in CSP connect-src and host_permissions). The release version lives only in package.json; the build stamps it into dist/manifest.json and the inpage provider (esbuild define `__WALLET_VERSION__`).
- `src/background.ts`: MV3 service worker. It owns the unlocked key, the dApp approval queue, per-origin consent, the DAPP_METHODS allowlist (enforced twice: pre-queue and in resolvePending), the popup sender-origin gate, provider events and alarm-driven auto-lock.
  - Queue caps: MAX_PENDING_GLOBAL=32, PER_ORIGIN=5. A request returned to its reservation confirm step is re-queued without re-checking them, so a site can sit one above its cap per such request.
  - At start it sets both `chrome.storage.local` and `chrome.storage.session` to `TRUSTED_CONTEXTS` (content scripts cannot read or write the vault or the header snapshot; test/storage-access-level.test.mjs).
  - A keyed method that throws "locked" maps to `WALLET_LOCKED`, anything else to `INTERNAL` (`thrownCode`).
- `src/content.ts` / `src/inpage.ts`: inject the frozen window.cairn provider and relay it over same-origin `window` messages (source, target and origin checked; replies are not authenticated, a script on the page can read and forge them); csd:announceProvider discovery.
- `src/core/`:
  - `keystore.ts`: AES-256-GCM vault; PBKDF2-SHA256 600k iters; MIN_ITERS=100k downgrade floor and MAX_ITERS=30M DoS ceiling.
  - `account.ts`: BIP-39/32/44, coin type 7779.
  - `csdtx.ts`: the deliberate browser twin of the server tx codec (bincode, txid=sha256d, sighash CSD_SIG_V1, low-S; loginDigest structurally disjoint from a tx sighash). Do not dedupe it into an import.
  - `node.ts`: the send engine; `assembleValueTx` is the single chokepoint for every value tx, in this order:
    - fee > 0, flat MAX_FEE=100 CSD, zero-address refusal;
    - selectVerified, then csd-tx's selectInputs from the vendored bundle (greedy largest-first, MAX_TX_INPUTS=512 from csd-codec; one coin served in two txid spellings is one coin);
    - verifyInputValues: fetch each source tx and recompute its txid with the consensus codec, in a bounded pool (VERIFY_CONCURRENCY=8) with a decisive short-circuit. Verdicts: number, notfound, transient, tamper, horizon, unrepresentable. "horizon" is classified only on the node's exact 503 plus body code `SCAN_HORIZON`, so a cold-index window skips coins instead of refusing the spend (test/ghostcoin.test.mjs). "unrepresentable" is classified on the raw body before the txid recompute when a serialized number cannot survive JSON.parse exactly (test/unrepresentable-coin.test.mjs). Both are skipped per coin like notfound and add no rung to the decisive tamper/transient fold;
    - the ghost re-select loop, then the proportional fee cap max(1 CSD, 10% of verified inputs), change to self only, and signAndSubmit (SUBMIT_REJECTED vs SUBMIT_MAYBE_INFLIGHT vs SUBMIT_DUPLICATE).
    - `maxSendable()` is the send sheet's Max: `selectVerified` run with a target that each round is the reported total of the 512 largest coins still eligible, so the figure (that verified target minus the fee, under both fee caps) is what one `send` accepts at that moment; popup-only, signs nothing (test/maxsendable.test.mjs sends exactly it and one base unit more).
    - `consolidate()` merges dust: up to 512 smallest coins into one self-output, verified like a send, both fee caps apply (popup-only, not in DAPP_METHODS; `consolidatePreview()` feeds the settings ▸ coins UI).
    - `spendableCoins()` is the set of coins selectInputs accepts, each once: it asks selectInputs about each coin and dedupes on `opKey`, csd-tx's outpoint key in the node's `0x` form (test/selectinputs-parity.ts, test/selectinputs-spelling.test.mjs).
    - `VERIFY_UNAVAILABLE` also covers a `/utxos` body without a `utxos` array and a selection that used its three rounds on coins the node could not prove yet (both refuse before signing).
  - `wallet.ts`: the `Wallet` class: vault lifecycle, multi-account, chrome.storage.session key rehydrate (fail-closed), brute-force auth guard (5 failures, then exponential lockout), endpoint settings, signer capture, the sign flows (send, sendMany, consolidate, propose, attest, fillOffer, posts, token transfer, name renew and set-primary, sealClaim, SIWC), SPV wiring and its test seams. The modules below hold the rest; each reads the wallet through a small IO object or host the class builds from closures, called when the code runs. Every flow captures its histKey before its first await so entries file under the account that signed.
  - `endpoints.ts`: the default endpoints (incl. clarvis, the second source) and the URL rules. RPC rule: `rpcAllowed` accepts only the Cairn proxy or a loopback node (`http://127.0.0.1:<port>`, `http://localhost:<port>`); a saved remote RPC is moved to the proxy once with a notice. The Cairn and CairnX API settings take https or loopback (`validRpcUrl`), and the manifest CSP limits what is reachable.
  - `fillpreflight.ts`: what is checked before an offer fill is signed: the offer read, the output sums, then one of three lanes (`fclaimLanePreflight`, `csdLanePreflight`, `tokenLanePreflight`); returns a refusal or null, signs nothing. The design is `docs/DESIGN-fill-lanes.md`.
  - `names.ts`: name resolution and verification for sends to a `.csd` name (`resolveName`, `verifyName`, `confirmName`, the hint-set cache read and write).
  - `market.ts`: the CSD/USD rate behind the balance's USD line, read from the Cairn API's `/api/market/csd` (absent on its 503, a failure or a body without a positive price from a named venue); display only, imported by nothing that signs (test/usd-line.test.mjs).
  - `cairnxview.ts`: display-only CairnX reads for the popup and the approval cards (balances, token list, token-fill quote, fill view, token decimals); never bound to a signature.
  - `history.ts`: `TxHistory`, the per-account history. `maybeRecord` is the single history chokepoint: ok records, SUBMIT_MAYBE_INFLIGHT records maybe:true under the local txid, SUBMIT_DUPLICATE clears an earlier maybe in place (never inserts). Its write chain, the rows parked in RAM when a write fails or the wallet is locked, and the inclusion reconcile (`pendingMerge`, `docs/DESIGN-inclusion-reconcile.md`).
  - `claims.ts`: `SealedClaims`, the per-account sealed claims: reveal preimages encrypted under the vault key, the write chain and parked records, `revealClaim` (refuses with `SEAL_NOT_MINED` until the node shows the commit mined) and the list. `sealClaim`, which signs the commit, is a `Wallet` method.
  - `cairnx.ts`: CairnX record builders over the vendored core; consensus rules imported, never re-typed; a pre-spend parseRecord round-trip so build success implies resolver acceptance. No on-device registration flow: the /names site drives registration through dApp propose, always clear-signed.
  - `namespv.ts`: trustless name verification over the header store (`headerstore.ts`: IndexedDB, 84-byte records in 4,096-height chunks) anchored by the release table `spvanchors.ts` (one block hash per chunk from the names floor 29,960, each a light-client checkpoint).
    - At or below the newest anchor a header is used only from a chunk whose records hash-link to two table hashes in the same session; above it, from the PoW light client seeded from the anchor chunk and synced forward with every consensus check, or, after a worker restart in a session that already verified it, by a hash walk to the session pin (`src/core/spvpin.ts`, test/namespv-session-pin.test.mjs).
    - Then: full-block merkle bind, signer auth and prevout-ownership bind, and the two-source union (`verifyNameUnion`: primary and clarvis). A disagreeing source is a warning, not a refusal (the warn-over-block rule; SECURITY.md states it).
    - Store, sync, migration and the union's lapse and badge rules: `docs/DESIGN-namespv-scaling.md`.
  - `spvbind.ts`: the SPV primitives `namespv.ts` and `fillspv.ts` share: the block bind (`bindBlock` over csd-light `bindBlockBody`: exact parse of the served `/block` text, the repeated-txid refusal before the merkle compare, test/merkle-dup-txid.test.mjs), the author bind (`bindSigner` over csd-crypto `authorOf`: the owner of the coin input 0 spends, test/namespv-fillspv-parity.test.mjs), signer recovery, the coinbase test, `paidTo` and the event mapping. Both binds return their refusal; a body that does not decode throws. namespv turns a refusal into a reason and fillspv into a throw (`BodyMismatchError` for a merkle mismatch) or a null.
- `src/popup/`: popup.ts (the popup's entry: it loads one `popup-*.ts` module per view or concern, such as `popup-send.ts`, `popup-sendflow.ts` for the review engine the CSD and token sends share, `popup-panels.ts` for the sheets and their teardown, `popup-state.ts` for the state several views read; source scans read the whole set through `scriptSource("popup.ts")` in scripts/popup-ids.mjs), approve.ts (clear-signing window), clearsign.ts (pure formatters, among them `groupedAddr`, the one address-in-groups-of-four display both pages use, lookalike detection and the nfinalize approve gate: it re-fetches the reservation and runs finalizeWinnerCheck before allowing a fee-burning finalize), QR. The identity avatar is cairn-ui's `avatar.js`, vendored with the theme files and the logos in `src/vendor/cairn-ui/` (PROVENANCE.json, checked by scripts/check-ui-vendor.mjs). The Cairn mark has one home, the vendored `mark.svg`: the pages draw `<use href="ui/mark.svg#mark">` in its viewBox, the sprite `icons.svg` holds Lucide icons only, and `scripts/mark.mjs` reads it for the extension icons and the store images (test/mark-home.test.mjs). `tiles.ts` gives a token row its tile: the mark only for the CAIRN whose served deploy id is the pinned one (`isPinnedDeploy`), the neutral glyph for every other token; the CSD row draws the vendored `csd-logo.jpg`.
- `src/vendor/cairnx-spv.js`: vendored esbuild bundle of the published csd-sdk packages (csd-light, csd-client, csd-codec, csd-crypto, csd-tx, cairnx-core) at the exact versions package.json pins as dev dependencies; `cairnx-spv.d.ts` is generated with it from the same export list, so the types are the packages' own. PROVENANCE.json pins both files' sha256, each package's version and lockfile integrity, and the noble versions (read the file for the current values). scripts/check-vendor-fresh.mjs (`npm run verify:vendor`, run by CI and the release build) checks those pins, that the wallet's @noble pins equal the ones csd-crypto declares, and re-runs scripts/build-spv-vendor.sh into a temp dir: both files must be byte-identical to the committed ones.
- `public/manifest.json`: permissions only storage, alarms and unlimitedStorage (the SPV header store grows with the chain); CSP connect-src limited to cairn-substrate.com, clarvis and localhost; web_accessible_resources only inpage.js; no externally_connectable.
- `public/icons/icon-{16,32,48,128}.png`: written by `scripts/gen-icons.mjs` from the vendored mark (the light theme's on-ink colour on an ink tile, pure JavaScript, the same bytes for the same input); test/extension-icons.test.mjs compares the committed pixels with the script's.
- `store/`: Chrome Web Store listing kit, including PUBLISH-RUNBOOK.md (security-critical). `WALLET-ERROR-CODES.md`: the dApp error contract (codes are the contract, strings are UX copy).

## Invariants and red lines

- Local signing only. The wallet never signs a digest a server handed it. Inputs are always wallet-selected; change only returns to the wallet's own address. A dApp can pass outputs, never UTXOs or a change address.
- Verify before sign, fail closed per class: tamper refuses the whole spend; transient is a retryable refusal; a ghost (notfound) coin is skipped, never spent unverified. Nothing is signed on any verify failure.
- Fee caps refuse, never rebuild.
- What you see is what you sign: frozen review snapshots; confirm-time name re-resolve and verified-regression refusal; account-switch-mid-approval refusal (ACCOUNT_CHANGED); fee-gate crossing refusal (FEE_CHANGED); bidi- and zero-width-hardened escapeHtml.
- No unattended transaction broadcast, in any form. Deferred finalize (sign upfront, broadcast later) was built and deliberately reverted; the wallet does not initiate a background broadcast. Automated flows may at most raise an approval prompt while the tab is visible.
- The Chrome Web Store upload stays manual and off CI (store/PUBLISH-RUNBOOK.md; supply-chain rationale from the Shai-Hulud incident class). No store API key or webstore-upload action enters CI. Single maintainer, so no dual control: reproduce-then-publish (the local stamped zip's sha256 must equal the CI-attested `cairn-wallet-store.zip`), hardware 2FA, and a post-publish CRX check against the attested zip (commands in the runbook).
- The deliberate copy stays a copy, never deduplicated into an import: src/core/csdtx.ts (server codec twin, pinned by the golden vectors in test/selftest.ts). Coin selection is csd-tx's selectInputs from the bundle, not a copy. The vendored bundle changes only via scripts/build-spv-vendor.sh and check-vendor-fresh.mjs --write.
- Every new user-facing {ok:false} carries a machine code (WALLET-ERROR-CODES.md); codes are additive, never reused.
- Build tripwires are load-bearing; adding a fetch host requires manifest CSP and host_permissions or the build fails.
- Privileged methods (export, mnemonic, account management, settings, reset, consolidate) are popup-only, refused on the dApp channel even if approved. `reset` exists only as a background method; no screen offers it.
- export/exportMnemonic deliberately work while locked (password-gated direct vault decrypt); correct behaviour, do not "fix".
- Offer fills: every lane merkle-proves the offer and binds the served terms to it before signing; the remaining resolver trust (give-backing, the running state of a partial offer on the offer-id lanes) and the second-source reads with their gaps are in `docs/DESIGN-fill-lanes.md`. Name sends stay on trustless SPV (`namespv`).
- Known accepted residuals: tx history and labels in chrome.storage.local are not additionally encrypted (sealed-claim preimages are vault-key-encrypted at rest, pinned by test/seal-encrypt.test.mjs; an OS-level compromise of the browser profile can read the remaining history, local-disk privacy only, never key material); PBKDF2-600k, with Argon2id on the roadmap; keys are hot in the service worker while unlocked (hardware-wallet support is on the roadmap); no external professional audit yet.

## Runtime footprint

- Node RPC: the Cairn proxy https://cairn-substrate.com/api/rpc or a loopback node only. GET 12s, POST 20s. Every outer timeout sits above its server-side worst case; do not lower one without re-deriving the inner chain.
- Cairn API (user-configurable, https or loopback): auth, /api/content, /api/domains, /api/headers at 15s with Retry-After-aware 429 and 502/503 backoff.
- CairnX read API /trade/api (12s); clarvis /trade/api (name-history union always, resolve fallback, 12s).
- Rate limits: the front door rate-limits per IP; the wallet's fan-out is bounded (send-path input verify at 8 concurrent, the fclaim fill-scan block fetch at 12), so legitimate flows stay under the per-IP budget.
- Storage: unlimitedStorage because the namespv header store (IndexedDB, 84 bytes per header, about 60 KB per chain-day) grows with the chain; chrome.storage.local holds the vault, history and settings.
- Consensus caps: MAX_TX_INPUTS=512, MAX_TX_BYTES=100KB; an all-coinbase holder tops out around 25,600 CSD per tx. consolidate() is the wallet-side answer.
- pendingMerge() (popup-only) settles open history rows (an unconfirmed merge, a maybe:true row) from chain state, not the clock, and submits nothing; the rules are in `docs/DESIGN-inclusion-reconcile.md` (`src/core/inclusion.ts`, test/inclusion-chain.test.mjs).
- `spentTxids` and `inputs` on a submit result are internal: `resolvePending` strips both before a page receives the result.

SPV header storage (the design as built is `docs/DESIGN-namespv-scaling.md`):

- The names floor 29,960 cannot move: verifying a name event at height h needs the verified header at exactly h. A name-history hint below it is dropped and flags `disagree`.
- A start reads only the newest anchor's chunk and the suffix above it, so restore cost follows the suffix, not the chain. The table is regenerated per release (store/PUBLISH-RUNBOOK.md step 2), and the `anchors` job fails a tag whose newest entry is more than 6,000 blocks below the public tip. An older height costs one chunk the first time a proof needs it.
- Every table entry is a light-client checkpoint for the life of the release (an `anchors` prefix in tests narrows the newest anchor, never the checkpoint map); a served chain that contradicts one fails closed with no fallback to an older entry.
- When the node tip cannot be read, `prepare` syncs nothing and reports `tipKnown: false`, and the fclaim fill lane refuses.
- Do not adopt a stored header without its walk to the table, its forward verification, or its walk to the session pin (headers verified earlier in the same browser session): that check is the storage-poisoning defence.

## Release and deploy

1. Bump the version in package.json only (`npm version X.Y.Z --no-git-tag-version`, which also updates package-lock.json). build.mjs stamps it into dist/manifest.json and window.cairn.
2. `npm test && npm run package` green. scripts/package.mjs emits byte-reproducible zips and sha256s: cairn-wallet-store-X.Y.Z.zip (manifest at the zip root, the local store upload file), cairn-wallet-store.zip (the same bytes under the stable name the release carries) and cairn-wallet.zip (nested, for load-unpacked). node_modules must be a real `npm ci` directory: a symlinked one changes esbuild's path comments and the hash.
3. Tag and push (maintainers only). release.yml runs three jobs:
   - `anchors`: re-walks `src/core/spvanchors.ts` from clarvis's public /api/headers and checks every entry against the front door's /api/rpc/block/height; the newest entry must be 1,000 to 6,000 below the public tip.
   - `build`: npm ci, typecheck, test, verify:vendor (the byte-identity rebuild), package; the four files leave as one artifact.
   - `release`, which needs the other two: it downloads the artifact, runs `sha256sum -c` on both zips, writes the SLSA attestation and runs the idempotent gh release create. Only `release` holds `contents: write`, `id-token: write` and `attestations: write`, and it checks nothing out and installs nothing, so tests and dev dependencies never run with the attestation token in reach (`test/release-workflow-permissions.test.mjs`).
   - release.yml also runs on pull requests that touch the table, scripts/update-spv-anchors.mjs or the vendored bundle; there only `anchors` runs, the publish jobs are gated to tag pushes. The table is regenerated per store/PUBLISH-RUNBOOK.md step 2. Both workflows default to `permissions: {}` with per-job grants and check out with `persist-credentials: false`.
4. Chrome Web Store: manual, per store/PUBLISH-RUNBOOK.md (upload the local `cairn-wallet-store-X.Y.Z.zip` to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) after its sha256 matches the release, then the post-publish CRX check). Never automate it.
5. The website's download links follow releases/latest automatically; the site updates its displayed wallet-version signal once the Chrome Web Store approves the new build.

## Contributor guidance (standing project rules)

1. Security fixes must not regress UX: no added latency, no declines on legitimate sends or buys, no over-engineering. Prefer warn over block, honesty over machinery. Fail-closed without an availability valve counts as a UX regression. Ideas already considered and declined as over-engineering include EIP-55-style checksums, hard-blocking unverified sends, and forced argon2id migration.
2. Maintainers deploy and release. PRs should not assume deploy access, bump versions, or cut tags; propose the change and a maintainer handles versioning and release.
3. Releases are tag plus CI GitHub release; the Chrome Web Store upload is always done manually by a maintainer, never automated (supply-chain caution after the npm Shai-Hulud incident class).
4. No unattended transaction broadcast. Automated flows may only raise approval prompts while the tab is visible.
5. Consensus rules are imported or vendored from csd-sdk, never re-declared in this repo.
6. No em dashes in any doc (`grep -cP '\x{2014}' <file>` prints 0; `npm run check:dashes-paths` checks every tracked .md outside docs/archive/); no AI-slop phrasing.
7. When scope is ambiguous, open an issue or short design note first rather than a large speculative diff.

## Gotchas

The incidents behind these are in `CHANGELOG.md`.

- When a submit fails, tell "the front door refused the HTTP request" apart from "the node rejected the tx" before blaming the wallet, and show "may be in flight" only when the tx may have been broadcast.
- One unverifiable coin must not block every spend: verify verdicts are per coin.
- The unlocked key survives a service-worker idle kill through chrome.storage.session. The approval window runs in a tab, so the sender gate keys on the extension-origin `sender.url`, not on a missing tab.
- The version is written only in package.json; the PROVENANCE and rebuild gates stop a stale vendored bundle; the source-host tripwire stops a fetch host missing from the CSP.
- fillOffer's exact `bigint` need-map preflight and the fail-closed registered-versus-unregistered handling in the union path are load-bearing; keep them.
- rename/removeAccount take an address, not an index.
- `sighashMatch` in SubmitResult is vestigial but dApp-visible; keep it.
- A .csd recipient never reaches a URL unvalidated (NAME_RE first).
- Wallet distribution is the Chrome Web Store and GitHub releases only; the sites do not serve the zip.

## Docs

| Doc | Holds |
|---|---|
| `README.md` | what the wallet is, install, accounts and recovery |
| `SECURITY.md` | threat model, trust boundaries, how to report |
| `WALLET-ERROR-CODES.md` | the dApp error-code contract (read by `test/wallet-0270-hygiene.test.mjs`; stays at the root) |
| `CHANGELOG.md` | release notes, including the history and incident notes moved out of this file |
| `docs/DESIGN-namespv-scaling.md` | the SPV header store, the release anchor table and name verification on top of them, as built |
| `docs/DESIGN-fill-lanes.md` | what each offer-fill lane proves before signing, and what stays resolver-trusted |
| `docs/DESIGN-inclusion-reconcile.md` | how sent transactions are settled as included, gone or stuck |
| `docs/DESIGN-viafill.md` | why a name bought through the market does not show as verified, and the options to fix it (open) |
| `store/README.md` | index of the Chrome Web Store package |
| `store/PUBLISH-RUNBOOK.md`, `store/STORE-LISTING.md`, `store/PRIVACY-POLICY.md` | release procedure, listing copy, privacy policy text |
| `.githooks/README.md` | the secret-scan pre-commit hook |
| `docs/archive/` | superseded docs, indexed in `docs/archive/README.md`; moved with `git mv`, basenames kept |

## Cross-repo map

Runtime npm deps (exact-pinned, only four): @noble/curves, @noble/hashes, @scure/bip32, @scure/bip39. Dev dependencies are exact-pinned too, each to the version package-lock.json installs (test/dep-pins.test.mjs). The csd-sdk packages are dev dependencies only: all trust-sensitive shared code ships as the vendored bundle built from them, and nothing in dist/ imports a package at runtime. csd-tx is bundled like the other csd-sdk packages (its `selectInputs`); no dependency on cairn-sdk. Downstream consumers of the wallet's contract: cairn-sdk (mapProviderError) and the cairn site's trade UI consume the machine error codes. Server-side counterparts live behind the cairn front door at https://cairn-substrate.com: the /api/rpc proxy (rate limiting and body caps), /api/headers for SPV, /trade/api for CairnX reads, with clarvis as the second name-verification source (same operator) and the csd-indexer explorer for chain browsing.
