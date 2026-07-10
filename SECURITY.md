# Security Policy

Cairn Wallet is non-custodial. Your keys are generated and stored only on your device,
encrypted with your password, and are never sent to any server.

## Reporting a vulnerability

If you find a security issue, please report it privately to **inversealtruism@gmail.com**
rather than opening a public issue. Include steps to reproduce and, if possible, a proof of
concept. We will acknowledge your report and keep you informed as we work on a fix, and we
are happy to credit you once it is resolved.

## How keys are protected

* **Encrypted at rest.** Keys and the recovery phrase are stored only as an AES-256-GCM vault, sealed with a key derived from your password using PBKDF2-SHA256 (600,000 iterations). A wrong password fails authenticated decryption and reveals nothing. The stored iteration count is validated on open, so a tampered vault cannot weaken the key derivation.
* **In memory only while unlocked.** The decrypted key lives only in the background service worker and is cleared by a 15-minute idle auto-lock.
* **Local signing.** The wallet builds each transaction, computes its `CSD_SIG_V1` sighash, and signs it on your device. Only the finished transaction is sent to the node. The wallet never signs a digest handed to it by a server, so a malicious or intercepted RPC cannot redirect funds or change what you approved. The "sign in with CSD" digest is structurally distinct from a transaction sighash, so a hostile site cannot turn a sign-in into a spend.
* **Deterministic, non-malleable signatures.** secp256k1 with RFC 6979 nonces and low-S enforcement.

The wallet also declares the `unlimitedStorage` permission. Its trustless `.csd` name
verification keeps a PoW-verified block-header snapshot in `chrome.storage.local`; the snapshot
grows with the chain (multi-MB today) and shares the default 10 MB quota with the encrypted
vault, so without the permission the header cache would eventually hit the quota and degrade
verification. Everything stays local to the device and nothing is transmitted; the vault is
unaffected. Nor can a poisoned snapshot forge verification: it is re-verified on load (PoW and
LWMA difficulty re-derivation), so storage tampering can at worst force a re-sync.

## What the wallet trusts the RPC for

Signing is local and the RPC can never alter what you sign, but the wallet does trust the
configured node/proxy for **state it displays and builds from**: balances, UTXO sets, history,
and CairnX token state. A malicious RPC cannot redirect funds or forge your approval, but it
could show a wrong balance, hide a transaction, or feed stale/false UTXOs (at worst causing a
rejected transaction or a misleading display, not a key or fund compromise). If that matters
for your threat model, point the wallet at your own node (`http://127.0.0.1:8789`) instead of
the public proxy.

### Sending to a `.csd` name

When you send to a `.csd` name (e.g. `alice.csd`), the wallet treats the configured CairnX name
service as **untrusted** and verifies its answer against the chain itself:

* it runs an **in-wallet SPV light client** seeded at a baked checkpoint, verifying every header
  forward (PoW + LWMA difficulty + prev-link), and proves each name record's inclusion against the
  PoW-committed merkle root;
* it **re-runs the audited CairnX resolver** over only those merkle-verified records and requires the
  recomputed `(owner, address)` to equal what the service claimed, so a fabricated redirect (the service
  has no signed, mined events for the attacker's address) **fails closed**;
* it binds each record's signer to the **coin it spends** (the prevout's scriptPubkey must be that
  signer's address), so a hostile block-body provider cannot substitute a foreign-but-valid signature
  to re-attribute a name's owner (NSPV-SIGSUB-1);
* it **unions name-history from two independent sources** (primary + clarvis) and resolves to the
  SPV-proven winner, so a single source that *withholds* a later transfer or a competing claim is
  defeated as long as one source is honest; a source whose answer disagrees with the proof is flagged;
* it never shows a name as plain "verified" when ownership was decided by an on-chain **offer fill**
  whose validity depends on state outside the name's own history (an open-lane claim cap or a
  name-for-token balance): those show an explicit **caution**, not a green badge (NSPV-CLAIMCAP-1); and
* it still shows the **full, untruncated resolved address** as the recipient you confirm, and
  **re-resolves + re-verifies at confirm time**, refusing to sign on any address change *or* a drop in
  verification status between review and confirm.

