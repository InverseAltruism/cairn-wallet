// A chain generated above a real fixture header, for tests that need blocks carrying their own transactions (name
// records, offers, reservations) on the production light client: each header has the bits the vendored client computes
// (its LWMA), real links and times, and a merkle root that commits its block's body; its hash goes into
// `globalThis.__testPowOk`, which the cut-table bundle's proof-of-work check accepts (test/helpers/cuttable.mjs with
// `powList`). `C` is that bundle and must export LightClient and serializeHeader.
import { createHash } from "node:crypto";
import { records, hashOf, headerOf, has, row, memStore } from "./spvfixture.mjs";
import { ctxid, rpcTxToTx, merkleRoot, FILLER } from "../_spvrig.ts";

const SEED = 46, HB = 84, CH = 4096;
const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

/** Heights fork+1..tip; `placed` maps a height to its block's transactions (one filler otherwise). */
export async function genChain(C, { fork, tip, placed = new Map() }) {
  globalThis.__testPowOk ??= new Set();
  const { client } = await C.LightClient.fromRecords(records(fork - SEED + 1, fork), { firstHeight: fork - SEED + 1, anchorHeight: fork }, { checkpoints: { [fork]: hashOf(fork) } });
  const rows = new Map(), bodyByHash = new Map();
  const merkleOf = (txs) => merkleRoot(txs.map((t) => ctxid(rpcTxToTx(t.app ? t : { ...t, app: { type: "None" } }))));
  const fillerMerkle = merkleOf([FILLER]);
  let prev = hashOf(fork), time = Number(headerOf(fork).time);
  for (let h = fork + 1; h <= tip; h++) {
    time += 119;
    const txs = placed.get(h) ?? [FILLER];
    const base = { version: 1, prev, merkle: placed.has(h) ? merkleOf(txs) : fillerMerkle, time, nonce: h };
    let bits = null;
    try { client.ingest(h, { ...base, bits: 1 }); }
    catch (e) { const m = /LWMA ([0-9a-f]+)$/.exec(String(e?.message)); if (!m) throw e; bits = parseInt(m[1], 16); }
    const header = { ...base, bits };
    const hash = hex(sha256d(C.serializeHeader(header)));
    globalThis.__testPowOk.add(hash);
    client.ingest(h, header);
    rows.set(h, { height: h, header, hash });
    bodyByHash.set(hash, { height: h, txs });
    prev = hash;
  }
  const rowOn = (h) => (h <= fork ? (has(h) ? row(h) : null) : rows.get(h) ?? null);
  const recordsTo = (lo, hi) => {
    const b = new Uint8Array((hi - lo + 1) * HB);
    for (let h = lo; h <= hi; h++) b.set(h <= fork ? records(h, h) : C.serializeHeader(rows.get(h).header), (h - lo) * HB);
    return b;
  };
  /** A store holding chunks 31 (the cut table's newest) to the one with `held`, and its head at `held`. */
  const storeTo = (held) => {
    const st = memStore();
    for (let k = 31; k <= Math.floor(held / CH); k++) st.chunks.set(k, recordsTo(k * CH, Math.min(k * CH + CH - 1, held)));
    st.head = { v: 2, tip: held, tipHash: rowOn(held).hash };
    return st;
  };
  return { rows, bodyByHash, rowOn, storeTo };
}
