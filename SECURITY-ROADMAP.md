# Cairn Wallet — Security Roadmap

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
  (SLSA build-provenance is emitted when the source repo is public — a no-op on a private repo; the CWS
  publish credential is kept off CI — see `store/PUBLISH-RUNBOOK.md`.)
- **Platform:** strict MV3 CSP, closed `externally_connectable`, minimal required permissions.

## Done 2026-06-04
- **[#3] Least-privilege host permissions** — removed the broad `https://*/*`
  `optional_host_permissions`; the optional set is now local nodes only
  (`http://localhost/*`, `https://localhost/*`, `http://127.0.0.1/*`). The default Cairn proxy is
  a required host permission, so the common cases work with no grant. Runtime grants are still
  requested per-exact-origin. *Trade-off:* a REMOTE custom HTTPS RPC is no longer reachable
  out of the box (use a local node or the Cairn proxy) — a documented power-user limitation,
  reintroducible later via a bounded, justified mechanism if needed.
- **[#4] Supply-chain hardening (partial)** — `@scure/bip32` + `@scure/bip39` pinned to exact
  versions; CI installs with `npm ci --ignore-scripts`. (Runtime dependency lockdown — LavaMoat
  /SES — remains a roadmap item below.)

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

## Roadmap (ranked)

### P0 — close before the wallet is "credible for holding meaningful value"
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
   (shipped, see "Done 2026-06-21" below). The extension now bundles a PoW-verified SPV light client
   (`core/namespv.ts` + `vendor/cairnx-spv.js`) and resolves a `.csd` name's winning record *in the
   wallet*: it proves each record's merkle inclusion against the verified header chain, **re-runs the
   canonical `@inversealtruism/cairnx-core` resolver** over only those records (no second resolver port),
   binds each record's signer to the coin it spends (prevout-ownership), unions two independent name-history
   sources, and shows a fail-closed caution (never a green badge) for fill-acquired ownership it cannot
   name-scope-prove. **Remaining residual (→ now the only open name-verify item):** a third source on a
   *different registrable domain* + per-source block bodies, to harden the withholding/competing-claim case
   beyond the same-apex two-source union. See `SECURITY.md` → "Sending to a `.csd` name".

### P1 — defense-in-depth (below best-in-class; partly mitigated by CSD being contract-less)
3. **Argon2id KDF for new vaults.** Memory-hard, vs PBKDF2's GPU/ASIC-friendliness for offline
   cracking of a stolen vault. `@noble/hashes` ships `argon2id`; the vault doc is already
   versioned (`v`/`iter`), so migrate new vaults to Argon2id and keep opening legacy PBKDF2
   vaults. Medium, security-sensitive — needs careful round-trip tests.
4. **Runtime dependency lockdown (LavaMoat / SES `lockdown()`).** Sandbox the 4 deps + neutralize
   prototype pollution. Drop-in for esbuild. Medium.
5. **Password-strength enforcement** at create/restore (length + zxcvbn-style) so the strong KDF
   isn't wasted on a weak password. Small.
6. ~~**Per-origin permission persistence + connected-sites view.**~~ ✅ **DONE** — per-origin
   consent grants live in the background (`connectedSites` / `disconnectSite`,
   `src/background.ts`), with a revocable Connected-sites list in Settings
   (`src/popup/popup.ts`).

### P2 — context-dependent (lower priority on a contract-less UTXO chain)
7. **Transaction pre-flight / risk display** — a node `/tx/template`-based dry-run + fee-rate
   sanity check in the approval window. (CSD has no token-approval drain vector, so the EVM
   motivation is largely absent.)
8. **Phishing / malicious-origin guard** — the provider injects on all `https://*` (like MetaMask), so
   any site can request a connection; injection scope is **not** the boundary (no keys exposed, every
   signing action is allowlist-gated + clear-signed + per-origin-consented). A local origin-fuzzylist
   (warn-don't-sign for look-alikes of the wallet's own protected origins) would add a phishing-banner
   layer on top — defense-in-depth, not a fund-safety gap.
