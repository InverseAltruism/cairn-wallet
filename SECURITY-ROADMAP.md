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
- **Supply chain / integrity:** reproducible build + SLSA build-provenance attestation + SHA-256
  (exceeds most shipping wallets); small pinned dep set; `npm ci --ignore-scripts` in CI.
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

### P1 — defense-in-depth (below best-in-class; partly mitigated by CSD being contract-less)
3. **Argon2id KDF for new vaults.** Memory-hard, vs PBKDF2's GPU/ASIC-friendliness for offline
   cracking of a stolen vault. `@noble/hashes` ships `argon2id`; the vault doc is already
   versioned (`v`/`iter`), so migrate new vaults to Argon2id and keep opening legacy PBKDF2
   vaults. Medium, security-sensitive — needs careful round-trip tests.
4. **Runtime dependency lockdown (LavaMoat / SES `lockdown()`).** Sandbox the 4 deps + neutralize
   prototype pollution. Drop-in for esbuild. Medium.
5. **Password-strength enforcement** at create/restore (length + zxcvbn-style) so the strong KDF
   isn't wasted on a weak password. Small.
6. **Per-origin permission persistence + connected-sites view.** Today every dApp call prompts
   (conservative, but no revocable record of connected origins). Add an EIP-2255-style grant +
   a disconnect UI. Medium.

### P2 — context-dependent (lower priority on a contract-less UTXO chain)
7. **Transaction pre-flight / risk display** — a node `/tx/template`-based dry-run + fee-rate
   sanity check in the approval window. (CSD has no token-approval drain vector, so the EVM
   motivation is largely absent.)
8. **Phishing / malicious-origin guard** — the provider injects only on `cairn-substrate.com` /
   localhost today, so exposure is narrow; revisit (warn-don't-sign for unknown origins, or a
   blocklist) if/when the provider is exposed to arbitrary sites.
