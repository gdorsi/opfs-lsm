/**
 * Count indexes: how many documents hold each value tuple of some fields.
 * The model test checks count indexes on a schema that has them from the
 * start; these tests check what it cannot: adding one to stored documents
 * while other handles write, two builds at once, a build cut short or
 * redefined, the lifecycle, and that a count reads count rows.
 */
import type { Db } from "@opfs-lsm/kv";
import { describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore, type Collection } from "../src/index.js";
import type { QueryInput } from "../src/schema.js";
import { codeOf, docstoreKeys, freshName, gate, keysUnder, openKv, recording, storedCatalog, storedPrefix, wrap, wrapViews } from "./harness.js";
import { expected, type ModelIndex } from "./oracle.js";

type Row = { id: string; a: number; b: string; tags: string[]; t: string };

const GROUPS = 1_200;
const ROWS = 2_400;
const row = (i: number): Row => ({
  id: `r${String(i).padStart(5, "0")}`,
  a: i % GROUPS,
  b: `b${i % 3}`,
  tags: [`t${i % 4}`, `t${i % 7}`],
  t: `w${i % 11} x${i % 13}`,
});

const plain = collection<Row>().index("byA", ["a", "b"]).text("search", "b", "t");
const v1 = defineSchema({ version: 1, collections: { rows: plain } });
const counted = plain.count("perA", "a").count("perAB", ["a", "b"]).count("perTag", "tags[]");
const v2 = defineSchema({ version: 2, collections: { rows: counted } });
/** One count index, so the build is one job whose steps a test can follow. */
const onlyPerA = plain.count("perA", "a");
const v2a = defineSchema({ version: 2, collections: { rows: onlyPerA } });
/** `perA` redefined on two fields. */
const deeperPerA = plain.count("perA", ["a", "b"]);

const MODEL: Record<"perA" | "perAB" | "perTag", ModelIndex> = {
  perA: { kind: "count", on: ["a"], multi: false },
  perAB: { kind: "count", on: ["a", "b"], multi: false },
  perTag: { kind: "count", on: ["tags"], multi: true },
};

/**
 * Every group of every count index `c` declares, one absent group, the bounds,
 * the whole index and, where the index takes one, a list of groups, from one
 * snapshot, against the oracle. The oracle lists an index once for all its
 * groups: one listing per group would cost more than everything it checks.
 */
async function expectCounts<Ix>(c: Collection<Row, Ix>, docs: readonly Row[], indexes = Object.keys(MODEL)): Promise<void> {
  await c.view(async (snap) => {
    const check = async (q: QueryInput, want: number) => {
      const got = await snap.count(q as never);
      if (got !== want) expect({ q, got }).toEqual({ q, got: want });
    };
    for (const index of indexes) {
      const ix = MODEL[index as keyof typeof MODEL];
      const groups = new Map<string, number>([[JSON.stringify("absent"), 0]]);
      for (const h of expected(docs, ix, {})) groups.set(JSON.stringify(h.values[0]), (groups.get(JSON.stringify(h.values[0])) ?? 0) + 1);
      for (const [g, n] of groups) await check({ index, eq: [JSON.parse(g) as never] }, n);
      const queries: QueryInput[] = [{ index }, { index, gte: 3, lt: 900 }, { index, gt: 3, lte: 900 }];
      if (index === "perTag") queries.push({ index, startsWith: "t1" }, { index, gt: "t1", lte: "t5" });
      else queries.push({ index, eq: [[1, 7, 500, "absent"]] });
      if (index === "perAB") queries.push({ index, eq: [7], startsWith: "b" }, { index, eq: [[1, 7]], gt: "b0", lte: "b2" });
      for (const q of queries) await check(q, expected(docs, ix, q).length);
    }
  });
}

