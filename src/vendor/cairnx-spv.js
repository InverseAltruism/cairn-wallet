// ../csd-sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/crypto.js
var crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

// ../csd-sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function rotl(word, shift) {
  return word << shift | word >>> 32 - shift >>> 0;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
var Hash = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto && typeof crypto.randomBytes === "function") {
    return Uint8Array.from(crypto.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}

// ../csd-sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE);
  const _32n = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// ../csd-sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends HashMD {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());

// ../csd-sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/sha256.js
var sha2562 = sha256;

// ../csd-sdk/packages/codec/dist/index.js
var strip0x = (h) => h.startsWith("0x") ? h.slice(2) : h;
var hb = (h) => hexToBytes(strip0x(h));
var hx = (b) => "0x" + bytesToHex(b);
var sha256d = (b) => sha2562(sha2562(b));
function u32(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 4294967295) {
    throw new Error(`u32: value ${n} out of range [0, 2^32)`);
  }
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64(n) {
  let v;
  if (typeof n === "bigint") {
    v = n;
  } else {
    if (!Number.isSafeInteger(n)) {
      throw new Error(`u64: unsafe number ${n} \u2014 pass values \u2265 2^53 (or negatives) as bigint`);
    }
    v = BigInt(n);
  }
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error(`u64: value ${v} out of range [0, 2^64)`);
  }
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
var lenBytes = (b) => concatBytes(u64(b.length), b);
function hbFixed(h, n) {
  const b = hb(h);
  if (b.length !== n) throw new Error(`expected a ${n}-byte (0x\u2026${n * 2}-hex) field, got ${b.length} bytes`);
  return b;
}
var CHAIN_ID_HASH = hexToBytes("1b17c7b04d05394674ca2c8e24f7433e251a1973cac2000c7b60966546e0b875");
var GENESIS_HASH = "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52";
var TARGET_BLOCK_SECS = 120;
var INITIAL_BITS = 503382015;
var POW_LIMIT_BITS = 503382015;
var LWMA_WINDOW = 45;
var LWMA_SOLVETIME_MAX_FACTOR = 12;
var MAX_FUTURE_DRIFT_SECS = 2 * 60 * 60;
var MTP_WINDOW = 11;
var MIN_BLOCK_SPACING_SECS = 60;
var EPOCH_LEN = 30;
var COIN = 1e8;
var INITIAL_REWARD = 50 * COIN;
var HALVING_INTERVAL = 1051200;
var MAX_HALVINGS = 64;
var MIN_FEE_PROPOSE = 25e6;
var MIN_FEE_ATTEST = 5e6;
var MAX_U128 = (1n << 128n) - 1n;
function blockReward(height) {
  const halvings = Math.floor(height / HALVING_INTERVAL);
  if (halvings >= MAX_HALVINGS) return 0;
  return Math.floor(INITIAL_REWARD / 2 ** halvings);
}
var COINBASE_TXID = "0x" + "00".repeat(32);
var COINBASE_VOUT = 4294967295;
var isCoinbaseInput = (i) => i.prevTxid === COINBASE_TXID && i.vout === COINBASE_VOUT;
function strippedTx(tx) {
  return { ...tx, inputs: tx.inputs.map((i) => isCoinbaseInput(i) ? i : { ...i, scriptSig: "0x" }) };
}
function serializeApp(app) {
  if (app.type === "None") return u32(0);
  if (app.type === "Propose")
    return concatBytes(u32(1), lenBytes(utf8ToBytes(app.domain)), hbFixed(app.payloadHash, 32), lenBytes(utf8ToBytes(app.uri)), u64(app.expiresEpoch));
  return concatBytes(u32(2), hbFixed(app.proposalId, 32), u32(app.score), u32(app.confidence));
}
function serialize(tx) {
  const parts = [u32(tx.version), u64(tx.inputs.length)];
  for (const i of tx.inputs) parts.push(hbFixed(i.prevTxid, 32), u32(i.vout), lenBytes(hb(i.scriptSig)));
  parts.push(u64(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64(o.value), hbFixed(o.scriptPubkey, 20));
  parts.push(u32(tx.locktime), serializeApp(tx.app));
  return concatBytes(...parts);
}
function txid(tx) {
  return hx(sha256d(serialize(strippedTx(tx))));
}
function taggedHash(tag, msg) {
  const t = sha2562(utf8ToBytes(tag));
  return sha2562(concatBytes(t, t, msg));
}
function sighash(tx) {
  return hx(sha256d(taggedHash("CSD_SIG_V1", concatBytes(serialize(strippedTx(tx)), CHAIN_ID_HASH))));
}
function serializeHeader(h) {
  const buf = new Uint8Array(84);
  buf.set(u32(h.version), 0);
  buf.set(hbFixed(h.prev, 32), 4);
  buf.set(hbFixed(h.merkle, 32), 36);
  buf.set(u64(h.time), 68);
  buf.set(u32(h.bits), 76);
  buf.set(u32(h.nonce), 80);
  return buf;
}
function headerHash(h) {
  return hx(sha256d(serializeHeader(h)));
}
function headerHashBytes(h) {
  return sha256d(serializeHeader(h));
}
function bitsToTarget(bits) {
  const exp = bits >>> 24 & 255;
  const mant = bits & 16777215;
  const out = new Uint8Array(32);
  if (exp === 0 || mant === 0) return out;
  if ((mant & 8388608) !== 0) return out;
  if (exp > 32) return out;
  let target;
  if (exp <= 3) target = BigInt(mant) >> BigInt(8 * (3 - exp));
  else target = BigInt(mant) << BigInt(8 * (exp - 3));
  if (target === 0n) return out;
  if (target >= 1n << 256n) return out;
  for (let i = 31; i >= 0 && target > 0n; i--) {
    out[i] = Number(target & 0xffn);
    target >>= 8n;
  }
  return out;
}
function targetToBigInt(target) {
  let v = 0n;
  for (const byte of target) v = v << 8n | BigInt(byte);
  return v;
}
function bigIntToTarget(x) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
function minBE(x) {
  if (x === 0n) return [];
  const b = [];
  while (x > 0n) {
    b.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  return b;
}
function targetToBits(target) {
  const x = targetToBigInt(target);
  if (x === 0n) return 0;
  const bytes = minBE(x);
  let exp = bytes.length;
  let mant;
  if (exp <= 3) {
    const shift = BigInt(8 * (3 - exp));
    mant = Number(x << shift & 0xffffffffn) & 16777215;
  } else {
    mant = (bytes[0] << 16 | bytes[1] << 8 | bytes[2]) >>> 0;
  }
  if ((mant & 8388608) !== 0) {
    mant >>= 8;
    exp += 1;
  }
  mant &= 16777215;
  return (exp << 24 | mant) >>> 0;
}
var POW_LIMIT_TARGET = targetToBigInt(bitsToTarget(POW_LIMIT_BITS));
function powOk(headerHashBE, bits) {
  const target = targetToBigInt(bitsToTarget(bits));
  if (target === 0n || target > POW_LIMIT_TARGET) return false;
  return targetToBigInt(headerHashBE) <= target;
}
function workForBits(bits) {
  const target = targetToBigInt(bitsToTarget(bits));
  if (target === 0n || target > POW_LIMIT_TARGET) return 0n;
  const w = (1n << 256n) / (target + 1n);
  return w > MAX_U128 ? MAX_U128 : w;
}
function merkleRoot(txidsHex) {
  if (txidsHex.length === 0) return "0x" + "00".repeat(32);
  let layer = txidsHex.map(hb);
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      const buf = new Uint8Array(64);
      buf.set(left, 0);
      buf.set(right, 32);
      next.push(sha256d(buf));
    }
    layer = next;
  }
  return hx(layer[0]);
}
function verifyMerkleProof(txidHex, pos, branchHex, merkleRootHex) {
  let cur = hb(txidHex);
  let idx = pos;
  for (const sibHex of branchHex) {
    const sib = hb(sibHex);
    const buf = new Uint8Array(64);
    if (idx & 1) {
      buf.set(sib, 0);
      buf.set(cur, 32);
    } else {
      buf.set(cur, 0);
      buf.set(sib, 32);
    }
    cur = sha256d(buf);
    idx >>= 1;
  }
  return hx(cur) === hx(hb(merkleRootHex));
}
function merkleBranch(txidsHex, pos) {
  let layer = txidsHex.map(hb);
  const branch = [];
  let idx = pos;
  while (layer.length > 1) {
    const sibIdx = idx ^ 1;
    const sib = sibIdx < layer.length ? layer[sibIdx] : layer[idx];
    branch.push(hx(sib));
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      const buf = new Uint8Array(64);
      buf.set(left, 0);
      buf.set(right, 32);
      next.push(sha256d(buf));
    }
    layer = next;
    idx >>= 1;
  }
  return branch;
}
var MAX_DEPTH = 256;
function canonicalJson(v, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error("canonicalJson: max nesting depth exceeded");
  if (v === null || typeof v !== "object") {
    if (v === void 0) return "null";
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x, depth + 1)).join(",") + "]";
  const o = v;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== void 0).map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k], depth + 1)).join(",") + "}";
}
function payloadHash(content) {
  return "0x" + bytesToHex(sha2562(utf8ToBytes(canonicalJson(content))));
}

// ../csd-sdk/packages/client/dist/index.js
var CsdClient = class {
  base;
  f;
  timeoutMs;
  retries;
  maxBytes;
  constructor(opts) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.maxBytes = Math.max(1, opts.maxResponseBytes ?? 16 * 1024 * 1024);
    const gf = globalThis.fetch;
    this.f = opts.fetch ?? (gf ? gf.bind(globalThis) : gf);
    this.timeoutMs = opts.timeoutMs ?? 1e4;
    this.retries = Math.max(0, opts.retries ?? 0);
    if (!this.f) throw new Error("no fetch available \u2014 pass opts.fetch");
  }
  async req(path, init, opts) {
    const maxRetries = opts?.noRetry ? 0 : this.retries;
    let lastErr;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.f(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        if (r.status >= 500 && attempt < maxRetries) {
          lastErr = new Error(`HTTP ${r.status}`);
        } else if (!r.ok) throw Object.assign(new Error(`${init?.method ?? "GET"} ${path} \u2192 HTTP ${r.status}`), { terminal: r.status < 500 });
        else return await this.readCapped(r, path);
      } catch (e) {
        if (attempt >= maxRetries || e?.terminal) throw e;
        lastErr = e;
      }
      const cap = Math.min(5e3, 250 * 2 ** attempt);
      await new Promise((res) => setTimeout(res, Math.floor(Math.random() * cap)));
      void lastErr;
    }
  }
  /**
   * Read a response body as JSON with a hard byte ceiling (`maxResponseBytes`). Rejects an
   * oversized `Content-Length` up front, and otherwise streams the body and aborts the moment
   * it exceeds the cap — so a malicious node cannot make us buffer a giant body and OOM before
   * we ever validate it (audit M2). Falls back to a size-checked `text()` on runtimes without a
   * streaming body (older MV3/Node), preserving the cap as a best effort.
   */
  async readCapped(r, path) {
    const max = this.maxBytes;
    const cl = r.headers.get("content-length");
    if (cl && Number(cl) > max) throw new Error(`GET ${path} \u2192 response too large (${cl} > ${max} bytes)`);
    const body = r.body;
    if (!body || typeof body.getReader !== "function") {
      const t = await r.text();
      const byteLen = new TextEncoder().encode(t).length;
      if (byteLen > max) throw new Error(`GET ${path} \u2192 response too large (${byteLen} > ${max} bytes)`);
      return JSON.parse(t);
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > max) {
          try {
            await reader.cancel();
          } catch {
          }
          throw new Error(`GET ${path} \u2192 response exceeded ${max} bytes`);
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    return JSON.parse(new TextDecoder().decode(buf));
  }
  get(path) {
    return this.req(path);
  }
  post(path, body, opts) {
    return this.req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, opts);
  }
  // The node returns application errors as `{ok:false, err}` with HTTP **200**, so a bare `get()`
  // can't see them. For endpoints whose `{ok:false}` result is useless to the caller (a missing
  // block), surface it as a thrown error — otherwise a beyond-tip/not-found block flows downstream
  // as a malformed object and crashes opaquely (e.g. the light client reading `header.prev`).
  async getOk(path) {
    const j = await this.get(path);
    if (j && j.ok === false) throw new Error(`GET ${path} \u2192 node error: ${j.err ?? "ok:false"}`);
    return j;
  }
  tip() {
    return this.get("/tip");
  }
  health() {
    return this.get("/health");
  }
  blockByHeight(h) {
    return this.getOk(`/block/height/${h}`);
  }
  blockByHash(hash) {
    return this.getOk(`/block/${hash}`);
  }
  tx(id) {
    return this.get(`/tx/${id}`);
  }
  // Default available=true: excludes immature/locked coinbase UTXOs so callers don't build txs spending
  // un-spendable outputs (the node would silently reject them) — audit TXB-1-SDK. Pass {available:false}
  // for the full set (e.g. balance display that wants to show locked coinbases).
  utxos(addr, opts = {}) {
    return this.get(`/utxos/${addr}${opts.available === false ? "" : "?available=true"}`);
  }
  // getOk: a not-found proposal returns {ok:false}@200; without this the caller reads .domain/.uri off a
  // malformed object instead of seeing the error (audit M6). (tx() deliberately keeps its bare get — its
  // {ok:false} is a documented VALID "not yet in a block" state that waitForTx/verifyInputValues handle.)
  proposal(id) {
    return this.getOk(`/proposal/${id}`);
  }
  proposals(domain, limit = 40) {
    return this.get(`/proposals/${encodeURIComponent(domain)}/${limit}`);
  }
  topDomain(domain, epoch) {
    return this.get(epoch == null ? `/top/${encodeURIComponent(domain)}` : `/top/${encodeURIComponent(domain)}/${epoch}`);
  }
  domains() {
    return this.get("/domains");
  }
  mempool() {
    return this.get("/mempool");
  }
  /**
   * Await a txid reaching `confirmations` (default 1) — the submit-then-confirm flow every
   * consumer was hand-rolling. Polls /tx + /tip; resolves {txid, height, confirmations};
   * rejects on timeout (default 10 min — CSD blocks are ~2 min but the live miner is lumpy).
   * A tx that drops OUT of the chain mid-wait (reorg) keeps polling until it re-confirms or
   * times out — never resolves on a stale sighting.
   */
  async waitForTx(txid2, opts = {}) {
    const want = Math.max(1, opts.confirmations ?? 1);
    const deadline = Date.now() + (opts.timeoutMs ?? 6e5);
    const poll = Math.max(500, opts.pollMs ?? 5e3);
    for (; ; ) {
      try {
        const t = await this.tx(txid2);
        if (t.ok && t.height != null) {
          const tip = await this.tip();
          const conf = tip.height - t.height + 1;
          if (conf >= want) return { txid: txid2, height: t.height, confirmations: conf };
        }
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`waitForTx ${txid2}: not at ${want} confirmation(s) within ${opts.timeoutMs ?? 6e5}ms`);
      await new Promise((res) => setTimeout(res, poll));
    }
  }
  /**
   * Broadcast a node-JSON tx (from @inversealtruism/csd-tx `txToNodeJson`).
   * ⚠ The node returns `{ok:false, err}` with HTTP 200 on REJECTION — and **`txid` is populated even
   * then** (it's the computed id of the rejected tx). Callers MUST check `.ok`; reading `.txid`
   * alone mistakes a rejected tx for a broadcast one. Use `submitOrThrow` if you want a hard failure.
   */
  submit(nodeJsonTx) {
    return this.post("/tx/submit", { tx: nodeJsonTx }, { noRetry: true });
  }
  /** As `submit`, but throws on node rejection (`ok:false`) instead of returning a misleading txid. */
  async submitOrThrow(nodeJsonTx) {
    const r = await this.submit(nodeJsonTx);
    if (!r.ok) throw new Error(`tx rejected by node: ${r.err ?? "unknown error"}`);
    return r;
  }
  templatePropose(body) {
    return this.post("/tx/template/propose", body);
  }
  templateAttest(body) {
    return this.post("/tx/template/attest", body);
  }
};
function rpcTxToTx(j) {
  const app = j.app.type === "None" ? { type: "None" } : j.app.type === "Propose" ? { type: "Propose", domain: j.app.domain, payloadHash: j.app.payload_hash, uri: j.app.uri, expiresEpoch: j.app.expires_epoch } : { type: "Attest", proposalId: j.app.proposal_id, score: j.app.score, confidence: j.app.confidence };
  return {
    version: j.version,
    locktime: j.locktime,
    app,
    inputs: j.inputs.map((i) => ({ prevTxid: i.prev_txid, vout: i.vout, scriptSig: i.script_sig })),
    outputs: j.outputs.map((o) => ({ value: o.value, scriptPubkey: o.script_pubkey }))
  };
}
function rpcHeaderToHeader(h) {
  return { version: h.version, prev: h.prev, merkle: h.merkle, time: h.time, bits: h.bits, nonce: h.nonce };
}

