import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionPrefix, decodeRowKey, encodeRowKey, hasPrefix, jsonCodec } from "../src/keys.ts";

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a].map((c) => c.codePointAt(0)!);
  const y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

function numbers(rand: () => number): number[] {
  const bits = new DataView(new ArrayBuffer(8));
  const out = [0, -0, 1, -1, 0.5, -0.5, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE];
  out.push(Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 53 + 2, -(2 ** 31));
  for (let i = 0; i < 2000; i++) {
    bits.setUint32(0, rand() * 2 ** 32);
    bits.setUint32(4, rand() * 2 ** 32);
    const n = bits.getFloat64(0);
    if (!Number.isNaN(n)) out.push(n);
    out.push(Math.round((rand() - 0.5) * 2000));
  }
  return out;
}

function strings(rand: () => number): string[] {
  const out = ["", "1", "a", "ab", "b", "\u0000", "￿", "😀", "퟿", ""];
  for (let i = 0; i < 2000; i++) {
    let s = "";
    const len = Math.floor(rand() * 6);
    for (let j = 0; j < len; j++) {
      const pick = rand();
      const cp = pick < 0.5 ? Math.floor(rand() * 128) : pick < 0.8 ? Math.floor(rand() * 0xd800) : 0x10000 + Math.floor(rand() * 0xfffff);
      s += String.fromCodePoint(cp);
    }
    out.push(s);
  }
  return out;
}

const prefix = collectionPrefix("todos");

test("every number and string key round-trips", () => {
  const rand = random(1);
  for (const n of numbers(rand)) assert.ok(Object.is(decodeRowKey(prefix, encodeRowKey(prefix, n)), n === 0 ? 0 : n), `${n}`);
  for (const s of strings(rand)) assert.equal(decodeRowKey(prefix, encodeRowKey(prefix, s)), s);
});

test("-0 is stored as 0 and every NaN as one NaN", () => {
  assert.deepEqual(encodeRowKey(prefix, -0), encodeRowKey(prefix, 0));
  const other = new DataView(new ArrayBuffer(8));
  other.setUint32(0, 0xfff00000);
  other.setUint32(4, 1);
  const payloadNaN = other.getFloat64(0);
  assert.ok(Number.isNaN(payloadNaN));
  assert.deepEqual(encodeRowKey(prefix, payloadNaN), encodeRowKey(prefix, NaN));
  assert.ok(Number.isNaN(decodeRowKey(prefix, encodeRowKey(prefix, NaN))));
});

test("the number 1 and the string \"1\" are different keys", () => {
  const one = encodeRowKey(prefix, 1);
  const text = encodeRowKey(prefix, "1");
  assert.notDeepEqual(one, text);
  assert.equal(decodeRowKey(prefix, one), 1);
  assert.equal(decodeRowKey(prefix, text), "1");
});

test("key bytes sort as numbers by value, strings by code point, numbers before strings", () => {
  const rand = random(2);
  const ns = numbers(rand);
  for (let i = 0; i + 1 < ns.length; i++) {
    const [a, b] = [ns[i]!, ns[i + 1]!];
    assert.equal(sign(compareBytes(encodeRowKey(prefix, a), encodeRowKey(prefix, b))), sign(a - b), `${a} vs ${b}`);
  }
  const ss = strings(rand);
  for (let i = 0; i + 1 < ss.length; i++) {
    const [a, b] = [ss[i]!, ss[i + 1]!];
    assert.equal(sign(compareBytes(encodeRowKey(prefix, a), encodeRowKey(prefix, b))), sign(compareCodePoints(a, b)));
  }
  assert.ok(compareBytes(encodeRowKey(prefix, Infinity), encodeRowKey(prefix, "")) < 0);
  assert.ok(compareBytes(encodeRowKey(prefix, NaN), encodeRowKey(prefix, "")) < 0);
});

test("a collection's prefix never prefixes another's keys", () => {
  const todo = collectionPrefix("todo");
  const todos = collectionPrefix("todos");
  assert.equal(hasPrefix(todo, encodeRowKey(todos, "x")), false);
  assert.equal(hasPrefix(todos, encodeRowKey(todo, "sx")), false);
  assert.equal(hasPrefix(todo, encodeRowKey(todo, "x")), true);
  assert.throws(() => decodeRowKey(todo, encodeRowKey(todos, "x")));
});

test("rejects what it cannot round-trip and bytes it did not write", () => {
  assert.throws(() => collectionPrefix("a\ud800"), TypeError);
  assert.throws(() => encodeRowKey(prefix, "\udc00b"), TypeError);
  assert.throws(() => encodeRowKey(prefix, true as unknown as string), TypeError);
  assert.throws(() => collectionPrefix("x".repeat(0x10000)), RangeError);
  const tagged = (...body: number[]) => Uint8Array.of(...prefix, ...body);
  assert.throws(() => decodeRowKey(prefix, tagged(0x03, 0x61)));
  assert.throws(() => decodeRowKey(prefix, tagged(0x01, 0, 0, 0)));
  assert.throws(() => decodeRowKey(prefix, tagged(0x02, 0xff)));
  assert.throws(() => decodeRowKey(prefix, prefix));
});

test("jsonCodec round-trips a row", () => {
  const codec = jsonCodec<{ id: string; n: number; tags: string[] }>();
  const row = { id: "é😀", n: 1.5, tags: ["a"] };
  assert.deepEqual(codec.decode(codec.encode(row)), row);
});