/** A seeded sequence of numbers in [0, 1). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Writes that move documents between groups, through `c`, kept in `docs`. */
function churner(c: Collection<Row, (typeof plain)["indexes"]>, docs: Map<string, Row>, seed: number) {
  const rand = random(seed);
  let next = ROWS;
  const pick = () => [...docs.keys()][Math.floor(rand() * docs.size)]!;
  return async (n: number) => {
    for (let k = 0; k < n; k++) {
      const r = rand();
      if (r < 0.25) {
        const doc = row(next++);
        await c.put(doc);
        docs.set(doc.id, doc);
      } else if (r < 0.4) {
        const id = pick();
        await c.delete(id);
        docs.delete(id);
      } else {
        const id = pick();
        const was = docs.get(id)!;
        const doc: Row = {
          ...was,
          a: r < 0.6 ? Math.floor(rand() * GROUPS) : was.a,
          b: r < 0.7 ? `b${Math.floor(rand() * 4)}` : was.b,
          tags: r < 0.8 ? [`t${Math.floor(rand() * 9)}`] : was.tags,
          t: `w${Math.floor(rand() * 11)}`,
        };
        await c.modify(id, () => doc);
        docs.set(id, doc);
      }
    }
  };
}

async function loaded(): Promise<{ name: string; docs: Map<string, Row> }> {
  const name = freshName();
  const kv = await openKv(name);
  const c = (await openDocStore(kv, v1)).collection("rows");
  const docs = new Map<string, Row>();
  for (let i = 0; i < ROWS; i += 600) {
    const slice = Array.from({ length: 600 }, (_, k) => row(i + k));
    await c.putMany(slice);
    for (const d of slice) docs.set(d.id, d);
  }
  await kv.close();
  return { name, docs };
}

const stateOf = async (kv: Db, index: string) => (await storedCatalog(kv)).collections["rows"]!.indexes[index]?.state.kind;

