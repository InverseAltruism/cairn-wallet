# Cairn Wallet — Security Model & Audit Scope

Cairn Wallet is a non-custodial Manifest V3 browser extension for Compute Substrate
(CSD). This document states the threat model, the mitigations in place, the known
residual risks, and the scope we recommend for a third-party audit before a public
Chrome Web Store launch.

## Assets we protect

1. **The recovery phrase** (BIP-39, 12 words) — the master secret. Whoever holds it
   controls all derived accounts.
2. **Per-account private keys** — derived from the phrase (HD, BIP-32/BIP-44 path
   `m/44'/7779'/0'/0/i`) or imported raw.
3. **The unlocked in-memory key material** in the service worker.

The phrase and keys are sealed in an **AES-256-GCM vault** under a key derived from the
user's password via **PBKDF2-SHA256 (600k iterations)**. They are never transmitted;
only locally-signed transactions leave the device.

## Trust boundaries

| Boundary | Rule |
|---|---|
| Web page ↔ wallet | A page reaches the wallet only through `window.cairn`, relayed by the content script to the background service worker. The page can request `connect / getAddress / signin / propose / attest / sealClaim / revealClaim` and **nothing else**. |
| dApp ↔ keys | The dApp channel can **never** call key-exposing or account-management methods (`export`, `exportMnemonic`, `restore`, `import`, `send`, `addAccount`, `reset`, `unlock`, …) even if a user clicks approve. Enforced in the background dispatcher and covered by `test/extension-boundary.ts`. |
| Approval | Every dApp write/identity request requires the wallet to be **unlocked** AND an explicit **user approval** rendered in a **separate extension popup window** (not an injectable iframe — avoids click-jacking/overlay). |
| Signing | The wallet signs only sighashes **it computes itself** from a tx it built. It never signs a 32-byte value handed to it by a server. The "Sign in with CSD" digest is structurally disjoint from a tx sighash, so a malicious API cannot harvest a spend signature from the login flow (`test/poc-signin-oracle.ts`). |

## Mitigations in place

- **Vault:** AES-256-GCM; PBKDF2-SHA256 600k; per-vault salt + iteration count stored
  in the vault; a **MIN_ITERS=100k floor-clamp on open** defeats a stored-params
  downgrade attack; wrong password → GCM authentication failure (no oracle, no partial
  plaintext).
- **Signing core:** `@noble/curves` secp256k1, **low-S** + RFC6979 deterministic nonces
  (no nonce reuse → no key recovery). The codec is validated against the **CSD consensus
  golden vectors** and against a **real on-chain signature** (oracle tests, not
  self-assertion).
- **Key isolation:** the unlocked key lives only in the service worker; **15-minute idle
  auto-lock** (alarm-driven, survives MV3 service-worker eviction).
- **Provider relay:** `postMessage` is targeted at the page's **own origin** (never
  `"*"`) and messages are checked for `source === window` and matching origin, so a
  cross-origin iframe cannot read provider traffic.
- **Clear-signing:** the approval dialog shows the domain, payload hash, URI, fee, the
  signer, the origin, and the **projected balance-after**; it flags an unusually large
  fee (> 5 CSD).
- **Address-poisoning defence:** sends use a two-step review that shows the **full**
  recipient address, a first-time-recipient warning, and a **lookalike warning** when a
  recipient matches a previously-seen address on head+tail but differs in the middle.
- **Numeric safety:** all CSD amounts/fees are range-checked to the JS safe-integer range
  before signing (a value above 2^53 could otherwise be silently mis-signed).
- **Supply chain:** only two runtime deps (`@noble/curves`, `@noble/hashes`) plus the
  HD libs (`@scure/bip32`, `@scure/bip39`) — all pinned, by the same maintainer, pure-JS,
  audited. CI builds the release with `npm ci`, runs the full test gate, and publishes a
  **byte-reproducible** zip with a SHA-256 and a **SLSA build-provenance attestation**, so
  anyone can confirm the published binary was built from this exact source.
- **MV3 hardening:** no remotely hosted code (everything bundled at build time); strict
  CSP (`script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
  minimal permissions (`storage`, `alarms`); narrow host permissions, with custom RPC/API
  hosts requested as an **optional** permission at the user's action.

## Known residual risks / deferred

- **No memory-hard KDF.** PBKDF2-600k matches MetaMask and the OWASP PBKDF2 floor but is
  not memory-hard; **Argon2id** (via WASM, needs `'wasm-unsafe-eval'` in CSP) would
  exceed the bar. Iteration count is stored per-vault and is upgradeable.
- **No per-origin connection allowlist / revoke UI yet.** Every request is already
  per-request approval-gated showing the origin, so the marginal risk is low; a
  "connected sites" management view is a planned enhancement.
- **No transaction simulation beyond fee/balance-diff.** dApp requests on CSD only move a
  fee (propose/attest), so the balance-diff preview covers the real impact; richer
  decoding would help if richer app types are added.
- **No hardware-wallet support.** Keys are software-custodied (encrypted at rest).
- **No phishing-domain blocklist.** The content script only injects on the configured
  Cairn origins, which limits exposure, but a known-malicious-site blocklist is not
  shipped.

## Recommended third-party audit scope

For a public launch we recommend an external review (e.g. **Cure53** or **Trail of
Bits** for the extension + crypto core, optionally **SlowMist** / **Least Authority**
for chain-specific coverage), scoped to:

1. **`src/core/csdtx.ts`** — consensus serialization, txid, `CSD_SIG_V1` sighash, and
   secp256k1 sign/verify vs the CSD golden vectors and live node.
2. **`src/core/keystore.ts` + `account.ts`** — vault KDF/encryption, HD derivation,
   downgrade resistance, RNG.
3. **The extension trust boundary** — `background.ts` / `content.ts` / `inpage.ts` /
   `popup/approve.ts`: dApp method gating, approval flow, click-jacking, message-origin
   handling, service-worker key lifetime.
4. **Supply chain** — dependency integrity, the reproducible-build pipeline, and the
   provenance attestation.

## Reporting

Please report security issues privately to the maintainer rather than opening a public
issue. (Set a contact/PGP here before publishing the listing.)
