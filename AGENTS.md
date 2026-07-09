# cairn-wallet

> Onboarding briefing for coding agents and outside contributors. `AGENTS.md` is canonical; `CLAUDE.md` imports it, so make edits here, not there.
> Production and operations specifics (hosting, deployment, keys) are intentionally out of scope here and maintained privately by the maintainers.

The first non-custodial browser wallet for Compute Substrate (CSD): a Chrome MV3 extension (Chrome/Brave/Edge) that generates a BIP-39 phrase on-device, derives accounts via BIP-32/44 at m/44'/7779'/0'/0/i (7779 is this wallet's own coin-type convention), encrypts keys locally, and signs everything on-device. It is the fund-custody endpoint of the ecosystem: CSD sends, CairnX token transfers, .csd name operations (renew, set-primary, send-to-name with in-wallet SPV), sealed commit-reveal claims, board posts, atomic offer fills (DvP), the `window.cairn` dApp provider used by cairn-substrate.com, and audience-bound Sign in with CSD (SIWC).

Distribution: Chrome Web Store (primary; extension id nnjiejlalkcfckfojhihbbcpfhimfemd) + reproducible GitHub release zips. Version state is ephemeral: see the dated State snapshot at the bottom. PUBLIC repo InverseAltruism/cairn-wallet, MIT.