// ../csd-sdk/packages/light/dist/index.js
var TARGET_MEMO_CAP = 4096;
var targetMemo = /* @__PURE__ */ new Map();
function bitsToTargetBigInt(bits) {
  const hit = targetMemo.get(bits);
  if (hit !== void 0) return hit;
  const v = targetToBigInt(bitsToTarget(bits));
  if (targetMemo.size >= TARGET_MEMO_CAP) targetMemo.clear();
  targetMemo.set(bits, v);
  return v;
}
var POW_LIMIT_TARGET2 = bitsToTargetBigInt(POW_LIMIT_BITS);
function expectedBitsFromWindow(window, height) {
  if (height === 0) return INITIAL_BITS;
  const parent = window[window.length - 1];
  if (!parent) throw new Error(`expectedBits: empty window for height ${height}`);
  if (height < 2) return parent.bits;
  const n = Math.min(LWMA_WINDOW, height, window.length);
  if (n < 2) return parent.bits;
  const w = window.slice(window.length - n);
  const times = [];
  const targets = [];
  for (const h of w) {
    const tg = bitsToTargetBigInt(h.bits);
    if (tg === 0n) throw new Error("expectedBits: invalid compact bits in window");
    times.push(BigInt(h.time));
    targets.push(tg);
  }
  if (times.length < 2) return parent.bits;
  const m = times.length;
  const t = BigInt(Math.max(TARGET_BLOCK_SECS, 1));
  const maxSolve = BigInt(Math.max(LWMA_SOLVETIME_MAX_FACTOR, 1) * Math.max(TARGET_BLOCK_SECS, 1));
  let weightedSum = 0n, denom = 0n;
  for (let i = 1; i < m; i++) {
    let dt = times[i] - times[i - 1];
    if (dt < 0n) dt = 0n;
    const st = dt < 1n ? 1n : dt > maxSolve ? maxSolve : dt;
    const ww = BigInt(i);
    weightedSum += st * ww;
    denom += ww;
  }
  if (denom === 0n) return parent.bits;
  const avgSolvetime = weightedSum / denom;
  let sumTarget = 0n;
  for (const tg of targets) sumTarget += tg;
  const avgTarget = sumTarget / BigInt(m);
  let nextTarget = avgTarget * avgSolvetime / t;
  if (nextTarget > POW_LIMIT_TARGET2) nextTarget = POW_LIMIT_TARGET2;
  if (nextTarget === 0n || nextTarget >= 1n << 256n) return POW_LIMIT_BITS;
  const bits = targetToBits(bigIntToTarget(nextTarget));
  if (bitsToTargetBigInt(bits) > POW_LIMIT_TARGET2) return POW_LIMIT_BITS;
  return bits;
}
var satAddWork = (a, bits) => {
  const s = a + workForBits(bits);
  return s > MAX_U128 ? MAX_U128 : s;
};
var LightClient = class _LightClient {
  client;
  provider;
  checkpoints;
  /** Verified header chain. chain[i].height = baseHeight + i. */
  chain = [];
  /** Height of chain[0] — 0 for genesis-start, the seed start for checkpoint-start. */
  baseHeight = 0;
  batch;
  /** Whether a real per-height source exists (vs the default provider that can only throw). */
  hasHeaderSource;
  constructor(opts = {}) {
    this.client = opts.client ?? (opts.baseUrl ? new CsdClient({ baseUrl: opts.baseUrl }) : void 0);
    this.batch = opts.headersBatchProvider;
    this.hasHeaderSource = !!(opts.headerProvider ?? this.client);
    this.checkpoints = opts.checkpoints ?? {};
    this.provider = opts.headerProvider ?? (async (h) => {
      if (!this.client) throw new Error("LightClient needs a client/baseUrl or a headerProvider");
      const b = await this.client.blockByHeight(h);
      return { header: rpcHeaderToHeader(b.header), hash: b.hash, txids: b.txs.map((t) => t.txid) };
    });
  }
  get tip() {
    return this.chain[this.chain.length - 1];
  }
  get chainwork() {
    return this.tip?.chainwork ?? 0n;
  }
  /** Whether every header back to genesis was verified (vs trusted from a checkpoint). */
  get fullyVerified() {
    return this.baseHeight === 0;
  }
  at(height) {
    return this.chain[height - this.baseHeight];
  }
  /** The chronological LWMA window (≤ LWMA_WINDOW headers) immediately preceding `height`. */
  windowBefore(height) {
    const startIdx = Math.max(0, height - this.baseHeight - LWMA_WINDOW);
    const endIdx = height - this.baseHeight;
    return this.chain.slice(startIdx, endIdx).map((c) => c.header);
  }
  /** Enforce a pinned checkpoint hash, if one is configured for this height (the only trust anchor). */
  pinCheckpoint(height, hash) {
    const cp = this.checkpoints[height];
    if (cp && cp.toLowerCase() !== hash.toLowerCase()) throw new Error(`checkpoint mismatch at ${height}`);
  }
  /** Sync + VERIFY headers [from..to] from genesis (or contiguous to the current tip). */
  async sync(to, from = this.baseHeight + this.chain.length) {
    if (from !== this.baseHeight + this.chain.length) throw new Error(`non-contiguous sync: tip ${this.baseHeight + this.chain.length - 1}, asked from ${from}`);
    if (this.batch) {
      for (let h = from; h <= to; ) {
        const want = Math.min(512, to - h + 1);
        const rows = await this.batch(h, want);
        if (!rows.length) throw new Error(`batch provider returned no headers at ${h}`);
        for (const r of rows.slice(0, want)) {
          this.ingest(h, r.header, r.hash);
          h++;
        }
      }
    } else {
      for (let h = from; h <= to; h++) {
        const { header, hash } = await this.provider(h);
        this.ingest(h, header, hash);
      }
    }
    if (!this.tip) throw new Error("sync produced no tip");
    return this.tip;
  }
  /** Verify a single header at `height` and append it (full consensus checks). */
  ingest(height, header, claimedHash) {
    if (height !== this.baseHeight + this.chain.length) throw new Error(`out-of-order ingest at ${height} (tip ${this.baseHeight + this.chain.length - 1})`);
    const vh = this.verifyOne(height, header, this.windowBefore(height), this.at(height - 1), claimedHash);
    this.chain.push(vh);
    return vh;
  }
  /** Pure verification of one header against a window + parent (no mutation). */
  verifyOne(height, header, window, parent, claimedHash) {
    const hash = headerHash(header);
    if (claimedHash && claimedHash.toLowerCase() !== hash.toLowerCase()) throw new Error(`header hash mismatch at ${height}`);
    if (height === 0) {
      if (hash.toLowerCase() !== GENESIS_HASH.toLowerCase()) throw new Error(`foreign genesis: ${hash}`);
      if (header.bits !== INITIAL_BITS) throw new Error("genesis bits != INITIAL_BITS");
    } else {
      if (!parent) throw new Error(`no parent context for height ${height}`);
      if (header.prev.toLowerCase() !== parent.hash.toLowerCase()) throw new Error(`broken prev link at ${height}`);
      this.checkTimeRules(height, header, window, parent);
      const exp = expectedBitsFromWindow(window, height);
      if (header.bits !== exp) throw new Error(`bad bits at ${height}: header ${header.bits.toString(16)} != LWMA ${exp.toString(16)}`);
    }
    if (!powOk(headerHashBytes(header), header.bits)) throw new Error(`invalid PoW at ${height}`);
    this.pinCheckpoint(height, hash);
    return { height, hash, header, chainwork: satAddWork(parent?.chainwork ?? 0n, header.bits) };
  }
  /**
   * Timestamp consensus rules (H3), a faithful port of chain/index.rs + chain/time.rs:
   *   • min spacing:  time ≥ parent.time + MIN_BLOCK_SPACING_SECS
   *   • MTP:          time > median of the last MTP_WINDOW header times ending at parent (inclusive)
   *   • future drift: time ≤ now() + MAX_FUTURE_DRIFT_SECS   (wall-clock, as the node does)
   * `window` is the chronological run preceding `height`; its last element IS the parent, so its
   * tail of MTP_WINDOW headers is exactly the node's MTP walk. Without these, an attacker could grind
   * timestamps to drive the LWMA toward POW_LIMIT.
   *
   * Edge (safe-direction): right after a checkpoint seed shorter than MTP_WINDOW, the available window
   * can be shorter than the node's full MTP walk (which would reach below baseHeight). A truncated
   * median over ascending times is ≥ the node's, so the `time > mtp` gate is only ever STRICTER here —
   * it can reject a header the node accepts, never accept one the node rejects. The standard API
   * (`syncFromCheckpoint`, context = LWMA_WINDOW = 45 ≥ MTP_WINDOW) always supplies a full window.
   */
  checkTimeRules(height, header, window, parent) {
    const time = Number(header.time);
    const minAllowed = Number(parent.header.time) + MIN_BLOCK_SPACING_SECS;
    if (time < minAllowed) throw new Error(`time too early at ${height}: ${time} < parent+${MIN_BLOCK_SPACING_SECS} (${minAllowed})`);
    const recent = window.slice(Math.max(0, window.length - MTP_WINDOW)).map((h) => Number(h.time)).sort((a, b) => a - b);
    const mtp = recent.length ? recent[Math.floor(recent.length / 2)] : 0;
    if (time <= mtp) throw new Error(`time <= MTP at ${height}: ${time} <= ${mtp}`);
    const maxAllowed = Math.floor(Date.now() / 1e3) + MAX_FUTURE_DRIFT_SECS;
    if (time > maxAllowed) throw new Error(`time too far in future at ${height}: ${time} > now+${MAX_FUTURE_DRIFT_SECS}`);
  }
  /**
   * Seed a TRUSTED, contiguous header run ending at a pinned checkpoint, so forward sync needs
   * only a small window — not a 27k-block genesis fetch. The seed is the trust anchor (PoW links
   * are still spot-checked, but seed bits aren't LWMA-re-derived; that's the explicit trade for
   * not syncing from genesis). chainwork becomes RELATIVE to the seed. `checkpointHash` MUST match
   * the last seeded header.
   */
  seedTrusted(seed, checkpointHash) {
    if (this.chain.length) throw new Error("seedTrusted must be called on a fresh client");
    if (!seed.length) throw new Error("empty seed");
    this.baseHeight = seed[0].height;
    let prevHash = null;
    for (let i = 0; i < seed.length; i++) {
      const s = seed[i];
      if (s.height !== this.baseHeight + i) throw new Error("seed not contiguous");
      const hash = headerHash(s.header);
      if (s.hash && s.hash.toLowerCase() !== hash.toLowerCase()) throw new Error(`seed header hash mismatch at ${s.height}`);
      if (prevHash && s.header.prev.toLowerCase() !== prevHash.toLowerCase()) throw new Error(`seed prev link broken at ${s.height}`);
      if (!powOk(headerHashBytes(s.header), s.header.bits)) throw new Error(`seed PoW invalid at ${s.height}`);
      this.pinCheckpoint(s.height, hash);
      this.chain.push({ height: s.height, hash, header: s.header, chainwork: satAddWork(this.chain[i - 1]?.chainwork ?? 0n, s.header.bits), trusted: true });
      prevHash = hash;
    }
    if (this.tip.hash.toLowerCase() !== checkpointHash.toLowerCase()) throw new Error(`checkpoint hash mismatch: seeded tip ${this.tip.hash} != ${checkpointHash}`);
  }
  /** Fetch + seed the LWMA window ending at `checkpointHeight`, asserting its hash, then ready to sync forward. */
  async syncFromCheckpoint(checkpointHeight, checkpointHash, context = LWMA_WINDOW) {
    const start = Math.max(0, checkpointHeight - context);
    let seed = [];
    if (this.batch) {
      try {
        for (let h = start; h <= checkpointHeight; ) {
          const want = Math.min(512, checkpointHeight - h + 1);
          const rows = await this.batch(h, want);
          if (!rows.length) throw new Error(`batch provider returned no headers at ${h}`);
          for (const r of rows.slice(0, want)) {
            seed.push({ height: h, header: r.header, hash: r.hash });
            h++;
          }
        }
      } catch (e) {
        if (!this.hasHeaderSource) throw e;
        seed = [];
      }
    }
    if (!seed.length) {
      for (let h = start; h <= checkpointHeight; h++) {
        const { header, hash } = await this.provider(h);
        seed.push({ height: h, header, hash });
      }
    }
    this.seedTrusted(seed, checkpointHash);
  }
  /**
   * Offer a competing branch (contiguous headers starting one above a common ancestor we hold).
   * Verifies it from the ancestor; if its cumulative chainwork EXCEEDS our current tip, we roll
   * back to the ancestor and adopt it (max-work rule). Otherwise we keep our chain.
   */
  tryReorg(alt) {
    if (!alt.length) return { adopted: false, reason: "empty branch" };
    const ancestorHeight = alt[0].height - 1;
    const ancestor = this.at(ancestorHeight);
    if (!ancestor) return { adopted: false, reason: `no common ancestor at ${ancestorHeight}` };
    const verified = [];
    let prev = ancestor;
    const baseWindow = this.windowBefore(ancestorHeight + 1);
    const window = [...baseWindow];
    for (let i = 0; i < alt.length; i++) {
      const a = alt[i];
      if (a.height !== ancestorHeight + 1 + i) return { adopted: false, reason: "alt not contiguous" };
      let vh;
      try {
        vh = this.verifyOne(a.height, a.header, window, prev, a.hash);
      } catch (e) {
        return { adopted: false, reason: `alt invalid at ${a.height}: ${e?.message}` };
      }
      verified.push(vh);
      prev = vh;
      window.push(a.header);
      if (window.length > LWMA_WINDOW) window.shift();
    }
    const altTip = verified[verified.length - 1];
    if (altTip.chainwork <= this.chainwork) return { adopted: false, reason: `alt work ${altTip.chainwork} \u2264 current ${this.chainwork}` };
    const rolledBack = this.baseHeight + this.chain.length - 1 - ancestorHeight;
    this.chain.length = ancestorHeight - this.baseHeight + 1;
    for (const v of verified) this.chain.push(v);
    return { adopted: true, rolledBack, newTip: altTip.height };
  }
  /**
   * Verify a tx's inclusion against a verified header (merkle proof built from the block).
   *
   * SG-CONTENT-BIND-1: the merkle branch is folded over a txid RE-DERIVED from each tx BODY
   * (`codecTxid(rpcTxToTx(body))`), NEVER the server-reported `.txid` field. The txid commits to the
   * whole tx (incl. `app.payload_hash`), so a body whose recomputed id folds to the PoW-verified merkle
   * root is authentic byte-for-byte — a lying read path that swaps a body while keeping the reported
   * `.txid` re-derives to a different id and fails closed (it neither matches the requested txid nor
   * folds to the root). On a proven inclusion we SURFACE the proven tx (`tx`) and, for a Propose, its
   * committed `appPayloadHash`, so a caller can bind an offer's terms to the ON-CHAIN commitment
   * instead of a resolver-served `/proposal` (which the same routed backend controls). This mirrors the
   * shipped `verifyClaimSPV` block re-derivation (cairn swapguard.js), made canonical here for A1/B4.
   */
  async verifyTxInclusion(txidHex) {
    if (!this.client) return { trustLevel: "rpc-trusted", included: false, reason: "no client for proof fetch" };
    const t = await this.client.tx(txidHex);
    if (!t.ok || t.height == null) return { trustLevel: "rpc-trusted", included: false, reason: "tx not in a block (mempool/unknown)" };
    const height = t.height;
    let tipHeight = this.baseHeight + this.chain.length - 1;
    if (height < this.baseHeight) return { trustLevel: "rpc-trusted", included: false, reason: `tx below the synced base (${this.baseHeight})` };
    if (height > tipHeight) {
      const gap = height - tipHeight;
      if (gap > 256) return { trustLevel: "rpc-trusted", included: false, reason: `tx at ${height} is ${gap} blocks beyond tip \u2014 sync(${height}) first` };
      await this.sync(height);
      tipHeight = this.baseHeight + this.chain.length - 1;
    }
    const verified = this.at(height);
    if (!verified) return { trustLevel: "rpc-trusted", included: false, reason: "could not verify the containing header" };
    const b = await this.client.blockByHeight(height);
    const derivedIds = [];
    for (const jt of b.txs) {
      try {
        derivedIds.push(txid(rpcTxToTx(jt)));
      } catch {
        return { trustLevel: "rpc-trusted", included: false, reason: "undecodable tx in block (tampered read path)" };
      }
    }
    const pos = derivedIds.findIndex((x) => x.toLowerCase() === txidHex.toLowerCase());
    if (pos < 0) return { trustLevel: "rpc-trusted", included: false, reason: "tx body not found in block (or re-derived txid mismatch)" };
    const ok = verifyMerkleProof(derivedIds[pos], pos, merkleBranch(derivedIds, pos), verified.header.merkle);
    if (!ok) return { trustLevel: "rpc-trusted", included: false, reason: "merkle proof failed" };
    const provenTx = b.txs[pos];
    const appPayloadHash = provenTx.app.type === "Propose" ? provenTx.app.payload_hash : void 0;
    return { trustLevel: "verified-inclusion", included: true, blockHeight: height, confirmations: tipHeight - height + 1, tx: provenTx, appPayloadHash };
  }
  /**
   * Balance for an address. HONEST: `rpc-trusted` — a header chain cannot prove an output is still
   * unspent (no UTXO commitment). A future Neutrino-style scan would yield `trustLevel:'scanned'`.
   */
  async balance(addr) {
    if (!this.client) throw new Error("no client");
    const u = await this.client.utxos(addr);
    return { confirmed: u.confirmed_balance, trustLevel: "rpc-trusted", note: "balance is RPC-trusted; a header chain cannot prove non-spend (no UTXO commitment)" };
  }
  /**
   * Serialize the verified chain for persistence. A long-lived consumer (wallet, bridge differ)
   * snapshots on shutdown and `fromSnapshot`s on boot instead of re-fetching FULL BLOCK BODIES
   * for the whole window every restart (the default provider's per-header cost). Headers only —
   * tiny (≈100 bytes/height as JSON).
   */
  toSnapshot() {
    return {
      v: 1,
      baseHeight: this.baseHeight,
      headers: this.chain.map((c) => ({ height: c.height, hash: c.hash, header: c.header, chainwork: c.chainwork.toString(), trusted: c.trusted ?? false }))
    };
  }
  /**
   * Restore from a snapshot. The load RE-VERIFIES — hash recomputation, prev links, timestamp
   * rules, PoW on every header, AND `bits` re-derived from the LWMA window for every NON-trusted
   * (forward-synced) header, exactly as the live `sync`/`verifyOne` path accepted it. Only the
   * original seed window (`trusted`) skips the time/LWMA re-derivation — the same posture
   * `seedTrusted` allows for the checkpoint trade. A checkpoint-configured client additionally
   * refuses any snapshot (other than a genesis-rooted one, anchored by the H4 GENESIS_HASH check
   * below) unless a pinned checkpoint COVERS the whole trusted seed prefix — `baseHeight +
   * LWMA_WINDOW - 1 <= cp <= last` for some configured `cp` (see the containment block for why).
   * Without that, a poisoned snapshot could place forged min-difficulty headers inside the
   * LWMA-skipping prefix and restore them as verified (grindable at POW_LIMIT). With it, a
   * localStorage-poisoned snapshot is REJECTED here, not restored as verified. chainwork is
   * recomputed, never read from the file.
   */
  static fromSnapshot(s, opts = {}) {
    if (s.v !== 1 || !Array.isArray(s.headers) || !s.headers.length) throw new Error("bad snapshot");
    const lc = new _LightClient(opts);
    const pinnedHeights = Object.keys(lc.checkpoints).map(Number);
    if (pinnedHeights.length && s.baseHeight > 0) {
      const last = s.baseHeight + s.headers.length - 1;
      const anchored = pinnedHeights.some((cp) => s.baseHeight + LWMA_WINDOW - 1 <= cp && cp <= last);
      if (!anchored) {
        throw new Error(`snapshot not anchored: no checkpoint in [${s.baseHeight + LWMA_WINDOW - 1}..${last}] to cover the trusted seed prefix`);
      }
    }
    lc.baseHeight = s.baseHeight;
    let prevHash = null;
    let work = 0n;
    for (let i = 0; i < s.headers.length; i++) {
      const e = s.headers[i];
      if (e.height !== s.baseHeight + i) throw new Error(`snapshot not contiguous at ${e.height}`);
      const hash = headerHash(e.header);
      if (hash.toLowerCase() !== e.hash.toLowerCase()) throw new Error(`snapshot hash mismatch at ${e.height}`);
      if (i === 0 && s.baseHeight === 0) {
        if (hash.toLowerCase() !== GENESIS_HASH.toLowerCase()) throw new Error(`snapshot foreign genesis: ${hash}`);
        if (e.header.bits !== INITIAL_BITS) throw new Error("snapshot genesis bits != INITIAL_BITS");
      }
      if (prevHash && e.header.prev.toLowerCase() !== prevHash) throw new Error(`snapshot prev link broken at ${e.height}`);
      const fullWindowAvailable = e.height - s.baseHeight >= LWMA_WINDOW;
      if (e.height > 0 && (!e.trusted || fullWindowAvailable)) {
        const window = lc.windowBefore(e.height);
        const parent = lc.chain[i - 1];
        if (parent) lc.checkTimeRules(e.height, e.header, window, parent);
        const exp = expectedBitsFromWindow(window, e.height);
        if (e.header.bits !== exp) throw new Error(`snapshot bad bits at ${e.height}: ${e.header.bits.toString(16)} != LWMA ${exp.toString(16)}`);
      }
      if (!powOk(headerHashBytes(e.header), e.header.bits)) throw new Error(`snapshot PoW invalid at ${e.height}`);
      lc.pinCheckpoint(e.height, hash);
      work = satAddWork(work, e.header.bits);
      lc.chain.push({ height: e.height, hash, header: e.header, chainwork: work, ...e.trusted ? { trusted: true } : {} });
      prevHash = hash.toLowerCase();
    }
    return lc;
  }
};

