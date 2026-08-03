# cairn-wallet

> Onboarding briefing for coding agents and outside contributors. `AGENTS.md` is canonical; `CLAUDE.md` imports it, so make edits here, not there.
> Production and operations specifics (hosting, deployment, keys) are intentionally out of scope here and maintained privately by the maintainers.

The first non-custodial browser wallet for Compute Substrate (CSD): a Chrome MV3 extension (Chrome/Brave/Edge) that generates a BIP-39 phrase on-device, derives accounts via BIP-32/44 at m/44'/7779'/0'/0/i (7779 is this wallet's own coin-type convention), encrypts keys locally, and signs everything on-device. It is the fund-custody endpoint of the ecosystem: CSD sends, CairnX token transfers, .csd name operations (renew, set-primary, send-to-name with in-wallet SPV), sealed commit-reveal claims, board posts, atomic offer fills (DvP), the `window.cairn` dApp provider used by cairn-substrate.com, and audience-bound Sign in with CSD (SIWC).

Distribution: Chrome Web Store (primary; extension id nnjiejlalkcfckfojhihbbcpfhimfemd) + reproducible GitHub release zips. Version state is ephemeral: see the dated State snapshot at the bottom. PUBLIC repo InverseAltruism/cairn-wallet, MIT.

Security posture: non-custodial, no hand-rolled crypto (every primitive comes from the four exact-pinned @noble/@scure libraries). The threat model and what the wallet does and does not trust are public in `SECURITY.md`; read it before touching a money path. (The ranked hardening roadmap is maintained privately with the other audit docs.) No external professional audit yet (it is the top roadmap item).

## The stack around it

The wallet is the signer for the whole app layer. It talks to: the cairn web front door at https://cairn-substrate.com (/api/rpc/* proxying to the node RPC, /trade/api/cairnx/* to the CairnX resolver, /api/headers for SPV, /api/content, /auth), and clarvis (https://clarvis.cairn-substrate.com) as the independent second source for name verification. Related public surfaces: the csd-sdk packages on npm (@inversealtruism/*) and the csd-indexer block explorer. Consensus math arrives ONLY via the vendored csd-sdk bundle. The chain: Rust node, 120s blocks, UTXO P2PKH, no script VM, no finality below app-layer confirmation depths.

## Architecture

Everything ships bundled by esbuild from src/ into dist/ (gitignored), zero runtime npm imports (all four deps inlined).

