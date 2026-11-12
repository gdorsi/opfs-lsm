/**
 * Byte mutations for the decoder properties, as fast-check arbitraries so a
 * failure shrinks to the fewest, smallest changes. Positions are fractions
 * of the input length, so one mutation applies to any input.
 */
import fc from "fast-check";
import type { SstEntry } from "../src/store/sst.js";

export type Mutation =
  | { readonly kind: "flip"; readonly at: number; readonly bit: number }
  | { readonly kind: "truncate"; readonly at: number }
  | { readonly kind: "extend"; readonly bytes: Uint8Array }
  /** Overwrite a u32 with a large value: a length or count field inflated. `field` 0-7 aims at that footer field. */
  | { readonly kind: "inflate"; readonly at: number; readonly field: number; readonly value: number }
  /** Add a small delta to a u32: a count or offset off by a little. `field` 0-7 aims at that footer field. */
  | { readonly kind: "nudge"; readonly at: number; readonly field: number; readonly delta: number }
  /** Overwrite five bytes with a varint near 2^32. */
  | { readonly kind: "varint"; readonly at: number }
  /** A run of 0x00 or 0xff, as a zeroed or erased page reads. */
  | { readonly kind: "fill"; readonly at: number; readonly n: number; readonly byte: number }
  /** Keep the head of the input and append the tail of another valid input. */
  | { readonly kind: "splice"; readonly at: number; readonly from: number };

/** Unbiased: fast-check otherwise favours 0 and 1, the ends of the input. */
const frac = fc.noBias(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }));
/** A footer field (0-7), or -1 for anywhere in the input. */
const field = fc.oneof(fc.constant(-1), fc.integer({ min: 0, max: 7 }));

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ kind: fc.constant("flip" as const), at: frac, bit: fc.integer({ min: 0, max: 7 }) }),
  fc.record({ kind: fc.constant("truncate" as const), at: frac }),
  fc.record({ kind: fc.constant("extend" as const), bytes: fc.uint8Array({ minLength: 1, maxLength: 48 }) }),
  fc.record({
    kind: fc.constant("inflate" as const),
    at: frac,
    field,
    value: fc.constantFrom(0xffffffff, 0x7fffffff, 0x01000000, 0x00100000, 0x10000),
  }),
  fc.record({ kind: fc.constant("nudge" as const), at: frac, field, delta: fc.constantFrom(-16, -2, -1, 1, 2, 16) }),
  fc.record({ kind: fc.constant("varint" as const), at: frac }),
  fc.record({ kind: fc.constant("fill" as const), at: frac, n: fc.integer({ min: 1, max: 64 }), byte: fc.constantFrom(0, 0xff) }),
  fc.record({ kind: fc.constant("splice" as const), at: frac, from: frac }),
);

export const mutationsArb = fc.array(mutationArb, { minLength: 1, maxLength: 3 });

/** `buf` with `m` applied. `other` is the second input a splice takes its tail from. */
function applyMutation(buf: Uint8Array, m: Mutation, other: Uint8Array): Uint8Array {
  const len = buf.byteLength;
  const pos = (f: number, room = 0) => Math.min(Math.max(0, len - room), Math.floor(f * (len - room + 1)));
  switch (m.kind) {
    case "flip": {
      if (len === 0) return buf;
      const out = buf.slice();
      out[pos(m.at, 1)]! ^= 1 << m.bit;
      return out;
    }
    case "truncate":
      return buf.slice(0, pos(m.at));
    case "extend": {
      const out = new Uint8Array(len + m.bytes.byteLength);
      out.set(buf);
      out.set(m.bytes, len);
      return out;
    }
    case "inflate": {
      if (len < 4) return buf;
      const out = buf.slice();
      const at = m.field >= 0 && len >= 44 ? len - 44 + 4 * m.field : pos(m.at, 4);
      new DataView(out.buffer).setUint32(at, m.value >>> 0, true);
      return out;
    }
    case "nudge": {
      if (len < 4) return buf;
      const out = buf.slice();
      const at = m.field >= 0 && len >= 44 ? len - 44 + 4 * m.field : pos(m.at, 4);
      const view = new DataView(out.buffer);
      view.setUint32(at, (view.getUint32(at, true) + m.delta) >>> 0, true);
      return out;
    }
    case "varint": {
      if (len < 5) return buf;
      const out = buf.slice();
      out.set([0xf0, 0xff, 0xff, 0xff, 0x0f], pos(m.at, 5));
      return out;
    }
    case "fill": {
      if (len === 0) return buf;
      const out = buf.slice();
      const at = pos(m.at, 1);
      out.fill(m.byte, at, Math.min(len, at + m.n));
      return out;
    }
    case "splice": {
      const head = buf.subarray(0, pos(m.at));
      const tail = other.subarray(Math.floor(m.from * (other.byteLength + 1)));
      const out = new Uint8Array(head.byteLength + tail.byteLength);
      out.set(head);
      out.set(tail, head.byteLength);
      return out;
    }
  }
}

export function applyMutations(buf: Uint8Array, ms: readonly Mutation[], other: Uint8Array): Uint8Array {
  return ms.reduce((b, m) => applyMutation(b, m, other), buf);
}

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

const keyUnit = fc.constantFrom(..."ab/0129".split(""));

/**
 * Sorted, unique entries for a run: short keys under a shared head so
 * blocks store a prefix, puts and tombstones, values that sometimes hold
 * " hot", and now and then one value larger than a block.
 */
export const entriesArb: fc.Arbitrary<SstEntry[]> = fc
  .uniqueArray(
    fc.record({
      key: fc.string({ unit: keyUnit, maxLength: 10 }),
      del: fc.boolean(),
      value: fc.oneof(
        { weight: 8, arbitrary: fc.uint8Array({ maxLength: 24 }) },
        { weight: 2, arbitrary: fc.constant(new TextEncoder().encode('{"tag":" hot"}')) },
        { weight: 1, arbitrary: fc.integer({ min: 4097, max: 6000 }).map((n) => new Uint8Array(n).fill(0x68)) },
      ),
      seq: fc.integer({ min: 0, max: 2 ** 40 }),
      expiresAt: fc.option(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), { nil: undefined, freq: 4 }),
    }),
    { selector: (e) => e.key, maxLength: 80 },
  )
  .map((rows) =>
    rows.map((r): SstEntry => {
      const key = new TextEncoder().encode(`t/${r.key}`);
      if (r.del) return { kind: "del", key, seq: r.seq };
      return { kind: "put", key, value: r.value, seq: r.seq, ...(r.expiresAt === undefined ? {} : { expiresAt: r.expiresAt }) };
    }),
  );