describe("adding a count index to stored documents", () => {
  it("counts them from one snapshot, one base row per group, and stores catalog format 4", async () => {
    const { name, docs } = await loaded();
    const kv = await openKv(name);
    expect((await storedCatalog(kv)).format).toBe(2);
    const c = (await openDocStore(kv, v2)).collection("rows");
    expect((await storedCatalog(kv)).format).toBe(4);
    for (const index of Object.keys(MODEL)) expect(await stateOf(kv, index)).toBe("ready");
    expect(await keysUnder(kv, await storedPrefix(kv, "rows", "perA"))).toBe(GROUPS);
    await expectCounts(c, [...docs.values()]);
    await kv.close();
  }, 30_000);

  it("stays exact while another handle writes before its snapshot, before its commit and before it is ready", async () => {
    const { name, docs } = await loaded();
    const writer = await openKv(name);
    const churn = churner((await openDocStore(writer, v1)).collection("rows"), docs, 1);
    const kv = await openKv(name);
    const commits = gate(kv, "update", 1);
    const snapshots = gate(commits.db, "view", 0);
    const building = openDocStore(snapshots.db, v2a);
    // The index is added (update 1); the build's snapshot waits.
    await snapshots.arrived(1);
    await churn(40);
    // The snapshot holds these writes and their count rows, as that of a tab that heard of them.
    await kv.sync();
    snapshots.release();
    // The snapshot is read; the commit of its base rows (update 2) waits.
    await commits.arrived(2);
    await churn(40);
    commits.release(1);
    // The catalog write that marks it ready (update 3) waits.
    await commits.arrived(3);
    await churn(40);
    commits.release();
    const c = (await building).collection("rows");
    expect(await stateOf(kv, "perA")).toBe("ready");
    await churn(40);
    // Another handle sees the writer's acked writes after its next sync, as another tab would.
    await kv.sync();
    await expectCounts(c, [...docs.values()], ["perA"]);
    await writer.close();
    await kv.close();
  }, 30_000);

  it("stays exact when two handles build at once while a third writes", async () => {
    const { name, docs } = await loaded();
    const writer = await openKv(name);
    const churn = churner((await openDocStore(writer, v1)).collection("rows"), docs, 2);
    const [kvB, kvC] = await Promise.all([openKv(name), openKv(name)]);
    const builds = Promise.all([openDocStore(kvB, v2), openDocStore(kvC, v2)]);
    await churn(60);
    const [b, c] = await builds;
    await Promise.all([b.whenIdle(), c.whenIdle(), kvB.sync(), kvC.sync()]);
    for (const index of Object.keys(MODEL)) expect(await stateOf(kvB, index)).toBe("ready");
    await expectCounts(b.collection("rows"), [...docs.values()]);
    await expectCounts(c.collection("rows"), [...docs.values()]);
    await Promise.all([writer.close(), kvB.close(), kvC.close()]);
  }, 30_000);

  it("restarts a build cut short, and leaves the keys of an uninterrupted one", async () => {
    const reference = async () => {
      const { name } = await loaded();
      const kv = await openKv(name);
      await (await openDocStore(kv, v2a)).whenIdle();
      const keys = await docstoreKeys(kv);
      await kv.close();
      return keys;
    };
    const { name, docs } = await loaded();
    const first = await openKv(name);
    // The index is added; the commit of the base rows never runs.
    const held = gate(first, "update", 1);
    const running = openDocStore(held.db, v2a).catch(() => undefined);
    await held.arrived(2);
    await first.close();
    held.release();
    await running;
    const kv = await openKv(name);
    expect(await stateOf(kv, "perA")).toBe("building");
    const c = (await openDocStore(kv, v2a)).collection("rows");
    expect(await stateOf(kv, "perA")).toBe("ready");
    await expectCounts(c, [...docs.values()], ["perA"]);
    expect(await docstoreKeys(kv)).toEqual(await reference());
    await kv.close();
  }, 30_000);

  it("writes nothing under the old prefix when another handle redefines the index before the build commits", async () => {
    const { name, docs } = await loaded();
    const deeper = defineSchema({ version: 3, collections: { rows: deeperPerA } });
    const kv = await openKv(name);
    const other = await openKv(name);
    const old: { prefix?: Uint8Array } = {};
    let commits = 0;
    // Before the build commits its base rows, another handle redefines the
    // index, builds it and sweeps the old prefix; then this handle hears of it.
    const db = wrap(kv, {
      update: async (keys, body) => {
        if (++commits === 2) {
          old.prefix = await storedPrefix(kv, "rows", "perA");
          await (await openDocStore(other, deeper)).whenIdle();
          await kv.sync();
        }
        return kv.update(keys, body);
      },
    });
    await (await openDocStore(db, v2a)).whenIdle();
    expect(await keysUnder(kv, old.prefix!)).toBe(0);
    const c = (await openDocStore(kv, deeper)).collection("rows");
    const all = [...docs.values()];
    await c.view(async (snap) => {
      for (let a = 0; a < GROUPS; a += 7) {
        expect(await snap.count({ index: "perA", eq: [a] })).toBe(expected(all, MODEL.perAB, { eq: [a] }).length);
        expect(await snap.count({ index: "perA", eq: [a, `b${a % 3}`] })).toBe(expected(all, MODEL.perAB, { eq: [a, `b${a % 3}`] }).length);
      }
    });
    await other.close();
    await kv.close();
  }, 30_000);

  it("leaves alone the index that takes its name and id after its collection is dropped and declared again", async () => {
    const name = freshName();
    const kv = await openKv(name);
    await (await openDocStore(kv, v1)).collection("rows").putMany(Array.from({ length: 50 }, (_, i) => row(i)));
    const other = await openKv(name);
    const views = gate(other, "view", 0);
    const old: { prefix?: Uint8Array } = {};
    const v5 = defineSchema({ version: 5, collections: { rows: onlyPerA } });
    let again: ReturnType<typeof openDocStore<typeof v5>> | undefined;
    let commits = 0;
    // Before the build commits, another handle drops rows, declares it again
    // with 10 documents, and adds perA again under the same id, whose build it holds.
    const db = wrap(kv, {
      update: async (keys, body) => {
        if (++commits === 2) {
          old.prefix = await storedPrefix(kv, "rows", "perA");
          await (await openDocStore(other, defineSchema({ version: 3, collections: {}, drop: ["rows"] }))).whenIdle();
          const rows = (await openDocStore(other, defineSchema({ version: 4, collections: { rows: plain } }))).collection("rows");
          await rows.putMany(Array.from({ length: 10 }, (_, i) => ({ ...row(i), id: `n${i}`, a: 1 })));
          again = openDocStore(views.db, v5);
          await views.arrived(1);
          await kv.sync();
          expect((await storedPrefix(kv, "rows", "perA"))).not.toEqual(old.prefix);
          expect((await storedCatalog(kv)).collections["rows"]!.indexes["perA"]).toMatchObject({ id: old.prefix!.at(-1), state: { kind: "building" } });
        }
        return kv.update(keys, body);
      },
    });
    await (await openDocStore(db, v2a)).whenIdle();
    views.release();
    const store = await again!;
    await store.whenIdle();
    expect(await keysUnder(kv, old.prefix!)).toBe(0);
    expect(await store.collection("rows").count({ index: "perA", eq: [1] })).toBe(10);
    await other.close();
    await kv.close();
  });

  it("counts a group that lost documents since the index was added: its count row is negative, and limit keeps it with its base row", async () => {
    const kv = await openKv(freshName());
    await (await openDocStore(kv, v1)).collection("rows").putMany([1, 2, 3].map((i) => ({ ...row(i), a: 1 })));
    const c = (await openDocStore(kv, v2a)).collection("rows");
    await c.deleteMany([row(1).id, row(2).id]);
    expect(await keysUnder(kv, await storedPrefix(kv, "rows", "perA"))).toBe(2);
    expect(await c.count({ index: "perA", eq: [1] })).toBe(1);
    expect(await c.count({ index: "perA", limit: 1 })).toBe(1);
    await c.delete(row(3).id);
    expect(await c.count({ index: "perA" })).toBe(0);
    await c.put({ ...row(4), a: 1 });
    expect(await c.count({ index: "perA", eq: [1] })).toBe(1);
    await kv.close();
  });

  it("fails with value on a stored document whose field it cannot hold, and drops its rows", async () => {
    const name = freshName();
    const kv = await openKv(name);
    await (await openDocStore(kv, defineSchema({ version: 1, collections: { rows: collection<Row>() } })))
      .collection("rows")
      .putMany([row(1), { ...row(2), a: [1, 2] as never }]);
    const store = await openDocStore(kv, v2a);
    await store.whenIdle();
    const state = (await storedCatalog(kv)).collections["rows"]!.indexes["perA"]!.state;
    expect(state).toEqual({ kind: "failed", reason: "value", ids: [row(2).id] });
    expect((await storedCatalog(kv)).dropped).toEqual([]);
    expect(await codeOf(store.collection("rows").count({ index: "perA", eq: [1] }))).toBe("index-failed");
    await kv.close();
  });
});