Security posture: non-custodial, no hand-rolled crypto (every primitive comes from the four exact-pinned @noble/@scure libraries). The threat model, what the wallet does and does not trust, and the remaining hardening roadmap are public in `SECURITY.md` and `SECURITY-ROADMAP.md`; read both before touching a money path. No external professional audit yet (it is the top P0 roadmap item).

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
  - `node.ts` (~644 lines): the send engine. `assembleValueTx` is the single chokepoint for EVERY value tx: fee>0, flat MAX_FEE=100 CSD, zero-address refusal, selectVerified -> selectInputs (greedy largest-first, MAX_TX_INPUTS=512; a marked KEEP-IN-SYNC fork of csd-tx's selectInputs) -> verifyInputValues (TXB-1: fetch each source tx, recompute txid with the consensus codec; verdicts number/notfound/transient/tamper; bounded pool VERIFY_CONCURRENCY=8 with decisive short-circuit) -> ghost re-select loop -> proportional fee cap max(1 CSD, 10% of verified inputs) -> change to self only -> signAndSubmit (SUBMIT_REJECTED vs SUBMIT_MAYBE_INFLIGHT disambiguation). `consolidate()` merges dust: up to 512 smallest coins into one self-output, TXB-1-verified, both fee caps apply (popup-only, NOT in DAPP_METHODS; `consolidatePreview()` feeds the settings ▸ coins UI).
  - `wallet.ts` (~913 lines): vault lifecycle, multi-account, chrome.storage.session key rehydrate (fail-closed), brute-force auth guard (5 failures -> exponential lockout), send/token/name/seal orchestration, fillOffer preflight, SPV wiring, history.
  - `cairnx.ts`: CairnX record builders over the vendored core; consensus rules IMPORTED never re-typed; pre-spend parseRecord round-trip so build-success implies resolver-acceptance. NO on-device registration flow (commit/reveal/finalize builders removed 2026-07-06; the /names site drives registration via dApp propose, always clear-signed).
  - `namespv.ts` (~434 lines): trustless name verification: PoW light client from baked checkpoint (height 29960), full-block merkle bind, signer auth + prevout-ownership bind, TWO-SOURCE UNION (verifyNameUnion: primary + clarvis, union by txid, SPV-prove every event, replay the audited resolver), fail-closed everywhere; viaFill names NEVER show green.
- `src/popup/`: popup.ts (~1,240 lines, main UI + shared send-flow engine), approve.ts (clear-signing window), clearsign.ts (pure formatters + lookalike detection + the nfinalize approve gate: re-fetches the reservation and runs finalizeWinnerCheck before allowing a fee-burning finalize), identicon, QR.
- `src/vendor/cairnx-spv.js`: vendored esbuild bundle of csd-sdk's audited dists. PROVENANCE.json pins bundleSha256 + csdSdkVersion (0.1.35) + csdSdkCommit + noble versions; scripts/check-vendor-fresh.mjs enforces integrity; CI rebuilds byte-identical from the pinned commit.
- `public/manifest.json`: permissions only storage+alarms; CSP connect-src limited to cairn-substrate.com, clarvis, localhost; web_accessible_resources only inpage.js; NO externally_connectable.
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
- Trust-model posture (evident in the code, stated plainly): fill/name-buy settlement currently trusts the resolver; there is no offer SPV in the wallet or SDK (contrast the name-send path, which is trustless SPV). Client-side SPV for fills (txid-recompute + merkle-bind the offer) is roadmapped.
- Known accepted residuals: sealed-claim preimages and tx history in chrome.storage.local are not additionally encrypted (an OS-level compromise of the browser profile can read them; local-disk privacy only, never key material); PBKDF2-600k with Argon2id roadmapped; keys are hot in the service worker while unlocked (hardware-wallet support is on the P0 roadmap); no external professional audit yet.

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
npm test                      # 21 tsx entries, sequential
npm run typecheck
npm run build                 # tripwires run here -> dist/
npm run package               # deterministic zips + sha256
npm run verify:vendor         # vendor-freshness gate
```

Load dist/ unpacked at chrome://extensions. Rebuild the vendored SPV bundle only when csd-sdk's verify surface changes: build csd-sdk (pnpm -r build), then `bash scripts/build-spv-vendor.sh`, then `node scripts/check-vendor-fresh.mjs --write`, recommit bundle + PROVENANCE.json together. UI harness: `node scripts/ux-shots.mjs` (headless walk, zero-page-error + element-ID assertions). Live mainnet E2E (maintainer-only, spends ~0.03 CSD of real funds): `tsx scripts/live-e2e.ts`.

## Testing

`npm test` = 21 tsx entries (no framework; run one with `npx tsx test/<file>`): selftest.ts (golden vectors, real on-chain sig vs recomputed sighash, vault downgrade resistance, HD derivation, fee-cap lock), pentest.ts (source-scan tripwires), extension-boundary.ts (the REAL background message gate), poc-signin-oracle.ts, multiwallet.ts, bruteforce, csdtx-boundary, clearsign.ts, cairnx.ts (byte-for-byte vs cairnx-core), siwc.ts, events.test.ts, namespv.test.mjs (+ PoCs: union withholding, stale-tip lapse, srs escape, v23 burn guard), ghostcoin.test.mjs, consolidate.test.mjs, selectinputs-parity.ts, identicon, qr. CI: typecheck + suite + build + verify:vendor + a token-gated vendor-fresh-full job (byte-identity rebuild from the PROVENANCE-pinned csd-sdk commit).

## Release and deploy

1. Bump version in LOCKSTEP: package.json, public/manifest.json, src/inpage.ts (provider version AND getCapabilities().version). build.mjs hard-fails on drift.
2. `npm test && npm run package` green. scripts/package.mjs emits two byte-reproducible artifacts + sha256s: cairn-wallet-store.zip (manifest at zip ROOT, the CWS upload) and cairn-wallet.zip (nested, for load-unpacked).
3. Tag + push (maintainers only) -> release.yml CI: vendor-fresh-full gate -> test -> package -> SLSA attestation (continue-on-error) -> idempotent gh release create with all four artifacts.
4. Chrome Web Store: MANUAL per store/PUBLISH-RUNBOOK.md. Never automate.
5. The website's download links follow releases/latest automatically; the site updates its displayed wallet-version signal once the Chrome Web Store approves the new build.

## Runtime footprint

Default endpoints (user-configurable, validated https/loopback-only): node RPC via https://cairn-substrate.com/api/rpc (GET 8s / POST 20s timeouts since 0.2.55), cairn API (auth, /api/content, /api/domains, /api/headers with bounded 429 backoff), CairnX read API /trade/api (6s money-path timeouts), clarvis /trade/api (name-history union always; resolve fallback since 0.2.55). Rate-limit interaction: the cairn front door rate-limits per IP; the wallet's verify fan-out is bounded at 8 concurrent regardless, so legitimate flows stay under it by design. Consensus caps: MAX_TX_INPUTS=512, MAX_TX_BYTES=100KB; an all-coinbase holder tops out ~25,600 CSD per tx; consolidate() is the wallet-side answer.

## Gotchas and incident history

- Large-send bug (2026-07, most instructive): a 10,540 CSD send (~211 coinbase inputs) failed with the misleading "may already be in flight" copy; nothing was broadcast. The first diagnosis (verify fan-out tripping the front door's rate limit) was WRONG and is superseded: the proven root cause was the front-door proxy's GLOBAL 64KB JSON body limit 400-ing /tx/submit at ~127+ inputs (~530 bytes/input) before the tx ever reached the node. Wallet 0.2.55 ships the wallet-side fixes (honest structured errors via sendRefused with "may be in flight" copy reserved for genuine SUBMIT_MAYBE_INFLIGHT/catch paths, SUBMIT_MAYBE_INFLIGHT vs SUBMIT_REJECTED, bounded verify concurrency, timeouts, TOO_MANY_INPUTS distinguished from INSUFFICIENT, token-send CSD fee pre-check, consolidate + preview); the matching server-side fix (a scoped larger body cap on that route plus a raised rate limit) shipped on the cairn front door. The fee guard was a red herring (send fee is fixed 0.01 CSD). Lesson: when a submit fails, distinguish "the front door refused the HTTP request" from "the node rejected the tx" before blaming the wallet, and never show "may be in flight" unless it truly may be.
- Ghost-UTXO incident (h47114): a node reorg-undo bug left phantom coins; under the old any-null-kills-all fold ONE ghost bricked every spend. 0.2.53: per-coin fail-closed classification + GHOST_INPUTS_SKIPPED + honest balance warning.
- MV3 SW idle-kill looked like premature locking; cured with chrome.storage.session key persistence. Related: the approval window runs IN A TAB, so the sender gate keys on extension-origin sender.url, not tab absence (a v0.2.17 regression).
- Version drift shipped once (v0.2.21) -> the lockstep tripwire. A stale vendored bundle shipped once -> the PROVENANCE + byte-diff gates. Clarvis was dead-on-arrival once because its host was missing from CSP -> the source-host tripwire.
- SPV /api/headers 429 spiral (2026-06-22) blocked buys -> bounded backoff. The general standing rule "fail-closed without an availability valve is a UX regression" comes from this.
- fillOffer once trusted a caller-supplied verified flag and could underpay a maker on a partial fill; both closed by the BigInt exact-compare need-map preflight in fillOffer and fail-closed registered-vs-unregistered handling in the union path. These guards are load-bearing; keep them.
- Misc: rename/removeAccount take an ADDRESS not an index; sighashMatch in SubmitResult is vestigial but dApp-visible, keep it; a .csd recipient must never reach a URL un-validated (NAME_RE first); Google Safe Browsing once flagged the sites for self-serving the zip (site-side; wallet distribution is CWS + GH only).

## State snapshot (2026-07-09; verify with `git log` and the GitHub releases page before trusting)

Version in tree: 0.2.55 (package.json / manifest / inpage in lockstep). Latest published GitHub release: v0.2.54; the Chrome Web Store version may lag a release or two behind it (store review plus the manual upload step). The 0.2.55 batch: honest structured send errors, coin consolidation + preview, bounded verify concurrency, RPC timeouts, clarvis resolve fallback. Vendored core: cairnx-core 0.1.35 at the csd-sdk commit pinned in src/vendor/PROVENANCE.json.

Sibling npm package versions at the same date: csd-tx 0.1.16, other csd-sdk packages 0.1.15-0.1.16, cairn-cli 0.3.19, cairn-sdk 0.2.1 (all verifiable on npm).

## Cross-repo map

Runtime npm deps (exact-pinned, only four): @noble/curves, @noble/hashes, @scure/bip32, @scure/bip39. NO npm dependency on csd-tx/cairnx-core/cairn-sdk; all trust-sensitive shared code arrives as the vendored bundle built from a local csd-sdk checkout at the commit pinned in PROVENANCE.json. Downstream consumers of the wallet's contract: cairn-sdk (mapProviderError) and the cairn site's trade UI consume the machine error codes. Server-side counterparts live behind the cairn front door at https://cairn-substrate.com: the /api/rpc proxy (rate limiting + body caps), /api/headers for SPV, /trade/api for CairnX reads, with clarvis as the independent second name-verification source and the csd-indexer explorer for chain browsing.
