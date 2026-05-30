# Cairn Wallet

A **non-custodial browser wallet for Compute Substrate (CSD)** — likely the first CSD wallet.
Hold your key locally (encrypted), sign transactions, post to Cairn, and **Sign in with CSD**
(passwordless). Your private key never leaves the device.

## Why not fork a Bitcoin wallet?
CSD shares Bitcoin's *crypto primitives* (secp256k1, `hash160`, SHA256d, UTXO) but **not** its
transaction format or addressing — CSD uses `bincode` serialization, the **CSD_SIG_V1** tagged-hash
sighash, and raw 20-byte `0x` addresses (no base58check/bech32). A Bitcoin wallet's value is in
exactly the layer we can't reuse (PSBT, address encoding, SIGHASH). So this reuses the **standard
MV3 extension architecture** (the pattern Alby/UniSat/MetaMask share) wired to our own
consensus-proven CSD signing core (`@noble/curves` + `@noble/hashes` + WebCrypto).

## Architecture
- **`src/core/`** — browser-safe, framework-free, the security-critical part:
  - `csdtx.ts` — CSD consensus serialize / txid / CSD_SIG_V1 sighash + secp256k1 sign/verify.
  - `account.ts` — keygen / import (range-validated).
  - `keystore.ts` — AES-256-GCM vault, PBKDF2-SHA256 (600k, OWASP 2023). Wrong password → decrypt fails.
  - `node.ts` — non-custodial submit (built + **locally signed**, then `/tx/submit`) + sign-in.
  - `wallet.ts` — the brain (storage-injected): create/import/unlock/lock/balance/send/propose/
    attest/post/support/signin/export, transaction history + idle auto-lock.
- **`src/background.ts`** — service worker; owns the unlocked key; approval queue for dApp requests.
- **`src/content.ts` + `src/inpage.ts`** — injects `window.cairn` (connect/signIn/propose/attest),
  relayed to the background and gated by user approval.
- **`src/popup/`** — the UI (cyberpunk). Works as an extension popup **and** standalone (dev mode).

## Build & load
```bash
npm install
npm run build          # → dist/  (esbuild bundles everything, incl. @noble)
# Chrome/Brave/Edge: chrome://extensions → enable Developer mode → Load unpacked → select dist/
```

## Security model
- The private key is generated/imported locally and stored **only** as an AES-GCM vault encrypted
  with your password. It is never sent to any server.
- Signing happens locally; only the **signed** transaction goes to the CSD node's `/tx/submit`.
- "Sign in with CSD" signs a server nonce locally; the server verifies the signature — no password,
  no key upload.
- dApp (`window.cairn`) requests require the wallet unlocked **and** explicit user approval.

## Verification
The security-critical core is covered by oracle-based tests (`npm test`) — checks that compare against
external ground truth, not self-referential assertions:
- the transaction codec reproduces the CSD **consensus golden vectors**;
- a **real on-chain signature** verifies against an independently recomputed sighash;
- the core signs transactions the **live node accepts**;
- keystore decryption fails on a wrong password; key generation is unique; signatures are
  deterministic and low-S (non-malleable);
- transaction history and idle auto-lock behave correctly across mined / pending / expired states.

## Configuration
Open **Settings** in the wallet to change:
- `Node RPC` — defaults to the public Cairn proxy (`https://cairn-substrate.com/api/rpc`); point it at
  your own node if you run one.
- `Cairn API` — defaults to `https://cairn-substrate.com`.

## License
MIT