describe("the lifecycle of a count index", () => {
  it("drops its rows when it is redefined or removed", async () => {
    const { name, docs } = await loaded();
    const kv = await openKv(name);
    await (await openDocStore(kv, v2)).whenIdle();
    const old = await storedPrefix(kv, "rows", "perA");
    const deeper = defineSchema({ version: 3, collections: { rows: deeperPerA.count("perAB", ["a", "b"]).count("perTag", "tags[]") } });
    const store = await openDocStore(kv, deeper);
    await store.whenIdle();
    expect(await keysUnder(kv, old)).toBe(0);
    const all = [...docs.values()];
    for (const eq of [[5], [5, "b2"], [7, "b0"]] as const) {
      expect(await store.collection("rows").count({ index: "perA", eq: [...eq] as never })).toBe(expected(all, MODEL.perAB, { eq: [...eq] }).length);
    }
    const deep = await storedPrefix(kv, "rows", "perA");
    expect((await storedCatalog(kv)).format).toBe(4);
    await (await openDocStore(kv, defineSchema({ version: 4, collections: { rows: plain } }))).whenIdle();
    expect(await keysUnder(kv, deep)).toBe(0);
    expect((await storedCatalog(kv)).format).toBe(2);
    await kv.close();
  }, 30_000);

  it("is ready across a clear, from zero", async () => {
    const { name } = await loaded();
    const kv = await openKv(name);
    const store = await openDocStore(kv, v2);
    const c = store.collection("rows");
    await c.clear();
    expect(await stateOf(kv, "perA")).toBe("ready");
    expect(await c.count({ index: "perA", eq: [1] })).toBe(0);
    await c.putMany([row(1), row(1 + GROUPS)]);
    expect(await c.count({ index: "perA", eq: [1] })).toBe(2);
    await store.whenIdle();
    await kv.close();
  }, 30_000);

  it("refuses a count index with unique, text or include, or without fields, and a write of a value it cannot hold", async () => {
    const kv = await openKv(freshName());
    for (const bad of [
      { by: "a", count: true, unique: true },
      { by: "a", count: true, text: "t" },
      { by: "a", count: true, include: ["t"] },
      { by: "a", count: false },
      { count: true },
      { by: [], count: true },
      { by: ["a", "a"], count: true },
    ]) {
      expect(await codeOf(openDocStore(kv, { version: 1, collections: { rows: { indexes: { bad } } } } as never))).toBe("schema");
    }
    const c = (await openDocStore(kv, v2a)).collection("rows");
    expect(await codeOf(c.put({ ...row(1), a: { x: 1 } as never }))).toBe("document");
    expect(await c.count({ index: "perA" })).toBe(0);
    // A group key is one byte shorter than kv's limit, because its base row adds one.
    const kvOnly = await openKv(freshName());
    const only = (await openDocStore(kvOnly, defineSchema({ version: 1, collections: { rows: collection<Row>().count("perA", "a") } }))).collection("rows");
    expect(await codeOf(only.put({ ...row(1), a: "z".repeat(8186) as never }))).toBe("document");
    await only.put({ ...row(1), a: "z".repeat(8185) as never });
    expect(await only.count({ index: "perA" })).toBe(1);
    await kvOnly.close();
    await kv.close();
  });

  it("is left out of the indexes query reads", async () => {
    const kv = await openKv(freshName());
    const c = (await openDocStore(kv, v2)).collection("rows");
    expect([...c.indexes.keys()]).toEqual(["byA", "search"]);
    await kv.close();
  });
});

