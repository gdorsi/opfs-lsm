/**
 * Deterministic data and the correctness oracle, in one structure.
 *
 * Key ids are integers. A key is `keyBytes` bytes: a filler prefix and the
 * id as big-endian u32 at the end, so key order is id order and fillseq is
 * truly ascending. A value is a pure function of (id, version):
 *
 *   [id u32][version u32][pseudo-random bytes][repeated filler byte]
 *
 * so the expected state is one Uint32Array of versions (0 = absent). Every
 * read is checked against it, and the live-bytes figure for space
 * amplification comes from the same array, so the oracle and the
 * denominator cannot disagree.
 */
import type { Params } from "../core/types.ts";

export class CorrectnessError extends Error {
  override name = "CorrectnessError";
}

export type Model = {
  readonly params: Params;
  key(id: number): Uint8Array;
  /** A key no write ever stores that sorts between `key(id)` and `key(id + 1)`: `key(id)` and one more byte (db_bench's missing keys). */
  missKey(id: number): Uint8Array;
  /** Current version of `id`; 0 when absent. */
  version(id: number): number;
  /** Bump the version of `id` and return the new version (for workloads that build their own values). */
  bump(id: number): number;
  /** Bump the version of `id` and return the bytes to write. */
  nextValue(id: number): Uint8Array;
  /** The value the store must hold for `id` now (undefined when absent). */
  expected(id: number): Uint8Array | undefined;
  /** Record a delete. */
  remove(id: number): void;
  /** Throws unless `got` is what the model expects for `id`. */
  verify(id: number, got: Uint8Array | undefined): void;
  /** Throws unless `got` is the current value of some live key; returns its id. */
  verifyAny(got: Uint8Array): number;
  /** The smallest live id at or after `from`; undefined when there is none. */
  nextLive(from: number): number | undefined;
  /** One past the highest id ever written. */
  readonly end: number;
  liveKeys(): number;
  liveLogicalBytes(): number;
  carry(): string;
};

const KEY_FILL = 0x6b; // "k"
const VALUE_FILL = 0x78; // "x"

export function createModel(params: Params, carried?: string): Model {
  const versions = carried ? decode(carried) : { v: new Uint32Array(Math.max(16, params.entries * 2)), end: 0 };
  let v = versions.v;
  let end = versions.end;
  const { keyBytes, valueBytes, compressibility } = params;
  const randomBytes = Math.max(0, Math.round((valueBytes - 8) * (1 - compressibility)));
  const usable = () => {
    if (keyBytes < 4 || valueBytes < 8) throw new Error("the key/value model needs keys ≥ 4 bytes and values ≥ 8");
  };

  const grow = (id: number) => {
    if (id < v.length) return;
    const next = new Uint32Array(Math.max(v.length * 2, id + 1));
    next.set(v);
    v = next;
  };

  const key = (id: number) => {
    usable();
    const k = new Uint8Array(keyBytes);
    k.fill(KEY_FILL, 0, keyBytes - 4);
    new DataView(k.buffer).setUint32(keyBytes - 4, id);
    return k;
  };

  const missKey = (id: number) => {
    const k = new Uint8Array(keyBytes + 1);
    k.set(key(id));
    return k;
  };

  const valueOf = (id: number, version: number) => {
    usable();
    const out = new Uint8Array(valueBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, id);
    view.setUint32(4, version);
    let s = (Math.imul(id, 0x9e3779b1) ^ Math.imul(version, 0x85ebca6b)) >>> 0;
    for (let i = 8; i < 8 + randomBytes; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      out[i] = s & 0xff;
    }
    out.fill(VALUE_FILL, 8 + randomBytes);
    return out;
  };

  const headerOf = (got: Uint8Array) => {
    if (got.byteLength !== valueBytes) throw new CorrectnessError(`value of ${got.byteLength} bytes, want ${valueBytes}`);
    const view = new DataView(got.buffer, got.byteOffset, got.byteLength);
    return { id: view.getUint32(0), version: view.getUint32(4) };
  };

  const model: Model = {
    params,
    key,
    missKey,
    version: (id) => v[id] ?? 0,
    bump(id) {
      grow(id);
      const version = (v[id] ?? 0) + 1;
      v[id] = version;
      if (id >= end) end = id + 1;
      return version;
    },
    nextValue(id) {
      return valueOf(id, model.bump(id));
    },
    expected(id) {
      const version = v[id] ?? 0;
      return version === 0 ? undefined : valueOf(id, version);
    },
    remove(id) {
      if (id < v.length) v[id] = 0;
    },
    verify(id, got) {
      const want = v[id] ?? 0;
      if (got === undefined) {
        if (want !== 0) throw new CorrectnessError(`key ${id}: missing, want version ${want}`);
        return;
      }
      const h = headerOf(got);
      if (h.id !== id || h.version !== want) {
        throw new CorrectnessError(`key ${id}: got id ${h.id} version ${h.version}, want version ${want}`);
      }
    },
    verifyAny(got) {
      const h = headerOf(got);
      if (h.version === 0 || v[h.id] !== h.version) {
        throw new CorrectnessError(`scan: id ${h.id} version ${h.version} is not live`);
      }
      return h.id;
    },
    nextLive(from) {
      for (let id = from; id < end; id++) if (v[id] !== 0) return id;
      return undefined;
    },
    get end() {
      return end;
    },
    liveKeys() {
      let n = 0;
      for (let i = 0; i < end; i++) if (v[i] !== 0) n++;
      return n;
    },
    liveLogicalBytes() {
      return model.liveKeys() * (keyBytes + valueBytes);
    },
    carry() {
      return encode(v, end);
    },
  };
  return model;
}

