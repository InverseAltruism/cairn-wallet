// Account = a CSD keypair. Keygen via secp256k1 CSPRNG; import validates the key.
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { addrFromPriv, pubFromPriv } from "./csdtx.js";

export interface Account { privkey: string; pubkey: string; addr: string }

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
