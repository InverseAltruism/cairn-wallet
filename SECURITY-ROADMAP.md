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
3. **In-wallet SPV light client → trustless `.csd` resolution (audit XREPO-1).** Sending to a
   `.csd` name currently trusts the configured CairnX name service for the `name → 0x…` address;
   the extension bundles no light client, so it cannot verify that mapping against the chain. The
   real fix is to resolve a name's winning record *in the wallet* and verify its inclusion
   (PoW + checkpoint + merkle proof) against the node — the SPV bundle already exists on the `/trade`
   web page (`swapguard`) and the CairnX codec is already in-wallet (`core/cairnx.ts`). **Constraint:**
   do this WITHOUT porting a second full CairnX resolver into the extension (a divergent replay would
   re-create the cross-language determinism-fork class); reuse the canonical `@inversealtruism/cairnx-core`
   resolver, fed by SPV-verified chain bytes. Effort: large (multi-session).
   - **Mitigated until then (DONE, this release):** a named send shows the **full** resolved address
     as the unmissable thing to confirm, with an explicit "a malicious server could substitute this"
     caution, and **re-resolves at confirm time, refusing to sign on any change** (stops a server that
     re-points a name mid-flow). The residual — a *consistently* hostile server — is what the light
     client closes. See `SECURITY.md` → "Sending to a `.csd` name". Tests: `test/cairnx.ts` (XREPO-1
     section) + `test/pentest.ts` tripwires.

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
8. **Phishing / malicious-origin guard** — the provider injects only on `cairn-substrate.com` /
   localhost today, so exposure is narrow; revisit (warn-don't-sign for unknown origins, or a
   blocklist) if/when the provider is exposed to arbitrary sites.