describe("count on a count index", () => {
  it("reads count rows, not entries, and caps the sum at limit", async () => {
    const kv = await openKv(freshName());
    let walks = 0;
    const db = wrapViews(kv, (snap) => ({ count: (r) => (walks++, snap.count(r)) }));
    const c = (await openDocStore(db, v2)).collection("rows");
    const docs = Array.from({ length: 300 }, (_, i) => row(i));
    await c.putMany(docs);
    const all = (q: QueryInput) => expected(docs, MODEL.perAB, q).length;
    for (const q of [{}, { eq: [3] }, { gte: 10, lt: 20 }, { eq: [3], startsWith: "b" }, { eq: [3, "b0"] }] as QueryInput[]) {
      expect(await c.count({ index: "perAB", ...q } as never)).toBe(all(q));
    }
    expect(await c.count({ index: "perAB", limit: 5 })).toBe(5);
    expect(walks).toBe(0);
    expect(await c.count({ index: "byA", eq: [3] })).toBe(1);
    expect(walks).toBe(1);
    await kv.close();
  });

  it("adds the groups of every combination of the values eq lists, and caps the sum at limit", async () => {
    const kv = await openKv(freshName());
    let walks = 0;
    const db = wrapViews(kv, (snap) => ({ count: (r) => (walks++, snap.count(r)) }));
    const c = (await openDocStore(db, v2)).collection("rows");
    const docs = Array.from({ length: 300 }, (_, i) => row(i));
    await c.putMany(docs);
    const lists: QueryInput[] = [
      { eq: [[3, 4, 5]] },
      { eq: [[3, 3, 4, "absent"]] },
      { eq: [[3, 4], ["b0", "b1"]] },
      { eq: [3, ["b0", "b2"]] },
      { eq: [[3, 4, 200]], startsWith: "b" },
      { eq: [[3, 4]], gte: "b1" },
      { eq: [[]] },
      { eq: [[3, 4], []] },
    ];
    for (const q of lists) {
      expect({ q, n: await c.count({ index: "perAB", ...q } as never) }).toEqual({ q, n: expected(docs, MODEL.perAB, q).length });
    }
    expect(await c.count({ index: "perA", eq: [[3, 4, 5]] })).toBe(3);
    expect(await c.count({ index: "perA", eq: [[3, 4, 5]], limit: 2 })).toBe(2);
    expect(await codeOf(c.count({ index: "perA", eq: [Array.from({ length: 65 }, (_, i) => i)] }))).toBe("query");
    expect(walks).toBe(0);
    await kv.close();
  });

  it("refuses a list for the array field of a count index, whose groups share documents", async () => {
    const kv = await openKv(freshName());
    const c = (await openDocStore(kv, v2)).collection("rows");
    await c.putMany([row(1), row(2)]);
    expect(await c.count({ index: "perTag", eq: ["t1"] })).toBe(1);
    expect(await codeOf(c.count({ index: "perTag", eq: [["t1", "t2"]] } as never))).toBe("query");
    expect(await codeOf(c.count({ index: "perTag", eq: [["t1"]] } as never))).toBe("query");
    await kv.close();
  });

  it("refuses query, queryIds, queryEntries, after, offset, reverse and match", async () => {
    const kv = await openKv(freshName());
    const c = (await openDocStore(kv, v2)).collection("rows");
    await c.putMany([row(1), row(2)]);
    const cursor = (await c.query({ index: "byA", limit: 1 })).next;
    expect(cursor).toBeDefined();
    expect(await codeOf(c.query({ index: "perA" } as never))).toBe("query");
    expect(await codeOf(c.queryIds({ index: "perA" } as never))).toBe("query");
    expect(await codeOf(c.queryEntries({ index: "perA" } as never))).toBe("query");
    expect(await codeOf(c.view((snap) => snap.queryEntries({ index: "perA" } as never)))).toBe("query");
    expect(await codeOf(c.count({ index: "perA", after: cursor } as never))).toBe("query");
    expect(await codeOf(c.count({ index: "perA", offset: 1 } as never))).toBe("query");
    expect(await codeOf(c.count({ index: "perA", reverse: false } as never))).toBe("query");
    expect(await codeOf(c.count({ index: "perA", match: "w1" } as never))).toBe("query");
    await kv.close();
  });

  it("counts every document when two handles write the same groups at once", async () => {
    const name = freshName();
    const [kvA, kvB] = await Promise.all([openKv(name), openKv(name)]);
    const a = (await openDocStore(kvA, v2)).collection("rows");
    const b = (await openDocStore(kvB, v2)).collection("rows");
    const docs = new Map<string, Row>();
    const write = (c: typeof a, from: number) =>
      Promise.all(
        Array.from({ length: 40 }, async (_, k) => {
          const doc: Row = { ...row(from + k), a: k % 3, tags: ["shared", `t${k % 2}`] };
          await c.put(doc);
          if (k % 4 === 0) {
            await c.delete(doc.id);
            return;
          }
          const moved: Row = { ...doc, a: (k + 1) % 3 };
          if (k % 4 === 1) await c.modify(doc.id, () => moved);
          docs.set(doc.id, k % 4 === 1 ? moved : doc);
        }),
      );
    await Promise.all([write(a, 0), write(b, 1_000)]);
    await Promise.all([kvA.sync(), kvB.sync()]);
    expect(await a.count({ index: "perA" })).toBe(docs.size);
    expect(await b.count({ index: "perTag", eq: ["shared"] })).toBe(docs.size);
    await expectCounts(a, [...docs.values()]);
    await expectCounts(b, [...docs.values()]);
    await Promise.all([kvA.close(), kvB.close()]);
  });

  it("costs a write one count read per group it changes, and none when it changes no group", async () => {
    const kv = await openKv(freshName());
    const { db, updates } = recording(kv);
    const light = defineSchema({ version: 1, collections: { rows: collection<Row>().count("perA", "a").count("perTag", "tags[]") } });
    const c = (await openDocStore(db, light)).collection("rows");
    await c.put(row(1));
    updates.length = 0;
    await c.modify(row(1).id, (d) => ({ ...d, t: "other words" }));
    await c.modify(row(1).id, (d) => ({ ...d, a: 2 }));
    // Catalog and row, then: nothing for new words, and the old and new group of perA (perTag's groups stay).
    expect(updates.map((u) => u.reads)).toEqual([2, 4]);
    await kv.close();
  });
});
