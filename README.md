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
* **CairnX tokens and `.csd` names.** The popup lists your token balances (decimals-aware, with locked amounts shown) and owned names, and sends tokens through the same reviewed confirmation as a CSD send. Transfer records are built and hashed inside the wallet, never fetched from a server.
* **CairnX clear-signing.** The approval window decodes `cairnx:v1` proposals (token transfers, deploys, mints, offers, bids, cancels, name claims/transfers/renewals) into structured fields, for wallet- and dApp-initiated requests alike. Unrecognized record shapes still show the raw payload.
* **Multi-account**, multi-input sends, transaction history, sealed claims, and an idle auto-lock.
* **Coin consolidation.** Merge up to 512 of your smallest coins into one from Settings → Coins; every input is chain-verified before signing, for a flat 0.01 CSD fee.
* **Open source**, with a reproducible build you can verify yourself.

## Install

**[Add to Chrome (Chrome Web Store)](https://chromewebstore.google.com/detail/cairn-wallet/nnjiejlalkcfckfojhihbbcpfhimfemd)** (works in Chrome, Brave, and Edge). This is the recommended install: a reviewed, auto-updating build.

Prefer to load it yourself? Every [GitHub release](https://github.com/InverseAltruism/cairn-wallet/releases/latest) ships `cairn-wallet.zip` (the load-unpacked variant) with a `.sha256`:

1. Download and unzip `cairn-wallet.zip` from the latest release (you get a `cairn-wallet` folder).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the folder.

### Verify a release

Cairn Wallet is open source and reproducibly built, so you never have to trust the binary:

```bash
git clone https://github.com/InverseAltruism/cairn-wallet
cd cairn-wallet && git checkout vX.Y.Z
npm ci && npm run package          # produces a byte-identical cairn-wallet.zip
sha256sum cairn-wallet.zip         # must equal the release .sha256
```

Each release also carries a **SLSA build-provenance attestation**: run
`gh attestation verify cairn-wallet.zip --repo InverseAltruism/cairn-wallet` to confirm the published
zip was built by this repo's CI from the tagged source.

## Backups

You can back up in two ways.

* **Recovery phrase (12 words).** Your primary backup. It restores every account in Cairn Wallet, or in any CSD wallet that uses the same derivation path (`m/44'/7779'/0'/0/i`).
* **Account private key** (*Reveal key*). A plain CSD private key for a single account. It imports into the `csd` CLI (`csd wallet recover`) and any CSD tool, so you can move one account elsewhere.

Your keys stay portable and are never locked to this wallet.

## Security

* Keys are stored only as an AES-256-GCM vault, encrypted with a key derived from your password using PBKDF2-SHA256 (600,000 iterations). Nothing is uploaded.
* Signing is local. The wallet builds each transaction, computes its `CSD_SIG_V1` sighash, and signs it on your device. Only the finished transaction is sent to the node, so a malicious or intercepted RPC cannot make the wallet sign anything other than what you approved.
* The unlocked key lives only in the background service worker and is cleared by a 15-minute idle auto-lock.
* Web pages reach the wallet only through the `window.cairn` provider, limited to connect, sign-in, propose, attest, sealed claims, send, and offer fills. Every fund-moving request needs the wallet unlocked and an explicit approval in a separate clear-signing popup. Key export, account management, and coin maintenance are never reachable from a page.

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

## Release flow

> For maintainers.

1. **Bump the version in lockstep** across `package.json`, `public/manifest.json`, and `src/inpage.ts` (both the
   provider object's `version:` and `getCapabilities`). `build.mjs` aborts the build on any drift. Then
   `npm test && npm run package` must pass locally.
2. **Tag and push**: `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z` triggers
   `.github/workflows/release.yml`: `npm ci` → `npm test` (full gate) → `npm run package` (deterministic
   `cairn-wallet.zip` *load-unpacked* variant **and** `cairn-wallet-store.zip` *Web-Store* variant with
   `manifest.json` at the zip root, each with a `.sha256`) → **SLSA build-provenance attestation** → publish the
   GitHub Release.
3. **Chrome Web Store**: upload `cairn-wallet-store.zip` (manifest at the zip root) to the
   [Developer Dashboard](https://chrome.google.com/webstore/devconsole). This is the primary distribution
   channel; `store/` holds the listing copy, privacy policy, and submission checklist.

[cairn-substrate.com](https://cairn-substrate.com) links users to the Chrome Web Store for install and to this
repo for source. It does not host the extension binary.

## dApp error contract

Every `{ok:false}` envelope a dApp can see carries a stable machine `code` next to the human
`error` string (outer envelope codes since 0.2.46; nested `SubmitResult` codes since 0.2.54).
The codes are the contract; the strings are UX copy and may change. The full list, retryability
semantics, and the code-less legacy strings consumers must still know live in
[`WALLET-ERROR-CODES.md`](WALLET-ERROR-CODES.md). The reference consumer is
`cairn-sdk`'s `mapProviderError` plus the cairn site's code-first `walletErrText`.

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

## Dual-source `.csd` name verification (XREPO-1 / NSPV-COMPLETE-1 cure)

Sending to a `.csd` name never trusts a resolver's word. The wallet:

1. fetches the name's on-chain record **hints** from **two independent resolvers**, `cairn-substrate.com` (primary) and `clarvis.cairn-substrate.com` (an independent second source running its
   own node→indexer→cairnx; see [cairn doc 36](https://github.com/InverseAltruism/cairn/blob/master/docs/ecosystem/36-clarvis-second-source-handoff.md));
2. **unions** them and **SPV-verifies every event** against a PoW header chain the wallet builds itself
   (`src/core/namespv.ts` → vendored `LightClient`): full-block merkle-bind + per-record signer-auth, so a
   resolver can only ever *add* real mined events, **never fabricate** one;
3. replays the audited CairnX resolver over the verified union and **sends to the chain-proven winner:** not
   to any resolver's bare claim, and flags any source whose stated answer disagrees.

A single resolver can't redirect funds (every record is SPV-verified), and it can't *withhold* its way to a
redirect either, because the other independent source fills the omission, an attacker would have to make
**both** hosts hide the **same** event. It is **fail-soft**: if the second source is unreachable the wallet
falls back to single-source with a caution; nothing the wallet signs ever depends on a resolver being up.

The dual-resolver architecture (topology, routing, how each host runs, and the wallet union contract) is
documented in [cairn doc 38, wallet dual-source handoff](https://github.com/InverseAltruism/cairn/blob/master/docs/handoffs/38-wallet-dual-source-clarvis-handoff.md)
(wallet side) and [doc 36](https://github.com/InverseAltruism/cairn/blob/master/docs/ecosystem/36-clarvis-second-source-handoff.md) (clarvis host side).

## Configuration

* **Node RPC.** Switch from the RPC menu at the top right. Choose the Cairn proxy (`https://cairn-substrate.com/api/rpc`), a local node (`http://127.0.0.1:8789`), or add your own.
* **Cairn API.** Set in Settings. Defaults to `https://cairn-substrate.com`.
* **CairnX API.** Set in Settings. The read-only endpoint for token balances and `.csd` names; defaults to `https://cairn-substrate.com/trade/api`. If it's unreachable the wallet simply shows no assets (with a retry), the CSD balance and sends are unaffected, and nothing the wallet signs ever depends on it.

The derivation path `m/44'/7779'/0'/0/i` is public metadata. It describes which keys are
derived, not the keys themselves. 7779 is an unregistered SLIP-44 coin type, used as Cairn
Wallet's convention for CSD.

## License

MIT

[Terms of Use](https://cairn-substrate.com/terms.html) · [Privacy Policy](https://cairn-substrate.com/wallet-privacy.html), also linked from the wallet's Settings.
