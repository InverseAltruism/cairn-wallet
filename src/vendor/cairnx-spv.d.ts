// Type surface for the vendored SPV bundle (src/vendor/cairnx-spv.js — built by scripts/build-spv-vendor.sh
// from the audited csd-sdk dists). Paired with the adjacent .js; only the members core/namespv.ts uses are typed.
export interface RpcTxJson {
  version: number;
  locktime: number;
  inputs: { prev_txid: string; vout: number; script_sig: string }[];
  outputs: { value: number; script_pubkey: string }[];
  app: { type: "None" } | { type: "Propose"; domain: string; payload_hash: string; uri: string; expires_epoch: number } | { type: "Attest"; proposal_id: string; score: number; confidence: number };
}
export interface Tx {
  version: number; locktime: number;
  inputs: { prevTxid: string; vout: number; scriptSig: string }[];
  outputs: { value: number | bigint; scriptPubkey: string }[];
  app: { type: "None" } | { type: "Propose"; domain: string; payloadHash: string; uri: string; expiresEpoch: number } | { type: "Attest"; proposalId: string; score: number; confidence: number };
}
export interface VerifiedHeader { height: number; hash: string; header: { merkle: string; prev: string; bits: number;[k: string]: unknown }; chainwork: bigint; trusted?: boolean }
export interface RpcBlock { ok: boolean; hash: string; height?: number; header: unknown; txs: (RpcTxJson & { txid: string })[] }

export class CsdClient {
  constructor(opts: { baseUrl: string; fetch?: typeof fetch });
  tip(): Promise<{ height: number; hash?: string }>;
  blockByHeight(h: number): Promise<RpcBlock>;
  blockByHash(hash: string): Promise<RpcBlock>;
}
export class LightClient {
  readonly chain: VerifiedHeader[];
  baseHeight: number;
  constructor(opts: { client?: CsdClient; baseUrl?: string; headersBatchProvider?: (from: number, count: number) => Promise<{ header: unknown; hash: string }[]>; checkpoints?: Record<number, string> });
  static fromSnapshot(s: unknown, opts?: ConstructorParameters<typeof LightClient>[0]): LightClient;
  syncFromCheckpoint(height: number, hash: string, context?: number): Promise<void>;
  sync(to: number, from?: number): Promise<VerifiedHeader>;
  toSnapshot(): unknown;
}
export function rpcTxToTx(j: RpcTxJson): Tx;
export function txid(tx: Tx): string;
export function sighash(tx: Tx): string;
export function merkleRoot(txids: string[]): string;
export function verifyMerkleProof(txid: string, pos: number, branch: string[], root: string): boolean;
export function addrFromPub(pub: string): string;
export function verifyDigest(sig: string, pub: string, digest: string): boolean;
// THE audited CairnX resolver, reused (never re-typed). Returns canonical state; we read .names[name].
export function resolve(events: unknown[], tipHeight: number): { names: Record<string, { owner: string; addr?: string; expired?: boolean; viaFill?: boolean; effectiveHeight: number; height: number; claimId: string }>;[k: string]: unknown };