The honest residual: "verified" means **chain-backed as shown**; for a very high-value transfer it is
still prudent to confirm the `0x…` address out-of-band. (As with every send, the wallet selects its own
inputs and returns change only to your own address.) See `SECURITY-ROADMAP.md` for the remaining
hardening (a third, different-domain source; per-source block bodies).

## dApp boundary

A web page interacts with the wallet only through the injected `window.cairn` provider,
relayed to the background service worker over same-origin messages. The provider is injected
on all sites (like MetaMask) so any dApp can request a connection, but injection scope is
**not** the security boundary: the content script only relays requests, exposes no keys, and
`host_permissions` (network access) stays scoped to the node/proxy, not broadened with it.
The provider exposes a fixed set of actions: connect, getAddress, sign in, propose, attest,
sealed claims, **send** (a plain CSD transfer), and **fillOffer** (an atomic CairnX
delivery-versus-payment fill, preflighted against the resolver before anything is signed).

**Per-origin consent (connected sites).** `connect`/`getAddress` grant *address visibility*:
the first time an origin connects the user approves it, and the origin is recorded as a
connected site (listed and revocable in Settings → wiped on reset). After that, that origin
may read the address without a fresh prompt. This is the **only** silent path, and only when
the wallet is unlocked **and the currently-active address is the SAME one the user consented to
share** (F11): consent is recorded against a specific address, so if the user has since switched
accounts, the silent path falls through to a fresh approval prompt rather than disclose the new,
unconsented address. **Every signing / fund-moving action (signin, send, propose, attest,
sealClaim, revealClaim) ALWAYS opens the clear-signing approval window, every time,
regardless of connection state.** Being connected never pre-approves a signature (enforced by
the fast-path guard in `background.ts` + the positive whitelist in `resolvePending`; proven by
`test/extension-boundary.ts` and the source-scan tripwires in `test/pentest.ts` §15).

`send` moves funds to a page-supplied recipient, so the approval window **clear-signs the
full (untruncated) recipient address(es), each amount, the total, the fee, and the
projected balance-after**, and warns on a first-time or look-alike (address-poisoning)
recipient. The wallet always selects its own inputs and returns change to its own address:
a page can pass `{to, amount, fee}` or `{outputs:[…], fee}` but can never choose which
UTXOs are spent, nor redirect the change. Key export, mnemonic/seed reveal, account
management, RPC/API settings, and wallet reset remain reachable **only** from the wallet's
own interface and are refused on the dApp channel even if a user approves the dialog
(enforced by the positive method whitelist in `resolvePending`, proven by
`test/extension-boundary.ts`).

## Supply chain

The wallet has a small, pinned dependency set (`@noble/curves`, `@noble/hashes`,
`@scure/bip32`, `@scure/bip39`), installed with `npm ci --ignore-scripts` (no install-time
lifecycle scripts run). The trust-sensitive SPV code is a **vendored bundle** of csd-sdk's audited
dists (`src/vendor/cairnx-spv.js`); `PROVENANCE.json` pins its sha256, the exact `@noble` versions,
the csd-sdk **version and source commit**, and a CI gate (`scripts/check-vendor-fresh.mjs`) rebuilds
it from source and requires byte-identity, so it cannot be hand-edited or left stale. Releases are
built in CI from tagged source with `npm ci` and a deterministic zip writer, so they are
**byte-for-byte reproducible**: rebuild from the same source and the SHA-256 matches the published
release. SLSA build-provenance is emitted when the source repo is public (it is a no-op on a private
repo; see `store/PUBLISH-RUNBOOK.md`).

## Publishing & updates

The wallet's defenses (SPV name-verify, clear-signing, the dApp boundary) run **inside the
extension**, so a malicious auto-update would disable them all at once. That makes the Chrome Web Store
publish credential the highest-blast-radius asset (cf. the Trust Wallet Dec-2025 leaked-CWS-key drain).
The CWS upload is therefore kept a **manual operator step, deliberately off CI** (a CI-resident store
key is exactly what supply-chain worms scrape), behind hardware-2FA, with reproduce-then-publish and
post-publish hash verification. You can verify the build you installed is the reviewed one by comparing
its version + hash against the published release. The full procedure is in `store/PUBLISH-RUNBOOK.md`.

## Verification

The signing core is tested against external ground truth: the transaction codec matches the
CSD consensus golden vectors, a real on-chain signature verifies against an independently
recomputed sighash, and the core produces transactions the live node accepts.
