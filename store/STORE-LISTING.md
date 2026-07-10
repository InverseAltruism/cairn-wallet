# Cairn Wallet: Chrome Web Store Listing Copy

Paste-ready content for each field in the Chrome Web Store Developer Dashboard. Fields
map to the dashboard tabs: **Store listing**, **Privacy practices**, **Account**.

---

## Store listing

**Item name** (manifest `name`, ≤ 75 chars)
```
Cairn Wallet
```

**Summary / short description** (manifest `description`, ≤ 132 chars; current = 124 ✓)
```
Non-custodial wallet for Compute Substrate (CSD): hold keys locally, sign transactions, post to Cairn, and Sign in with CSD.
```

**Category**
```
Productivity
```
(There is no crypto/finance category; Productivity is the standard choice for a wallet.
"Developer Tools" is an acceptable alternative.)

**Language**
```
English (United States)
```

**Detailed description** (store body; opens with a one-line statement of what it does)
```
Cairn Wallet is a non-custodial wallet for the Compute Substrate (CSD) network. Your keys are generated and stored only on your device and are never uploaded to any server.

KEY FEATURES
• Self-custody by design: a 12-word recovery phrase (BIP-39) is generated on your device; all accounts derive from it (BIP-32/BIP-44 HD). You can also import a single private key.
• Encrypted at rest: your phrase and keys are sealed with AES-256-GCM under your password (PBKDF2-SHA256, 600,000 iterations). A 15-minute idle auto-lock protects an unattended session.
• Local signing: transactions are built and signed on your device; only the signed transaction is sent to the node. The key never leaves the wallet.
• Send & receive CSD, with a clear two-step send review that shows the full recipient address, the fee, your balance after, a first-time-recipient warning, and an address-poisoning lookalike warning.
• Post to Cairn and support proposals on-chain, and "Sign in with CSD": prove your address to a site by signing a challenge, with no password.
• Multiple accounts, transaction history with explorer links, and an optional custom node/API.

SECURITY
• Open source and reproducibly built: every release ships a SHA-256 and a build-provenance attestation, so you can verify the published extension was built from the exact source.
• No remotely-hosted code, no analytics, no trackers. Minimal permissions.

Cairn Wallet is self-custodial: you alone control your keys and recovery phrase. We cannot access, freeze, or recover your funds. Back up your recovery phrase; it is the only way to restore your wallet.

Source & verification: https://github.com/InverseAltruism/cairn-wallet
```

**Screenshots**: `store/assets/screenshot-*.png` (1280×800). Provide 3–5.
**Small promo tile**: `store/assets/promo-440x280.png`.
**Marquee promo tile** (optional): `store/assets/marquee-1400x560.png`.
**Store icon**: `public/icons/icon-128.png` (128×128) ✓ already in the package.

---

## Privacy practices tab

**Single purpose** (one narrow purpose)
```
Cairn Wallet is a non-custodial cryptocurrency wallet: it stores the user's keys locally (encrypted), and signs and submits Compute Substrate (CSD) transactions the user explicitly approves.
```

**Privacy policy URL**
```
https://cairn-substrate.com/wallet-privacy.html   (host store/PRIVACY-POLICY.md here, or any public URL)
```

**Permission justifications** (one per declared permission/host)

- `storage`
```
Stores the user's encrypted key vault, public account list, local transaction history, and settings on the user's own device. Nothing is transmitted off-device.
```
- `unlimitedStorage`
```
The wallet's trustless .csd name verification keeps a proof-of-work-verified block-header snapshot in chrome.storage.local. That snapshot grows with the chain (multi-MB already) and shares the default 10MB quota with the user's encrypted key vault, so without unlimitedStorage the header cache would hit the quota and degrade verification. All of this data stays on the user's own device: nothing is collected or transmitted, and the vault is unaffected.
```
- `alarms`
```
Runs the 15-minute idle auto-lock that wipes the in-memory key, and retries registering a Cairn post's off-chain content after its transaction is mined, even if the MV3 service worker was suspended.
```
- Host permission `https://cairn-substrate.com/*`
```
The default Compute Substrate node proxy and Cairn API. Used to read public chain data (balance, UTXOs, proposals) and to submit transactions the user approves. No user data is sent beyond the signed transaction itself.
```
- Host permission `http://127.0.0.1:8789/*`
```
Lets users who run their own local Compute Substrate node connect the wallet to it (localhost only). Optional; the wallet works against the default remote node without it.
```
- Optional host permissions `http://localhost/*`, `https://localhost/*`, `http://127.0.0.1/*`
```
Requested only at the moment a user chooses a custom local node/API URL in Settings, and only for that specific localhost host. This lets advanced users point the wallet at a node they run themselves. Not requested unless the user explicitly sets a custom endpoint. (These exactly match `optional_host_permissions` in manifest.json: localhost/127.0.0.1 only; no `https://*/*` or `<all_urls>`.)
```
- Content scripts on `https://*/*` (broad match)
```
Injects a tiny in-page provider (window.cairn) so any website the user visits can REQUEST to connect this wallet, the same model as MetaMask and other Web3 wallets. The content script only relays connection/signing REQUESTS to the extension; it reads no page content, sends no data, and exposes no keys. Nothing happens on any site until the user explicitly approves a connection in the wallet's own popup, and every transaction/signature is approved per-action in a separate clear-signing window. Connected sites are listed and revocable in Settings. NETWORK access is NOT broadened by this: host_permissions stays scoped to the node/proxy (localhost + cairn-substrate.com); the broad match is injection-only.
```

**Data usage: categories collected**
```
NONE. The wallet collects and transmits no user data. Keys are generated and stored
encrypted ON THE USER'S DEVICE and never leave it; the only outbound traffic is a
chain transaction or sign-in signature the user explicitly approves. Under Chrome's
data-disclosure definition (data "collected" = transmitted off the device), nothing is
collected, so leave ALL data categories UNCHECKED.
```
(Do NOT check ANY category: web history, personal communications, location, financial/
payment info, health, personal info, authentication information; none are collected or
transmitted. This matches store/CHROME-SUBMISSION.md.)

**Data usage: required certifications** (check all three; they are true for this extension)
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Remote code**
```
No. All code, including the @noble and @scure libraries, is bundled in the package at build time. The extension fetches data from the node API but never fetches or executes remote code.
```

---

## Account tab

**Trader status**: Declare **Trader** (this is a published software product). Provide the
legal name + contact address Google requires; it is shown to EU users. (If you are an
individual publishing non-commercially you may qualify as non-trader; confirm against
Google's definition, but a public wallet generally counts as a trader.)

**2-Step Verification**: must be enabled on the publishing Google account before submit.

---

## Notes for review (optional "notes to reviewer" field)
```
Cairn Wallet is a non-custodial wallet for the Compute Substrate (CSD) blockchain. Keys are generated and stored locally (AES-256-GCM, PBKDF2). It is open source and reproducibly built (SHA-256 + SLSA provenance per release). No remote code; minimal permissions (storage, alarms, and unlimitedStorage for the local block-header cache used in trustless name verification). Host permissions are the blockchain node/API used to read chain data and submit user-approved transactions; the localhost host permission supports users running their own node. The extension does not mine cryptocurrency.
```