// ../csd-sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/hmac.js
var HMAC = class extends Hash {
  constructor(hash, _key) {
    super();
    this.finished = false;
    this.destroyed = false;
    ahash(hash);
    const key = toBytes(_key);
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    abytes(out, this.outputLen);
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to || (to = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new HMAC(hash, key);

// ../csd-sdk/node_modules/.pnpm/@noble+curves@1.9.7/node_modules/@noble/curves/esm/utils.js
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
function _abool2(value, title = "") {
  if (typeof value !== "boolean") {
    const prefix = title && `"${title}"`;
    throw new Error(prefix + "expected boolean, got type=" + typeof value);
  }
  return value;
}
function _abytes2(value, length, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function numberToHexUnpadded(num) {
  const hex = num.toString(16);
  return hex.length & 1 ? "0" + hex : hex;
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  abytes(bytes);
  return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function ensureBytes(title, hex, expectedLength) {
  let res;
  if (typeof hex === "string") {
    try {
      res = hexToBytes(hex);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes(hex)) {
    res = Uint8Array.from(hex);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
var bitMask = (n) => (_1n << BigInt(n)) - _1n;
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  if (typeof hashLen !== "number" || hashLen < 2)
    throw new Error("hashLen must be a number");
  if (typeof qByteLen !== "number" || qByteLen < 2)
    throw new Error("qByteLen must be a number");
  if (typeof hmacFn !== "function")
    throw new Error("hmacFn must be a function");
  const u8n = (len) => new Uint8Array(len);
  const u8of = (byte) => Uint8Array.of(byte);
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...b) => hmacFn(k, v, ...b);
  const reseed = (seed = u8n(0)) => {
    k = h(u8of(0), seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(u8of(1), seed);
    v = h();
  };
  const gen = () => {
    if (i++ >= 1e3)
      throw new Error("drbg: tried 1000 values");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = void 0;
    while (!(res = pred(gen())))
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
function _validateObject(object, fields, optFields = {}) {
  if (!object || typeof object !== "object")
    throw new Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    const val = object[fieldName];
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
  Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
}
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// ../csd-sdk/node_modules/.pnpm/@noble+curves@1.9.7/node_modules/@noble/curves/esm/abstract/modular.js
var _0n2 = BigInt(0);
var _1n2 = BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  if (!Fp.eql(Fp.sqr(root), n))
    throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp, n) {
  const p1div4 = (Fp.ORDER + _1n2) / _4n;
  const root = Fp.pow(n, p1div4);
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const p5div8 = (Fp.ORDER - _5n) / _8n;
  const n2 = Fp.mul(n, _2n);
  const v = Fp.pow(n2, p5div8);
  const nv = Fp.mul(n, v);
  const i = Fp.mul(Fp.mul(nv, _2n), v);
  const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    let tv1 = Fp.pow(n, c4);
    let tv2 = Fp.mul(tv1, c1);
    const tv3 = Fp.mul(tv1, c2);
    const tv4 = Fp.mul(tv1, c3);
    const e1 = Fp.eql(Fp.sqr(tv2), n);
    const e2 = Fp.eql(Fp.sqr(tv3), n);
    tv1 = Fp.cmov(tv1, tv2, e1);
    tv2 = Fp.cmov(tv4, tv3, e2);
    const e3 = Fp.eql(Fp.sqr(tv2), n);
    const root = Fp.cmov(tv1, tv2, e3);
    assertIsSquare(Fp, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    if (Fp.is0(n))
      return n;
    if (FpLegendre(Fp, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp.mul(Fp.ONE, cc);
    let t = Fp.pow(n, Q);
    let R = Fp.pow(n, Q1div2);
    while (!Fp.eql(t, Fp.ONE)) {
      if (Fp.is0(t))
        return Fp.ZERO;
      let i = 1;
      let t_tmp = Fp.sqr(t);
      while (!Fp.eql(t_tmp, Fp.ONE)) {
        i++;
        t_tmp = Fp.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = Fp.pow(c, exponent);
      M = i;
      c = Fp.sqr(b);
      t = Fp.mul(t, c);
      R = Fp.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  _validateObject(field, opts);
  return field;
}
function FpPow(Fp, num, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp.ONE;
  if (power === _1n2)
    return num;
  let p = Fp.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp.mul(p, d);
    d = Fp.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = acc;
    return Fp.mul(acc, num);
  }, Fp.ONE);
  const invertedAcc = Fp.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = Fp.mul(acc, inverted[i]);
    return Fp.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  const p1mod2 = (Fp.ORDER - _1n2) / _2n;
  const powered = Fp.pow(n, p1mod2);
  const yes = Fp.eql(powered, Fp.ONE);
  const zero = Fp.eql(powered, Fp.ZERO);
  const no = Fp.eql(powered, Fp.neg(Fp.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, bitLenOrOpts, isLE = false, opts = {}) {
  if (ORDER <= _0n2)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  let _nbitLength = void 0;
  let _sqrt = void 0;
  let modFromBytes = false;
  let allowedLengths = void 0;
  if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {
    if (opts.sqrt || isLE)
      throw new Error("cannot specify opts in two arguments");
    const _opts = bitLenOrOpts;
    if (_opts.BITS)
      _nbitLength = _opts.BITS;
    if (_opts.sqrt)
      _sqrt = _opts.sqrt;
    if (typeof _opts.isLE === "boolean")
      isLE = _opts.isLE;
    if (typeof _opts.modFromBytes === "boolean")
      modFromBytes = _opts.modFromBytes;
    allowedLengths = _opts.allowedLengths;
  } else {
    if (typeof bitLenOrOpts === "number")
      _nbitLength = bitLenOrOpts;
    if (opts.sqrt)
      _sqrt = opts.sqrt;
  }
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n2,
    ONE: _1n2,
    allowedLengths,
    create: (num) => mod(num, ORDER),
    isValid: (num) => {
      if (typeof num !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num);
      return _0n2 <= num && num < ORDER;
    },
    is0: (num) => num === _0n2,
    // is valid and invertible
    isValidNot0: (num) => !f.is0(num) && f.isValid(num),
    isOdd: (num) => (num & _1n2) === _1n2,
    neg: (num) => mod(-num, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num) => mod(num * num, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num, power) => FpPow(f, num, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    // Same as above, but doesn't normalize
    sqrN: (num) => num * num,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num) => invert(num, ORDER),
    sqrt: _sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    toBytes: (num) => isLE ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
    fromBytes: (bytes, skipValidation = true) => {
      if (allowedLengths) {
        if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
          throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
        }
        const padded = new Uint8Array(BYTES);
        padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
        bytes = padded;
      }
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
      if (modFromBytes)
        scalar = mod(scalar, ORDER);
      if (!skipValidation) {
        if (!f.isValid(scalar))
          throw new Error("invalid field element: outside of range 0..ORDER");
      }
      return scalar;
    },
    // TODO: we don't need it here, move out to separate fn
    invertBatch: (lst) => FpInvertBatch(f, lst),
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov: (a, b, c) => c ? b : a
  });
  return Object.freeze(f);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE = false) {
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// ../csd-sdk/node_modules/.pnpm/@noble+curves@1.9.7/node_modules/@noble/curves/esm/abstract/curve.js
var _0n3 = BigInt(0);
var _1n3 = BigInt(1);
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3)
    throw new Error("invalid wNAF");
}
var wNAF = class {
  // Parametrized with a given Point class (not individual point)
  constructor(Point, bits) {
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.Fn = Point.Fn;
    this.bits = bits;
  }
  // non-const time multiplication ladder
  _unsafeLadder(elm, n, p = this.ZERO) {
    let d = elm;
    while (n > _0n3) {
      if (n & _1n3)
        p = p.add(d);
      d = d.double();
      n >>= _1n3;
    }
    return p;
  }
  /**
   * Creates a wNAF precomputation window. Used for caching.
   * Default window size is set by `utils.precompute()` and is equal to 8.
   * Number of precomputed points depends on the curve size:
   * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
   * - 𝑊 is the window size
   * - 𝑛 is the bitlength of the curve order.
   * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
   * @param point Point instance
   * @param W window size
   * @returns precomputed point tables flattened to a single array
   */
  precomputeWindow(point, W) {
    const { windows, windowSize } = calcWOpts(W, this.bits);
    const points = [];
    let p = point;
    let base = p;
    for (let window = 0; window < windows; window++) {
      base = p;
      points.push(base);
      for (let i = 1; i < windowSize; i++) {
        base = base.add(p);
        points.push(base);
      }
      p = base.double();
    }
    return points;
  }
  /**
   * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
   * More compact implementation:
   * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
   * @returns real and fake (for const-time) points
   */
  wNAF(W, precomputes, n) {
    if (!this.Fn.isValid(n))
      throw new Error("invalid scalar");
    let p = this.ZERO;
    let f = this.BASE;
    const wo = calcWOpts(W, this.bits);
    for (let window = 0; window < wo.windows; window++) {
      const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        f = f.add(negateCt(isNegF, precomputes[offsetF]));
      } else {
        p = p.add(negateCt(isNeg, precomputes[offset]));
      }
    }
    assert0(n);
    return { p, f };
  }
  /**
   * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
   * @param acc accumulator point to add result of multiplication
   * @returns point
   */
  wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
    const wo = calcWOpts(W, this.bits);
    for (let window = 0; window < wo.windows; window++) {
      if (n === _0n3)
        break;
      const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        continue;
      } else {
        const item = precomputes[offset];
        acc = acc.add(isNeg ? item.negate() : item);
      }
    }
    assert0(n);
    return acc;
  }
  getPrecomputes(W, point, transform) {
    let comp = pointPrecomputes.get(point);
    if (!comp) {
      comp = this.precomputeWindow(point, W);
      if (W !== 1) {
        if (typeof transform === "function")
          comp = transform(comp);
        pointPrecomputes.set(point, comp);
      }
    }
    return comp;
  }
  cached(point, scalar, transform) {
    const W = getW(point);
    return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
  }
  unsafe(point, scalar, transform, prev) {
    const W = getW(point);
    if (W === 1)
      return this._unsafeLadder(point, scalar, prev);
    return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
  }
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  createCache(P, W) {
    validateW(W, this.bits);
    pointWindowSizes.set(P, W);
    pointPrecomputes.delete(P);
  }
  hasCache(elm) {
    return getW(elm) !== 1;
  }
};
function mulEndoUnsafe(Point, point, k1, k2) {
  let acc = point;
  let p1 = Point.ZERO;
  let p2 = Point.ZERO;
  while (k1 > _0n3 || k2 > _0n3) {
    if (k1 & _1n3)
      p1 = p1.add(acc);
    if (k2 & _1n3)
      p2 = p2.add(acc);
    acc = acc.double();
    k1 >>= _1n3;
    k2 >>= _1n3;
  }
  return { p1, p2 };
}
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  const plength = points.length;
  const slength = scalars.length;
  if (plength !== slength)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(plength));
  let windowSize = 1;
  if (wbits > 12)
    windowSize = wbits - 3;
  else if (wbits > 4)
    windowSize = wbits - 2;
  else if (wbits > 0)
    windowSize = 2;
  const MASK = bitMask(windowSize);
  const buckets = new Array(Number(MASK) + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits; i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0; j < slength; j++) {
      const scalar = scalars[j];
      const wbits2 = Number(scalar >> BigInt(i) & MASK);
      buckets[wbits2] = buckets[wbits2].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0; j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function _createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}

// ../csd-sdk/node_modules/.pnpm/@noble+curves@1.9.7/node_modules/@noble/curves/esm/abstract/weierstrass.js
var divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n2) / den;
function _splitEndoScalar(k, basis, n) {
  const [[a1, b1], [a2, b2]] = basis;
  const c1 = divNearest(b2 * k, n);
  const c2 = divNearest(-b1 * k, n);
  let k1 = k - c1 * a1 - c2 * a2;
  let k2 = -c1 * b1 - c2 * b2;
  const k1neg = k1 < _0n4;
  const k2neg = k2 < _0n4;
  if (k1neg)
    k1 = -k1;
  if (k2neg)
    k2 = -k2;
  const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
  if (k1 < _0n4 || k1 >= MAX_NUM || k2 < _0n4 || k2 >= MAX_NUM) {
    throw new Error("splitScalar (endomorphism): failed, k=" + k);
  }
  return { k1neg, k1, k2neg, k2 };
}
function validateSigFormat(format) {
  if (!["compact", "recovered", "der"].includes(format))
    throw new Error('Signature format must be "compact", "recovered", or "der"');
  return format;
}
function validateSigOpts(opts, def) {
  const optsn = {};
  for (let optName of Object.keys(def)) {
    optsn[optName] = opts[optName] === void 0 ? def[optName] : opts[optName];
  }
  _abool2(optsn.lowS, "lowS");
  _abool2(optsn.prehash, "prehash");
  if (optsn.format !== void 0)
    validateSigFormat(optsn.format);
  return optsn;
}
var DERErr = class extends Error {
  constructor(m = "") {
    super(m);
  }
};
var DER = {
  // asn.1 DER encoding utils
  Err: DERErr,
  // Basic building block is TLV (Tag-Length-Value)
  _tlv: {
    encode: (tag, data) => {
      const { Err: E } = DER;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length & 1)
        throw new E("tlv.encode: unpadded data");
      const dataLen = data.length / 2;
      const len = numberToHexUnpadded(dataLen);
      if (len.length / 2 & 128)
        throw new E("tlv.encode: long form length too big");
      const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
      const t = numberToHexUnpadded(tag);
      return t + lenLen + len + data;
    },
    // v - value, l - left bytes (unparsed)
    decode(tag, data) {
      const { Err: E } = DER;
      let pos = 0;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length < 2 || data[pos++] !== tag)
        throw new E("tlv.decode: wrong tlv");
      const first = data[pos++];
      const isLong = !!(first & 128);
      let length = 0;
      if (!isLong)
        length = first;
      else {
        const lenLen = first & 127;
        if (!lenLen)
          throw new E("tlv.decode(long): indefinite length not supported");
        if (lenLen > 4)
          throw new E("tlv.decode(long): byte length is too big");
        const lengthBytes = data.subarray(pos, pos + lenLen);
        if (lengthBytes.length !== lenLen)
          throw new E("tlv.decode: length bytes not complete");
        if (lengthBytes[0] === 0)
          throw new E("tlv.decode(long): zero leftmost byte");
        for (const b of lengthBytes)
          length = length << 8 | b;
        pos += lenLen;
        if (length < 128)
          throw new E("tlv.decode(long): not minimal encoding");
      }
      const v = data.subarray(pos, pos + length);
      if (v.length !== length)
        throw new E("tlv.decode: wrong value length");
      return { v, l: data.subarray(pos + length) };
    }
  },
  // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
  // since we always use positive integers here. It must always be empty:
  // - add zero byte if exists
  // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
  _int: {
    encode(num) {
      const { Err: E } = DER;
      if (num < _0n4)
        throw new E("integer: negative integers are not allowed");
      let hex = numberToHexUnpadded(num);
      if (Number.parseInt(hex[0], 16) & 8)
        hex = "00" + hex;
      if (hex.length & 1)
        throw new E("unexpected DER parsing assertion: unpadded hex");
      return hex;
    },
    decode(data) {
      const { Err: E } = DER;
      if (data[0] & 128)
        throw new E("invalid signature integer: negative");
      if (data[0] === 0 && !(data[1] & 128))
        throw new E("invalid signature integer: unnecessary leading zero");
      return bytesToNumberBE(data);
    }
  },
  toSig(hex) {
    const { Err: E, _int: int, _tlv: tlv } = DER;
    const data = ensureBytes("signature", hex);
    const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
    if (seqLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
    const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
    if (sLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    return { r: int.decode(rBytes), s: int.decode(sBytes) };
  },
  hexFromSig(sig) {
    const { _tlv: tlv, _int: int } = DER;
    const rs = tlv.encode(2, int.encode(sig.r));
    const ss = tlv.encode(2, int.encode(sig.s));
    const seq = rs + ss;
    return tlv.encode(48, seq);
  }
};
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
var _2n2 = BigInt(2);
var _3n2 = BigInt(3);
var _4n2 = BigInt(4);
function _normFnElement(Fn, key) {
  const { BYTES: expected } = Fn;
  let num;
  if (typeof key === "bigint") {
    num = key;
  } else {
    let bytes = ensureBytes("private key", key);
    try {
      num = Fn.fromBytes(bytes);
    } catch (error) {
      throw new Error(`invalid private key: expected ui8a of size ${expected}, got ${typeof key}`);
    }
  }
  if (!Fn.isValidNot0(num))
    throw new Error("invalid private key: out of range [1..N-1]");
  return num;
}
function weierstrassN(params, extraOpts = {}) {
  const validated = _createCurveFields("weierstrass", params, extraOpts);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor, n: CURVE_ORDER } = CURVE;
  _validateObject(extraOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object",
    wrapPrivateKey: "boolean"
  });
  const { endo } = extraOpts;
  if (endo) {
    if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {
      throw new Error('invalid endo: expected "beta": bigint and "basises": array');
    }
  }
  const lengths = getWLengths(Fp, Fn);
  function assertCompressionIsSupported() {
    if (!Fp.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes(_c, point, isCompressed) {
    const { x, y } = point.toAffine();
    const bx = Fp.toBytes(x);
    _abool2(isCompressed, "isCompressed");
    if (isCompressed) {
      assertCompressionIsSupported();
      const hasEvenY = !Fp.isOdd(y);
      return concatBytes(pprefix(hasEvenY), bx);
    } else {
      return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));
    }
  }
  function pointFromBytes(bytes) {
    _abytes2(bytes, void 0, "Point");
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    const length = bytes.length;
    const head = bytes[0];
    const tail = bytes.subarray(1);
    if (length === comp && (head === 2 || head === 3)) {
      const x = Fp.fromBytes(tail);
      if (!Fp.isValid(x))
        throw new Error("bad point: is not on curve, wrong x");
      const y2 = weierstrassEquation(x);
      let y;
      try {
        y = Fp.sqrt(y2);
      } catch (sqrtError) {
        const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      const isYOdd = Fp.isOdd(y);
      const isHeadOdd = (head & 1) === 1;
      if (isHeadOdd !== isYOdd)
        y = Fp.neg(y);
      return { x, y };
    } else if (length === uncomp && head === 4) {
      const L = Fp.BYTES;
      const x = Fp.fromBytes(tail.subarray(0, L));
      const y = Fp.fromBytes(tail.subarray(L, L * 2));
      if (!isValidXY(x, y))
        throw new Error("bad point: is not on curve");
      return { x, y };
    } else {
      throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
    }
  }
  const encodePoint = extraOpts.toBytes || pointToBytes;
  const decodePoint = extraOpts.fromBytes || pointFromBytes;
  function weierstrassEquation(x) {
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
  }
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function acoord(title, n, banZero = false) {
    if (!Fp.isValid(n) || banZero && Fp.is0(n))
      throw new Error(`bad point coordinate ${title}`);
    return n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ProjectivePoint expected");
  }
  function splitEndoScalarN(k) {
    if (!endo || !endo.basises)
      throw new Error("no endo");
    return _splitEndoScalar(k, endo.basises, Fn.ORDER);
  }
  const toAffineMemo = memoized((p, iz) => {
    const { X, Y, Z } = p;
    if (Fp.eql(Z, Fp.ONE))
      return { x: X, y: Y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(Z);
    const x = Fp.mul(X, iz);
    const y = Fp.mul(Y, iz);
    const zz = Fp.mul(Z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw new Error("invZ was invalid");
    return { x, y };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw new Error("bad point: x or y not field elements");
    if (!isValidXY(x, y))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
    k2p = new Point(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
    k1p = negateCt(k1neg, k1p);
    k2p = negateCt(k2neg, k2p);
    return k1p.add(k2p);
  }
  class Point {
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    constructor(X, Y, Z) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y, true);
      this.Z = acoord("z", Z);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      if (Fp.is0(x) && Fp.is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    static fromBytes(bytes) {
      const P = Point.fromAffine(decodePoint(_abytes2(bytes, void 0, "point")));
      P.assertValidity();
      return P;
    }
    static fromHex(hex) {
      return Point.fromBytes(ensureBytes("pointHex", hex));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
     *
     * @param windowSize
     * @param isLazy true will defer table computation until the first multiplication
     * @returns
     */
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy)
        this.multiply(_3n2);
      return this;
    }
    // TODO: return `this`
    /** A point on curve is valid if it conforms to equation. */
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (!Fp.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !Fp.isOdd(y);
    }
    /** Compare one point to another. */
    equals(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
    negate() {
      return new Point(this.X, Fp.neg(this.Y), this.Z);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n2);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n2);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    /**
     * Constant time multiplication.
     * Uses wNAF method. Windowed method may be 10% faster,
     * but takes 2x longer to generate and consumes 2x memory.
     * Uses precomputes when available.
     * Uses endomorphism for Koblitz curves.
     * @param scalar by which the point would be multiplied
     * @returns New point
     */
    multiply(scalar) {
      const { endo: endo2 } = extraOpts;
      if (!Fn.isValidNot0(scalar))
        throw new Error("invalid scalar: out of range");
      let point, fake;
      const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point, p));
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
        const { p: k1p, f: k1f } = mul(k1);
        const { p: k2p, f: k2f } = mul(k2);
        fake = k1f.add(k2f);
        point = finishEndo(endo2.beta, k1p, k2p, k1neg, k2neg);
      } else {
        const { p, f } = mul(scalar);
        point = p;
        fake = f;
      }
      return normalizeZ(Point, [point, fake])[0];
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed secret key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(sc) {
      const { endo: endo2 } = extraOpts;
      const p = this;
      if (!Fn.isValid(sc))
        throw new Error("invalid scalar: out of range");
      if (sc === _0n4 || p.is0())
        return Point.ZERO;
      if (sc === _1n4)
        return p;
      if (wnaf.hasCache(this))
        return this.multiply(sc);
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
        const { p1, p2 } = mulEndoUnsafe(Point, p, k1, k2);
        return finishEndo(endo2.beta, p1, p2, k1neg, k2neg);
      } else {
        return wnaf.unsafe(p, sc);
      }
    }
    multiplyAndAddUnsafe(Q, a, b) {
      const sum = this.multiplyUnsafe(a).add(Q.multiplyUnsafe(b));
      return sum.is0() ? void 0 : sum;
    }
    /**
     * Converts Projective point to affine (x, y) coordinates.
     * @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
     */
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    /**
     * Checks whether Point is free of torsion elements (is in prime subgroup).
     * Always torsion-free for cofactor=1 curves.
     */
    isTorsionFree() {
      const { isTorsionFree } = extraOpts;
      if (cofactor === _1n4)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      return wnaf.unsafe(this, CURVE_ORDER).is0();
    }
    clearCofactor() {
      const { clearCofactor } = extraOpts;
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(cofactor);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    toBytes(isCompressed = true) {
      _abool2(isCompressed, "isCompressed");
      this.assertValidity();
      return encodePoint(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      return bytesToHex(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
    // TODO: remove
    get px() {
      return this.X;
    }
    get py() {
      return this.X;
    }
    get pz() {
      return this.Z;
    }
    toRawBytes(isCompressed = true) {
      return this.toBytes(isCompressed);
    }
    _setWindowSize(windowSize) {
      this.precompute(windowSize);
    }
    static normalizeZ(points) {
      return normalizeZ(Point, points);
    }
    static msm(points, scalars) {
      return pippenger(Point, Fn, points, scalars);
    }
    static fromPrivateKey(privateKey) {
      return Point.BASE.multiply(_normFnElement(Fn, privateKey));
    }
  }
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
  Point.ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
  Point.Fp = Fp;
  Point.Fn = Fn;
  const bits = Fn.BITS;
  const wnaf = new wNAF(Point, extraOpts.endo ? Math.ceil(bits / 2) : bits);
  Point.BASE.precompute(8);
  return Point;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function getWLengths(Fp, Fn) {
  return {
    secretKey: Fn.BYTES,
    publicKey: 1 + Fp.BYTES,
    publicKeyUncompressed: 1 + 2 * Fp.BYTES,
    publicKeyHasPrefix: true,
    signature: 2 * Fn.BYTES
  };
}
function ecdh(Point, ecdhOpts = {}) {
  const { Fn } = Point;
  const randomBytes_ = ecdhOpts.randomBytes || randomBytes;
  const lengths = Object.assign(getWLengths(Point.Fp, Fn), { seed: getMinHashLength(Fn.ORDER) });
  function isValidSecretKey(secretKey) {
    try {
      return !!_normFnElement(Fn, secretKey);
    } catch (error) {
      return false;
    }
  }
  function isValidPublicKey(publicKey, isCompressed) {
    const { publicKey: comp, publicKeyUncompressed } = lengths;
    try {
      const l = publicKey.length;
      if (isCompressed === true && l !== comp)
        return false;
      if (isCompressed === false && l !== publicKeyUncompressed)
        return false;
      return !!Point.fromBytes(publicKey);
    } catch (error) {
      return false;
    }
  }
  function randomSecretKey(seed = randomBytes_(lengths.seed)) {
    return mapHashToField(_abytes2(seed, lengths.seed, "seed"), Fn.ORDER);
  }
  function getPublicKey(secretKey, isCompressed = true) {
    return Point.BASE.multiply(_normFnElement(Fn, secretKey)).toBytes(isCompressed);
  }
  function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  }
  function isProbPub(item) {
    if (typeof item === "bigint")
      return false;
    if (item instanceof Point)
      return true;
    const { secretKey, publicKey, publicKeyUncompressed } = lengths;
    if (Fn.allowedLengths || secretKey === publicKey)
      return void 0;
    const l = ensureBytes("key", item).length;
    return l === publicKey || l === publicKeyUncompressed;
  }
  function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
    if (isProbPub(secretKeyA) === true)
      throw new Error("first arg must be private key");
    if (isProbPub(publicKeyB) === false)
      throw new Error("second arg must be public key");
    const s = _normFnElement(Fn, secretKeyA);
    const b = Point.fromHex(publicKeyB);
    return b.multiply(s).toBytes(isCompressed);
  }
  const utils = {
    isValidSecretKey,
    isValidPublicKey,
    randomSecretKey,
    // TODO: remove
    isValidPrivateKey: isValidSecretKey,
    randomPrivateKey: randomSecretKey,
    normPrivateKeyToScalar: (key) => _normFnElement(Fn, key),
    precompute(windowSize = 8, point = Point.BASE) {
      return point.precompute(windowSize, false);
    }
  };
  return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point, utils, lengths });
}
function ecdsa(Point, hash, ecdsaOpts = {}) {
  ahash(hash);
  _validateObject(ecdsaOpts, {}, {
    hmac: "function",
    lowS: "boolean",
    randomBytes: "function",
    bits2int: "function",
    bits2int_modN: "function"
  });
  const randomBytes2 = ecdsaOpts.randomBytes || randomBytes;
  const hmac2 = ecdsaOpts.hmac || ((key, ...msgs) => hmac(hash, key, concatBytes(...msgs)));
  const { Fp, Fn } = Point;
  const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;
  const { keygen, getPublicKey, getSharedSecret, utils, lengths } = ecdh(Point, ecdsaOpts);
  const defaultSigOpts = {
    prehash: false,
    lowS: typeof ecdsaOpts.lowS === "boolean" ? ecdsaOpts.lowS : false,
    format: void 0,
    //'compact' as ECDSASigFormat,
    extraEntropy: false
  };
  const defaultSigOpts_format = "compact";
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n4;
    return number > HALF;
  }
  function validateRS(title, num) {
    if (!Fn.isValidNot0(num))
      throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
    return num;
  }
  function validateSigLength(bytes, format) {
    validateSigFormat(format);
    const size = lengths.signature;
    const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : void 0;
    return _abytes2(bytes, sizer, `${format} signature`);
  }
  class Signature {
    constructor(r, s, recovery) {
      this.r = validateRS("r", r);
      this.s = validateRS("s", s);
      if (recovery != null)
        this.recovery = recovery;
      Object.freeze(this);
    }
    static fromBytes(bytes, format = defaultSigOpts_format) {
      validateSigLength(bytes, format);
      let recid;
      if (format === "der") {
        const { r: r2, s: s2 } = DER.toSig(_abytes2(bytes));
        return new Signature(r2, s2);
      }
      if (format === "recovered") {
        recid = bytes[0];
        format = "compact";
        bytes = bytes.subarray(1);
      }
      const L = Fn.BYTES;
      const r = bytes.subarray(0, L);
      const s = bytes.subarray(L, L * 2);
      return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);
    }
    static fromHex(hex, format) {
      return this.fromBytes(hexToBytes(hex), format);
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    recoverPublicKey(messageHash) {
      const FIELD_ORDER = Fp.ORDER;
      const { r, s, recovery: rec } = this;
      if (rec == null || ![0, 1, 2, 3].includes(rec))
        throw new Error("recovery id invalid");
      const hasCofactor = CURVE_ORDER * _2n2 < FIELD_ORDER;
      if (hasCofactor && rec > 1)
        throw new Error("recovery id is ambiguous for h>1 curve");
      const radj = rec === 2 || rec === 3 ? r + CURVE_ORDER : r;
      if (!Fp.isValid(radj))
        throw new Error("recovery id 2 or 3 invalid");
      const x = Fp.toBytes(radj);
      const R = Point.fromBytes(concatBytes(pprefix((rec & 1) === 0), x));
      const ir = Fn.inv(radj);
      const h = bits2int_modN(ensureBytes("msgHash", messageHash));
      const u1 = Fn.create(-h * ir);
      const u2 = Fn.create(s * ir);
      const Q = Point.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));
      if (Q.is0())
        throw new Error("point at infinify");
      Q.assertValidity();
      return Q;
    }
    // Signatures should be low-s, to prevent malleability.
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    toBytes(format = defaultSigOpts_format) {
      validateSigFormat(format);
      if (format === "der")
        return hexToBytes(DER.hexFromSig(this));
      const r = Fn.toBytes(this.r);
      const s = Fn.toBytes(this.s);
      if (format === "recovered") {
        if (this.recovery == null)
          throw new Error("recovery bit must be present");
        return concatBytes(Uint8Array.of(this.recovery), r, s);
      }
      return concatBytes(r, s);
    }
    toHex(format) {
      return bytesToHex(this.toBytes(format));
    }
    // TODO: remove
    assertValidity() {
    }
    static fromCompact(hex) {
      return Signature.fromBytes(ensureBytes("sig", hex), "compact");
    }
    static fromDER(hex) {
      return Signature.fromBytes(ensureBytes("sig", hex), "der");
    }
    normalizeS() {
      return this.hasHighS() ? new Signature(this.r, Fn.neg(this.s), this.recovery) : this;
    }
    toDERRawBytes() {
      return this.toBytes("der");
    }
    toDERHex() {
      return bytesToHex(this.toBytes("der"));
    }
    toCompactRawBytes() {
      return this.toBytes("compact");
    }
    toCompactHex() {
      return bytesToHex(this.toBytes("compact"));
    }
  }
  const bits2int = ecdsaOpts.bits2int || function bits2int_def(bytes) {
    if (bytes.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes);
    const delta = bytes.length * 8 - fnBits;
    return delta > 0 ? num >> BigInt(delta) : num;
  };
  const bits2int_modN = ecdsaOpts.bits2int_modN || function bits2int_modN_def(bytes) {
    return Fn.create(bits2int(bytes));
  };
  const ORDER_MASK = bitMask(fnBits);
  function int2octets(num) {
    aInRange("num < 2^" + fnBits, num, _0n4, ORDER_MASK);
    return Fn.toBytes(num);
  }
  function validateMsgAndHash(message, prehash) {
    _abytes2(message, void 0, "message");
    return prehash ? _abytes2(hash(message), void 0, "prehashed message") : message;
  }
  function prepSig(message, privateKey, opts) {
    if (["recovered", "canonical"].some((k) => k in opts))
      throw new Error("sign() legacy options not supported");
    const { lowS, prehash, extraEntropy } = validateSigOpts(opts, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    const h1int = bits2int_modN(message);
    const d = _normFnElement(Fn, privateKey);
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (extraEntropy != null && extraEntropy !== false) {
      const e = extraEntropy === true ? randomBytes2(lengths.secretKey) : extraEntropy;
      seedArgs.push(ensureBytes("extraEntropy", e));
    }
    const seed = concatBytes(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!Fn.isValidNot0(k))
        return;
      const ik = Fn.inv(k);
      const q = Point.BASE.multiply(k).toAffine();
      const r = Fn.create(q.x);
      if (r === _0n4)
        return;
      const s = Fn.create(ik * Fn.create(m + r * d));
      if (s === _0n4)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n4);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = Fn.neg(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, recovery);
    }
    return { seed, k2sig };
  }
  function sign(message, secretKey, opts = {}) {
    message = ensureBytes("message", message);
    const { seed, k2sig } = prepSig(message, secretKey, opts);
    const drbg = createHmacDrbg(hash.outputLen, Fn.BYTES, hmac2);
    const sig = drbg(seed, k2sig);
    return sig;
  }
  function tryParsingSig(sg) {
    let sig = void 0;
    const isHex = typeof sg === "string" || isBytes(sg);
    const isObj = !isHex && sg !== null && typeof sg === "object" && typeof sg.r === "bigint" && typeof sg.s === "bigint";
    if (!isHex && !isObj)
      throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
    if (isObj) {
      sig = new Signature(sg.r, sg.s);
    } else if (isHex) {
      try {
        sig = Signature.fromBytes(ensureBytes("sig", sg), "der");
      } catch (derError) {
        if (!(derError instanceof DER.Err))
          throw derError;
      }
      if (!sig) {
        try {
          sig = Signature.fromBytes(ensureBytes("sig", sg), "compact");
        } catch (error) {
          return false;
        }
      }
    }
    if (!sig)
      return false;
    return sig;
  }
  function verify(signature, message, publicKey, opts = {}) {
    const { lowS, prehash, format } = validateSigOpts(opts, defaultSigOpts);
    publicKey = ensureBytes("publicKey", publicKey);
    message = validateMsgAndHash(ensureBytes("message", message), prehash);
    if ("strict" in opts)
      throw new Error("options.strict was renamed to lowS");
    const sig = format === void 0 ? tryParsingSig(signature) : Signature.fromBytes(ensureBytes("sig", signature), format);
    if (sig === false)
      return false;
    try {
      const P = Point.fromBytes(publicKey);
      if (lowS && sig.hasHighS())
        return false;
      const { r, s } = sig;
      const h = bits2int_modN(message);
      const is = Fn.inv(s);
      const u1 = Fn.create(h * is);
      const u2 = Fn.create(r * is);
      const R = Point.BASE.multiplyUnsafe(u1).add(P.multiplyUnsafe(u2));
      if (R.is0())
        return false;
      const v = Fn.create(R.x);
      return v === r;
    } catch (e) {
      return false;
    }
  }
  function recoverPublicKey(signature, message, opts = {}) {
    const { prehash } = validateSigOpts(opts, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
  }
  return Object.freeze({
    keygen,
    getPublicKey,
    getSharedSecret,
    utils,
    lengths,
    Point,
    sign,
    verify,
    recoverPublicKey,
    Signature,
    hash
  });
}
function _weierstrass_legacy_opts_to_new(c) {
  const CURVE = {
    a: c.a,
    b: c.b,
    p: c.Fp.ORDER,
    n: c.n,
    h: c.h,
    Gx: c.Gx,
    Gy: c.Gy
  };
  const Fp = c.Fp;
  let allowedLengths = c.allowedPrivateKeyLengths ? Array.from(new Set(c.allowedPrivateKeyLengths.map((l) => Math.ceil(l / 2)))) : void 0;
  const Fn = Field(CURVE.n, {
    BITS: c.nBitLength,
    allowedLengths,
    modFromBytes: c.wrapPrivateKey
  });
  const curveOpts = {
    Fp,
    Fn,
    allowInfinityPoint: c.allowInfinityPoint,
    endo: c.endo,
    isTorsionFree: c.isTorsionFree,
    clearCofactor: c.clearCofactor,
    fromBytes: c.fromBytes,
    toBytes: c.toBytes
  };
  return { CURVE, curveOpts };
}
function _ecdsa_legacy_opts_to_new(c) {
  const { CURVE, curveOpts } = _weierstrass_legacy_opts_to_new(c);
  const ecdsaOpts = {
    hmac: c.hmac,
    randomBytes: c.randomBytes,
    lowS: c.lowS,
    bits2int: c.bits2int,
    bits2int_modN: c.bits2int_modN
  };
  return { CURVE, curveOpts, hash: c.hash, ecdsaOpts };
}
function _ecdsa_new_output_to_legacy(c, _ecdsa) {
  const Point = _ecdsa.Point;
  return Object.assign({}, _ecdsa, {
    ProjectivePoint: Point,
    CURVE: Object.assign({}, c, nLength(Point.Fn.ORDER, Point.Fn.BITS))
  });
}
function weierstrass(c) {
  const { CURVE, curveOpts, hash, ecdsaOpts } = _ecdsa_legacy_opts_to_new(c);
  const Point = weierstrassN(CURVE, curveOpts);
  const signs = ecdsa(Point, hash, ecdsaOpts);
  return _ecdsa_new_output_to_legacy(c, signs);
}

// ../csd-sdk/node_modules/.pnpm/@noble+curves@1.9.7/node_modules/@noble/curves/esm/_shortw_utils.js
function createCurve(curveDef, defHash) {
  const create = (hash) => weierstrass({ ...curveDef, hash });
  return { ...create(defHash), create };
}

// ../csd-sdk/node_modules/.pnpm/@noble+curves@1.9.7/node_modules/@noble/curves/esm/secp256k1.js
var secp256k1_CURVE = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
};
var secp256k1_ENDO = {
  beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
  basises: [
    [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
    [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
  ]
};
var _2n3 = /* @__PURE__ */ BigInt(2);
function sqrtMod(y) {
  const P = secp256k1_CURVE.p;
  const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow2(b3, _3n3, P) * b3 % P;
  const b9 = pow2(b6, _3n3, P) * b3 % P;
  const b11 = pow2(b9, _2n3, P) * b2 % P;
  const b22 = pow2(b11, _11n, P) * b11 % P;
  const b44 = pow2(b22, _22n, P) * b22 % P;
  const b88 = pow2(b44, _44n, P) * b44 % P;
  const b176 = pow2(b88, _88n, P) * b88 % P;
  const b220 = pow2(b176, _44n, P) * b44 % P;
  const b223 = pow2(b220, _3n3, P) * b3 % P;
  const t1 = pow2(b223, _23n, P) * b22 % P;
  const t2 = pow2(t1, _6n, P) * b2 % P;
  const root = pow2(t2, _2n3, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw new Error("Cannot find square root");
  return root;
}
var Fpk1 = Field(secp256k1_CURVE.p, { sqrt: sqrtMod });
var secp256k1 = createCurve({ ...secp256k1_CURVE, Fp: Fpk1, lowS: true, endo: secp256k1_ENDO }, sha256);

// ../csd-sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/legacy.js
var Rho160 = /* @__PURE__ */ Uint8Array.from([
  7,
  4,
  13,
  1,
  10,
  6,
  15,
  3,
  12,
  0,
  9,
  5,
  2,
  14,
  11,
  8
]);
var Id160 = /* @__PURE__ */ (() => Uint8Array.from(new Array(16).fill(0).map((_, i) => i)))();
var Pi160 = /* @__PURE__ */ (() => Id160.map((i) => (9 * i + 5) % 16))();
var idxLR = /* @__PURE__ */ (() => {
  const L = [Id160];
  const R = [Pi160];
  const res = [L, R];
  for (let i = 0; i < 4; i++)
    for (let j of res)
      j.push(j[i].map((k) => Rho160[k]));
  return res;
})();
var idxL = /* @__PURE__ */ (() => idxLR[0])();
var idxR = /* @__PURE__ */ (() => idxLR[1])();
var shifts160 = /* @__PURE__ */ [
  [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
  [12, 13, 11, 15, 6, 9, 9, 7, 12, 15, 11, 13, 7, 8, 7, 7],
  [13, 15, 14, 11, 7, 7, 6, 8, 13, 14, 13, 12, 5, 5, 6, 9],
  [14, 11, 12, 14, 8, 6, 5, 5, 15, 12, 15, 14, 9, 9, 8, 6],
  [15, 12, 13, 13, 9, 5, 8, 6, 14, 11, 12, 11, 8, 6, 5, 5]
].map((i) => Uint8Array.from(i));
var shiftsL160 = /* @__PURE__ */ idxL.map((idx, i) => idx.map((j) => shifts160[i][j]));
var shiftsR160 = /* @__PURE__ */ idxR.map((idx, i) => idx.map((j) => shifts160[i][j]));
var Kl160 = /* @__PURE__ */ Uint32Array.from([
  0,
  1518500249,
  1859775393,
  2400959708,
  2840853838
]);
var Kr160 = /* @__PURE__ */ Uint32Array.from([
  1352829926,
  1548603684,
  1836072691,
  2053994217,
  0
]);
function ripemd_f(group, x, y, z) {
  if (group === 0)
    return x ^ y ^ z;
  if (group === 1)
    return x & y | ~x & z;
  if (group === 2)
    return (x | ~y) ^ z;
  if (group === 3)
    return x & z | y & ~z;
  return x ^ (y | ~z);
}
var BUF_160 = /* @__PURE__ */ new Uint32Array(16);
var RIPEMD160 = class extends HashMD {
  constructor() {
    super(64, 20, 8, true);
    this.h0 = 1732584193 | 0;
    this.h1 = 4023233417 | 0;
    this.h2 = 2562383102 | 0;
    this.h3 = 271733878 | 0;
    this.h4 = 3285377520 | 0;
  }
  get() {
    const { h0, h1, h2, h3, h4 } = this;
    return [h0, h1, h2, h3, h4];
  }
  set(h0, h1, h2, h3, h4) {
    this.h0 = h0 | 0;
    this.h1 = h1 | 0;
    this.h2 = h2 | 0;
    this.h3 = h3 | 0;
    this.h4 = h4 | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      BUF_160[i] = view.getUint32(offset, true);
    let al = this.h0 | 0, ar = al, bl = this.h1 | 0, br = bl, cl = this.h2 | 0, cr = cl, dl = this.h3 | 0, dr = dl, el = this.h4 | 0, er = el;
    for (let group = 0; group < 5; group++) {
      const rGroup = 4 - group;
      const hbl = Kl160[group], hbr = Kr160[group];
      const rl = idxL[group], rr = idxR[group];
      const sl = shiftsL160[group], sr = shiftsR160[group];
      for (let i = 0; i < 16; i++) {
        const tl = rotl(al + ripemd_f(group, bl, cl, dl) + BUF_160[rl[i]] + hbl, sl[i]) + el | 0;
        al = el, el = dl, dl = rotl(cl, 10) | 0, cl = bl, bl = tl;
      }
      for (let i = 0; i < 16; i++) {
        const tr = rotl(ar + ripemd_f(rGroup, br, cr, dr) + BUF_160[rr[i]] + hbr, sr[i]) + er | 0;
        ar = er, er = dr, dr = rotl(cr, 10) | 0, cr = br, br = tr;
      }
    }
    this.set(this.h1 + cl + dr | 0, this.h2 + dl + er | 0, this.h3 + el + ar | 0, this.h4 + al + br | 0, this.h0 + bl + cr | 0);
  }
  roundClean() {
    clean(BUF_160);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0);
  }
};
var ripemd160 = /* @__PURE__ */ createHasher(() => new RIPEMD160());

// ../csd-sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/ripemd160.js
var ripemd1602 = ripemd160;

// ../csd-sdk/packages/crypto/dist/index.js
var strip0x2 = (h) => h.startsWith("0x") ? h.slice(2) : h;
var hb2 = (h) => hexToBytes(strip0x2(h));
var hx2 = (b) => "0x" + bytesToHex(b);
function hash160(bytes) {
  return hx2(ripemd1602(sha2562(bytes)));
}
function addrFromPub(pub33) {
  return hash160(hb2(pub33));
}
function verifyDigest(sig64, pub33, digestHex) {
  try {
    const s = hb2(sig64), p = hb2(pub33), d = hb2(digestHex);
    if (s.length !== 64 || p.length !== 33 || d.length !== 32) return false;
    if (secp256k1.Signature.fromCompact(s).hasHighS()) return false;
    return secp256k1.verify(s, d, p, { lowS: true });
  } catch {
    return false;
  }
}
function parseScriptSig(scriptSig) {
  if (typeof scriptSig !== "string") return null;
  const h = strip0x2(scriptSig).toLowerCase();
  if (h.length < 2 + 128 + 2 + 66) return null;
  if (h.slice(0, 2) !== "40") return null;
  if (h.slice(130, 132) !== "21") return null;
  const sig = h.slice(2, 130), pub = h.slice(132, 198);
  if (!/^[0-9a-f]{128}$/.test(sig) || !/^[0-9a-f]{66}$/.test(pub)) return null;
  return { sig64: "0x" + sig, pub33: "0x" + pub };
}
function recoverSigner(scriptSig, digestHex) {
  if (typeof scriptSig !== "string") return null;
  const h = strip0x2(scriptSig).toLowerCase();
  if (h.length !== 198) return null;
  const p = parseScriptSig(h);
  if (!p) return null;
  try {
    if (!verifyDigest(p.sig64, p.pub33, digestHex)) return null;
    return addrFromPub(p.pub33).toLowerCase();
  } catch {
    return null;
  }
}

// ../csd-sdk/packages/cairnx/dist/index.js
var DOMAIN = "cairnx:v1";
var ACTIVATION_HEIGHT = 29860;
var V11_HEIGHT = 29960;
var V12_HEIGHT = 30300;
var V13_HEIGHT = 31100;
var V14_HEIGHT = 31400;
var V15_HEIGHT = 32e3;
var V16_HEIGHT = 33600;
var V17_HEIGHT = 34e3;
var NAME_TERM_EPOCHS = 8760;
var NAME_GRACE_EPOCHS = 720;
var NAME_PREMIUM_START = 20n;
var NAME_PREMIUM_DECAY_EPOCHS = 720;
function expiredClaimFee(name, epochsPastGraceEnd, height) {
  const base = nameRegFee(name, height);
  if (epochsPastGraceEnd >= NAME_PREMIUM_DECAY_EPOCHS) return base;
  const left = BigInt(NAME_PREMIUM_DECAY_EPOCHS - epochsPastGraceEnd);
  const mult = 1n + (NAME_PREMIUM_START - 1n) * left / BigInt(NAME_PREMIUM_DECAY_EPOCHS);
  return base * mult;
}
var MAX_RECORD_BYTES = 512;
var MAX_AMOUNT = (1n << 96n) - 1n;
var SCORE_FILL = 100;
var SCORE_CANCEL = 0;
var SCORE_CLAIM = 50;
var CLAIM_WINDOW_BLOCKS = 15;
var CLAIM_WINDOW_BLOCKS_V20 = 40;
var CLAIM_FILL_GRACE_BLOCKS = 5;
var MAX_ACTIVE_CLAIMS = 3;
var CLAIM_COOLDOWN_BLOCKS = 15;
var FCLAIM_MAX_EPOCH_AHEAD = 2;
var FILL_TIP_MARGIN = 4;
var CONF_TOKEN_FILL = 1e6;
var TREASURY_ADDR = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
var FEE_BPS = 100;
var FEE_BPS_V16 = 150;
var REBATE_FLAT = 25000000n;
var REBATE_BPS = 50;
var DEPLOY_FEE = 1e8;
var V18_HEIGHT = 4e4;
var NAME_FEE_SHORT_V18 = 670000000n;
var NAME_FEE_V18 = 300000000n;
var V24_HEIGHT = 46400;
var NAME_FEE_LEN3_V24 = 1500000000n;
var NAME_FEE_LEN4_V24 = 1000000000n;
var NAME_FEE_MID_V24 = 500000000n;
var NAME_FEE_LONG_V24 = 300000000n;
var V19_HEIGHT = 36700;
var V20_HEIGHT = 38400;
var V21_HEIGHT = 40100;
var MAX_OFFER_EPOCHS = 168;
var V22_HEIGHT = 41300;
var V23_HEIGHT = 52e3;
var ZERO_ADDR = "0x" + "00".repeat(20);
var PKEY = /^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$/;
var PROFILE_MAX_KEYS = 16;
var PROFILE_MAX_VALUE_BYTES = 256;
function nameRegFee(name, height) {
  if (height >= V24_HEIGHT) {
    const ln = name.length;
    if (ln <= 3) return NAME_FEE_LEN3_V24;
    if (ln === 4) return NAME_FEE_LEN4_V24;
    if (ln <= 9) return NAME_FEE_MID_V24;
    return NAME_FEE_LONG_V24;
  }
  if (height >= V18_HEIGHT) return name.length <= 4 ? NAME_FEE_SHORT_V18 : NAME_FEE_V18;
  const n = name.length;
  if (n <= 3) return 500000000n;
  if (n === 4) return 200000000n;
  if (n === 5) return 100000000n;
  if (n <= 9) return 50000000n;
  return 10000000n;
}
var tradeFee = (want, bps = FEE_BPS) => (want * BigInt(bps) + 9999n) / 10000n;
var makerRebate = (value) => REBATE_FLAT + (value * BigInt(REBATE_BPS) + 9999n) / 10000n;
var TICKER_RE = /^[A-Z][A-Z0-9]{2,11}$/;
var ADDR_RE = /^0x[0-9a-f]{40}$/;
var AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
var NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
var HASH_RE = /^0x[0-9a-f]{64}$/;
var SALT_RE = /^[0-9a-fA-F]{16,128}$/;
var RESERVED_NAMES = /* @__PURE__ */ new Set(["csd", "treasury", "admin", "official", "root", "www", "support"]);
var COMMIT_MAX_BLOCKS = 8 * EPOCH_LEN;
var V25_HEIGHT = 46440;
var REG_COMMIT_MAX_BLOCKS = 8;
var REG_FINALIZE_GRACE_BLOCKS = 20;
var MAX_PENDING_REG = 3;
var FINALIZE_TIP_MARGIN = 2;
var V26_HEIGHT = 46480;
var V27_HEIGHT = 46520;
var V28_HEIGHT = 6e4;
var epochOf = (height) => Math.floor(height / EPOCH_LEN);
var claimWindowAt = (height) => height >= V20_HEIGHT ? CLAIM_WINDOW_BLOCKS_V20 : CLAIM_WINDOW_BLOCKS;
var claimWindowOf = (claimUntilHeight) => claimUntilHeight - CLAIM_WINDOW_BLOCKS_V20 >= V20_HEIGHT ? CLAIM_WINDOW_BLOCKS_V20 : CLAIM_WINDOW_BLOCKS;
var claimGraceOf = (claimUntilHeight, claimTxid) => claimTxid !== void 0 ? 0 : claimUntilHeight - CLAIM_WINDOW_BLOCKS_V20 >= V20_HEIGHT ? CLAIM_FILL_GRACE_BLOCKS : 0;
var fclaimEpochFor = (tipHeight, offerExpiresEpoch) => Math.min(epochOf(tipHeight + CLAIM_WINDOW_BLOCKS_V20 + CLAIM_FILL_GRACE_BLOCKS), offerExpiresEpoch);
var fclaimHoldEnd = (expiresEpoch) => (expiresEpoch + 1) * EPOCH_LEN - 1;
var offerExpiryHeightOf = (expiresEpoch, anchorHeight) => {
  const raw = (Number(expiresEpoch ?? 0) + 1) * EPOCH_LEN;
  if (anchorHeight >= V22_HEIGHT) return raw;
  const capped = (epochOf(anchorHeight) + MAX_OFFER_EPOCHS + 1) * EPOCH_LEN;
  return Math.min(raw, Math.max(V21_HEIGHT, capped));
};
var isNameGive = (g) => typeof g.name === "string";
var isTokenWant = (w) => typeof w.ticker === "string";
function parseAmount(s, opts = {}) {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) return null;
  const v = BigInt(s);
  if (v > MAX_AMOUNT) return null;
  if (v === 0n && !opts.allowZero) return null;
  return v;
}
var isAddr = (a) => typeof a === "string" && ADDR_RE.test(a);
var isTicker = (t) => typeof t === "string" && TICKER_RE.test(t);
var isHash = (h) => typeof h === "string" && HASH_RE.test(h);
var isName = (n) => typeof n === "string" && NAME_RE.test(n) && !RESERVED_NAMES.has(n);
function nameCommit(name, salt, owner) {
  return payloadHash({ t: "cairnx:name:commit:v1", name, salt, owner: owner.toLowerCase() });
}
function strWellFormed(s) {
  const wf = String.prototype.isWellFormed;
  if (typeof wf === "function") return wf.call(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 56320 && n <= 57343)) return false;
      i++;
    } else if (c >= 56320 && c <= 57343) {
      return false;
    }
  }
  return true;
}
function isWellFormedDeep(v) {
  if (typeof v === "string") return strWellFormed(v);
  if (Array.isArray(v)) return v.every(isWellFormedDeep);
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      if (!strWellFormed(k)) return false;
      if (!isWellFormedDeep(val)) return false;
    }
  }
  return true;
}
var onlyKeys = (r, allowed) => Object.keys(r).every((k) => allowed.has(k));
var DEPLOY_KEYS = /* @__PURE__ */ new Set(["v", "t", "ticker", "name", "decimals", "supply", "mint", "mintLimit"]);
var MINT_KEYS = /* @__PURE__ */ new Set(["v", "t", "ticker", "amount"]);
var TRANSFER_KEYS = /* @__PURE__ */ new Set(["v", "t", "ticker", "to", "amount", "memo", "ts"]);
var OFFER_KEYS = /* @__PURE__ */ new Set(["v", "t", "give", "want", "min", "bid", "taker", "memo", "ts"]);
var BID_KEYS = /* @__PURE__ */ new Set(["v", "t", "want", "give", "memo", "ts"]);
var NAME_KEYS = /* @__PURE__ */ new Set(["v", "t", "name", "salt"]);
var NFINALIZE_KEYS = /* @__PURE__ */ new Set(["v", "t", "name", "salt"]);
var NPROFILE_KEYS = /* @__PURE__ */ new Set(["v", "t", "name", "p"]);
var FCLAIM_KEYS = /* @__PURE__ */ new Set(["v", "t", "offer"]);
function parseRecord(uri, payloadHashHex) {
  if (new TextEncoder().encode(uri).length > MAX_RECORD_BYTES) return null;
  let obj;
  try {
    obj = JSON.parse(uri);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  try {
    if (canonicalJson(obj) !== uri) return null;
    if (payloadHash(obj).toLowerCase() !== payloadHashHex.toLowerCase()) return null;
  } catch {
    return null;
  }
  if (!isWellFormedDeep(obj)) return null;
  const r = obj;
  if (r.v !== 1 || typeof r.t !== "string") return null;
  switch (r.t) {
    case "deploy": {
      if (!onlyKeys(r, DEPLOY_KEYS)) return null;
      if (!isTicker(r.ticker)) return null;
      if (r.name !== void 0 && (typeof r.name !== "string" || r.name.length > 32)) return null;
      if (typeof r.decimals !== "number" || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 8) return null;
      if (parseAmount(r.supply) === null) return null;
      if (r.mint !== "open" && r.mint !== "issuer") return null;
      if (r.mint === "open" && parseAmount(r.mintLimit) === null) return null;
      if (r.mint === "issuer" && r.mintLimit !== void 0) return null;
      return r;
    }
    case "mint": {
      if (!onlyKeys(r, MINT_KEYS)) return null;
      if (!isTicker(r.ticker)) return null;
      if (r.amount !== void 0 && parseAmount(r.amount) === null) return null;
      return r;
    }
    case "transfer": {
      if (!onlyKeys(r, TRANSFER_KEYS)) return null;
      if (!isTicker(r.ticker) || !isAddr(r.to) || parseAmount(r.amount) === null) return null;
      if (r.memo !== void 0 && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== void 0 && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r;
    }
    case "offer": {
      if (!onlyKeys(r, OFFER_KEYS)) return null;
      const g = r.give;
      const w = r.want;
      if (!g || !w || typeof g !== "object" || Array.isArray(g) || typeof w !== "object" || Array.isArray(w)) return null;
      const gKeys = Object.keys(g).sort().join(",");
      if (gKeys === "amount,ticker") {
        if (!isTicker(g.ticker) || parseAmount(g.amount) === null) return null;
      } else if (gKeys === "name") {
        if (!isName(g.name)) return null;
      } else return null;
      const wKeys = Object.keys(w).filter((k) => k !== "payto").sort().join(",");
      if (wKeys === "value") {
        if (parseAmount(w.value, { allowZero: true }) === null) return null;
      } else if (wKeys === "amount,ticker") {
        if (!isTicker(w.ticker) || parseAmount(w.amount, { allowZero: true }) === null) return null;
        if (gKeys === "amount,ticker" && w.ticker === g.ticker) return null;
        if (r.min !== void 0) return null;
      } else return null;
      if (w.payto !== void 0 && !isAddr(w.payto)) return null;
      if (r.min !== void 0) {
        if (gKeys !== "amount,ticker" || wKeys !== "value") return null;
        const mn = parseAmount(r.min);
        if (mn === null || mn > parseAmount(w.value, { allowZero: true })) return null;
      }
      if (r.bid !== void 0 && !isHash(r.bid)) return null;
      if (r.taker !== void 0 && !isAddr(r.taker)) return null;
      if (r.memo !== void 0 && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== void 0 && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r;
    }
    case "ocancel": {
      if (r.ticker !== void 0 && r.name !== void 0) return null;
      if (r.ticker !== void 0 && !isTicker(r.ticker)) return null;
      if (r.name !== void 0 && !isName(r.name)) return null;
      const n = Object.keys(r).length;
      if (n !== 2 + (r.ticker !== void 0 ? 1 : 0) + (r.name !== void 0 ? 1 : 0)) return null;
      return r;
    }
    case "bid": {
      if (!onlyKeys(r, BID_KEYS)) return null;
      const w = r.want;
      const g = r.give;
      if (!w || !g || typeof w !== "object" || Array.isArray(w) || typeof g !== "object" || Array.isArray(g)) return null;
      const wKeys = Object.keys(w).sort().join(",");
      if (wKeys === "amount,ticker") {
        if (!isTicker(w.ticker) || parseAmount(w.amount) === null) return null;
      } else if (wKeys === "name") {
        if (!isName(w.name)) return null;
      } else return null;
      if (Object.keys(g).sort().join(",") !== "value" || parseAmount(g.value) === null) return null;
      if (r.memo !== void 0 && (typeof r.memo !== "string" || r.memo.length > 64)) return null;
      if (r.ts !== void 0 && (typeof r.ts !== "number" || !Number.isSafeInteger(r.ts))) return null;
      return r;
    }
    // ── names (v1.1) ──
    case "ncommit": {
      if (!isHash(r.commit)) return null;
      if (Object.keys(r).length !== 3) return null;
      return r;
    }
    case "name": {
      if (!onlyKeys(r, NAME_KEYS)) return null;
      if (!isName(r.name)) return null;
      if (r.salt !== void 0 && (typeof r.salt !== "string" || !SALT_RE.test(r.salt))) return null;
      return r;
    }
    case "nfinalize": {
      if (!onlyKeys(r, NFINALIZE_KEYS)) return null;
      if (!isName(r.name)) return null;
      if (typeof r.salt !== "string" || !SALT_RE.test(r.salt)) return null;
      return r;
    }
    case "nxfer": {
      if (!isName(r.name) || !isAddr(r.to)) return null;
      if (Object.keys(r).length !== 4) return null;
      return r;
    }
    case "nset": {
      if (!isName(r.name) || !isAddr(r.addr)) return null;
      if (Object.keys(r).length !== 4) return null;
      return r;
    }
    // ── v1.5 ──
    case "nrenew": {
      if (!isName(r.name)) return null;
      if (Object.keys(r).length !== 3) return null;
      return r;
    }
    case "nprofile": {
      if (!onlyKeys(r, NPROFILE_KEYS)) return null;
      if (!isName(r.name)) return null;
      const p = r.p;
      if (!p || typeof p !== "object" || Array.isArray(p)) return null;
      const keys = Object.keys(p);
      if (keys.length > PROFILE_MAX_KEYS) return null;
      for (const k of keys) {
        if (!PKEY.test(k)) return null;
        const val = p[k];
        if (typeof val !== "string") return null;
        if (new TextEncoder().encode(val).length > PROFILE_MAX_VALUE_BYTES) return null;
      }
      return r;
    }
    case "tmeta": {
      if (!isTicker(r.ticker)) return null;
      if (typeof r.hash !== "string" || !HASH_RE.test(r.hash)) return null;
      if (Object.keys(r).length !== 4) return null;
      return r;
    }
    case "fclaim": {
      if (!onlyKeys(r, FCLAIM_KEYS)) return null;
      if (!isHash(r.offer)) return null;
      return r;
    }
    default:
      return null;
  }
}
function buildRecord(record) {
  const uri = canonicalJson(record);
  const ph = payloadHash(record);
  const back = parseRecord(uri, ph);
  if (back === null) throw new Error("record does not validate against CONVENTION.md");
  return { record, uri, payloadHash: ph };
}
var deploy = (r) => buildRecord({ v: 1, t: "deploy", ...r });
var mint = (r) => buildRecord({ v: 1, t: "mint", ...r });
var transfer = (r) => buildRecord({ v: 1, t: "transfer", ...r });
var offer = (r) => buildRecord({ v: 1, t: "offer", ...r });
var bid = (r) => buildRecord({ v: 1, t: "bid", ...r });
var offerCancelAll = (r = {}) => buildRecord({ v: 1, t: "ocancel", ...r });
var nameCommitRecord = (r) => buildRecord({ v: 1, t: "ncommit", ...r });
var nameClaim = (r) => buildRecord({ v: 1, t: "name", ...r });
var nameFinalize = (r) => buildRecord({ v: 1, t: "nfinalize", ...r });
var nameXfer = (r) => buildRecord({ v: 1, t: "nxfer", ...r });
var nameSet = (r) => buildRecord({ v: 1, t: "nset", ...r });
var nameRenew = (r) => buildRecord({ v: 1, t: "nrenew", ...r });
var tokenMeta = (r) => buildRecord({ v: 1, t: "tmeta", ...r });
var nameProfile = (r) => buildRecord({ v: 1, t: "nprofile", ...r });
var fclaim = (r) => buildRecord({ v: 1, t: "fclaim", ...r });
function ptAmt(v) {
  return typeof v === "string" && AMOUNT_RE.test(v) ? BigInt(v) : 0n;
}
var ord = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function resolve(events, tipHeight) {
  const ordered = [...events].sort(
    (a, b) => a.height - b.height || Number(a.kind === "attest") - Number(b.kind === "attest") || a.pos - b.pos || ord(
      a.kind === "propose" ? a.id : a.txid,
      b.kind === "propose" ? b.id : b.txid
    )
  );
  const tokens = /* @__PURE__ */ new Map();
  const balances = /* @__PURE__ */ new Map();
  const names = /* @__PURE__ */ new Map();
  const commits = /* @__PURE__ */ new Map();
  const recaptures = /* @__PURE__ */ new Map();
  const offers = /* @__PURE__ */ new Map();
  const offerLock = /* @__PURE__ */ new Map();
  const bids = /* @__PURE__ */ new Map();
  const fclaims = /* @__PURE__ */ new Map();
  const log = [];
  let feesPaid = 0n;
  let pendingCancels = [];
  let pendingBlock = -1;
  const applyPendingCancels = () => {
    for (const f of pendingCancels) f();
    pendingCancels = [];
  };
  const bal = (ticker, addr) => {
    let m = balances.get(ticker);
    if (!m) {
      m = /* @__PURE__ */ new Map();
      balances.set(ticker, m);
    }
    let b = m.get(addr);
    if (!b) {
      b = { available: 0n, locked: 0n };
      m.set(addr, b);
    }
    return b;
  };
  const note = (e, id, kind, ok, why) => log.push({ height: e.height, pos: e.pos, id, kind, ok, ...why ? { note: why } : {} });
  const releaseGive = (o) => {
    if (isNameGive(o.give)) {
      const n = names.get(o.give.name);
      if (n) n.locked = false;
    } else {
      const amt = offerLock.get(o.id) ?? 0n;
      const b = bal(o.give.ticker, o.seller);
      b.locked -= amt;
      b.available += amt;
    }
  };
  const effExpiry = (e, height) => e.height >= V22_HEIGHT ? e.expiresEpoch : height >= V21_HEIGHT ? Math.min(e.expiresEpoch, epochOf(e.height) + MAX_OFFER_EPOCHS) : e.expiresEpoch;
  const sweepExpired = (height) => {
    const ep = epochOf(height);
    for (const o of offers.values()) {
      if (o.status === "open" && ep > effExpiry(o, height)) {
        releaseGive(o);
        o.status = "expired";
      }
    }
    for (const b of bids.values()) {
      if (b.status === "open" && ep > effExpiry(b, height)) b.status = "expired";
    }
    for (const nm of [...names.keys()]) {
      const n = names.get(nm);
      if (n.pending && n.finalizeBy !== void 0 && height > n.finalizeBy) names.delete(nm);
    }
    for (const nm of [...recaptures.keys()]) {
      const r = recaptures.get(nm);
      if (height > r.finalizeBy) recaptures.delete(nm);
    }
  };
  const V15_EPOCH = epochOf(V15_HEIGHT);
  const paidThrough = (n) => n.paidThroughEpoch ?? V15_EPOCH + NAME_TERM_EPOCHS;
  const lapsed = (n, ep) => ep > paidThrough(n) + NAME_GRACE_EPOCHS;
  const inGrace = (n, ep) => ep > paidThrough(n) && !lapsed(n, ep);
  const markBidDone = (o, buyer) => {
    if (!o.bid) return;
    const b = bids.get(o.bid);
    if (b && b.status === "open" && b.bidder === buyer) b.status = "done";
  };
  const voidOpenNameOffers = (name, height) => {
    for (const o of offers.values()) if (o.status === "open" && isNameGive(o.give) && o.give.name === name) {
      if (height >= V28_HEIGHT && o.claimTxid !== void 0 && claimHeld(o, height)) continue;
      releaseGive(o);
      o.status = "cancelled";
    }
  };
  const earlierAnchor = (effHeight, pos, id, inc) => effHeight < inc.effHeight || effHeight === inc.effHeight && (pos < inc.pos || pos === inc.pos && id < inc.id);
  const claimGrace = (o) => o.claimUntilHeight !== void 0 ? claimGraceOf(o.claimUntilHeight, o.claimTxid) : 0;
  const claimHeld = (o, height) => o.claimedBy !== void 0 && o.claimUntilHeight !== void 0 && height < o.claimUntilHeight + claimGrace(o);
  const openFillReject = (o, height, who, targetId) => {
    if (!(height >= V13_HEIGHT && !o.taker)) return void 0;
    if (height < V17_HEIGHT) return "v1.3: open CSD-quoted fills disabled (offer must be taker-bound)";
    if (height >= V28_HEIGHT && o.claimTxid !== void 0 && targetId === o.id) return "v2.8: fill the fclaim txid, not the offer";
    if (!(claimHeld(o, height) && who === o.claimedBy)) return "v1.7: open offer \u2014 claim it first (no live claim by you)";
    return void 0;
  };
  const deliverNameToBuyer = (n, who, ev) => {
    n.owner = who;
    n.locked = false;
    n.addr = void 0;
    n.profile = void 0;
    if (ev.height >= V13_HEIGHT) {
      n.effHeight = ev.height;
      n.pos = ev.pos;
      n.id = ev.txid;
      n.height = ev.height;
      n.viaFill = true;
    }
  };
  const releaseGiveLock = (o, who, amt) => {
    const t = o.give.ticker;
    bal(t, o.seller).locked -= amt;
    bal(t, who).available += amt;
    offerLock.delete(o.id);
  };
  for (const ev of ordered) {
    if (ev.height < ACTIVATION_HEIGHT) continue;
    if (ev.height !== pendingBlock) {
      applyPendingCancels();
      pendingBlock = ev.height;
    }
    sweepExpired(ev.height);
    const v11 = ev.height >= V11_HEIGHT;
    const v12 = ev.height >= V12_HEIGHT;
    const v15 = ev.height >= V15_HEIGHT;
    const v16 = ev.height >= V16_HEIGHT;
    const v19 = ev.height >= V19_HEIGHT;
    const v23 = ev.height >= V23_HEIGHT;
    const v25 = ev.height >= V25_HEIGHT;
    const v26 = ev.height >= V26_HEIGHT;
    const feeToTreasury = ev.kind === "propose" ? ptAmt((ev.paidTo ?? {})[TREASURY_ADDR]) : 0n;
    if (ev.kind === "propose") {
      const rec = parseRecord(ev.uri, ev.payloadHash);
      if (!rec) {
        note(ev, ev.id, "invalid", false, "unparseable/non-canonical record");
        continue;
      }
      const who = ev.proposer.toLowerCase();
      if (rec.t === "deploy") {
        if (tokens.has(rec.ticker)) {
          note(ev, ev.id, "deploy", false, "ticker taken (first anchor wins)");
          continue;
        }
        if (v11 && feeToTreasury < BigInt(DEPLOY_FEE)) {
          note(ev, ev.id, "deploy", false, "deploy fee unpaid");
          continue;
        }
        const supply = parseAmount(rec.supply);
        const mintLimit = rec.mint === "open" ? parseAmount(rec.mintLimit) : null;
        tokens.set(rec.ticker, {
          minted: 0n,
          supply,
          mintLimit,
          meta: { ticker: rec.ticker, deployId: ev.id, deployer: who, name: rec.name, decimals: rec.decimals, supply: rec.supply, minted: "0", mint: rec.mint, mintLimit: rec.mintLimit, height: ev.height }
        });
        if (v11) feesPaid += BigInt(DEPLOY_FEE);
        note(ev, ev.id, "deploy", true);
      } else if (rec.t === "mint") {
        const tok = tokens.get(rec.ticker);
        if (!tok) {
          note(ev, ev.id, "mint", false, "unknown ticker");
          continue;
        }
        const remaining = tok.supply - tok.minted;
        if (remaining <= 0n) {
          note(ev, ev.id, "mint", false, "supply exhausted");
          continue;
        }
        let credit;
        if (tok.meta.mint === "issuer") {
          if (who !== tok.meta.deployer) {
            note(ev, ev.id, "mint", false, "issuer-only mint");
            continue;
          }
          const req = rec.amount !== void 0 ? parseAmount(rec.amount) : null;
          if (req === null) {
            note(ev, ev.id, "mint", false, "issuer mint requires amount");
            continue;
          }
          credit = req < remaining ? req : remaining;
        } else {
          const req = rec.amount !== void 0 ? parseAmount(rec.amount) : tok.mintLimit;
          const capped = req < tok.mintLimit ? req : tok.mintLimit;
          credit = capped < remaining ? capped : remaining;
        }
        tok.minted += credit;
        bal(rec.ticker, who).available += credit;
        note(ev, ev.id, "mint", true, credit.toString());
      } else if (rec.t === "transfer") {
        if (!tokens.has(rec.ticker)) {
          note(ev, ev.id, "transfer", false, "unknown ticker");
          continue;
        }
        const amt = parseAmount(rec.amount);
        const from = bal(rec.ticker, who);
        if (from.available < amt) {
          note(ev, ev.id, "transfer", false, "insufficient available balance");
          continue;
        }
        from.available -= amt;
        bal(rec.ticker, rec.to.toLowerCase()).available += amt;
        note(ev, ev.id, "transfer", true);
      } else if (rec.t === "ncommit") {
        if (!v11) {
          note(ev, ev.id, "ncommit", false, "before v1.1 activation");
          continue;
        }
        const prev = commits.get(rec.commit);
        if (prev === void 0 || ev.height < prev) commits.set(rec.commit, ev.height);
        note(ev, ev.id, "ncommit", true);
      } else if (rec.t === "name") {
        if (!v11) {
          note(ev, ev.id, "name", false, "before v1.1 activation");
          continue;
        }
        const regWindow = v25 || v26 ? REG_COMMIT_MAX_BLOCKS : COMMIT_MAX_BLOCKS;
        let effHeight = ev.height;
        if (rec.salt !== void 0) {
          const ch = nameCommit(rec.name, rec.salt, who);
          const cH = commits.get(ch);
          if (cH === void 0 || cH >= ev.height || ev.height - cH > regWindow) {
            note(ev, ev.id, "name", false, "no valid in-window commit for this reveal");
            continue;
          }
          effHeight = cH;
        }
        const cur = names.get(rec.name);
        const epClaim = epochOf(ev.height);
        const curActive = cur && cur.pending && cur.finalizeBy !== void 0 && ev.height > cur.finalizeBy ? void 0 : cur;
        if (curActive && !curActive.pending && v15 && lapsed(curActive, epClaim)) {
          if (v26) {
            if (rec.salt === void 0) {
              note(ev, ev.id, "name", false, "v2.6: recapture requires a commit-reveal (salt)");
              continue;
            }
            const cr = recaptures.get(rec.name);
            const crActive = cr && ev.height > cr.finalizeBy ? void 0 : cr;
            const better2 = !crActive || earlierAnchor(effHeight, ev.pos, ev.id, crActive);
            if (!better2) {
              note(ev, ev.id, "name", false, "recapture already reserved (earlier anchor wins)");
              continue;
            }
            let myR = 0;
            for (const [nm, r] of recaptures) if (r.owner === who && nm !== rec.name && ev.height <= r.finalizeBy) myR++;
            if (myR >= MAX_PENDING_REG) {
              note(ev, ev.id, "name", false, "too many pending recaptures (max reached)");
              continue;
            }
            recaptures.set(rec.name, { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, finalizeBy: effHeight + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS });
            note(ev, ev.id, "name", true, crActive ? "recapture reserved (displaced prior reservation)" : "recapture reserved (pending finalize)");
            continue;
          }
          const fee = expiredClaimFee(rec.name, epClaim - (paidThrough(curActive) + NAME_GRACE_EPOCHS), ev.height);
          if (feeToTreasury < fee) {
            note(ev, ev.id, "name", false, "lapsed-name claim fee unpaid (decaying premium)");
            continue;
          }
          voidOpenNameOffers(rec.name, ev.height);
          names.set(rec.name, { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, locked: false, viaFill: true, paidThroughEpoch: epClaim + NAME_TERM_EPOCHS });
          feesPaid += fee;
          note(ev, ev.id, "name", true, "lapsed lease re-claimed (premium)");
          continue;
        }
        if (v25) {
          if (rec.salt === void 0) {
            note(ev, ev.id, "name", false, "v2.5: registration requires a commit-reveal (salt)");
            continue;
          }
          const better2 = !curActive || !curActive.viaFill && earlierAnchor(effHeight, ev.pos, ev.id, curActive);
          if (!better2) {
            note(ev, ev.id, "name", false, curActive?.viaFill ? "name taken (purchased \u2014 not displaceable)" : "name taken (earlier anchor wins)");
            continue;
          }
          let myPending = 0;
          for (const [nm, n] of names) if (n.pending && n.owner === who && nm !== rec.name && n.finalizeBy !== void 0 && ev.height <= n.finalizeBy) myPending++;
          if (myPending >= MAX_PENDING_REG) {
            note(ev, ev.id, "name", false, "too many pending reservations (max reached)");
            continue;
          }
          if (curActive) {
            voidOpenNameOffers(rec.name, ev.height);
          }
          names.set(rec.name, { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, locked: false, pending: true, finalizeBy: effHeight + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS });
          note(ev, ev.id, "name", true, curActive ? "reserved (displaced prior reservation)" : "reserved (pending finalize)");
          continue;
        }
        if (feeToTreasury < nameRegFee(rec.name, ev.height)) {
          note(ev, ev.id, "name", false, "name registration fee unpaid");
          continue;
        }
        const cand = {
          owner: who,
          effHeight,
          pos: ev.pos,
          id: ev.id,
          height: ev.height,
          locked: false,
          ...v15 ? { paidThroughEpoch: epClaim + NAME_TERM_EPOCHS } : {}
        };
        const better = !curActive || !curActive.viaFill && earlierAnchor(effHeight, ev.pos, ev.id, curActive);
        if (!better) {
          note(ev, ev.id, "name", false, curActive?.viaFill ? "name taken (purchased \u2014 not displaceable)" : "name taken (earlier anchor wins)");
          continue;
        }
        if (curActive) {
          voidOpenNameOffers(rec.name, ev.height);
        }
        names.set(rec.name, cand);
        feesPaid += nameRegFee(rec.name, ev.height);
        note(ev, ev.id, "name", true, curActive ? "displaced prior holder" : void 0);
      } else if (rec.t === "nfinalize") {
        if (!v25) {
          note(ev, ev.id, "nfinalize", false, "before v2.5 activation");
          continue;
        }
        const n = names.get(rec.name);
        if (n && n.pending && n.owner === who) {
          const cH = commits.get(nameCommit(rec.name, rec.salt, who));
          if (cH === void 0 || cH !== n.effHeight) {
            note(ev, ev.id, "nfinalize", false, "salt does not match the reservation commit");
            continue;
          }
          if (!(ev.height > n.effHeight + REG_COMMIT_MAX_BLOCKS)) {
            note(ev, ev.id, "nfinalize", false, "too early \u2014 displacement contest not yet frozen");
            continue;
          }
          if (n.finalizeBy !== void 0 && ev.height > n.finalizeBy) {
            note(ev, ev.id, "nfinalize", false, "reservation expired");
            continue;
          }
          if (feeToTreasury < nameRegFee(rec.name, ev.height)) {
            note(ev, ev.id, "nfinalize", false, "name registration fee unpaid");
            continue;
          }
          delete n.pending;
          delete n.finalizeBy;
          n.paidThroughEpoch = epochOf(ev.height) + NAME_TERM_EPOCHS;
          feesPaid += nameRegFee(rec.name, ev.height);
          note(ev, ev.id, "nfinalize", true);
          continue;
        }
        const r = v26 ? recaptures.get(rec.name) : void 0;
        if (r && r.owner === who) {
          const cH = commits.get(nameCommit(rec.name, rec.salt, who));
          if (cH === void 0 || cH !== r.effHeight) {
            note(ev, ev.id, "nfinalize", false, "salt does not match the recapture commit");
            continue;
          }
          if (!(ev.height > r.effHeight + REG_COMMIT_MAX_BLOCKS)) {
            note(ev, ev.id, "nfinalize", false, "too early \u2014 recapture contest not yet frozen");
            continue;
          }
          if (ev.height > r.finalizeBy) {
            note(ev, ev.id, "nfinalize", false, "recapture reservation expired");
            continue;
          }
          const cur = names.get(rec.name);
          const ep = epochOf(ev.height);
          if (!cur || cur.pending || !lapsed(cur, ep)) {
            recaptures.delete(rec.name);
            note(ev, ev.id, "nfinalize", false, "name is no longer lapsed");
            continue;
          }
          const fee = expiredClaimFee(rec.name, ep - (paidThrough(cur) + NAME_GRACE_EPOCHS), ev.height);
          if (feeToTreasury < fee) {
            note(ev, ev.id, "nfinalize", false, "recapture premium unpaid (decaying)");
            continue;
          }
          voidOpenNameOffers(rec.name, ev.height);
          names.set(rec.name, { owner: who, effHeight: r.effHeight, pos: r.pos, id: r.id, height: r.height, locked: false, paidThroughEpoch: ep + NAME_TERM_EPOCHS });
          recaptures.delete(rec.name);
          feesPaid += fee;
          note(ev, ev.id, "nfinalize", true, "recapture finalized (premium)");
          continue;
        }
        note(ev, ev.id, "nfinalize", false, "no matching pending reservation you own");
      } else if (rec.t === "nxfer") {
        const n = names.get(rec.name);
        if (!n || n.owner !== who) {
          note(ev, ev.id, "nxfer", false, "not the name owner");
          continue;
        }
        if (n.pending) {
          note(ev, ev.id, "nxfer", false, "name reservation not yet finalized");
          continue;
        }
        if (v15 && lapsed(n, epochOf(ev.height))) {
          note(ev, ev.id, "nxfer", false, "lease lapsed \u2014 claim it instead");
          continue;
        }
        if (n.locked) {
          note(ev, ev.id, "nxfer", false, "name is locked by an open offer");
          continue;
        }
        n.owner = rec.to.toLowerCase();
        n.addr = void 0;
        n.profile = void 0;
        note(ev, ev.id, "nxfer", true);
      } else if (rec.t === "nset") {
        const n = names.get(rec.name);
        if (!n || n.owner !== who) {
          note(ev, ev.id, "nset", false, "not the name owner");
          continue;
        }
        if (n.pending) {
          note(ev, ev.id, "nset", false, "name reservation not yet finalized");
          continue;
        }
        if (v15 && lapsed(n, epochOf(ev.height))) {
          note(ev, ev.id, "nset", false, "lease lapsed \u2014 claim it instead");
          continue;
        }
        if (v23 && rec.addr.toLowerCase() === ZERO_ADDR) n.addr = void 0;
        else n.addr = rec.addr.toLowerCase();
        note(ev, ev.id, "nset", true);
      } else if (rec.t === "nprofile") {
        if (!v19) {
          note(ev, ev.id, "nprofile", false, "before v1.9 activation");
          continue;
        }
        const n = names.get(rec.name);
        if (!n || n.owner !== who) {
          note(ev, ev.id, "nprofile", false, "not the name owner");
          continue;
        }
        if (n.pending) {
          note(ev, ev.id, "nprofile", false, "name reservation not yet finalized");
          continue;
        }
        if (v15 && lapsed(n, epochOf(ev.height))) {
          note(ev, ev.id, "nprofile", false, "lease lapsed \u2014 claim it instead");
          continue;
        }
        n.profile = Object.keys(rec.p).length ? { ...rec.p } : void 0;
        note(ev, ev.id, "nprofile", true);
      } else if (rec.t === "offer") {
        const wantIsToken = isTokenWant(rec.want);
        if ((wantIsToken || rec.min !== void 0 || rec.bid !== void 0) && !v12) {
          note(ev, ev.id, "offer", false, "v1.2 offer shape before activation");
          continue;
        }
        if (ev.height >= V13_HEIGHT && ev.height < V17_HEIGHT && !wantIsToken && rec.taker === void 0) {
          note(ev, ev.id, "offer", false, "v1.3: CSD-priced offers must be taker-bound (use bid/RFQ)");
          continue;
        }
        const payto = (rec.want.payto ?? who).toLowerCase();
        if (payto === TREASURY_ADDR) {
          note(ev, ev.id, "offer", false, "payto cannot be the protocol treasury");
          continue;
        }
        if (!Number.isSafeInteger(ev.expiresEpoch)) {
          note(ev, ev.id, "offer", false, "expiresEpoch out of safe-integer range");
          continue;
        }
        if (epochOf(ev.height) > ev.expiresEpoch) {
          note(ev, ev.id, "offer", false, "already expired at anchor");
          continue;
        }
        if (ev.height >= V21_HEIGHT && ev.height < V22_HEIGHT && ev.expiresEpoch - epochOf(ev.height) > MAX_OFFER_EPOCHS) {
          note(ev, ev.id, "offer", false, "v2.1: offer duration exceeds the max");
          continue;
        }
        const give = rec.give;
        if (isNameGive(give)) {
          if (!v11) {
            note(ev, ev.id, "offer", false, "name offers need v1.1");
            continue;
          }
          const n = names.get(give.name);
          if (!n || n.owner !== who) {
            note(ev, ev.id, "offer", false, "you don't own this name");
            continue;
          }
          if (n.pending) {
            note(ev, ev.id, "offer", false, "name reservation not yet finalized");
            continue;
          }
          if (n.locked) {
            note(ev, ev.id, "offer", false, "name already locked by another offer");
            continue;
          }
          const saleEmbargo = ev.height >= V27_HEIGHT ? REG_COMMIT_MAX_BLOCKS : COMMIT_MAX_BLOCKS;
          if (ev.height >= V13_HEIGHT && !n.viaFill && ev.height - n.effHeight <= saleEmbargo) {
            note(ev, ev.id, "offer", false, "name too young to sell (must out-age the reveal window)");
            continue;
          }
          if (v15 && paidThrough(n) < ev.expiresEpoch) {
            note(ev, ev.id, "offer", false, "v1.5: lease ends inside the offer window (renew first)");
            continue;
          }
          n.locked = true;
        } else {
          if (!tokens.has(give.ticker)) {
            note(ev, ev.id, "offer", false, "unknown ticker");
            continue;
          }
          const amt = parseAmount(give.amount);
          const s = bal(give.ticker, who);
          if (s.available < amt) {
            note(ev, ev.id, "offer", false, "insufficient available balance");
            continue;
          }
          s.available -= amt;
          s.locked += amt;
          offerLock.set(ev.id, amt);
        }
        const o = {
          id: ev.id,
          seller: who,
          give,
          want: wantIsToken ? { ticker: rec.want.ticker, amount: rec.want.amount, payto } : { value: rec.want.value, payto },
          ...rec.taker ? { taker: rec.taker.toLowerCase() } : {},
          ...rec.min !== void 0 ? { min: rec.min, paid: "0", delivered: "0", fills: [] } : {},
          ...rec.bid !== void 0 ? { bid: rec.bid } : {},
          status: "open",
          expiresEpoch: ev.expiresEpoch,
          height: ev.height,
          feeBps: v11 ? v16 ? FEE_BPS_V16 : FEE_BPS : 0
        };
        offers.set(ev.id, o);
        const linked = rec.bid !== void 0 ? bids.get(rec.bid) : void 0;
        if (linked) linked.offers.push(ev.id);
        note(ev, ev.id, "offer", true);
      } else if (rec.t === "bid") {
        if (!v12) {
          note(ev, ev.id, "bid", false, "bids need v1.2");
          continue;
        }
        if (!Number.isSafeInteger(ev.expiresEpoch)) {
          note(ev, ev.id, "bid", false, "expiresEpoch out of safe-integer range");
          continue;
        }
        if (epochOf(ev.height) > ev.expiresEpoch) {
          note(ev, ev.id, "bid", false, "already expired at anchor");
          continue;
        }
        if (ev.height >= V21_HEIGHT && ev.height < V22_HEIGHT && ev.expiresEpoch - epochOf(ev.height) > MAX_OFFER_EPOCHS) {
          note(ev, ev.id, "bid", false, "v2.1: bid duration exceeds the max");
          continue;
        }
        bids.set(ev.id, {
          id: ev.id,
          bidder: who,
          want: rec.want,
          give: rec.give,
          status: "open",
          expiresEpoch: ev.expiresEpoch,
          height: ev.height,
          offers: []
        });
        note(ev, ev.id, "bid", true);
      } else if (rec.t === "ocancel") {
        if (!v12) {
          note(ev, ev.id, "ocancel", false, "ocancel needs v1.2");
          continue;
        }
        const targets = [];
        for (const o of offers.values()) {
          if (o.status !== "open" || o.seller !== who) continue;
          if (o.taker !== void 0 && o.height >= V28_HEIGHT) continue;
          if (rec.ticker !== void 0 && !(!isNameGive(o.give) && o.give.ticker === rec.ticker)) continue;
          if (rec.name !== void 0 && !(isNameGive(o.give) && o.give.name === rec.name)) continue;
          targets.push(o);
        }
        if (ev.height >= V14_HEIGHT) {
          pendingCancels.push(() => {
            let n = 0;
            for (const o of targets) {
              if (ev.height >= V28_HEIGHT && o.claimTxid !== void 0 && claimHeld(o, ev.height)) continue;
              if (o.status === "open") {
                releaseGive(o);
                o.status = "cancelled";
                n++;
              }
            }
            note(ev, ev.id, "ocancel", true, `${n} cancelled (deferred past same-block fills)`);
          });
        } else {
          for (const o of targets) {
            releaseGive(o);
            o.status = "cancelled";
          }
          note(ev, ev.id, "ocancel", true, `${targets.length} cancelled`);
        }
      } else if (rec.t === "nrenew") {
        if (!v15) {
          note(ev, ev.id, "nrenew", false, "nrenew needs v1.5");
          continue;
        }
        const n = names.get(rec.name);
        const ep = epochOf(ev.height);
        if (n && n.pending) {
          note(ev, ev.id, "nrenew", false, "name reservation not yet finalized");
          continue;
        }
        if (!n || lapsed(n, ep)) {
          note(ev, ev.id, "nrenew", false, "no live lease (lapsed names are claimed, not renewed)");
          continue;
        }
        if (inGrace(n, ep) && who !== n.owner) {
          note(ev, ev.id, "nrenew", false, "grace period: only the owner may renew");
          continue;
        }
        if (feeToTreasury < nameRegFee(rec.name, ev.height)) {
          note(ev, ev.id, "nrenew", false, "renewal fee unpaid");
          continue;
        }
        n.paidThroughEpoch = paidThrough(n) + NAME_TERM_EPOCHS;
        feesPaid += nameRegFee(rec.name, ev.height);
        note(ev, ev.id, "nrenew", true, `paid through epoch ${n.paidThroughEpoch}`);
      } else if (rec.t === "tmeta") {
        if (!v15) {
          note(ev, ev.id, "tmeta", false, "tmeta needs v1.5");
          continue;
        }
        const tok = tokens.get(rec.ticker);
        if (!tok) {
          note(ev, ev.id, "tmeta", false, "unknown ticker");
          continue;
        }
        if (who !== tok.meta.deployer) {
          note(ev, ev.id, "tmeta", false, "issuer-only metadata");
          continue;
        }
        tok.meta.tmeta = rec.hash;
        note(ev, ev.id, "tmeta", true);
      } else if (rec.t === "fclaim") {
        if (ev.height < V28_HEIGHT) {
          note(ev, ev.id, "fclaim", false, "fclaim needs v2.8");
          continue;
        }
        const target = offers.get(rec.offer);
        const E = ev.expiresEpoch;
        const deny = (why) => {
          fclaims.set(ev.id, { offer: rec.offer, proposer: who, expiresEpoch: E, height: ev.height, granted: false });
          note(ev, ev.id, "fclaim", false, why);
        };
        if (!target) {
          deny("unknown offer");
          continue;
        }
        if (target.status !== "open") {
          deny(`offer ${target.status}`);
          continue;
        }
        if (target.taker) {
          deny("taker-bound offer needs no claim");
          continue;
        }
        if (isTokenWant(target.want)) {
          deny("claims are for CSD-priced offers");
          continue;
        }
        if (E > effExpiry(target, ev.height)) {
          deny("hold would outlive the offer expiry");
          continue;
        }
        if (E > epochOf(ev.height) + FCLAIM_MAX_EPOCH_AHEAD) {
          deny("hold too far ahead (anti-squat)");
          continue;
        }
        if (epochOf(ev.height) > E) {
          deny("expiry already in the past");
          continue;
        }
        if (claimHeld(target, ev.height)) {
          deny("offer already claimed (hold live)");
          continue;
        }
        if (target.claimedBy === who && target.claimUntilHeight !== void 0 && ev.height < target.claimUntilHeight + claimGrace(target) + CLAIM_COOLDOWN_BLOCKS) {
          deny("claim cooldown (you just held this offer)");
          continue;
        }
        let liveN = 0;
        for (const x of offers.values()) if (x.claimedBy === who && claimHeld(x, ev.height)) liveN++;
        if (liveN >= MAX_ACTIVE_CLAIMS) {
          deny(`max ${MAX_ACTIVE_CLAIMS} live claims per address`);
          continue;
        }
        target.claimedBy = who;
        target.claimUntilHeight = (E + 1) * EPOCH_LEN;
        target.claimTxid = ev.id;
        fclaims.set(ev.id, { offer: rec.offer, proposer: who, expiresEpoch: E, height: ev.height, granted: true });
        note(ev, ev.id, "fclaim", true);
      }
    } else {
      const who = ev.attester.toLowerCase();
      let o = offers.get(ev.proposalId);
      if (!o && ev.height >= V28_HEIGHT && ev.score === SCORE_FILL) {
        const fc = fclaims.get(ev.proposalId);
        if (fc && fc.granted) {
          const linked = offers.get(fc.offer);
          if (linked && linked.claimTxid === ev.proposalId) o = linked;
        }
      }
      if (!o) {
        if (ev.height >= V28_HEIGHT && ev.score === SCORE_FILL && fclaims.has(ev.proposalId)) {
          note(ev, ev.txid, "fill", false, "fclaim not current (denied or superseded): no delivery, denied-fclaim fill");
          continue;
        }
        const b = bids.get(ev.proposalId);
        if (b && ev.score === SCORE_CANCEL) {
          if (who !== b.bidder) {
            note(ev, ev.txid, "bidcancel", false, "only bidder may cancel");
            continue;
          }
          if (b.status !== "open") {
            note(ev, ev.txid, "bidcancel", false, `bid ${b.status}`);
            continue;
          }
          b.status = "cancelled";
          note(ev, ev.txid, "bidcancel", true);
        }
        continue;
      }
      if (ev.score === SCORE_CANCEL) {
        if (who !== o.seller) {
          note(ev, ev.txid, "cancel", false, "only seller may cancel");
          continue;
        }
        if (o.status !== "open") {
          note(ev, ev.txid, "cancel", false, `offer ${o.status}`);
          continue;
        }
        if (o.taker !== void 0 && o.height >= V28_HEIGHT) {
          note(ev, ev.txid, "cancel", false, "v2.8: taker-bound offers are firm quotes (uncancellable)");
          continue;
        }
        if (ev.height >= V14_HEIGHT) {
          pendingCancels.push(() => {
            if (ev.height >= V28_HEIGHT && o.claimTxid !== void 0 && claimHeld(o, ev.height)) {
              note(ev, ev.txid, "cancel", false, "v2.8: frozen (fclaim hold live)");
              return;
            }
            if (o.status === "open") {
              releaseGive(o);
              o.status = "cancelled";
              note(ev, ev.txid, "cancel", true);
            } else note(ev, ev.txid, "cancel", false, "superseded by same-block fill (v1.4)");
          });
        } else {
          releaseGive(o);
          o.status = "cancelled";
          note(ev, ev.txid, "cancel", true);
        }
      } else if (ev.score === SCORE_FILL && isTokenWant(o.want)) {
        if (o.status !== "open") {
          note(ev, ev.txid, "fill", false, `offer ${o.status}`);
          continue;
        }
        if (o.taker && who !== o.taker) {
          note(ev, ev.txid, "fill", false, "taker-bound offer");
          continue;
        }
        if (ev.confidence !== CONF_TOKEN_FILL) {
          note(ev, ev.txid, "fill", false, "token fill requires confidence marker");
          continue;
        }
        if (!tokens.has(o.want.ticker)) {
          note(ev, ev.txid, "fill", false, "want ticker does not exist");
          continue;
        }
        const amt = BigInt(o.want.amount);
        const fee = o.feeBps ? tradeFee(amt, o.feeBps) : 0n;
        const buyer = bal(o.want.ticker, who);
        if (buyer.available < amt + fee) {
          note(ev, ev.txid, "fill", false, "insufficient want-token balance");
          continue;
        }
        const giveName = isNameGive(o.give) ? names.get(o.give.name) : void 0;
        if (isNameGive(o.give) && !giveName) {
          note(ev, ev.txid, "fill", false, "name vanished (consensus violation)");
          continue;
        }
        const giveLock = isNameGive(o.give) ? void 0 : offerLock.get(o.id);
        if (!isNameGive(o.give) && giveLock === void 0) {
          note(ev, ev.txid, "fill", false, "offer lock missing");
          continue;
        }
        buyer.available -= amt + fee;
        bal(o.want.ticker, o.want.payto).available += amt;
        if (fee > 0n) bal(o.want.ticker, TREASURY_ADDR).available += fee;
        if (isNameGive(o.give)) deliverNameToBuyer(giveName, who, ev);
        else releaseGiveLock(o, who, giveLock);
        o.status = "filled";
        o.fill = { buyer: who, txid: ev.txid, height: ev.height, paid: amt.toString(), fee: fee.toString() };
        markBidDone(o, who);
        note(ev, ev.txid, "fill", true);
      } else if (ev.score === SCORE_FILL && o.min !== void 0 && !isNameGive(o.give)) {
        if (o.status !== "open") {
          note(ev, ev.txid, "fill", false, `offer ${o.status}`);
          continue;
        }
        if (o.taker && who !== o.taker) {
          note(ev, ev.txid, "fill", false, "taker-bound offer");
          continue;
        }
        const blk = openFillReject(o, ev.height, who, ev.proposalId);
        if (blk) {
          note(ev, ev.txid, "fill", false, blk);
          continue;
        }
        const pt = ev.paidTo ?? {};
        const want = BigInt(o.want.value);
        const paidSoFar = BigInt(o.paid ?? "0");
        const remaining = want - paidSoFar;
        const X = ptAmt(pt[o.want.payto]);
        const minV = BigInt(o.min);
        const effMin = remaining < minV ? remaining : minV;
        if (X < effMin) {
          note(ev, ev.txid, "fill", false, "payment below offer min");
          continue;
        }
        const x = X < remaining ? X : remaining;
        const fee = o.feeBps ? tradeFee(x, o.feeBps) : 0n;
        if (ptAmt(pt[TREASURY_ADDR]) < fee) {
          note(ev, ev.txid, "fill", false, "protocol fee unpaid");
          continue;
        }
        const giveTotal = BigInt(o.give.amount);
        const newPaid = paidSoFar + x;
        const deliveredSoFar = BigInt(o.delivered ?? "0");
        const newDelivered = giveTotal * newPaid / want;
        const out = newDelivered - deliveredSoFar;
        if (out === 0n) {
          note(ev, ev.txid, "fill", false, "fill too small to deliver any tokens");
          continue;
        }
        const lock = offerLock.get(o.id);
        if (lock === void 0) {
          note(ev, ev.txid, "fill", false, "offer lock missing");
          continue;
        }
        bal(o.give.ticker, o.seller).locked -= out;
        bal(o.give.ticker, who).available += out;
        offerLock.set(o.id, lock - out);
        o.paid = newPaid.toString();
        o.delivered = newDelivered.toString();
        const entry = { buyer: who, txid: ev.txid, height: ev.height, paid: x.toString(), fee: fee.toString(), got: out.toString() };
        (o.fills ??= []).push(entry);
        feesPaid += fee;
        if (newPaid === want) {
          o.status = "filled";
          o.fill = entry;
          offerLock.delete(o.id);
          markBidDone(o, who);
        }
        note(ev, ev.txid, "fill", true, `partial ${x}/${want}`);
      } else if (ev.score === SCORE_FILL) {
        if (o.status !== "open") {
          note(ev, ev.txid, "fill", false, `offer ${o.status}`);
          continue;
        }
        if (o.taker && who !== o.taker) {
          note(ev, ev.txid, "fill", false, "taker-bound offer");
          continue;
        }
        const blk = openFillReject(o, ev.height, who, ev.proposalId);
        if (blk) {
          note(ev, ev.txid, "fill", false, blk);
          continue;
        }
        const pt = ev.paidTo ?? {};
        const want = BigInt(o.want.value);
        const fee = o.feeBps ? tradeFee(want, o.feeBps) : 0n;
        const restingLiquidity = o.taker !== void 0 && o.bid !== void 0 || o.height >= V17_HEIGHT && o.taker === void 0;
        const rebate = o.height >= V16_HEIGHT && restingLiquidity ? makerRebate(want) : 0n;
        const need = /* @__PURE__ */ new Map();
        const addNeed = (a, v) => need.set(a, (need.get(a) ?? 0n) + v);
        addNeed(o.want.payto, want);
        addNeed(TREASURY_ADDR, fee);
        if (rebate > 0n) addNeed(o.seller, rebate);
        let unpaid;
        for (const [addr, amt] of need) if (ptAmt(pt[addr]) < amt) {
          unpaid = addr === TREASURY_ADDR ? "protocol fee unpaid" : rebate > 0n && addr === o.seller ? "maker rebate unpaid (v1.6)" : "payment below want.value";
          break;
        }
        if (unpaid) {
          note(ev, ev.txid, "fill", false, unpaid);
          continue;
        }
        const paid = ptAmt(pt[o.want.payto]);
        if (isNameGive(o.give)) {
          const n = names.get(o.give.name);
          if (!n) {
            note(ev, ev.txid, "fill", false, "name vanished (consensus violation)");
            continue;
          }
          deliverNameToBuyer(n, who, ev);
        } else {
          const amt = offerLock.get(o.id);
          if (amt === void 0) {
            note(ev, ev.txid, "fill", false, "offer lock missing");
            continue;
          }
          releaseGiveLock(o, who, amt);
        }
        feesPaid += fee;
        o.status = "filled";
        o.fill = { buyer: who, txid: ev.txid, height: ev.height, paid: paid.toString(), fee: fee.toString() };
        markBidDone(o, who);
        note(ev, ev.txid, "fill", true);
      } else if (ev.height >= V17_HEIGHT && ev.score === SCORE_CLAIM) {
        if (ev.height >= V28_HEIGHT) {
          note(ev, ev.txid, "claim", false, "v2.8: claims are fclaim proposals now");
          continue;
        }
        if (o.status !== "open") {
          note(ev, ev.txid, "claim", false, `offer ${o.status}`);
          continue;
        }
        if (o.taker) {
          note(ev, ev.txid, "claim", false, "taker-bound offer needs no claim");
          continue;
        }
        if (isTokenWant(o.want)) {
          note(ev, ev.txid, "claim", false, "claims are for CSD-priced offers (token offers are no-op-safe)");
          continue;
        }
        if (claimHeld(o, ev.height)) {
          note(ev, ev.txid, "claim", false, "offer already claimed (hold live)");
          continue;
        }
        if (o.claimedBy === who && o.claimUntilHeight !== void 0 && ev.height < o.claimUntilHeight + claimGrace(o) + CLAIM_COOLDOWN_BLOCKS) {
          note(ev, ev.txid, "claim", false, "claim cooldown (you just held this offer)");
          continue;
        }
        let liveN = 0;
        for (const x of offers.values()) if (x.claimedBy === who && claimHeld(x, ev.height)) liveN++;
        if (liveN >= MAX_ACTIVE_CLAIMS) {
          note(ev, ev.txid, "claim", false, `max ${MAX_ACTIVE_CLAIMS} live claims per address`);
          continue;
        }
        o.claimedBy = who;
        o.claimUntilHeight = ev.height + claimWindowAt(ev.height);
        note(ev, ev.txid, "claim", true);
      }
    }
  }
  applyPendingCancels();
  sweepExpired(tipHeight + 1);
  const tokensOut = {};
  for (const [t, tok] of [...tokens.entries()].sort(([a], [b]) => ord(a, b))) tokensOut[t] = { ...tok.meta, minted: tok.minted.toString() };
  const balancesOut = {};
  for (const [t, m] of [...balances.entries()].sort(([a], [b]) => ord(a, b))) {
    const inner = {};
    for (const [a, b] of [...m.entries()].sort(([x], [y]) => ord(x, y))) {
      if (b.available === 0n && b.locked === 0n) continue;
      inner[a] = { available: b.available.toString(), locked: b.locked.toString() };
    }
    if (Object.keys(inner).length) balancesOut[t] = inner;
  }
  const namesOut = {};
  const tipV15 = tipHeight >= V15_HEIGHT;
  const tipV19 = tipHeight >= V19_HEIGHT;
  const tipV25 = tipHeight >= V25_HEIGHT;
  const tipEpoch = epochOf(tipHeight);
  for (const [nm, n] of [...names.entries()].sort(([a], [b]) => ord(a, b))) {
    if (tipV25 && n.pending) {
      namesOut[nm] = { name: nm, owner: n.owner, claimId: n.id, height: n.height, effectiveHeight: n.effHeight, locked: n.locked, pending: true, finalizeBy: n.finalizeBy };
      continue;
    }
    namesOut[nm] = {
      name: nm,
      owner: n.owner,
      claimId: n.id,
      height: n.height,
      effectiveHeight: n.effHeight,
      locked: n.locked,
      ...n.addr ? { addr: n.addr } : {},
      ...n.viaFill ? { viaFill: true } : {},
      // v1.9 profile materialized at v1.9+ tips ONLY (the apply is also gated) → every pre-v1.9 canonical
      // hash stays byte-identical; absent when empty/unset.
      ...tipV19 && n.profile ? { profile: n.profile } : {},
      // lease fields exist only at v1.5+ tips so every pre-v1.5 canonical hash stays pinned
      ...tipV15 ? { paidThroughEpoch: paidThrough(n), ...lapsed(n, tipEpoch) ? { expired: true } : {} } : {}
    };
  }
  const offersOut = {};
  for (const [id, o] of [...offers.entries()].sort(([a], [b]) => ord(a, b))) offersOut[id] = o;
  const bidsOut = {};
  for (const [id, b] of [...bids.entries()].sort(([a], [b2]) => ord(a, b2))) bidsOut[id] = b;
  const recapturesOut = {};
  for (const [nm, r] of [...recaptures.entries()].sort(([a], [b]) => ord(a, b))) recapturesOut[nm] = { owner: r.owner, effectiveHeight: r.effHeight, finalizeBy: r.finalizeBy };
  const fclaimsOut = {};
  for (const [txid2, fc] of [...fclaims.entries()].sort(([a], [b]) => ord(a, b))) if (fc.granted) fclaimsOut[txid2] = { offer: fc.offer, proposer: fc.proposer, expiresEpoch: fc.expiresEpoch, height: fc.height };
  return { tipHeight, tokens: tokensOut, balances: balancesOut, names: namesOut, offers: offersOut, bids: bidsOut, recaptures: recapturesOut, fclaims: fclaimsOut, events: log, feesPaid: feesPaid.toString() };
}
function canonicalState(s) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => ord(a, b)).map(([k, x]) => [k, sortKeys(x)]));
    }
    return v;
  };
  const { events: _events, recaptures: _recaptures, fclaims: _fclaims, ...data } = s;
  return JSON.stringify(sortKeys(data));
}
var CLAIM_ATTACKER_Q = 0.2;
var CLAIM_MIN_DEPTH = 3;
var COMMIT_REVEAL_MIN_DEPTH = 3;
function requiredClaimDepth(valueSats, height) {
  const r = CLAIM_ATTACKER_Q / (1 - CLAIM_ATTACKER_Q);
  const V = Number(valueSats);
  const R = blockReward(height) || INITIAL_REWARD;
  const max = claimWindowAt(height) - 5;
  for (let D = CLAIM_MIN_DEPTH; D <= max; D++) {
    if (Math.pow(r, D) * V <= D * R) return { depth: D, reversalPct: Math.pow(r, D) * 100, capped: false };
  }
  return { depth: max, reversalPct: Math.pow(r, max) * 100, capped: true };
}
function previewFill(offer2, payRaw) {
  const pay = BigInt(payRaw);
  const zero = { deliverable: false, got: 0n, pay: 0n, fee: 0n, rebate: 0n };
  if (offer2.status !== "open") return { ...zero, reason: "not-open" };
  if (isTokenWant(offer2.want)) return { ...zero, reason: "not-csd-priced" };
  const want = BigInt(offer2.want.value);
  const feeBps = offer2.feeBps;
  if (offer2.min !== void 0 && !isNameGive(offer2.give)) {
    const paidSoFar = BigInt(offer2.paid ?? "0");
    const remaining = want - paidSoFar;
    const minV = BigInt(offer2.min);
    const effMin = remaining < minV ? remaining : minV;
    if (pay < effMin) return { ...zero, reason: "below-min" };
    const x = pay < remaining ? pay : remaining;
    const fee2 = feeBps ? tradeFee(x, feeBps) : 0n;
    const giveTotal = BigInt(offer2.give.amount);
    const newPaid = paidSoFar + x;
    const deliveredSoFar = BigInt(offer2.delivered ?? "0");
    const out = giveTotal * newPaid / want - deliveredSoFar;
    if (out === 0n) return { deliverable: false, reason: "zero-delivery", got: 0n, pay: x, fee: fee2, rebate: 0n };
    return { deliverable: true, reason: "ok", got: out, pay: x, fee: fee2, rebate: 0n };
  }
  if (pay < want) return { deliverable: false, reason: "below-min", got: 0n, pay, fee: 0n, rebate: 0n };
  const fee = feeBps ? tradeFee(want, feeBps) : 0n;
  const restingLiquidity = offer2.taker !== void 0 && offer2.bid !== void 0 || offer2.height >= V17_HEIGHT && offer2.taker === void 0;
  const rebate = offer2.height >= V16_HEIGHT && restingLiquidity ? makerRebate(want) : 0n;
  const got = isNameGive(offer2.give) ? 1n : BigInt(offer2.give.amount);
  return { deliverable: true, reason: "ok", got, pay: want, fee, rebate };
}
function requiredFillOutputs(offer2, payRaw) {
  if (isTokenWant(offer2.want)) return [];
  const p = previewFill(offer2, payRaw);
  if (!p.deliverable) return null;
  const need = /* @__PURE__ */ new Map();
  const add = (a, v) => {
    if (v > 0n) {
      const k = a.toLowerCase();
      need.set(k, (need.get(k) ?? 0n) + v);
    }
  };
  add(offer2.want.payto, p.pay);
  add(TREASURY_ADDR, p.fee);
  add(offer2.seller, p.rebate);
  return [...need].map(([to, value]) => ({ to, value }));
}
var FEE_GATE_MARGIN_BLOCKS = 5;
var NAME_FEE_GATES = [V18_HEIGHT, V24_HEIGHT];
var buildFeeHeight = (tip) => {
  const t = Number(tip);
  for (const g of NAME_FEE_GATES) if (t < g && t >= g - FEE_GATE_MARGIN_BLOCKS) return g;
  return t;
};
function isOpenClaimLane(offer2, tip) {
  return tip >= V13_HEIGHT && offer2.taker === void 0 && !isTokenWant(offer2.want);
}
function hasLiveClaim(offer2, me, tip) {
  if (tip < V17_HEIGHT) return false;
  if (offer2.claimedBy === void 0 || offer2.claimUntilHeight === void 0) return false;
  if (offer2.claimedBy.toLowerCase() !== me.toLowerCase()) return false;
  const grace = claimGraceOf(offer2.claimUntilHeight, offer2.claimTxid);
  return tip < offer2.claimUntilHeight + grace;
}
function fillTargetId(offer2, tip) {
  if (tip >= V28_HEIGHT && offer2.claimTxid !== void 0 && offer2.claimUntilHeight !== void 0 && tip < offer2.claimUntilHeight) return offer2.claimTxid;
  return offer2.id;
}
function fillIsSafe(offer2, me, pay, tip) {
  const preview = previewFill(offer2, pay);
  if (offer2.status !== "open") return { safe: false, reason: `offer is ${offer2.status}`, preview };
  if (offer2.taker !== void 0 && offer2.taker.toLowerCase() !== me.toLowerCase())
    return { safe: false, reason: "taker-bound offer \u2014 not bound to you", preview };
  if (isOpenClaimLane(offer2, tip) && !hasLiveClaim(offer2, me, tip))
    return { safe: false, reason: "open CSD offer \u2014 claim it first and fill while your claim is live", preview };
  if (isTokenWant(offer2.want)) return { safe: true, reason: "token-priced \u2014 deliverability is the buyer's balance", preview };
  if (!preview.deliverable) {
    if (preview.reason === "below-min") return { safe: false, reason: "payment is below the offer minimum", preview };
    return { safe: false, reason: "this payment would deliver 0 tokens \u2014 refusing (the CSD would be lost)", preview };
  }
  return { safe: true, reason: "ok", preview };
}
function finalizeWinnerCheck(nameState, me, commitHeight, tip) {
  const m = me.toLowerCase();
  if (!nameState) return { safe: false, reason: "no reservation on-chain (displaced, swept, or never accepted) \u2014 a finalize now would burn the fee" };
  if (nameState.owner?.toLowerCase() !== m) return { safe: false, reason: "an earlier committer won this name \u2014 you were outbid" };
  if (nameState.pending !== true) return { safe: false, reason: "already registered to you \u2014 no second finalize fee is needed" };
  if (Number(nameState.effectiveHeight) !== Number(commitHeight))
    return { safe: false, reason: "your reservation was displaced (effective height changed) \u2014 a finalize now would burn the fee" };
  if (tip !== void 0 && tip !== null && Number.isFinite(Number(tip))) {
    const t = Number(tip);
    const eff = Number(nameState.effectiveHeight);
    const freezeEnd = eff + REG_COMMIT_MAX_BLOCKS;
    const closeAt = eff + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS - FINALIZE_TIP_MARGIN;
    if (t <= freezeEnd + FINALIZE_TIP_MARGIN)
      return { safe: false, reason: `too early \u2014 the displacement contest is not frozen yet (finalizable after block ${freezeEnd + FINALIZE_TIP_MARGIN}, chain tip ${t}); the resolver would reject the finalize after the fee moved, burning it` };
    if (t > closeAt)
      return { safe: false, reason: `this reservation's finalize window has closed (safe until block ${closeAt}, chain tip ${t}); a finalize now would mine past the deadline and burn the fee` };
  }
  return { safe: true, reason: "ok" };
}
var primaryRankBefore = (a, b) => a.effectiveHeight < b.effectiveHeight || a.effectiveHeight === b.effectiveHeight && a.claimId < b.claimId;
function pickPrimaryName(names, a) {
  const q = String(a).toLowerCase();
  let best = null;
  for (const n of names) {
    if (n.owner !== q || n.addr !== q) continue;
    if (n.expired === true || n.locked) continue;
    if (!best || primaryRankBefore(n, best)) best = n;
  }
  return best ? best.name : null;
}
var GAP_NEEDED = EPOCH_LEN * (FCLAIM_MAX_EPOCH_AHEAD + 1) - 1 + CLAIM_COOLDOWN_BLOCKS;
var SCAN_MARGIN = EPOCH_LEN;
var MAX_SCAN = GAP_NEEDED + SCAN_MARGIN;
function bindRecord(ev) {
  const rec = parseRecord(ev.uri, ev.payloadHash);
  if (!rec) return null;
  if (payloadHash(rec).toLowerCase() !== String(ev.payloadHash).toLowerCase()) return null;
  return rec;
}
function replayLiveHold(proven, offerId, fclaimTxid, me, evalHeight) {
  const events = proven.map(({ depth: _depth, ...e }) => e);
  const state = resolve(events, evalHeight);
  const offer2 = state.offers[offerId.toLowerCase()] ?? state.offers[offerId];
  const granted = state.fclaims[fclaimTxid.toLowerCase()] !== void 0 || state.fclaims[fclaimTxid] !== void 0;
  const routed = !!offer2 && offer2.claimTxid !== void 0 && offer2.claimTxid.toLowerCase() === fclaimTxid.toLowerCase();
  const heldByMe = !!offer2 && offer2.status === "open" && hasLiveClaim(offer2, me, evalHeight);
  return { state, offer: offer2, granted, routed, heldByMe };
}
async function verifyFillSpv(offerId, fclaimTxid, me, io, opts) {
  const no = (reason) => ({ safe: false, reason });
  let tip;
  try {
    tip = Number(await io.tip());
  } catch {
    return no("could not read a PoW-verified tip");
  }
  if (!Number.isFinite(tip)) return no("no PoW-verified tip");
  const depthOf = (ev) => Math.min(Number(ev.depth), tip - Number(ev.height) + 1);
  let hintIds;
  try {
    hintIds = await io.offerEventIds(offerId, fclaimTxid);
  } catch {
    return no("could not enumerate the offer's events");
  }
  const want = /* @__PURE__ */ new Set([offerId.toLowerCase(), fclaimTxid.toLowerCase(), ...(hintIds ?? []).map((x) => String(x).toLowerCase())]);
  const proven = [];
  for (const wid of want) {
    let ev;
    try {
      ev = await io.provenEvent(wid);
    } catch {
      ev = null;
    }
    if (ev && (ev.kind === "propose" ? ev.id : ev.txid).toLowerCase() === wid) proven.push(ev);
  }
  const isProp = (e) => e.kind === "propose";
  const offerEv = proven.find((e) => isProp(e) && e.id.toLowerCase() === offerId.toLowerCase());
  const fclaimEv = proven.find((e) => isProp(e) && e.id.toLowerCase() === fclaimTxid.toLowerCase());
  if (!offerEv) return no("offer not merkle-proven (no PoW-verified offer Propose)");
  if (!fclaimEv) return no("fclaim not merkle-proven (no PoW-verified fclaim Propose)");
  if (fclaimEv.height < V28_HEIGHT) return no("fclaim mined below the V28 gate (no fclaim lane there)");
  const offerRec = bindRecord(offerEv);
  const fclaimRec = bindRecord(fclaimEv);
  if (!offerRec || offerRec.t !== "offer") return no("offer record does not bind to its on-chain commitment");
  if (!fclaimRec || fclaimRec.t !== "fclaim") return no("fclaim record does not bind to its on-chain commitment");
  if (fclaimRec.offer.toLowerCase() !== offerId.toLowerCase()) return no("fclaim does not reference this offer");
  if (isTokenWant(offerRec.want)) return no("the fclaim lane is CSD-priced offers only");
  const wantValue = BigInt(offerRec.want.value);
  const E = Number(fclaimEv.expiresEpoch);
  const need = requiredClaimDepth(wantValue, offerEv.height).depth;
  if (!(depthOf(offerEv) >= need)) return no(`offer not buried deep enough yet (${depthOf(offerEv)} < ${need}) - wait`);
  if (!(depthOf(fclaimEv) >= need)) return no(`fclaim not buried deep enough yet (${depthOf(fclaimEv)} < ${need}) - wait`);
  const laneIds = /* @__PURE__ */ new Set([offerId.toLowerCase()]);
  for (const e of proven) {
    if (!isProp(e)) continue;
    const r2 = e.id.toLowerCase() === fclaimTxid.toLowerCase() ? fclaimRec : bindRecord(e);
    if (r2 && r2.t === "fclaim" && r2.offer.toLowerCase() === offerId.toLowerCase()) laneIds.add(e.id.toLowerCase());
  }
  for (const e of proven) {
    if (e.kind === "attest" && e.score === SCORE_FILL && laneIds.has(e.proposalId.toLowerCase()) && !(depthOf(e) >= need))
      return no(`an earlier fill-basis event is not buried deep enough yet (${depthOf(e)} < ${need}) - wait`);
  }
  const r = replayLiveHold(proven, offerId, fclaimTxid, me, tip);
  if (!r.offer) return no("the offer does not resolve from the proven events (unknown/rejected offer)");
  if (!Number.isInteger(opts.myLiveHoldsAtGrant) || opts.myLiveHoldsAtGrant < 0)
    return no("the caller must assert myLiveHoldsAtGrant (the buyer's concurrent other-offer live-hold count) for the cap check");
  if (opts.myLiveHoldsAtGrant >= MAX_ACTIVE_CLAIMS) return no("you held the max active claims when this fclaim was granted - the resolver denied it on the cap, refusing (the payment would burn)");
  if (!(r.routed && r.granted)) return no("this fclaim is not the live granted hold (denied or superseded) - refusing, the payment would burn");
  if (!r.heldByMe) return no("no live claim by you on an open offer (cancelled, lapsed, or not your hold) - refusing");
  let pay;
  try {
    pay = opts.pay !== void 0 ? BigInt(opts.pay) : wantValue;
  } catch {
    return no("invalid pay amount");
  }
  const dp = previewFill({ ...r.offer, status: "open" }, pay);
  if (!dp.deliverable || dp.got < 1n) return no("this fill would deliver 0 units - refusing (the CSD would be lost)");
  const holdEnd = fclaimHoldEnd(E);
  if (holdEnd < tip + FILL_TIP_MARGIN) return no(`too close to the hold deadline (holdEnd ${holdEnd}, tip ${tip}) - would strand`);
  return { safe: true, reason: "ok" };
}
var feeBpsAt = (height) => height >= V11_HEIGHT ? height >= V16_HEIGHT ? FEE_BPS_V16 : FEE_BPS : 0;
function provenOfferTerms(offerRec, provenHeight) {
  const w = offerRec.want;
  return {
    height: Number(provenHeight),
    feeBps: feeBpsAt(Number(provenHeight)),
    value: w.value !== void 0 ? String(w.value) : void 0,
    taker: offerRec.taker !== void 0 ? String(offerRec.taker).toLowerCase() : void 0,
    bid: offerRec.bid !== void 0 ? String(offerRec.bid).toLowerCase() : void 0,
    min: offerRec.min !== void 0 ? String(offerRec.min) : void 0
  };
}
function bindOfferTerms(servedOffer, t) {
  const o = servedOffer;
  const s = (v) => v === void 0 || v === null ? "" : String(v).toLowerCase();
  if (Number(o?.height) !== t.height) return true;
  if (Number(o?.feeBps) !== t.feeBps) return true;
  if (t.value !== void 0 && String(o?.want?.value) !== t.value) return true;
  if (s(o?.taker) !== s(t.taker)) return true;
  if (s(o?.bid) !== s(t.bid)) return true;
  const om = o?.min;
  if ((om !== void 0 && om !== null) !== (t.min !== void 0)) return true;
  if (t.min !== void 0 && String(om) !== t.min) return true;
  return false;
}
function bindProvenOffer(offerEv) {
  const rec = bindRecord(offerEv);
  if (!rec || rec.t !== "offer") return null;
  const seller = String(offerEv.proposer).toLowerCase();
  const w = rec.want;
  const payto = w.payto && ADDR_RE.test(String(w.payto).toLowerCase()) ? String(w.payto).toLowerCase() : seller;
  return { payto, seller, terms: provenOfferTerms(rec, offerEv.height) };
}
function paidToFromOutputs(outputs) {
  const m = /* @__PURE__ */ Object.create(null);
  for (const o of outputs) {
    if (typeof o.value !== "number" || !Number.isSafeInteger(o.value) || o.value < 0) continue;
    m[o.addr] = (BigInt(m[o.addr] ?? "0") + BigInt(o.value)).toString();
  }
  return m;
}
export {
  ACTIVATION_HEIGHT,
  ADDR_RE,
  AMOUNT_RE,
  BID_KEYS,
  CLAIM_ATTACKER_Q,
  CLAIM_COOLDOWN_BLOCKS,
  CLAIM_FILL_GRACE_BLOCKS,
  CLAIM_MIN_DEPTH,
  CLAIM_WINDOW_BLOCKS,
  CLAIM_WINDOW_BLOCKS_V20,
  COMMIT_MAX_BLOCKS,
  COMMIT_REVEAL_MIN_DEPTH,
  CONF_TOKEN_FILL,
  CsdClient,
  DEPLOY_FEE,
  DEPLOY_KEYS,
  DOMAIN,
  EPOCH_LEN,
  FCLAIM_KEYS,
  FCLAIM_MAX_EPOCH_AHEAD,
  FEE_BPS,
  FEE_BPS_V16,
  FEE_GATE_MARGIN_BLOCKS,
  FILL_TIP_MARGIN,
  FINALIZE_TIP_MARGIN,
  GAP_NEEDED,
  HALVING_INTERVAL,
  HASH_RE,
  INITIAL_REWARD,
  LightClient,
  MAX_ACTIVE_CLAIMS,
  MAX_AMOUNT,
  MAX_OFFER_EPOCHS,
  MAX_PENDING_REG,
  MAX_RECORD_BYTES,
  MAX_SCAN,
  MINT_KEYS,
  MIN_FEE_ATTEST,
  MIN_FEE_PROPOSE,
  NAME_FEE_LEN3_V24,
  NAME_FEE_LEN4_V24,
  NAME_FEE_LONG_V24,
  NAME_FEE_MID_V24,
  NAME_FEE_SHORT_V18,
  NAME_FEE_V18,
  NAME_GRACE_EPOCHS,
  NAME_KEYS,
  NAME_PREMIUM_DECAY_EPOCHS,
  NAME_PREMIUM_START,
  NAME_RE,
  NAME_TERM_EPOCHS,
  NFINALIZE_KEYS,
  NPROFILE_KEYS,
  OFFER_KEYS,
  PKEY,
  PROFILE_MAX_KEYS,
  PROFILE_MAX_VALUE_BYTES,
  REBATE_BPS,
  REBATE_FLAT,
  REG_COMMIT_MAX_BLOCKS,
  REG_FINALIZE_GRACE_BLOCKS,
  RESERVED_NAMES,
  SALT_RE,
  SCAN_MARGIN,
  SCORE_CANCEL,
  SCORE_CLAIM,
  SCORE_FILL,
  TICKER_RE,
  TRANSFER_KEYS,
  TREASURY_ADDR,
  V11_HEIGHT,
  V12_HEIGHT,
  V13_HEIGHT,
  V14_HEIGHT,
  V15_HEIGHT,
  V16_HEIGHT,
  V17_HEIGHT,
  V18_HEIGHT,
  V19_HEIGHT,
  V20_HEIGHT,
  V21_HEIGHT,
  V22_HEIGHT,
  V23_HEIGHT,
  V24_HEIGHT,
  V25_HEIGHT,
  V26_HEIGHT,
  V27_HEIGHT,
  V28_HEIGHT,
  ZERO_ADDR,
  addrFromPub,
  bid,
  bindOfferTerms,
  bindProvenOffer,
  blockReward,
  buildFeeHeight,
  buildRecord,
  canonicalJson,
  canonicalState,
  claimGraceOf,
  claimWindowAt,
  claimWindowOf,
  deploy,
  epochOf,
  expiredClaimFee,
  fclaim,
  fclaimEpochFor,
  fclaimHoldEnd,
  feeBpsAt,
  fillIsSafe,
  fillTargetId,
  finalizeWinnerCheck,
  hasLiveClaim,
  isName,
  isNameGive,
  isOpenClaimLane,
  isTokenWant,
  makerRebate,
  merkleRoot,
  mint,
  nameClaim,
  nameCommit,
  nameCommitRecord,
  nameFinalize,
  nameProfile,
  nameRegFee,
  nameRenew,
  nameSet,
  nameXfer,
  offer,
  offerCancelAll,
  offerExpiryHeightOf,
  paidToFromOutputs,
  parseAmount,
  parseRecord,
  payloadHash,
  pickPrimaryName,
  previewFill,
  primaryRankBefore,
  provenOfferTerms,
  recoverSigner,
  replayLiveHold,
  requiredClaimDepth,
  requiredFillOutputs,
  resolve,
  rpcTxToTx,
  sighash,
  tokenMeta,
  tradeFee,
  transfer,
  txid,
  verifyDigest,
  verifyFillSpv,
  verifyMerkleProof
};
