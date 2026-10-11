# Cairn Wallet: Privacy Policy

_Last updated: 2026-10-11_

Cairn Wallet ("the extension") is a non-custodial browser wallet for the Compute Substrate (CSD) network. The
short version: **the extension does not collect, transmit, sell, or share your personal data, and your keys never
leave your device.** The same text is served at https://cairn-substrate.com/wallet-privacy.html.

## Who provides this extension

Cairn Wallet is published by InverseAltruism (contact: inversealtruism@gmail.com). It is open source:
https://github.com/InverseAltruism/cairn-wallet

## What the extension stores on your device

Only in your browser's local extension storage (`chrome.storage.local`) on your own device:

- Your **encrypted vault**: your recovery phrase and private keys, sealed with AES-256-GCM under a key derived from
  your password (PBKDF2-SHA256, 600,000 iterations). The unencrypted phrase and keys exist only in memory while the
  wallet is unlocked, and are wiped on lock, including the 15-minute idle auto-lock.
- Your **public account list** (addresses and labels).
- Your **local transaction history and sealed-claim records**, keyed by address.
- Your **settings**, and a cache of block headers used to verify `.csd` names.

**None of this is ever transmitted to us or to any third party.** We operate no servers that receive your wallet
data, and there are no analytics, telemetry, or tracking of any kind.

## What the extension sends, and to whom

- To the node proxy and Cairn API at `cairn-substrate.com` (or a local node you run): requests for public chain
  data (balances, unspent outputs, blocks, names, offers) and the signed transactions you explicitly approve.
- To `clarvis.cairn-substrate.com`, an independent second copy of the same public chain data run by the same
  operator: read-only lookups of the name or offer you are about to use, so the wallet can compare two sources
  before you sign. Nothing about you is sent beyond the lookup itself.
- For "Sign in with CSD", the wallet signs the site's sign-in message locally and returns the signature and that
  message to the site that asked. No password and no key are sent.

Transactions and addresses submitted to a blockchain are public on that network. That is a property of the
blockchain, not data collection by this extension. Like any web request, these requests reveal your IP address to
the server that receives them.

## What the extension does not do

- It does **not** collect personally identifiable information.
- It does **not** transmit your private key, recovery phrase, or password anywhere.
- It does **not** sell or transfer any user data to third parties.
- It does **not** use any data for advertising, profiling, or creditworthiness.
- It does **not** include analytics, trackers, or remotely hosted code.

## Permissions and why they are needed

- **storage**: to save your encrypted vault, account list, history, and settings on your device.
- **unlimitedStorage**: so the local block-header cache used for name verification can grow with the chain without
  hitting the storage quota. It stays on your device.
- **alarms**: to run the 15-minute idle auto-lock and to retry registering a post's off-chain content after its
  transaction is mined, even if the extension's background worker was suspended.
- **Host access**: `cairn-substrate.com` and `clarvis.cairn-substrate.com` (above), and a local node at
  `127.0.0.1:8789` if you run one. Other local addresses (`localhost` or `127.0.0.1` on another port) are requested
  only when you set one in Settings.

## Data retention and deletion

All data lives on your device. Removing the extension deletes it. We hold no copy and therefore cannot recover a
lost password or recovery phrase.

## Changes

This policy may be updated; the date above changes when it is. Material changes are noted in this repository.

## Contact

Questions or security reports: inversealtruism@gmail.com.
