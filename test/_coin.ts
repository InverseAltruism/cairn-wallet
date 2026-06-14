// Test helper for the TXB-1 input-value verification: build a confirmed UTXO whose `txid` is the REAL
// txid of a source tx we can also serve at /tx/<txid>, so node.ts's verifyInputValues (which recomputes
// the source txid and reads the real output value) passes. Without this, value-moving tests would fail
// closed (the wallet refuses to spend an input it can't verify against the chain).
import { txid, type Tx } from "../src/core/csdtx.js";

export interface MockCoin { coin: any; body: any }

export function mkCoin(value: number, vout = 0, extra: Record<string, unknown> = {}): MockCoin {
  const outputs = Array.from({ length: vout + 1 }, (_, i) => ({ value: i === vout ? value : 1, scriptPubkey: "0x" + "cd".repeat(20) }));
  const src: Tx = { version: 1, locktime: 0, app: { type: "None" }, inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 0, scriptSig: "0x" }], outputs };
  const id = txid(src);
  const body = {
    version: 1, locktime: 0, app: { type: "None" }, txid: id,
    inputs: [{ prev_txid: "0x" + "11".repeat(32), vout: 0, script_sig: "0x" }],
    outputs: outputs.map((o) => ({ value: o.value, script_pubkey: o.scriptPubkey })),
  };
  return { coin: { txid: id, vout, value, confirmations: 9, ...extra }, body };
}

// If `url` is a GET /tx/<txid> (NOT /tx/submit), return the matching source body wrapped as the node does
// ({ok,tx}), else null so the caller's mock can fall through.
export function txReply(url: string, coins: MockCoin[]): any | null {
  const m = String(url).match(/\/tx\/(0x[0-9a-fA-F]{64})\b/);
  if (!m) return null;
  const id = m[1].toLowerCase();
  const hit = coins.find((c) => String(c.coin.txid).toLowerCase() === id);
  return { ok: true, status: 200, json: async () => (hit ? { ok: true, tx: hit.body } : { ok: false, err: "not found" }) };
}
