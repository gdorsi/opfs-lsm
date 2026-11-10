import type { Db, Entry } from "@opfs-lsm/kv";
import { describe, expect, it } from "vitest";
import { defineSchema, openDocStore } from "../src/index.js";
import type { AnySchema } from "../src/schema.js";
import { docstoreKeys, freshName, gate, keysUnder, openKv, storedCatalog, storedPrefix } from "./harness.js";

type Row = { id: string; a: number; b?: string; tags: string[]; u?: number; t: string };

const ROWS = 1_600;
const rows: Row[] = Array.from({ length: ROWS }, (_, i) => ({
  id: `r${String(i).padStart(4, "0")}`,
  a: i % 7,
  ...(i % 3 ? { b: `b${i % 13}` } : {}),
  tags: [`t${i % 5}`, `t${i % 11}`],
  ...(i % 4 ? { u: i } : {}),
  t: `w${i % 17} x${i % 19}`,
}));

const define = defineSchema<{ rows: Row }>();
const v1 = define({ version: 1, collections: { rows: { byA: { on: "a" } } } });
const v2 = {
  sorted: define({ version: 2, collections: { rows: { byA: { on: "a" }, added: { on: ["b", "a"] } } } }),
  multi: define({ version: 2, collections: { rows: { byA: { on: "a" }, added: { on: "tags", multi: true } } } }),
  unique: define({ version: 2, collections: { rows: { byA: { on: "a" }, added: { on: "u", unique: true } } } }),
  text: define({ version: 2, collections: { rows: { byA: { on: "a" }, added: { on: "a", text: "t" } } } }),
};
const withoutA = define({ version: 2, collections: { rows: {} } });

/** 500 rows per chunk, then the empty scan that marks the index ready. */
const BACKFILL_SCANS = Math.ceil(ROWS / 500) + 1;
/** 1,000 keys per batch over the rows and their byA entries. */
const SWEEP_BATCHES = Math.ceil((2 * ROWS) / 1_000);
const steps = (n: number) => Array.from({ length: n }, (_, k) => k);

async function loaded(): Promise<string> {
  const name = freshName();
  const kv = await openKv(name);
  const c = (await openDocStore(kv, v1)).collection("rows");
  for (let i = 0; i < ROWS; i += 400) await c.putMany(rows.slice(i, i + 400));
  await kv.close();
  return name;
}

/** Run `start` on a handle whose `method` holds every call after the first `k`, close that handle once one is held, and reopen. */
async function stopAt(name: string, method: "range" | "batch", k: number, start: (db: Db) => Promise<unknown>): Promise<Db> {
  const kv = await openKv(name);
  const held = gate(kv, method, k);
  const running = start(held.db).catch(() => undefined);
  await held.arrived(k + 1);
  await kv.close();
  held.release();
  await running;
  return openKv(name);
}

/** The keys an uninterrupted run leaves once idle. */
async function finished<S extends AnySchema>(schema: S, before: (kv: Db) => Promise<void> = async () => {}): Promise<Entry[]> {
  const kv = await openKv(await loaded());
  try {
    await before(kv);
    await (await openDocStore(kv, schema)).whenIdle();
    return await docstoreKeys(kv);
  } finally {
    await kv.close();
  }
}

describe("a backfill stopped between chunks", () => {
  describe.each(Object.keys(v2) as (keyof typeof v2)[])("of a %s index", (kind) => {
    const schema = v2[kind];
    let reference: Promise<Entry[]> | undefined;

    it.each(steps(BACKFILL_SCANS))("after %i scans leaves it building, and the next open ends where an uninterrupted one does", async (k) => {
      reference ??= finished(schema);
      const kv = await stopAt(await loaded(), "range", k, (db) => openDocStore(db, schema));
      try {
        expect((await storedCatalog(kv)).collections["rows"]!.indexes["added"]!.state).toEqual({ kind: "building" });
        await openDocStore(kv, schema);
        expect((await storedCatalog(kv)).collections["rows"]!.indexes["added"]!.state).toEqual({ kind: "ready" });
        expect(await docstoreKeys(kv)).toEqual(await reference);
      } finally {
        await kv.close();
      }
    });
  });
});

describe("a sweep stopped between batches", () => {
  it.each(steps(SWEEP_BATCHES))("of a cleared collection, after %i batches, keeps the prefix listed, and the next open empties it", async (k) => {
    const kept = rows.slice(0, 3).map((r) => ({ ...r, id: `kept-${r.id}` }));
    const name = await loaded();
    let prefix: Uint8Array | undefined;
    const kv = await stopAt(name, "batch", k, async (db) => {
      const c = (await openDocStore(db, v1)).collection("rows");
      prefix = await storedPrefix(db, "rows");
      await c.clear();
      await c.putMany(kept);
    });
    try {
      expect((await storedCatalog(kv)).dropped).toHaveLength(1);
      await (await openDocStore(kv, v1)).whenIdle();
      expect((await storedCatalog(kv)).dropped).toEqual([]);
      expect(await keysUnder(kv, prefix!)).toBe(0);
      const reference = await finished(v1, async (ref) => {
        const c = (await openDocStore(ref, v1)).collection("rows");
        await c.clear();
        await c.putMany(kept);
      });
      expect(await docstoreKeys(kv)).toEqual(reference);
    } finally {
      await kv.close();
    }
  });

  it.each(steps(Math.ceil(ROWS / 1_000)))("of a removed index, after %i batches, keeps the prefix listed, and the next open empties it", async (k) => {
    const name = await loaded();
    const before = await openKv(name);
    const prefix = await storedPrefix(before, "rows", "byA");
    await before.close();
    const kv = await stopAt(name, "batch", k, (db) => openDocStore(db, withoutA));
    try {
      expect((await storedCatalog(kv)).dropped).toHaveLength(1);
      await (await openDocStore(kv, withoutA)).whenIdle();
      expect((await storedCatalog(kv)).dropped).toEqual([]);
      expect(await keysUnder(kv, prefix)).toBe(0);
      expect(await docstoreKeys(kv)).toEqual(await finished(withoutA));
    } finally {
      await kv.close();
    }
  });
});