function encode(v: Uint32Array, end: number): string {
  const bytes = new Uint8Array(v.buffer, 0, end * 4);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `${v.length}:${end}:${btoa(bin)}`;
}

function decode(s: string): { v: Uint32Array; end: number } {
  const [len, end, b64] = s.split(":");
  const v = new Uint32Array(Number(len));
  const bin = atob(b64 ?? "");
  const bytes = new Uint8Array(v.buffer);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { v, end: Number(end) };
}

/** Seeded PRNG (splitmix32) returning [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 0x1_0000_0000;
  };
}

/** Hash of strings and numbers into a seed. */
export function seedOf(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("\u0000")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A Fisher-Yates permutation of [0, n). */
export function permutation(n: number, next: () => number): Uint32Array {
  const p = new Uint32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  return p;
}

/** YCSB's ScrambledZipfianGenerator draws from this many items whatever the key count, with this zeta(ITEM_COUNT, 0.99). */
const SCRAMBLED_ITEMS = 10_000_000_000;
const SCRAMBLED_ZETAN = 26.46902820178302;

/**
 * YCSB ScrambledZipfian over [0, n): zipfian with theta 0.99 over 10^10 items, then FNV-hashed into
 * [0, n) so hot keys spread over the key space. The skew is that of 10^10 items, not of n: the hottest
 * key takes 1 / 26.47 of the draws (3.8%) at any n, where a zipfian over n items takes more, and more the smaller n is.
 */
export function zipfian(n: number, next: () => number): () => number {
  const z = zipfRaw(SCRAMBLED_ITEMS, next, SCRAMBLED_ZETAN);
  return () => fnv64mod(z(), n);
}

/**
 * Zipfian with theta 0.99 over a small set, every item reachable: ranks map
 * to items through a seeded permutation. `zipfian` hashes ranks instead,
 * which collides when n is small and leaves some items never picked.
 */
export function zipfianOf(n: number, next: () => number): () => number {
  const items = permutation(n, next);
  const z = zipfRaw(n, next);
  return () => items[z()]!;
}

function zipfRaw(n: number, next: () => number, known?: number): () => number {
  const theta = 0.99;
  let zetan = known ?? 0;
  if (known === undefined) for (let i = 1; i <= n; i++) zetan += 1 / Math.pow(i, theta);
  const zeta2 = 1 + 1 / Math.pow(2, theta);
  const alpha = 1 / (1 - theta);
  const eta = (1 - Math.pow(2 / n, 1 - theta)) / (1 - zeta2 / zetan);
  return () => {
    const u = next();
    const uz = u * zetan;
    if (uz < 1) return 0;
    if (uz < 1 + Math.pow(0.5, theta)) return 1;
    return Math.floor(n * Math.pow(eta * u - eta + 1, alpha)) % n;
  };
}

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 1099511628211n;

/** YCSB's Utils.fnvhash64 of the 8 bytes of `x`, least significant first, as a signed long's absolute value, mod `n`. */
function fnv64mod(x: number, n: number): number {
  let rest = BigInt(x);
  let h = FNV_OFFSET_64;
  for (let i = 0; i < 8; i++) {
    h ^= rest & 0xffn;
    rest >>= 8n;
    h = BigInt.asUintN(64, h * FNV_PRIME_64);
  }
  const signed = BigInt.asIntN(64, h);
  return Number((signed < 0n ? -signed : signed) % BigInt(n));
}