- `build.mjs`: build + three HARD TRIPWIRES: (1) forbidden external message surface (externally_connectable/onMessageExternal anywhere aborts), (2) version lockstep (package.json == manifest.json == every version string in inpage.ts), (3) source-host coverage (every hardcoded https fetch host must be in CSP connect-src AND host_permissions).
- `src/background.ts`: MV3 service worker; owns the unlocked key, the dApp approval queue, per-origin consent, the DAPP_METHODS allowlist (enforced twice: pre-queue and in resolvePending), the popup sender-origin gate, provider events, queue caps (MAX_PENDING_GLOBAL=32 / PER_ORIGIN=5), alarm-driven auto-lock.
- `src/content.ts` / `src/inpage.ts`: inject the frozen window.cairn provider; per-page-load nonce handshake; csd:announceProvider discovery.
- `src/core/`:
  - `keystore.ts`: AES-256-GCM vault; PBKDF2-SHA256 600k iters; MIN_ITERS=100k downgrade floor + MAX_ITERS=30M DoS ceiling.
  - `account.ts`: BIP-39/32/44, coin type 7779.
  - `csdtx.ts`: DELIBERATE browser twin of the server tx codec (bincode, txid=sha256d, sighash CSD_SIG_V1, low-S; loginDigest structurally disjoint from a tx sighash). Do NOT dedupe into an import.
  - `node.ts` (~788 lines): the send engine. `assembleValueTx` is the single chokepoint for EVERY value tx: fee>0, flat MAX_FEE=100 CSD, zero-address refusal, selectVerified -> selectInputs (greedy largest-first, MAX_TX_INPUTS=512; a marked KEEP-IN-SYNC fork of csd-tx's selectInputs) -> verifyInputValues (TXB-1: fetch each source tx, recompute txid with the consensus codec; verdicts number/notfound/transient/tamper/horizon/unrepresentable; the fourth-class "horizon" is BN0w, classified ONLY on the node v0.1.6 exact 503 + body code SCAN_HORIZON pair and per-coin-skippable exactly like notfound, so a node cold-index window skips coins instead of refusing the whole spend; inert until the node emits it; the fifth-class "unrepresentable" is W6/ND-1 in 0.2.66, classified on the RAW body before the txid recompute when a codec-serialized number cannot survive JSON.parse exactly, and per-coin-skippable exactly like horizon so one dust coin from a stranger can no longer brick consolidate(); NEITHER adds a rung to the decisive tamper/transient fold; bounded pool VERIFY_CONCURRENCY=8 with decisive short-circuit) -> ghost re-select loop -> proportional fee cap max(1 CSD, 10% of verified inputs) -> change to self only -> signAndSubmit (SUBMIT_REJECTED vs SUBMIT_MAYBE_INFLIGHT vs SUBMIT_DUPLICATE disambiguation). `consolidate()` merges dust: up to 512 smallest coins into one self-output, TXB-1-verified, both fee caps apply (popup-only, NOT in DAPP_METHODS; `consolidatePreview()` feeds the settings ▸ coins UI). `spendableCoins()` is the standalone spendability predicate, ★KEEP-IN-SYNC with selectInputs' filter and pinned by test/selectinputs-parity.ts.
  - `wallet.ts` (~1,045 lines): vault lifecycle, multi-account, chrome.storage.session key rehydrate (fail-closed), brute-force auth guard (5 failures -> exponential lockout), send/token/name/seal orchestration, fillOffer preflight, SPV wiring, history. maybeRecord is the single history chokepoint: ok records, SUBMIT_MAYBE_INFLIGHT records maybe:true under the LOCAL txid, SUBMIT_DUPLICATE clears an earlier maybe in place (never inserts); every flow captures its histKey PRE-await so entries file under the account that signed.
  - `cairnx.ts`: CairnX record builders over the vendored core; consensus rules IMPORTED never re-typed; pre-spend parseRecord round-trip so build-success implies resolver-acceptance. NO on-device registration flow (commit/reveal/finalize builders removed 2026-07-06; the /names site drives registration via dApp propose, always clear-signed).
  - `namespv.ts` (~672 lines): trustless name verification: PoW light client from baked checkpoint (height 29960), full-block merkle bind, signer auth + prevout-ownership bind, TWO-SOURCE UNION (verifyNameUnion: primary + clarvis, union by txid, SPV-prove every event, replay the audited resolver), fail-closed everywhere; viaFill names NEVER show green. BP8b: long cold syncs persist verified header PREFIXES mid-sync (partial-progress snapshots, header-chain key ONLY), so a 429'd/interrupted bootstrap RESUMES instead of restarting from zero; the lapse floor NEVER advances on a partial persist (floorAdvance runs only after a fully successful serialized sync); restore still re-verifies everything (the storage-poisoning defense is untouched).
- `src/popup/`: popup.ts (~1,334 lines, main UI + shared send-flow engine), approve.ts (clear-signing window), clearsign.ts (pure formatters + lookalike detection + the nfinalize approve gate: re-fetches the reservation and runs finalizeWinnerCheck before allowing a fee-burning finalize), identicon, QR.
- `src/vendor/cairnx-spv.js`: vendored esbuild bundle of csd-sdk's audited dists. PROVENANCE.json pins bundleSha256 + csdSdkVersion + csdSdkCommit + noble versions (currently csdSdkVersion 0.1.41 at csd-sdk commit 82175f98, bundle sha f34994f2c58c; the gate warns when csd-sdk HEAD has moved past that commit and the byte-diff stays authoritative); scripts/check-vendor-fresh.mjs enforces integrity; CI rebuilds byte-identical from the pinned commit.
- `public/manifest.json`: permissions only storage+alarms+unlimitedStorage (the SPV header snapshot outgrows the default quota); CSP connect-src limited to cairn-substrate.com, clarvis, localhost; web_accessible_resources only inpage.js; NO externally_connectable.
- `store/`: CWS listing kit incl. PUBLISH-RUNBOOK.md (security-critical). `WALLET-ERROR-CODES.md`: the dApp error contract (codes are the contract, strings are UX copy).

## Invariants and red lines

- Local signing only. The wallet never signs a digest a server handed it. Inputs are always wallet-selected; change ONLY returns to the wallet's own address. A dApp can pass outputs, never UTXOs or a change address.
- Verify before sign, fail closed per class: tamper = refuse whole spend; transient = retryable refusal; ghost (notfound) = skip that coin, never spend unverified (the 0.2.53 per-coin fail-closed rule). Nothing is signed on any verify failure.
- Fee caps refuse, never rebuild.
- WYSIWYS everywhere: frozen review snapshots; confirm-time name re-resolve + verified-regression refusal; account-switch-mid-approval refusal (ACCOUNT_CHANGED); fee-gate crossing refusal (FEE_CHANGED); bidi/zero-width-hardened escapeHtml.
- NO unattended transaction broadcast, ever. Deferred finalize (sign upfront, broadcast later) was built and deliberately REVERTED; the wallet never initiates a background broadcast. Automated flows may at most raise an approval prompt while the tab is visible. Do not reintroduce unattended broadcast in any form.
- CWS upload stays MANUAL and OFF CI (store/PUBLISH-RUNBOOK.md; supply-chain rationale from the Shai-Hulud incident class). No CWS API key or webstore-upload action may ever enter CI. Reproduce-then-publish dual control, hardware-2FA, post-publish hash verification.
- Deliberate forks are KEEP-IN-SYNC, never dedupe: src/core/csdtx.ts (server codec twin) and node.ts selectInputs (csd-tx fork, pinned by test/selectinputs-parity.ts). The vendored bundle changes only via scripts/build-spv-vendor.sh + check-vendor-fresh.mjs --write.
- Every new user-facing {ok:false} carries a machine code (WALLET-ERROR-CODES.md); codes are additive, never reused.
- Build tripwires are load-bearing; adding a fetch host requires manifest CSP + host_permissions or the build fails.
- Privileged methods (export, mnemonic, account mgmt, settings, reset, consolidate) are popup-only, refused on the dApp channel even if approved.
- export/exportMnemonic deliberately work while locked (password-gated direct vault decrypt); correct behavior, do not "fix".
- Trust-model posture (evident in the code, stated plainly): the fclaim fill lane (`verifyFillSpv` + `fclaimLanePreflight`) and the legacy dApp fill lane (`fillOfferPreflight`) now MERKLE-PROVE the offer and bind the payment/rebate/fee/`min` legs to the on-chain author, fail-closed (R1/R1.1; 0.2.60/0.2.61). The TOKEN-priced fill lane (attest CONF_TOKEN_FILL -> fillOffer, outputs:[]) also merkle-proves the offer record and binds its give/want CONTENT before signing (B7e-FIX: the give legs + want-type via the vendored `bindOfferTerms`, and the token `want.ticker`/`want.amount` you pay explicitly), mirroring the site swapguard `verifyOfferContent`, so a resolver bait-and-switch give/want is REFUSED not merely warned; the token debit PREVIEW in the clear-sign (`tokenFillQuote`) stays resolver-served and explicitly-unverified (M3 display residual, verify on the explorer). Partial-fill RUNNING state (`paid`/`delivered`) is resolver-derived and NOT bindable from the creation-block proof, so a mid-fill PARTIAL offer keeps the pre-existing N1 running-total trust until full fill-replay SPV (roadmapped B3/B4); `min` (an on-chain OFFER_KEYS field) IS bound, closing the whole-fill->partial maker-rebate-drop burn. name-send stays trustless SPV (`namespv`).
- Known accepted residuals: tx history/labels in chrome.storage.local are not additionally encrypted (sealed-claim preimages ARE vault-key-encrypted at rest since L5, pinned by test/seal-encrypt.test.mjs; an OS-level compromise of the browser profile can read the remaining history, local-disk privacy only, never key material); PBKDF2-600k with Argon2id roadmapped; keys are hot in the service worker while unlocked (hardware-wallet support is on the P0 roadmap); no external professional audit yet.

## Contributor guidance (standing project rules)

1. Security fixes must NEVER regress UX: no added latency, no declines on legitimate sends/buys, no over-engineering. Prefer warn over block, honesty over machinery. This rule has been enforced repeatedly in triage; ideas already considered and DECLINED as over-engineering include EIP-55-style checksums, hard-blocking unverified sends, and forced argon2id migration.
2. Maintainers deploy and release. PRs should not assume deploy access, bump versions, or cut tags; propose the change and a maintainer handles versioning and release.
3. Releases are tag + CI GitHub release; the Chrome Web Store upload is always done manually by a maintainer, never automated (supply-chain caution after the npm Shai-Hulud incident class).
4. NO unattended transaction broadcast, ever. Automated flows may only raise approval prompts while the tab is visible.
5. Consensus rules are imported/vendored from csd-sdk, never re-declared in this repo.
6. No em dashes / AI-slop in READMEs or user-facing docs.
7. When scope is ambiguous, open an issue or short design note first rather than a large speculative diff.

## Dev workflow

```bash
npm ci                        # CI uses --ignore-scripts
npm test                      # test/run.mjs glob runner (57 files at this writing), sequential
npm run typecheck
npm run build                 # tripwires run here -> dist/
npm run package               # deterministic zips + sha256
npm run verify:vendor         # vendor-freshness gate
```

Load dist/ unpacked at chrome://extensions. Rebuild the vendored SPV bundle only when csd-sdk's verify surface changes: build csd-sdk (pnpm -r build), then `bash scripts/build-spv-vendor.sh`, then `node scripts/check-vendor-fresh.mjs --write`, recommit bundle + PROVENANCE.json together. UI harness: `node scripts/ux-shots.mjs` (headless walk, zero-page-error + element-ID assertions). Live mainnet E2E (maintainer-only, spends ~0.03 CSD of real funds): `tsx scripts/live-e2e.ts`.

## Testing

`npm test` = `test/run.mjs`, a GLOB runner (B0c: new test files are auto-discovered, never hand-listed; 57 files green at this writing; run one with `npx tsx test/<file>`). The runner itself is guarded: `test/runner-guards.test.mjs` (B8w, the N24 guard-of-the-guard) drives the REAL runner against throwaway sandboxes, incl. the 3-file middle-fails fixture proving a mid-suite failure still runs the remaining files AND forces a non-zero exit. Highlights: selftest.ts (golden vectors, real on-chain sig vs recomputed sighash, vault downgrade resistance, HD derivation, fee-cap lock), pentest.ts (source-scan tripwires), extension-boundary.ts (the REAL background message gate), poc-signin-oracle.ts, multiwallet.ts, bruteforce, csdtx-boundary, clearsign.ts, cairnx.ts (byte-for-byte vs cairnx-core), siwc.ts, events.test.ts, namespv.test.mjs (+ PoCs: union withholding, stale-tip lapse, srs escape, v23 burn guard), ghostcoin.test.mjs, consolidate.test.mjs (incl. the maybe-inflight record/clear/reconcile matrix and account-switch filing), resolve-fallback.test.mjs (clarvis base-claim source selection), persistvault-race.test.mjs (concurrent account-mgmt cannot drop an imported key), selectinputs-parity.ts (also pins spendableCoins filter parity), identicon, qr. CI: typecheck + suite + build + verify:vendor + a token-gated vendor-fresh-full job (byte-identity rebuild from the PROVENANCE-pinned csd-sdk commit).

## Release and deploy

1. Bump version in LOCKSTEP: package.json, public/manifest.json, src/inpage.ts (provider version AND getCapabilities().version). build.mjs hard-fails on drift.
2. `npm test && npm run package` green. scripts/package.mjs emits two byte-reproducible artifacts + sha256s: cairn-wallet-store.zip (manifest at zip ROOT, the CWS upload) and cairn-wallet.zip (nested, for load-unpacked).
3. Tag + push (maintainers only) -> release.yml CI: vendor-fresh-full gate -> test -> package -> SLSA attestation (continue-on-error) -> idempotent gh release create with all four artifacts.
4. Chrome Web Store: MANUAL per store/PUBLISH-RUNBOOK.md. Never automate.
5. The website's download links follow releases/latest automatically; the site updates its displayed wallet-version signal once the Chrome Web Store approves the new build.

## Runtime footprint

Default endpoints (user-configurable, validated https/loopback-only): node RPC via https://cairn-substrate.com/api/rpc (GET 12s / POST 20s timeouts - every outer timeout sits deliberately ABOVE its server-side worst case, a timeout-inversion class fixed in 0.2.55; do not lower them without re-deriving the inner chains), cairn API (auth, /api/content, /api/domains, /api/headers at 15s with Retry-After-aware 429 + 502/503 backoff), CairnX read API /trade/api (12s), clarvis /trade/api (name-history union always; resolve fallback, 12s). Rate-limit interaction: the cairn front door rate-limits per IP; the wallet's verify fan-out is bounded (send-path input verify at 8 concurrent, the fclaim fill-scan block fetch at 12), so legitimate flows stay well under the per-IP budget by design. Storage: the manifest carries unlimitedStorage because the namespv header snapshot is multi-MB and grows with the chain, sharing chrome.storage.local with the vault. Consensus caps: MAX_TX_INPUTS=512, MAX_TX_BYTES=100KB; an all-coinbase holder tops out ~25,600 CSD per tx; consolidate() is the wallet-side answer, with pendingMerge() (popup-only; writes only its own bookkeeping latches) deriving the "merge confirming" state from history + the balance fetch's own utxo set (zero extra requests; persisted confirmed latch) and reconciling maybe:true entries whose txid shows up in that set.

SPV snapshot growth (the honest picture, established 2026-07-10): the baked checkpoint sits at the names-activation floor and CAN NEVER BE BUMPED past it - verifying a name event at height h needs the PoW-verified header at exactly h, so the chain must span from the floor to tip forever; "bump the checkpoint to shrink the snapshot" is WRONG and breaks historical name verification (an existing snapshot's baseHeight is also sticky: syncFromCheckpoint runs only on a cache miss). Growth is therefore structural: ~370 bytes/header on disk (~270 KB/day) and a full re-verify on every service-worker cold start. 0.2.56 cut the restore CPU ~4x (csd-light 0.1.16 memoizes the pure LWMA bits→target conversion; byte-identical, adversarially differential-tested) - roughly 1s at today's ~21k headers, growing ~35ms per chain-day, so this buys months, not years. BP8b (REBIND) additionally persists partial sync progress, so an interrupted cold bootstrap resumes instead of restarting from zero. The scaling roadmap is now a committed design note, docs/DESIGN-namespv-scaling.md (BP8-design, N14): async/chunked restore (pure scheduling), snapshot format v2 (binary, kills the JSON parse), verified-event proof cache (the only path that beats the no-pruning floor); do NOT "skip re-verification of persisted headers" - re-verify-on-load IS the storage-poisoning defense.

## Gotchas and incident history

- Large-send bug (2026-07, most instructive): a 10,540 CSD send (~211 coinbase inputs) failed with the misleading "may already be in flight" copy; nothing was broadcast. The first diagnosis (verify fan-out tripping the front door's rate limit) was WRONG and is superseded: the proven root cause was the front-door proxy's GLOBAL 64KB JSON body limit 400-ing /tx/submit at ~127+ inputs (~530 bytes/input) before the tx ever reached the node. Wallet 0.2.55 ships the wallet-side fixes (honest structured errors via sendRefused with "may be in flight" copy reserved for genuine SUBMIT_MAYBE_INFLIGHT/catch paths, SUBMIT_MAYBE_INFLIGHT vs SUBMIT_REJECTED, bounded verify concurrency, timeouts, TOO_MANY_INPUTS distinguished from INSUFFICIENT, token-send CSD fee pre-check, consolidate + preview); the matching server-side fix (a scoped larger body cap on that route plus a raised rate limit) shipped on the cairn front door. The fee guard was a red herring (send fee is fixed 0.01 CSD). Lesson: when a submit fails, distinguish "the front door refused the HTTP request" from "the node rejected the tx" before blaming the wallet, and never show "may be in flight" unless it truly may be.
- Ghost-UTXO incident (h47114): a node reorg-undo bug left phantom coins; under the old any-null-kills-all fold ONE ghost bricked every spend. 0.2.53: per-coin fail-closed classification + GHOST_INPUTS_SKIPPED + honest balance warning.
- MV3 SW idle-kill looked like premature locking; cured with chrome.storage.session key persistence. Related: the approval window runs IN A TAB, so the sender gate keys on extension-origin sender.url, not tab absence (a v0.2.17 regression).
- Version drift shipped once (v0.2.21) -> the lockstep tripwire. A stale vendored bundle shipped once -> the PROVENANCE + byte-diff gates. Clarvis was dead-on-arrival once because its host was missing from CSP -> the source-host tripwire.
- SPV /api/headers 429 spiral (2026-06-22) blocked buys -> bounded backoff. The general standing rule "fail-closed without an availability valve is a UX regression" comes from this.
- fillOffer once trusted a caller-supplied verified flag and could underpay a maker on a partial fill; both closed by the BigInt exact-compare need-map preflight in fillOffer and fail-closed registered-vs-unregistered handling in the union path. These guards are load-bearing; keep them.
- Misc: rename/removeAccount take an ADDRESS not an index; sighashMatch in SubmitResult is vestigial but dApp-visible, keep it; a .csd recipient must never reach a URL un-validated (NAME_RE first); Google Safe Browsing once flagged the sites for self-serving the zip (site-side; wallet distribution is CWS + GH only).

## State snapshot (2026-08-02, Plan 75-B batch C2; verify with `git log` and the GitHub releases page before trusting)

**Version 0.2.66, MERGED to master `a036261`, TAGGED `v0.2.66`, GitHub release built by `release.yml`
with all four assets (2026-08-03). The Chrome Web Store upload is the ONE remaining action.** Store-zip
sha256 `5446a71bedab8072dc6742c61c2c81d017c119d0bc1fdfd41e1df92b44db0870`, matching the released
`.sha256` asset byte for byte; the manifest inside the zip reads 0.2.66.
★**The packaged-artifact QA PASSED** (see cairn/docs/Plans/75-TRACKER.md section L): 5 of 7 scenarios
executed in real headed Chrome against the PACKAGED zip on the live chain, 43 assertions, 0 FAIL, and the
three lock-dependent ones (W1, poisoning, W8) driven by the REAL 15-minute idle auto-lock timer rather
than a scripted `lock()`. W2 was proven by forcing the race with a 6 s CDP request pause, because at real
network speed the window does not exist and the test would be vacuous. S4 (token fill) is N-A, no live
subject exists; S5 (Renew) is N-A, register-then-renew costs 6.00 CSD against the 2.00 CSD test ceiling,
so **W5's Renew happy path is untested on the packaged artifact** and is covered instead by
`test/fee-tier-clamp.test.mjs`, which pins that a fractional tip returns null and is NOT normalized to 0.
★**ROLLBACK, corrected by the operator 2026-08-03:** the Chrome Web Store IS rollback-capable, and nobody
installs from the GitHub release. Any doc saying "no rollback, only a forward 0.2.67" is wrong. The Chrome Web Store
field version is **0.2.64** (the listing has read 0.2.64 since 2026-07-23); the repo and the GitHub release
are at 0.2.65, which was minted by Plan 75 and never reached the store, so this ships as 0.2.66 and the
store jumps 0.2.64 to 0.2.66. Rollback on this vehicle is FORWARD ONLY, as 0.2.67.

What 0.2.66 carries (Plan 75-B C2, items W1 to W8, seven code edits):
W1 (AW-4) the approval window resets four of its five once-per-request latches at the `$("req").innerHTML`
rebuild, so an approval left open across an idle auto-lock repaints its address-poisoning and
first-time-recipient warnings and its token debit quote instead of showing empty boxes; the 1.2s poll adds
zero fetches (pinned by `test/approve-repaint-dom.test.mjs`). The FIFTH latch is the approve-gate latch and
is deliberately not reset; it is W8 below.
W2 (AW-3) the async DOM fillers (`fillBalance`, `fillSendWarning`, `fillTokenSim`) carry the
`renderedId !== r.id` guard after their await, so a superseded request's late balance fetch can no longer
repaint the money row of the request now on screen.
W3 (N-05) `fillOffer`'s score guard uses `!= null`, so an explicit `score: null` is treated as absent
again (it never shipped; the store still serves 0.2.64, and this release must not be the one that
introduces the refusal). A present-and-not-100 score is still refused.
W4 (AW-SEAL-LOCK-1) `lock()` no longer wipes `pendingHist`/`pendingSeals`. An idle auto-lock destroyed a
PAID commit's only reveal nonce and the parked history rows behind the double-pay backstop. `doReset()`
still clears both, so reset discipline is unchanged, and `test/storage-durability.test.mjs` case I is
revised (with its reasoning) from M9's old pin. HONESTY: both arrays are RAM on the MV3 service worker and
still die at SW idle kill; this buys survival across a lock and unlock inside ONE service-worker lifetime,
not durability.
W5 (Q-02) `feePricingTip` normalizes with `Number.isSafeInteger` and returns `number | null`. A served tip
of `65100.5` or `1e16` is finite but is not a height: it used to reach the vendored `buildFeeHeight`, throw
RangeError, and be swallowed by clearsign's bare catch, silently disarming the CLEARSIGN-FEE-1
underpayment warning. Normalizing to 0 would have been WORSE (it prices the cheapest tier, so the wallet's
own Renew would build an underpaid record and BURN the fee), so both build sites refuse on null. That
refusal IS UX-6's refusal and is recorded as such; the paired happy-path (fresh install, live tip, floor 0)
prices and signs unchanged.
W6 (ND-1) a fifth input verdict, `unrepresentable`, with code `VERIFY_UNREPRESENTABLE`. There is no upper
bound on `expires_epoch` in consensus, so a stranger could anchor one tx with
`expires_epoch = 9007199254740993` and 1 sat to a victim: `JSON.parse` rounds it, the recomputed txid
differs, the coin classified `tamper`, and tamper is decisive for the whole spend. `consolidate()` selects
smallest-first, so that dust coin bricked the documented remedy for the large-send class, permanently. The
new verdict is classified on the RAW body before `nodeTxToTx`, mirrors `horizon` (per-coin skippable, own
array, own reporting rung after horizon and before notfound), adds NO rung to the decisive fold, and is
never aliased to `notfound` (that copy would call a real coin missing). A well-formed body with a wrong
txid is still `tamper`.
W7 the four version literals (`package.json`, `public/manifest.json`, `src/inpage.ts` x2) at 0.2.66, and
this snapshot. No new version tripwire was built: `build.mjs:32-38` already matches EVERY `version:`
string in `inpage.ts` and was re-verified live by mutating the manifest and the second inpage literal
(both aborted the build).
W8 (AW-4, the fifth latch) the nfinalize/nrenew/nset approve-gate note survives the unlock repaint. Its
latch (`nfinForId`) was outside W1's reset line while its output is written with `insertAdjacentHTML` into
the very element the rebuild destroys, so a FEE-BURN warning (for example that the name is a pending
reservation rather than a finalized registration, so the renewal would be ignored on-chain and the fee
burned) was still silently lost across an idle auto-lock, inside W1's own stated rule. The fix RE-ATTACHES the already-settled verdict and
nothing else. Adding `nfinForId` to W1's reset line instead would have AUTHORED A NEW DEFECT: it re-runs
the bounded 6s name fetch on every repaint AND resets `nfinBlocked` to false with a fresh in-flight
verdict, so `armButtons`' 700ms timer re-enables Approve on a request the gate had already BLOCKED until
the new verdict lands. Both shapes are pinned in `test/approve-repaint-dom.test.mjs` (cases 5 to 7): the
naive reset is what turns the blocked-button assertion red. Not handled and stated plainly rather than
left implied: a verdict that settles WHILE the wallet is locked is still dropped by the `renderedId` guard,
so it has no note to re-attach and `nfinBlocked` stays false; `resolve()` still awaits `nfinGate` and
refuses a blocking verdict at the click, which is the fund-safety belt in that corner.

Gate as run 2026-08-02 on this branch: `npm run typecheck` clean, `npm test` **57/57 files** (up from 54;
three new files: `approve-repaint-dom`, `seal-lock-park`, `unrepresentable-coin`), `npm run build` green
with all three tripwires, `npm run verify:vendor` PASSES byte-identically against csd-sdk 0.1.41 dists.
Vendored bundle: `csdSdkVersion 0.1.41`, `csdSdkCommit 82175f98`, `bundleSha256 f34994f2c58c`. The gate
prints a standing commit-mismatch warning because csd-sdk HEAD has advanced past that pin; the byte-diff
is authoritative and passes. **OWED before tagging:** re-run `node scripts/check-vendor-fresh.mjs --write`
after Plan 75-B batch C0 lands on csd-sdk master, so the PROVENANCE pin names csd-sdk HEAD, and commit the
bundle and PROVENANCE together. **OWED before uploading:** the packaged-zip human click-through,
`docs/QA-0.2.66-packaged-clickthrough.md`, which is the only control on a vehicle with no rollback.
Also known and deliberately NOT shipped here: the namespv checkpoint at `src/core/namespv.ts:40` stays
29,960 (a checkpoint is a trust decision, not a perf knob, and the diff on this vehicle is kept minimal);
`package-lock.json` still records 0.2.60 and is not one of the four lockstep literals.

The paragraph below is the 2026-07-23 snapshot, retained as release narrative.

Version 0.2.64 on master, RELEASED: tag v0.2.64 (6ff9615), PROVENANCE byte-verified at csd-sdk 0.1.40/722b427, CI GitHub release built, and the CWS upload is DONE (0.2.64 live in the Chrome Web Store as of 2026-07-23; field adoption feeds the ~tip-80,000 V29 checkpoint). Master is one merge ahead of the tag: rebind/bp6-wallet (BP6 wallet half, the OBS-3 legacy-claim tombstone) was rebased onto 0.2.64 and merged 2026-07-23 once the tip passed 60,134 (below that the tombstone would have shipped a burn window); it rides the NEXT wallet vehicle, suite 48/48 at merge. What shipped IN 0.2.64 (the S-06 mega-vehicle): B4a (single-source), the B5 WALLET-HARDEN chain B5a..B5f + B5g/h/i, BP8b (namespv partial-progress snapshot persistence, see the namespv bullet: partial persists write the header-chain key only, the lapse floor never advances on one), BP8-design (docs/DESIGN-namespv-scaling.md, the N14 scaling roadmap), BN0w (the node SCAN_HORIZON 503 consumed as a fourth per-coin-skippable "horizon" verify verdict; inert until node v0.1.6 emits it), B8w (the runner-guards N24 guard-of-the-guard + lazy dist walk + the N18 pin), the re-vendor to cairnx-core 0.1.40 (PROVENANCE re-pinned at release per R3), and B7e + B7e-FIX (BOTH fill lanes bind; the token lane now merkle-proves the offer record and binds give/want content, see the trust-model bullet; CONF_TOKEN_FILL de-duped across its 5 sites). 0.2.64 carried ~15 batches in one CWS upload (the named mega-vehicle risk, accepted in writing; upload completed 2026-07-23). M3 residual, accepted in writing: the tokenFillQuote clear-sign DISPLAY number stays resolver-served and explicitly unverified (bounded: the fill itself is content-bound, so the worst case is a warning-ignoring user overpaying up to the genuine on-chain price, not theft; loud verify-on-explorer warning; recorded cheap tightening = echo the preflight's proven wantAmount into the clear-sign). History below this line is prior-release narrative, not the current tree.

0.2.63 (2026-07-20, REBIND S-03: BP4 fclaim scan transport - the ~224-block by-height fclaim scan parallelized into bounded-concurrency waves (pool 12, ascending) with a per-height bindBlock memo and a shared light client behind a single-flight LC.sync serializer so two concurrent consumers cannot interleave ingests; plus a source-pinned guard that the serializer is applied at its use-site, and the B0c glob test runner. Zero verification-logic change. Git-level released + tagged v0.2.63 + CI GitHub release rebuilt; the CWS upload is the operator's manual step). 0.2.62 (2026-07-18: the legacy dApp fill lane now MERKLE-PROVE-binds want-TYPE - refuse to sign a CSD payment on an offer whose proven on-chain terms carry no `want.value`, closing a lying-resolver token-priced-as-CSD pay-without-delivery burn; mirrors the fclaim lane's isTokenWant rejection. Git-level released + tagged; the CWS upload is the operator's manual step). 0.2.61 was Plan 70 R1/R1.1/R2 fund-boundary binds: F2/F2-legacy payto+seller+fee+min on both fill lanes, L5 seal-preimage encrypt-at-rest; vendored cairnx-core 0.1.38 @ csd-sdk commit 84f22d7. The dated batch narratives BELOW (0.2.55-0.2.58) are historical context, not the current tree. // 0.2.58 batch: persistVault serialized behind a promise chain + cleartext mirror captured from the same pre-await snapshot as the sealed doc, so concurrent account-management can no longer drop a just-added imported (non-recoverable) key (pinned by persistvault-race.test.mjs); nfinalize gate comment corrected to honest resolver-trust scope (the finalize window is best-effort against an honest-but-stale resolver, not a Byzantine one); F-CLIP btn-backup-done clears a copied first-backup secret on dismiss; expectSigner throw consolidated to one helper.

The 0.2.57 batch (Plans/68 Tracks A + B1/B2 + C2): signing-context capture closes the fillOffer account-switch race (captureSigner/signerUnchanged + the expectSigner backstop threaded from the approval window AND the popup review snapshots; ACCOUNT_CHANGED now fires at the sign tick, not only pre-dispatch); imported-key removal is password-gated with an irreversibility warning (HD removal stays one-click; sentinel REMOVE_IMPORTED_REAUTH); the fillOffer preflight fails CLOSED on a clean 404 or status-less 200 (new code OFFER_UNKNOWN - filling a proposal the resolver will not settle burned the whole payment); the nfinalize approve gate gains the freeze-window half via the completed vendored finalizeWinnerCheck (cairnx-core 0.1.36) and the gate now also covers nrenew/nset (nameActApproveGate: block only definitive no-ops, warn on transport failure); flushPending keeps paid bodies on a refused registration and survives concurrent queueing; getPermissions requires unlocked; single-source/low-depth name badges read honestly weaker; maybe-entries get a post-expiry tombstone and maybe-path seals are flagged; CI actions SHA-pinned (attest v2). Vendored core: cairnx-core 0.1.36 + csd-light 0.1.17 (snapshot anchor containment + restore-time timestamp rules) at the csd-sdk commit pinned in src/vendor/PROVENANCE.json. The 0.2.55 batch (unreleased, riding in 0.2.56): honest structured send errors (SUBMIT_MAYBE_INFLIGHT / SUBMIT_DUPLICATE with locally computed txids), coin consolidation + preview + the pending-merge indicator and merge-aware refusal copy, bounded verify concurrency, timeout-inversion fixes, unlimitedStorage, clarvis resolve fallback, 7-day pending-content retention. The 0.2.56 batch: maybe-inflight outcomes recorded in history for EVERY value flow at the maybeRecord chokepoint (maybe:true entries with the local txid; cleared in place on a definitive ok/duplicate or when the txid shows up in the utxo set; time-bounded "may be in flight" marker in the history UI), history filed under the account that SIGNED (pre-await histKey capture), maybe-inflight cairnPost content + sealClaim preimages persisted (a landed ambiguous tx no longer loses its body/reveal), ~4x faster SPV snapshot restore (vendored csd-light 0.1.16 LWMA memo, byte-identical), Terms of Use + Privacy links in Settings, spendableCoins/clarvis-fallback/2xx-unparseable test pins, store-listing unlimitedStorage justification, em-dash-free user-facing docs, portable ux-shots (no machine paths in the public repo). Vendored core: cairnx-core 0.1.35 + csd-light 0.1.16 at the csd-sdk commit pinned in src/vendor/PROVENANCE.json.

Sibling versions at 2026-07-23: npm cairnx-core 0.1.40, csd-tx 0.1.17, csd-light 0.1.18, csd-registry 0.1.16, other csd-sdk packages 0.1.15; cairn-cli 0.3.23, cairn-sdk 0.4.0, csd-indexer 0.2.10 (tagged; live process may trail until its restart).

## Cross-repo map

Runtime npm deps (exact-pinned, only four): @noble/curves, @noble/hashes, @scure/bip32, @scure/bip39. NO npm dependency on csd-tx/cairnx-core/cairn-sdk; all trust-sensitive shared code arrives as the vendored bundle built from a local csd-sdk checkout at the commit pinned in PROVENANCE.json. Downstream consumers of the wallet's contract: cairn-sdk (mapProviderError) and the cairn site's trade UI consume the machine error codes. Server-side counterparts live behind the cairn front door at https://cairn-substrate.com: the /api/rpc proxy (rate limiting + body caps), /api/headers for SPV, /trade/api for CairnX reads, with clarvis as the independent second name-verification source and the csd-indexer explorer for chain browsing.
