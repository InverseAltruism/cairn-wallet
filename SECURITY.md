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

## What the wallet trusts the RPC for

Signing is local and the RPC can never alter what you sign — but the wallet does trust the
configured node/proxy for **state it displays and builds from**: balances, UTXO sets, history,
and CairnX token state. A malicious RPC cannot redirect funds or forge your approval, but it
could show a wrong balance, hide a transaction, or feed stale/false UTXOs (at worst causing a
rejected transaction or a misleading display, not a key or fund compromise). If that matters
for your threat model, point the wallet at your own node (`http://127.0.0.1:8789`) instead of
the public proxy.

## dApp boundary

A web page interacts with the wallet only through the injected `window.cairn` provider,
relayed to the background service worker over same-origin messages. The provider is injected
on all sites (like MetaMask) so any dApp can request a connection — but injection scope is
**not** the security boundary: the content script only relays requests, exposes no keys, and
`host_permissions` (network access) stays scoped to the node/proxy, not broadened with it.
The provider exposes a fixed set of actions: connect, getAddress, sign in, propose, attest,
sealed claims, and **send** (a plain CSD transfer).

**Per-origin consent (connected sites).** `connect`/`getAddress` grant *address visibility*:
the first time an origin connects the user approves it, and the origin is recorded as a
connected site (listed and revocable in Settings → wiped on reset). After that, that origin
may read the address without a fresh prompt. This is the **only** silent path, and only when
the wallet is unlocked. **Every signing / fund-moving action — signin, send, propose, attest,
sealClaim, revealClaim — ALWAYS opens the clear-signing approval window, every time,
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
`@scure/bip32`, `@scure/bip39`). Releases are built in CI from tagged source with
`npm ci`, ship a SHA-256 checksum and a SLSA build-provenance attestation, and are
byte-for-byte reproducible: rebuild from the same source and the hash matches the published
release.

## Verification

The signing core is tested against external ground truth: the transaction codec matches the
CSD consensus golden vectors, a real on-chain signature verifies against an independently
recomputed sighash, and the core produces transactions the live node accepts.
