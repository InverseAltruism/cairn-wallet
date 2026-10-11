# Chrome Web Store — paste-ready answers

Each console error below maps to an exact value to paste. Items marked **(you)** can only
be done in your own Google account; everything else is copy and paste.

---

## 1. Publisher contact email  (you)

> "Du musst eine Kontakt-E-Mail-Adresse angeben…" and "Du musst die Kontakt-E-Mail-Adresse
> des Publishers bestätigen…"

In the Developer Dashboard: **Account** (gear icon) → **Contact email** → enter
`inversealtruism@gmail.com` → **Save**, then click the verification link Google emails you.
This is account-level and can only be done by you.

---

## 2. Privacy policy URL

Privacy practices tab → **Privacy policy URL**:

```
https://cairn-substrate.com/wallet-privacy.html
```

(Already live.)

---

## 3. Single purpose description

Privacy practices tab → **Single purpose**:

```
Cairn Wallet is a non-custodial cryptocurrency wallet for the Compute Substrate (CSD) network. It generates and stores the user's keys locally in encrypted form, and signs and submits CSD transactions that the user explicitly approves.
```

---

## 4. Permission justifications

Privacy practices tab → **Permission justification**, one field each.

**storage**
```
Stores the user's encrypted key vault, account list, transaction history, and settings locally on the user's own device via chrome.storage.local. None of this data is transmitted off the device.
```

**unlimitedStorage**
```
The wallet's trustless .csd name verification keeps a proof-of-work-verified block-header snapshot in chrome.storage.local. That snapshot grows with the chain (multi-MB already) and shares the default 10MB quota with the user's encrypted key vault, so without unlimitedStorage the header cache would hit the quota and degrade verification. All of this data stays on the user's own device: nothing is collected or transmitted, and the vault is unaffected.
```

**alarms**
```
Runs a periodic timer that automatically locks the wallet after 15 minutes of inactivity, and retries registering a post's off-chain content after its transaction is mined. Alarms are required because the Manifest V3 service worker is suspended when idle.
```

**Host permission**
```
The wallet connects to the Compute Substrate blockchain node and the Cairn API to read public chain data (balances, unspent outputs, proposals) and to submit transactions the user explicitly approves. The default endpoints are cairn-substrate.com and an optional local node at 127.0.0.1:8789. Broader host access is optional and requested only at the moment the user enters a custom node URL in Settings, scoped to that host. No browsing data is read.
```

---

## 5. Data usage (same tab, complete these too)

- **Data collected:** none of the listed categories. The extension stores keys locally and
  transmits no personal data, so you can leave the data-collection categories unchecked.
- **Certifications** (check all three; each is true):
  - I do not sell or transfer user data to third parties, outside of the approved use cases.
  - I do not use or transfer user data for purposes unrelated to my item's single purpose.
  - I do not use or transfer user data to determine creditworthiness or for lending purposes.
- **Remote code:** No (all libraries are bundled at build time).

---

## 6. Trader status (Account tab, if prompted)

Declare your trader/non-trader status. A published wallet is generally a "trader," which
requires a public legal name and contact address shown to EU users.

---

## Optional: store upload package

The console showed no package error, so your uploaded package is fine. If you ever re-upload
and Chrome rejects the zip for not having `manifest.json` at the root, upload a flat zip of the
`dist/` contents (manifest at the top level) rather than the release `cairn-wallet.zip`, which
nests files under a `cairn-wallet/` folder for the Load-unpacked flow.
