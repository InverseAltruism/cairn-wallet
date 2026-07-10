# Cairn Wallet: Security Roadmap

Tracks security gaps from the 2026-06-04 benchmark against industry-standard and
best-in-class open-source wallets (MetaMask, Rabby, Phantom, Frame, Keplr) and standards
(CCSS, OWASP, Chrome MV3 guidance). It complements `SECURITY.md` (current threat model).

## Where the wallet meets or exceeds the baseline
- **KDF:** PBKDF2-HMAC-SHA256, 600k iters (= current MetaMask) + a stored-iteration
  downgrade floor (`MIN_ITERS`) MetaMask doesn't advertise.
- **Vault:** AES-256-GCM, fresh IV per seal, authenticated; wrong password → tag failure (no oracle).
- **dApp boundary:** positive method allowlist, double-enforced; privileged ops unreachable
  from pages; inputs/change always wallet-selected; local sighash (never signs an RPC-supplied
  digest); sign-in digest disjoint from a spend sighash.
- **Clear-signing:** full untruncated recipients, per-output amounts, total, fee, balance-after;
  address-poisoning (look-alike) + first-time-recipient warnings; anti-click-through approval.
- **Supply chain / integrity:** reproducible (byte-deterministic) build + SHA-256 + vendored-bundle
  sha/commit pin with a CI rebuild-vs-source gate; small pinned dep set; `npm ci --ignore-scripts` in CI.
  (SLSA build-provenance is emitted when the source repo is public, a no-op on a private repo; the CWS
  publish credential is kept off CI, see `store/PUBLISH-RUNBOOK.md`.)
- **Platform:** strict MV3 CSP, closed `externally_connectable`, minimal required permissions.

