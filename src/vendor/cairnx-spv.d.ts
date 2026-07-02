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
  tx(id: string): Promise<{ ok?: boolean; tx?: RpcTxJson } | null>; // /tx/{id} — used by namespv prevout-ownership bind (H3)
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
/** STRICT signer recovery (csd-crypto 0.1.15): exact 198-byte CSD_SIG_V1 frame + verifyDigest
 *  against the given digest; lowercase addr20 or null. The wallet's namespv authenticator. */
export function recoverSigner(scriptSig: string, digest: string): string | null;
// THE audited CairnX resolver, reused (never re-typed). Returns canonical state; we read .names[name].
export function resolve(events: unknown[], tipHeight: number): { names: Record<string, { owner: string; addr?: string; expired?: boolean; viaFill?: boolean; pending?: boolean; finalizeBy?: number; effectiveHeight: number; height: number; claimId: string }>;[k: string]: unknown };

// ── CairnX convention surface (cairnx-core) — imported by core/cairnx.ts instead of a hand-typed copy
// (shared-core de-dup, cairn docs/Plans/46). The bundle already inlines all of cairnx-core to serve
// resolve(); these are the same reviewed bytes, now type-declared for the wallet's build/decode/display.
export const DOMAIN: string;
export const MIN_FEE_PROPOSE: number;
export const TREASURY_ADDR: string;
export const FEE_BPS: number;
export const FEE_BPS_V16: number;
export const REBATE_BPS: number;
export const REBATE_FLAT: bigint;
export const V16_HEIGHT: number;
export const V18_HEIGHT: number;
export const V24_HEIGHT: number;   // v2.4 name-fee gate (imported by core/cairnx.ts buildFeeHeight)
export const V25_HEIGHT: number;   // v2.5 sealed-reservation gate (clearsign fee-warning: name reveal is free at V25)
export const NAME_RE: RegExp;
export const PKEY: RegExp;
export const TICKER_RE: RegExp;
export const ADDR_RE: RegExp;
export const AMOUNT_RE: RegExp;
export const SALT_RE: RegExp;
export const RESERVED_NAMES: ReadonlySet<string>;
export const MAX_AMOUNT: bigint;
export const MAX_RECORD_BYTES: number;
export const PROFILE_MAX_KEYS: number;
export const PROFILE_MAX_VALUE_BYTES: number;
export function canonicalJson(v: unknown, depth?: number): string;
export function payloadHash(record: unknown): string;
export function tradeFee(want: bigint, bps?: number): bigint;
export function makerRebate(value: bigint): bigint;
export function nameRegFee(name: string, height: number): bigint;
export function parseRecord(uri: string, payloadHashHex: string): Record<string, unknown> | null;
/** Canonical amount gate (AMOUNT_RE + MAX_AMOUNT + allowZero); bigint or null. */
export function parseAmount(s: unknown, opts?: { allowZero?: boolean }): bigint | null;
export function nameCommit(name: string, salt: string, owner: string): string;
