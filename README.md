# Cairn Wallet

The first non-custodial wallet for Compute Substrate (CSD).

Cairn Wallet generates a 12-word recovery phrase on your device and derives your accounts
from it (BIP-39 / BIP-32 HD). Your keys are encrypted locally and never leave your machine.
The wallet signs transactions on your device, sends and receives CSD, and lets you post to
and support items on [Cairn](https://cairn-substrate.com).

## Features

* **Non-custodial.** Keys are generated and stored only on your device, encrypted with your password.
* **Standard recovery.** A 12-word BIP-39 phrase backs up every account.
* **Local signing.** Transactions are built and signed on your device. Only the signed transaction is sent to the node.
* **CairnX tokens and `.csd` names.** The popup lists your token balances (decimals-aware, with locked amounts shown) and owned names, and sends tokens through the same reviewed confirmation as a CSD send. Transfer records are built and hashed inside the wallet — never fetched from a server.
* **CairnX clear-signing.** The approval window decodes `cairnx:v1` proposals (token transfers, deploys, mints, offers, bids, cancels, name claims/transfers/renewals) into structured fields — for wallet- and dApp-initiated requests alike. Unrecognized record shapes still show the raw payload.
* **Multi-account**, multi-input sends, transaction history, sealed claims, and an idle auto-lock.
* **Open source**, with a reproducible build you can verify yourself.

## Install

1. Download `cairn-wallet.zip` from the [latest release](https://github.com/InverseAltruism/cairn-wallet/releases/latest), or click **Get Wallet** on [cairn-substrate.com](https://cairn-substrate.com).
2. Unzip it. You get a `cairn-wallet` folder.
3. Open `chrome://extensions` in Chrome, Brave, or Edge. Turn on **Developer mode**, click **Load unpacked**, and select the `cairn-wallet` folder.

### Verify the download

Every release ships a SHA-256 checksum and a build-provenance attestation that ties the zip
to the source commit and CI run.

```bash
sha256sum -c cairn-wallet.zip.sha256
gh attestation verify cairn-wallet.zip --repo InverseAltruism/cairn-wallet
```

## Backups

You can back up in two ways.

* **Recovery phrase (12 words).** Your primary backup. It restores every account in Cairn Wallet, or in any CSD wallet that uses the same derivation path (`m/44'/7779'/0'/0/i`).
* **Account private key** (*Reveal key*). A plain CSD private key for a single account. It imports into the `csd` CLI (`csd wallet recover`) and any CSD tool, so you can move one account elsewhere.

Your keys stay portable and are never locked to this wallet.

## Security

* Keys are stored only as an AES-256-GCM vault, encrypted with a key derived from your password using PBKDF2-SHA256 (600,000 iterations). Nothing is uploaded.
* Signing is local. The wallet builds each transaction, computes its `CSD_SIG_V1` sighash, and signs it on your device. Only the finished transaction is sent to the node, so a malicious or intercepted RPC cannot make the wallet sign anything other than what you approved.
* The unlocked key lives only in the background service worker and is cleared by a 15-minute idle auto-lock.
* Web pages reach the wallet only through the `window.cairn` provider, limited to connect, sign-in, propose, attest, and sealed claims. Every request needs the wallet unlocked and an explicit approval in a separate popup. Key export and account management are never reachable from a page.

To report a security issue, see [SECURITY.md](SECURITY.md).

## Build from source

```bash
npm ci
npm test
npm run build
npm run package
```

`npm run package` is byte-for-byte reproducible. Rebuild from the tagged source and the
SHA-256 matches the published release, so you never have to trust the binary.

### Tests

The signing core is verified against external ground truth, not only its own assertions:

* the transaction codec reproduces the CSD consensus golden vectors (bytes, txid, and sighash);
* a real on-chain signature verifies against an independently recomputed sighash;
* the core produces transactions the live node accepts;
* the vault rejects a wrong password and resists a stored-iteration downgrade, and signatures are deterministic and low-S;
* the dApp boundary, approval flow, coin selection, and HD derivation each have dedicated tests.

## Architecture

`src/core/` is browser-safe, framework-free, and holds the security-critical code.

* `csdtx.ts`: CSD serialization, txid, the `CSD_SIG_V1` sighash, and secp256k1 sign and verify.
* `account.ts`: BIP-39 phrase generation, BIP-32/BIP-44 HD derivation (`m/44'/7779'/0'/0/i`), and raw single-key import.
* `keystore.ts`: the AES-256-GCM and PBKDF2 vault.
* `node.ts`: coin selection and the build, sign, and submit flow.
* `wallet.ts`: orchestration (create, restore, import, lock and unlock, multi-account, send, post, support, reveal, history, auto-lock).

The extension layer:

* `background.ts`: the service worker. It owns the unlocked key and the dApp approval queue.
* `content.ts` and `inpage.ts`: inject the `window.cairn` provider and relay requests to the background, behind explicit approval and same-origin checks.
* `popup/`: the user interface.

## Configuration

* **Node RPC.** Switch from the RPC menu at the top right. Choose the Cairn proxy (`https://cairn-substrate.com/api/rpc`), a local node (`http://127.0.0.1:8790`), or add your own.
* **Cairn API.** Set in Settings. Defaults to `https://cairn-substrate.com`.
* **CairnX API.** Set in Settings. The read-only endpoint for token balances and `.csd` names; defaults to `https://cairn-substrate.com/trade/api`. If it's unreachable the wallet simply shows no assets (with a retry) — the CSD balance and sends are unaffected, and nothing the wallet signs ever depends on it.

The derivation path `m/44'/7779'/0'/0/i` is public metadata. It describes which keys are
derived, not the keys themselves. 7779 is an unregistered SLIP-44 coin type, used as Cairn
Wallet's convention for CSD.

## License

MIT