## Done 2026-06-04
- **[#3] Least-privilege host permissions:** removed the broad `https://*/*`
  `optional_host_permissions`; the optional set is now local nodes only
  (`http://localhost/*`, `https://localhost/*`, `http://127.0.0.1/*`). The default Cairn proxy is
  a required host permission, so the common cases work with no grant. Runtime grants are still
  requested per-exact-origin. *Trade-off:* a REMOTE custom HTTPS RPC is no longer reachable
  out of the box (use a local node or the Cairn proxy), a documented power-user limitation,
  reintroducible later via a bounded, justified mechanism if needed.
- **[#4] Supply-chain hardening (partial):** `@scure/bip32` + `@scure/bip39` pinned to exact
  versions; CI installs with `npm ci --ignore-scripts`. (Runtime dependency lockdown via
  LavaMoat/SES remains a roadmap item below.)

## Done 2026-06-21 (security-hardening release)
A whole-surface remediation closed the four findings from the hardening plan plus the supporting
medium/low set (all changes reject-more / fail-closed / additive; the audited cores stayed byte-for-byte
intact, verified by a multi-agent regression + pentest QA):
- **`.csd` name-verify (roadmap #3 above):** in-wallet SPV light client + audited-resolver replay +
  **prevout-ownership bind** (a hostile block-body provider can no longer substitute a foreign signature to
  re-attribute a name; NSPV-SIGSUB-1) + **two-source union** (clarvis now reachable in the manifest; a build
  tripwire keeps every fetched host in CSP + host_permissions) + **fail-closed caution for fill-acquired
  names** the scoped replay can't prove (NSPV-CLAIMCAP-1) + confirm-time re-verify that refuses a
  verification-status regression.
- **Value/spend:** absolute max-fee cap; stale-offer re-check before a fill; account-switch-mid-approval
  binding (the approval signs only the account it displayed); 32-byte digest guard on `signSighash`.
- **Clear-signing:** loud + single-sourced multi-recipient truncation (hidden total disclosed); Unicode
  bidi/zero-width neutralization in displayed fields; address-poisoning check extended to `nset`/`nxfer`
  targets; offline token-fill debit preview (fail-closed).
- **Supply chain:** `PROVENANCE.json` now pins the csd-sdk **source commit**; RPC/API URL validation
  (https/loopback only, no embedded credentials); single-sourced name regex; cross-mirror drift + dispatch-sync
  + `importKeyRaw`-downgrade regression tests; publish-security model documented in `store/PUBLISH-RUNBOOK.md`.

## Done 2026-07-06..09 (0.2.53 - 0.2.55 fund-safety batch)
- **[0.2.53] Per-coin fail-closed ghost-input verification:** each input is now classified on its
  own (tamper / transient / not-found) instead of one null verdict killing the whole selection, so a
  single unprovable "ghost" coin no longer bricks every spend; unverified coins are skipped, never
  signed.
- **[0.2.54] Shared send-flow engine + machine error codes + nfinalize approve gate:** every value
  flow runs through one reviewed send engine; each user-facing failure carries a stable machine
  code; a fee-burning name finalize is re-checked in the approval window before it can be signed.
- **[0.2.55] Honest submit disambiguation + consolidation:** SUBMIT_REJECTED vs
  SUBMIT_MAYBE_INFLIGHT vs SUBMIT_DUPLICATE, with locally computed txids ("may be in flight" copy is
  reserved for genuinely ambiguous outcomes); coin consolidation + preview (up to 512 smallest coins
  into one self-output, every input chain-verified); bounded verify concurrency (8);
  timeout-inversion fixes (client timeouts sit above their server-side worst cases); the
  `unlimitedStorage` permission for the growing SPV header snapshot.

## Done 2026-07-10 (0.2.56)
- **Maybe-inflight outcomes recorded for every value flow:** a SUBMIT_MAYBE_INFLIGHT result is now
  written to history (with its locally computed txid) and reconciled once the chain answers, so an
  ambiguous submit can no longer vanish from the record; plus a signing-account history filing fix.
- **clarvis resolve fallback** test-pinned (the second source now backs up name resolution, not just
  history union).
- **~4x faster SPV snapshot restore:** memoized LWMA math in the vendored csd-light,
  byte-identical output (adversarially verified).
- **Terms of Use / Privacy links in Settings.**

## Roadmap (ranked)

### P0: close before the wallet is "credible for holding meaningful value"
1. **Independent professional security audit** (Cure53 / Trail of Bits / SlowMist / Least
   Authority). Scope: keystore, dApp boundary, sighash + sign-in-oracle, approval flow, HD
   derivation, MV3 lifecycle. Publish the report in-repo (as Rabby does). Self-tests against
   golden vectors + ~6 adversarial agent passes + a Rust-consensus differential fuzz are strong,
   but they are **not** a substitute for an external adversarial review. *Prereq:* prepare an
   audit package (threat model, architecture notes, scope, findings tracker).
2. **Hardware-wallet support (Ledger first).** Keys are currently always hot (in the MV3 service
   worker). Add `@ledgerhq/hw-transport-webhid` + a CSD/secp256k1 signing path: build the tx
   locally, send only the sighash to the device, apply the returned signature. Effort: large
   (multi-session). Borrow from Rabby/Frame Ledger integrations.
3. ~~**In-wallet SPV light client → trustless `.csd` resolution (audit XREPO-1).**~~ ✅ **DONE**
   (shipped, see "Done 2026-06-21" above). The extension now bundles a PoW-verified SPV light client
   (`core/namespv.ts` + `vendor/cairnx-spv.js`) and resolves a `.csd` name's winning record *in the
   wallet*: it proves each record's merkle inclusion against the verified header chain, **re-runs the
   canonical `@inversealtruism/cairnx-core` resolver** over only those records (no second resolver port),
   binds each record's signer to the coin it spends (prevout-ownership), unions two independent name-history
   sources, and shows a fail-closed caution (never a green badge) for fill-acquired ownership it cannot
   name-scope-prove. **Remaining residual (→ now the only open name-verify item):** a third source on a
   *different registrable domain* + per-source block bodies, to harden the withholding/competing-claim case
   beyond the same-apex two-source union. See `SECURITY.md` → "Sending to a `.csd` name".
4. **Client-side SPV for CairnX settlement (fill + registration).** The name-*send* path is trustless
   (item 3), but `fillOffer` settlement and the name finalize/renew/set-primary gate are still
   resolver-trusted: the wallet computes the fill's required outputs from the offer's own fields and
   fails closed on an unsettleable offer (which defeats a resolver lying about status), but it has no
   on-device proof of the offer's or the reservation's on-chain state. A coherently self-consistent
   lie from a compromised/MITM'd resolver can make the wallet sign a fill or finalize the chain will not
   settle, burning a **bounded** amount (one fill's payment, or one registration fee; never keys or the
   rest of the balance). Close it by proving offer inclusion (txid recompute + merkle-bind against the
   verified header chain, the same machinery as item 3) and registration state before signing. Effort:
   large (shared `verifyfill` in cairnx-core + both vendored bundles). See `SECURITY.md` →
   "What the wallet trusts the CairnX resolver for".

### P1: defense-in-depth (below best-in-class; partly mitigated by CSD being contract-less)
4. **Argon2id KDF for new vaults.** Memory-hard, vs PBKDF2's GPU/ASIC-friendliness for offline
   cracking of a stolen vault. `@noble/hashes` ships `argon2id`; the vault doc is already
   versioned (`v`/`iter`), so migrate new vaults to Argon2id and keep opening legacy PBKDF2
   vaults. Medium, security-sensitive; needs careful round-trip tests.
5. **Runtime dependency lockdown (LavaMoat / SES `lockdown()`).** Sandbox the 4 deps + neutralize
   prototype pollution. Drop-in for esbuild. Medium.
6. ~~**Password-strength enforcement** at create/restore (length + zxcvbn-style).~~ ✅ **DONE**:
   obviously-weak passwords are refused at vault creation (`core/keystore.ts`, audit KEY-1) and a
   non-blocking strength hint shows on the new-wallet field (`popup/popup.ts`, CUST-1-1). A full
   zxcvbn-style score remains an optional refinement.
7. ~~**Per-origin permission persistence + connected-sites view.**~~ ✅ **DONE**: per-origin
   consent grants live in the background (`connectedSites` / `disconnectSite`,
   `src/background.ts`), with a revocable Connected-sites list in Settings
   (`src/popup/popup.ts`).

### P2: context-dependent (lower priority on a contract-less UTXO chain)
8. **Transaction pre-flight / risk display:** a node `/tx/template`-based dry-run + fee-rate
   sanity check in the approval window. (CSD has no token-approval drain vector, so the EVM
   motivation is largely absent.)
9. **Phishing / malicious-origin guard:** the provider injects on all `https://*` (like MetaMask), so
   any site can request a connection; injection scope is **not** the boundary (no keys exposed, every
   signing action is allowlist-gated + clear-signed + per-origin-consented). A local origin-fuzzylist
   (warn-don't-sign for look-alikes of the wallet's own protected origins) would add a phishing-banner
   layer on top: defense-in-depth, not a fund-safety gap.
