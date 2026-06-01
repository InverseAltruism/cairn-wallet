// Account = a CSD keypair. Keys come from a BIP-39 seed phrase (BIP-32/BIP-44 HD
// derivation) for new wallets, or from a raw imported private key. Import validates.
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { addrFromPriv, pubFromPriv } from "./csdtx.js";

export interface Account { privkey: string; pubkey: string; addr: string }

// Cairn's HD derivation path for CSD. CSD has no registered SLIP-44 coin type, so we
// define one here; this path is the de-facto standard for CSD HD wallets and any
// future wallet can recover the same accounts from the same 12-word phrase.
// m / purpose' / coin' / account' / change / index   (BIP-44)
export const CSD_COIN_TYPE = 7779;
export const hdPath = (index: number) => `m/44'/${CSD_COIN_TYPE}'/0'/0/${index}`;

export function fromPriv(privInput: string): Account {
  const h = (privInput.startsWith("0x") ? privInput.slice(2) : privInput).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("private key must be 32-byte hex");
  // secp256k1 rejects 0 and >= curve order
  if (!secp256k1.utils.isValidPrivateKey(h)) throw new Error("private key out of range");
  const priv = "0x" + h;
  return { privkey: priv, pubkey: pubFromPriv(priv), addr: addrFromPriv(priv) };
}

export function generate(): Account {
  return fromPriv("0x" + bytesToHex(secp256k1.utils.randomPrivateKey()));
}

// ── BIP-39 / BIP-32 HD ──────────────────────────────────────────────────────
// 12-word English mnemonic (128 bits entropy). The phrase is the master backup:
// one phrase recovers every derived account, in order, in any compatible wallet.
export function newMnemonic(): string { return generateMnemonic(wordlist, 128); }
export function normalizeMnemonic(m: string): string { return m.trim().replace(/\s+/g, " ").toLowerCase(); }
export function isValidMnemonic(m: string): boolean { return validateMnemonic(normalizeMnemonic(m), wordlist); }

// Derive the account at `index` along Cairn's HD path from a seed phrase. Pure +
// deterministic: same phrase + index → same key/address, every time.
export function deriveAccount(mnemonic: string, index: number): Account {
  const norm = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(norm, wordlist)) throw new Error("invalid recovery phrase");
  const seed = mnemonicToSeedSync(norm);
  const node = HDKey.fromMasterSeed(seed).derive(hdPath(index));
  if (!node.privateKey) throw new Error("HD derivation produced no key");
  return fromPriv("0x" + bytesToHex(node.privateKey));
}
