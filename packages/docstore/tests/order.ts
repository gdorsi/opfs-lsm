import fc from "fast-check";
import type { Scalar } from "../src/schema.js";

/** The documented value order, written from the definition rather than from the encoding. */
export function compareScalar(a: Scalar, b: Scalar): number {
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return compareCodePoints(a, b);
  return 0;
}

function rank(v: Scalar): number {
  if (v === null) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  return typeof v === "number" ? 3 : 4;
}

export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

export function compareTuple(a: readonly Scalar[], b: readonly Scalar[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = compareScalar(a[i]!, b[i]!);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Few distinct characters, so equal strings, prefixes and U+0000 collide often. */
const denseStringArb = fc.string({ unit: fc.constantFrom("\0", "a", "b", "\u{ffff}", "😀"), maxLength: 3 });

export const stringArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: denseStringArb },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 6 }) },
);

export const numberArb: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(-0, 0, 1, -1, 0.5, -0.5, 2 ** 53, -(2 ** 53), Number.MIN_VALUE, -Number.MIN_VALUE),
  fc.constantFrom(Number.MAX_VALUE, -Number.MAX_VALUE),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

export const scalarArb: fc.Arbitrary<Scalar> = fc.oneof(fc.constant(null), fc.boolean(), numberArb, stringArb);

/** Mostly a small pool of values, so random entries share values and random queries hit them. */
export const denseScalarArb: fc.Arbitrary<Scalar> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom<Scalar>(null, false, true, -0, 0, 1, -1, 0.5) },
  { weight: 6, arbitrary: denseStringArb },
  { weight: 1, arbitrary: scalarArb },
);
