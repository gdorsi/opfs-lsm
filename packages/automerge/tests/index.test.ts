import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ClosedError, ConstraintError } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { decodeKey, encodeKey, kvStorage } from "../src/index.ts";

const SEED = 0x5eed;
const ITERATIONS = 5_000;

function dbName(): string {
  return `am${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segmentsStartWith(key: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (key[i] !== prefix[i]) return false;
  }
  return true;
}

function bytesStartWith(key: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.byteLength > key.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) {
    if (key[i] !== prefix[i]) return false;
  }
  return true;
}

function segment(rand: () => number, i: number): string {
  if (i % 1000 === 0) return "x".repeat(65_535);
  const kind = rand();
  if (kind < 0.12) return "";
  if (kind < 0.24) return `nul-\u0000-${i}`;
  if (kind < 0.36) return `astral-\u{1F680}-${i}`;
  const n = 1 + Math.floor(rand() * 8);
  let text = "";
  for (let j = 0; j < n; j++) {
    text += String.fromCharCode(32 + Math.floor(rand() * 90));
  }
  return text;
}

function assertPrefixIff(key: readonly string[], prefix: readonly string[]): void {
  const encodedKey = encodeKey(key);
  const encodedPrefix = encodeKey(prefix);
  assert.equal(
    bytesStartWith(encodedKey, encodedPrefix),
    segmentsStartWith(key, prefix),
  );
}

test("codec prefix iff and round-trip", () => {
  const rand = mulberry32(SEED);
  for (let i = 0; i < ITERATIONS; i++) {
    const count = 1 + Math.floor(rand() * 4);
    const key = Array.from({ length: count }, () => segment(rand, i));
    assert.deepEqual(decodeKey(encodeKey(key)), key);
    const cut = Math.floor(rand() * (key.length + 1));
    assertPrefixIff(key, key.slice(0, cut));
    if (key.length > 0) {
      const last = key[key.length - 1] ?? "";
      const sibling =
        last.length >= 65_535 ? `${last.slice(0, -1)}Y` : `${last}X`;
      assertPrefixIff(key, key.slice(0, -1).concat(sibling));
    }
    if (i % 500 === 0) {
      assert.throws(() => encodeKey(["ok", "\uD800"]), Error);
      assert.throws(() => encodeKey(["\uDC00"]), Error);
      assert.throws(() => encodeKey(["\uD800a"]), Error);
    }
  }
  assertPrefixIff(["doc", "snapshot", "h"], ["doc", "snapshot"]);
  assertPrefixIff(["doc", "snapshotX"], ["doc", "snapshot"]);
  assertPrefixIff(["docX", "snapshot"], ["doc"]);
  assert.equal(
    bytesStartWith(encodeKey(["doc", "snapshot"]), encodeKey(["doc", "snapshotX"])),
    false,
  );
  assert.equal(bytesStartWith(encodeKey(["docX"]), encodeKey(["doc"])), false);
  assert.throws(() => encodeKey(["y".repeat(65_536)]), Error);
  assert.deepEqual(decodeKey(encodeKey([])), []);
  assert.throws(() => decodeKey(Uint8Array.of(0)), Error);
  assert.throws(() => decodeKey(Uint8Array.of(0, 4, 1)), Error);
  assert.throws(() => decodeKey(Uint8Array.of(0, 1, 0xff)), Error);
});

test("save, load, loadRange, and caller-buffer alias", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const storage = kvStorage(db);
  const doc = "doc";
  try {
    assert.equal(await storage.load(["missing"]), undefined);

    const first = Uint8Array.of(1, 2, 3);
    await storage.save(["k"], first);
    const loaded = await storage.load(["k"]);
    assert.ok(loaded);
    assert.notEqual(loaded, first);
    assert.deepEqual(loaded, Uint8Array.of(1, 2, 3));

    const next = Uint8Array.of(9);
    await storage.save(["k"], next);
    assert.deepEqual(await storage.load(["k"]), Uint8Array.of(9));

    const caller = Uint8Array.of(4, 5, 6);
    await storage.save(["alias"], caller);
    caller[0] = 0;
    assert.deepEqual(await storage.load(["alias"]), Uint8Array.of(4, 5, 6));

    const saved = [
      [doc, "snapshot"],
      [doc, "snapshot", "h"],
      [doc, "snapshotX"],
      [doc, "incremental", "h"],
      [doc + "X", "snapshot"],
      ["other", "x"],
    ];
    for (const [index, key] of saved.entries()) {
      await storage.save(key, Uint8Array.of(index));
    }
    const ranged = await storage.loadRange([doc, "snapshot"]);
    assert.deepEqual(
      ranged.map((chunk) => chunk.key).sort(compareKeys),
      [
        [doc, "snapshot"],
        [doc, "snapshot", "h"],
      ].sort(compareKeys),
    );
    const everything = await storage.loadRange([]);
    assert.deepEqual(
      everything.map((chunk) => chunk.key).sort(compareKeys),
      [["k"], ["alias"], ...saved].sort(compareKeys),
    );
  } finally {
    await storage.close();
  }
});

test("removeRange clears 2501 keys and a second call is a no-op", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const storage = kvStorage(db);
  try {
    for (let i = 0; i < 2501; i++) {
      await storage.save(["batch", String(i)], Uint8Array.of(1));
    }
    await storage.save(["keep"], Uint8Array.of(7));
    await storage.removeRange(["batch"]);
    assert.deepEqual(await storage.loadRange(["batch"]), []);
    assert.deepEqual(await storage.load(["keep"]), Uint8Array.of(7));
    await storage.removeRange(["batch"]);
    assert.deepEqual(await storage.loadRange(["batch"]), []);
    assert.deepEqual(await storage.load(["keep"]), Uint8Array.of(7));
  } finally {
    await storage.close();
  }
});

test("key over 8 KiB rejects ConstraintError and a sibling write lands", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const storage = kvStorage(db);
  try {
    await assert.rejects(
      () => storage.save(["x".repeat(8191)], Uint8Array.of(1)),
      (err: unknown) => err instanceof ConstraintError,
    );
    await storage.save(["sibling"], Uint8Array.of(2));
    assert.deepEqual(await storage.load(["sibling"]), Uint8Array.of(2));
  } finally {
    await storage.close();
  }
});

test("close twice resolves and later calls reject ClosedError", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const storage = kvStorage(db);
  await storage.close();
  await storage.close();
  await assert.rejects(
    () => storage.load(["a"]),
    (err: unknown) => err instanceof ClosedError,
  );
  await assert.rejects(
    () => storage.save(["a"], Uint8Array.of(1)),
    (err: unknown) => err instanceof ClosedError,
  );
});

test("second handle misses a save until it syncs", async () => {
  const name = dbName();
  const a = await openHarnessDb({ name, forceMemory: true });
  const b = await openHarnessDb({ name, forceMemory: true });
  const storageA = kvStorage(a);
  const storageB = kvStorage(b);
  try {
    await storageA.save(["doc", "snapshot", "h"], Uint8Array.of(3));
    assert.deepEqual(await storageB.loadRange(["doc"]), []);
    await b.sync();
    const seen = await storageB.loadRange(["doc"]);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.key, ["doc", "snapshot", "h"]);
    assert.deepEqual(seen[0]?.data, Uint8Array.of(3));
  } finally {
    await storageA.close();
    await storageB.close();
  }
});

function compareKeys(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}
