# Cairn Wallet

A non-custodial browser wallet for **Compute Substrate (CSD)** — the first wallet on the network.

Cairn Wallet generates a standard 12-word recovery phrase on your device, derives your accounts from
it (BIP-39 / BIP-32 HD), and keeps everything encrypted locally. It signs transactions on-device,
sends and receives CSD, and lets you post to and support items on [Cairn](https://cairn-substrate.com).
Your private keys and recovery phrase never leave your machine.

- **Non-custodial** — keys are generated and stored only on your device, encrypted under your password.
- **Standard recovery** — a 12-word BIP-39 phrase backs up all your accounts; HD derivation (BIP-32/44).
- **Local signing** — transactions are built and signed locally; only the signed transaction is sent.
- **Multi-account**, multi-input sends, transaction history, sealed claims, and an idle auto-lock.
- **Open source and reproducibly built** — every release is verifiable down to the byte.

## Install

Download the latest release and load it unpacked:

1. Get **`cairn-wallet.zip`** from
   **[the latest release](https://github.com/InverseAltruism/cairn-wallet/releases/latest)**
   (or click *Get Wallet* on [cairn-substrate.com](https://cairn-substrate.com)).
2. Unzip it — you get a `cairn-wallet` folder.
3. Open `chrome://extensions` (Chrome, Brave, or Edge), enable **Developer mode**, click
   **Load unpacked**, and select the `cairn-wallet` folder.

### Verify the download (recommended)

Each release ships a SHA-256 checksum and a SLSA build-provenance attestation that ties the zip to the
exact source commit and CI run:

```bash
sha256sum -c cairn-wallet.zip.sha256                                        # checksum matches the release
gh attestation verify cairn-wallet.zip --repo InverseAltruism/cairn-wallet  # built from this source, in CI
```

## Backups & portability

There are two backups, and they serve different purposes:

- **Recovery phrase (12 words).** Your primary backup. It restores **all** accounts at once, in Cairn
  Wallet or any CSD wallet that adopts the same derivation path (`m/44'/7779'/0'/0/i`).
- **Account private key** (*Reveal key*). A plain CSD private key for a single account. Since CSD has
  no shared HD standard yet, this is the **portable** backup — it imports into the official `csd` CLI
  (`csd wallet recover`) and any CSD tool, recovering the same address. Use it to move one account
  elsewhere.

Your keys are never locked to this wallet: the phrase is the convenient full backup, and per-account
private-key export is the universal escape hatch.

## Security model

- Keys are generated or imported locally and stored only as an **AES-256-GCM vault**, encrypted with a
  key derived from your password via **PBKDF2-SHA256 (600,000 iterations)**. Nothing is uploaded.
- **Signing is local.** The wallet builds the transaction, computes its `CSD_SIG_V1` sighash itself, and
  signs it. Only the finished, signed transaction is sent to the node — so a malicious or
  man-in-the-middled RPC cannot make the wallet sign something other than what you approved.
- The unlocked key lives only in the background service worker and is wiped on a **15-minute idle
  auto-lock**.
- A web page reaches the wallet only through the injected `window.cairn` provider, which is limited to
  a small set of methods (connect, sign-in, propose, attest, sealed claims). Every request requires the
  wallet to be unlocked **and** an explicit approval in a separate popup window. Key-exposing and
  account-management actions are never reachable from a page.

See [`SECURITY.md`](SECURITY.md) for the full threat model and recommended audit scope.

## Why not fork a Bitcoin wallet?

CSD reuses Bitcoin's cryptographic primitives — secp256k1, `hash160`, double-SHA-256, a UTXO model —
but its transaction format and addressing are different: it serializes with `bincode`, uses the
`CSD_SIG_V1` tagged-hash sighash, and uses raw 20-byte `0x` addresses with no base58check or bech32
encoding. The parts of a Bitcoin wallet worth reusing (PSBT, address codecs, SIGHASH variants) are
exactly the parts CSD doesn't use. What does carry over is the extension shape, so Cairn Wallet uses the
standard Manifest V3 architecture (the same shape as MetaMask, Alby, and UniSat) wired to a purpose-built
CSD signing core on `@noble/curves`, `@noble/hashes`, `@scure/bip32`, `@scure/bip39`, and WebCrypto.

## Build from source

```bash
npm ci          # install exact, pinned dependencies
npm test        # security + behavior test suite
npm run build   # bundle into dist/ (esbuild inlines all dependencies)
npm run package # produce a reproducible cairn-wallet.zip + .sha256
```

`npm run package` is **byte-for-byte reproducible**: rebuild from the tagged source and the SHA-256 will
match the published release exactly, so you never have to trust the binary. After building, you can also
Load unpacked the `dist/` folder directly.

### How it's tested

The security-critical core is verified against **external ground truth**, not just its own assertions:

- the transaction codec reproduces the CSD consensus golden vectors (bytes, txid, and sighash);
- a real on-chain signature verifies against an independently recomputed sighash;
- the signing core produces transactions the live node accepts (proven on mainnet);
- the vault refuses a wrong password (authenticated decryption, no plaintext leak) and resists a
  stored-iteration downgrade; signatures are deterministic and low-S (non-malleable);
- the dApp trust boundary, approval flow, multi-input coin selection, and HD derivation are covered by
  dedicated behavioral and adversarial tests.

## Architecture

`src/core/` is browser-safe, framework-free, and the security-critical part of the codebase:

- **`csdtx.ts`** — CSD consensus serialization, txid, the `CSD_SIG_V1` sighash, and secp256k1
  sign/verify.
- **`account.ts`** — BIP-39 phrase generation and BIP-32/BIP-44 HD derivation
  (`m/44'/7779'/0'/0/i`), plus raw single-key import with range validation.
- **`keystore.ts`** — the AES-256-GCM + PBKDF2 vault.
- **`node.ts`** — multi-input coin selection and the non-custodial build → sign → `/tx/submit` flow.
- **`wallet.ts`** — orchestration (storage is injected): create, restore, import, lock/unlock,
  multi-account management, send, post/support, reveal key, reveal phrase, history, and auto-lock.

The extension layer:

- **`background.ts`** — the service worker; owns the unlocked key and the dApp approval queue.
- **`content.ts` / `inpage.ts`** — inject the `window.cairn` provider and relay requests to the
  background, gated by explicit user approval (with origin checks, never a wildcard).
- **`popup/`** — the UI; runs as the extension popup and also standalone in dev mode for testing.

## Configuration

- **Node RPC** — switch nodes from the **RPC** menu (top-right): pick the public Cairn proxy
  (`https://cairn-substrate.com/api/rpc`), a local node (`http://127.0.0.1:8790`), or add your own.
- **Cairn API** — set in Settings; defaults to `https://cairn-substrate.com` (used for posting content
  and reading board categories).

The derivation path (`m/44'/7779'/0'/0/i`) is public, non-sensitive metadata — it describes which keys
are derived, not the keys themselves. `7779` is an unregistered SLIP-44 coin type, claimed here as
Cairn Wallet's convention for CSD.

## License

MIT
