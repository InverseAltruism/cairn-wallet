# Cairn Wallet

A non-custodial browser wallet for Compute Substrate (CSD), and as far as I know the first CSD wallet.
It holds your key locally (encrypted), signs transactions, posts to Cairn, and lets you sign in to
sites with your CSD key instead of a password. The private key never leaves your device.

## Why not just fork a Bitcoin wallet?

CSD borrows Bitcoin's cryptographic primitives (secp256k1, `hash160`, SHA256d, a UTXO model), but
the transaction format and addressing are different. CSD serializes with `bincode`, uses the
`CSD_SIG_V1` tagged-hash sighash, and addresses are raw 20-byte `0x` values with no base58check or
bech32 encoding.

The parts of a Bitcoin wallet actually worth reusing (PSBT, address encoding, SIGHASH) are exactly
the parts CSD doesn't use, so a fork would carry a lot of weight that never applies. What does carry
over is the extension shape itself. This wallet uses the standard Manifest V3 architecture that
Alby, UniSat, and MetaMask all share, wired to a CSD signing core built on `@noble/curves`,
`@noble/hashes`, and WebCrypto.

## Architecture

`src/core/` is browser-safe, framework-free, and the security-critical part of the codebase:

- `csdtx.ts`: CSD consensus serialization, txid, the `CSD_SIG_V1` sighash, and secp256k1 sign/verify.
- `account.ts`: key generation and import, with range validation.
- `keystore.ts`: an AES-256-GCM vault using PBKDF2-SHA256 (600k iterations, per OWASP 2023). A wrong
  password fails to decrypt rather than returning garbage.
- `node.ts`: non-custodial submit (the transaction is built and signed locally, then sent to
  `/tx/submit`) plus sign-in.
- `wallet.ts`: the orchestration layer (storage is injected): create, import, unlock, lock, balance,
  send, propose, attest, post, support, sign-in, export, transaction history, and idle auto-lock.

The rest:

- `src/background.ts` is the service worker. It owns the unlocked key and the approval queue for dApp
  requests.
- `src/content.ts` and `src/inpage.ts` inject `window.cairn` (connect, signIn, propose, attest),
  relay it to the background, and gate everything behind explicit user approval.
- `src/popup/` is the UI. It runs as an extension popup and also standalone in dev mode.

## Build and load

```bash
npm install
npm run build          # outputs to dist/ (esbuild bundles everything, including @noble)
```

Then in Chrome, Brave, or Edge: open `chrome://extensions`, enable Developer mode, choose Load
unpacked, and select the `dist/` folder.

## Security model

- The private key is generated or imported locally and stored only as an AES-GCM vault encrypted with
  your password. It is never sent to any server.
- Signing happens locally. Only the signed transaction goes to the CSD node's `/tx/submit`.
- Sign in with CSD works by signing a server nonce locally; the server verifies the signature. There's
  no password and no key upload.
- `window.cairn` requests require the wallet to be unlocked and explicitly approved by the user.

## Verification

The security-critical core is covered by oracle-based tests (`npm test`). These compare against
external ground truth rather than asserting against themselves:

- the transaction codec reproduces the CSD consensus golden vectors;
- a real on-chain signature verifies against an independently recomputed sighash;
- the core signs transactions the live node accepts;
- keystore decryption fails on a wrong password, key generation is unique, and signatures are
  deterministic and low-S (non-malleable);
- transaction history and idle auto-lock behave correctly across mined, pending, and expired states.

## Configuration

Open Settings in the wallet to change:

- `Node RPC`: defaults to the public Cairn proxy (`https://cairn-substrate.com/api/rpc`). Point it at
  your own node if you run one.
- `Cairn API`: defaults to `https://cairn-substrate.com`.

## License

MIT
