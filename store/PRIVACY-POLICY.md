# Cairn Wallet — Privacy Policy

_Last updated: 2026-06-01_

Cairn Wallet ("the extension") is a non-custodial browser wallet for the Compute
Substrate (CSD) network. This policy explains exactly what the extension does and does
not do with your data. The short version: **the extension does not collect, transmit,
sell, or share your personal data, and your keys never leave your device.**

## Who provides this extension

Cairn Wallet is published by the Cairn project (contact: inversealtruism@gmail.com).
It is open source: https://github.com/InverseAltruism/cairn-wallet

## What the extension stores (locally, on your device)

The extension stores the following **only** in your browser's local extension storage
(`chrome.storage.local`) on your own device:

- Your **encrypted vault** — your recovery phrase and private keys, sealed with
  AES-256-GCM under a key derived from your password (PBKDF2-SHA256, 600,000 iterations).
  The unencrypted phrase and keys exist only in memory while the wallet is unlocked, and
  are wiped on lock (including a 15-minute idle auto-lock).
- Your **public account list** (addresses and labels), to display your accounts.
- Your **local transaction history and sealed-claim records**, keyed by address.
- Your **settings** (the node RPC and Cairn API URLs you choose).

**None of this is ever transmitted to us or to any third party.** We operate no servers
that receive your wallet data, and we have no analytics, telemetry, or tracking of any
kind.

## What the extension sends, and to whom

To function as a wallet, the extension communicates **only** with the blockchain node /
API endpoints you configure (by default, the public Compute Substrate node proxy and
Cairn API at `cairn-substrate.com`; you may point these at your own node in Settings):

- It reads public chain data (your balance, UTXOs, proposals) from the node.
- It submits **signed transactions** you explicitly approve to the node's `/tx/submit`.
- For "Sign in with CSD", it signs a server-provided random nonce locally and sends the
  signature to prove control of your address. No password and no key are sent.

Transactions and addresses submitted to a blockchain network are inherently public on
that network. That is a property of the blockchain, not data collection by this
extension.

## What the extension does NOT do

- It does **not** collect personally identifiable information.
- It does **not** transmit your private key, recovery phrase, or password anywhere.
- It does **not** sell or transfer any user data to third parties.
- It does **not** use any data for advertising, profiling, or creditworthiness.
- It does **not** include analytics, trackers, or remotely-hosted code.

## Permissions and why they are needed

- **storage** — to save your encrypted vault, account list, history, and settings on
  your device.
- **alarms** — to run the 15-minute idle auto-lock and to retry posting off-chain
  content after a transaction is mined, even if the service worker was suspended.
- **Host access** to your configured node/API (`cairn-substrate.com` by default, plus a
  local node at `127.0.0.1:8789` if you run one; any custom host is requested only when
  you set it in Settings) — to read chain data and submit the transactions you approve.

## Data retention and deletion

All data lives on your device. Use **Reset** in the wallet, or remove the extension, to
delete it. We hold no copy and therefore cannot recover a lost password or recovery
phrase.

## Changes

We may update this policy; the "Last updated" date will change accordingly. Material
changes will be noted in the extension's repository.

## Contact

Questions or security reports: inversealtruism@gmail.com.
