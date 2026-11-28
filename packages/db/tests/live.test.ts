import { DocStoreError } from "@opfs-lsm/docstore";
import { CorruptDatabaseError } from "@opfs-lsm/kv";
import { destroyHarnessDb } from "@opfs-lsm/kv/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOn, tableOf } from "../src/database.js";
import { ClosedError, collection, eq, gt, ilike, inArray, like, query, QueryError, type Collections, type Database } from "../src/index.js";
import { freshName, holdViews, openKv, until, watch } from "./harness.js";

type Issue = { id: string; title: string; status: number; modified: number; note?: string };

const collections = {
  issues: collection<Issue>().text("byModified", "modified", "title").index("byStatus", ["status", "modified"]),
};

const open: Database<Collections>[] = [];
async function openDb(name = freshName()) {
  const views = holdViews(await openKv(name));
  const db = await openOn(views.db, { version: 1, collections });
  open.push(db);
  return { db, issues: db.collections.issues, views };
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const issue = (n: number, over: Partial<Issue> = {}): Issue => ({ id: `i${n}`, title: `Issue ${n}`, status: 1, modified: n, ...over });
const ids = (rows: readonly { id: string }[] | undefined) => rows?.map((r) => r.id);

type Issues = Awaited<ReturnType<typeof openDb>>["issues"];

/** Every change `issues` hands to a listener refuses `member`, as when the catalog moved under it or a document cannot be read. */
function faultChanges(issues: Issues, member: "before" | "written" | "doc") {
  const refusing = (change: object) =>
    new Proxy(change, {
      get(target, prop) {
        if (prop === member) {
          const refuse = () => {
            throw new DocStoreError("schema", "the catalog of the change holds the index otherwise");
          };
          return member === "doc" ? refuse() : refuse;
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const docs = tableOf(issues).docs;
  const real = docs.changes.bind(docs);
  vi.spyOn(docs, "changes").mockImplementation((listener) =>
    real((event) => listener(event.kind === "append" ? { ...event, changes: event.changes.map((c) => refusing(c) as typeof c) } : event)),
  );
}

describe("a subscription", () => {
  it("is not called again when another document gives an equal result", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1, { title: "same" }), issue(2, { title: "same" })]);
    const titles = query((q) =>
      q
        .from({ i: issues })
        .orderBy(({ i }) => i.modified)
        .select(({ i }) => ({ title: i.title }))
        .limit(1),
    );
    const first = query((q) =>
      q
        .from({ i: issues })
        .orderBy(({ i }) => i.modified)
        .select(({ i }) => ({ title: i.title }))
        .findOne(),
    );
    const seen = [watch<unknown>(titles), watch<unknown>(first)] as const;
    await until(() => seen.every((s) => s.values.length === 1));
    await issues.delete("i1");
    const after = watch(query((q) => q.from({ i: issues }).count()));
    await until(() => after.values.at(-1) === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen[0].values).toEqual([[{ title: "same" }]]);
    expect(seen[1].values).toEqual([{ title: "same" }]);
  });

  it("gets the result after the first read, then each result that differs", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2), issue(3, { status: 2 })]);
    const open = query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.modified, "desc").limit(2));
    const seen = watch(open);
    expect(seen.values).toEqual([]);
    await until(() => seen.values.length === 1);
    expect(ids(seen.values[0])).toEqual(["i2", "i1"]);

    await issues.insert(issue(4));
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["i4", "i2"]);

    await issues.update("i4", (draft) => {
      draft.status = 2;
    });
    await until(() => seen.values.length === 3);
    expect(ids(seen.values[2])).toEqual(["i2", "i1"]);

    await issues.delete("i2");
    await until(() => seen.values.length === 4);
    expect(ids(seen.values[3])).toEqual(["i1"]);
    expect(seen.errors).toEqual([]);
  });

  it("is not called for a change that leaves the result as it was", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2), issue(3)]);
    const newest = query((q) => q.from({ i: issues }).orderBy(({ i }) => i.modified, "desc").limit(2));
    const seen = watch(newest);
    await until(() => seen.values.length === 1);

    await issues.insert(issue(0));
    await issues.upsert(issue(3));
    await issues.update("i1", (draft) => {
      draft.title = "Renamed, and outside the two newest";
    });
    await issues.delete("i0");
    // A change the result does show comes last, so the ones before it had their chance.
    await issues.insert(issue(9));
    await until(() => seen.values.length > 1);
    expect(seen.values.map(ids)).toEqual([["i3", "i2"], ["i9", "i3"]]);
  });

  it("reads a limited count again for an insert and a delete, and not for an edit", async () => {
    const { issues, views } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const seen = watch(query((q) => q.from({ i: issues }).limit(10).count()));
    await until(() => seen.values.length === 1);
    const reads = views.views();

    await issues.update("i1", (draft) => {
      draft.status = 2;
      draft.modified = 9;
    });
    await issues.upsert(issue(2, { title: "Renamed" }));
    await issues.insert(issue(3));
    await until(() => seen.values.length === 2);
    await issues.delete("i1");
    await until(() => seen.values.length === 3);
    expect(seen.values).toEqual([2, 3, 2]);
    expect(views.views()).toBe(reads + 2);
  });

  it("hands out the same object for a row that did not change", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2), issue(3)]);
    const all = query((q) => q.from({ i: issues }).orderBy(({ i }) => i.modified));
    const seen = watch(all);
    await until(() => seen.values.length === 1);

    await issues.update("i2", (draft) => {
      draft.title = "Changed";
    });
    await until(() => seen.values.length === 2);
    const [first, second] = seen.values as [Issue[], Issue[]];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toEqual(issue(2, { title: "Changed" }));
    expect(second[2]).toBe(first[2]);

  });

  it("keeps a selected row while its selected fields stay the same, and is not called while every row does", async () => {
    const { issues, views } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const titles = query((q) => q.from({ i: issues }).orderBy(({ i }) => i.modified).select(({ i }) => ({ id: i.id, title: i.title, note: i.note })));
    const seen = watch(titles);
    await until(() => seen.values.length === 1);
    expect(seen.values[0]).toEqual([
      { id: "i1", title: "Issue 1", note: null },
      { id: "i2", title: "Issue 2", note: null },
    ]);
    const reads = views.views();
    await issues.update("i1", (draft) => {
      draft.status = 5;
    });
    await until(() => views.views() > reads);
    await issues.update("i2", (draft) => {
      draft.title = "Two";
    });
    await until(() => seen.values.length > 1);
    expect(seen.values).toHaveLength(2);
    expect(seen.values[1]![0]).toBe(seen.values[0]![0]);
    expect(seen.values[1]![1]).toEqual({ id: "i2", title: "Two", note: null });
  });

  it("follows one row and a count", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2, { title: "Fix login" })]);
    const one = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.id, "i1")).findOne()));
    const total = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).where(({ i }) => ilike(i.title, "%login%")).count()));
    await until(() => one.values.length === 1 && total.values.length === 1);
    expect(one.values[0]).toEqual(issue(1));
    expect(total.values).toEqual([1]);

    await issues.delete("i2");
    await until(() => total.values.length === 2);
    await issues.delete("i1");
    await until(() => one.values.length === 2);
    expect(total.values).toEqual([1, 0]);
    expect(one.values[1]).toBeUndefined();
  });

  it("hands over a page before a count read in the same snapshot, and the count then agrees with it", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2, { status: 2 })]);
    const { docs } = tableOf(issues);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const view = docs.view.bind(docs);
    vi.spyOn(docs, "view").mockImplementation((body) =>
      view((snap) => {
        const slow = new Proxy(snap, {
          get(target, key) {
            const value = Reflect.get(target, key, target) as unknown;
            if (key !== "count" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
            return async (...args: unknown[]) => {
              await gate;
              return value.apply(target, args) as unknown;
            };
          },
        });
        return body(slow);
      }),
    );
    const page = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).limit(10)));
    const total = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).count()));
    await until(() => page.values.length === 1);
    expect(ids(page.values[0])).toEqual(["i1"]);
    expect(total.values).toEqual([]);
    // Written after the snapshot: the count must not see it.
    await issues.insert(issue(3));
    release();
    await until(() => total.values.length === 2);
    expect(total.values).toEqual([1, 2]);
    await until(() => page.values.length === 2);
    expect(ids(page.values[1])).toEqual(["i1", "i3"]);
  });

  it("stops at once when unsubscribed, a read in flight included", async () => {
    const { issues, views } = await openDb();
    await issues.insert(issue(1));
    const all = query((q) => q.from({ i: issues }));
    views.hold();
    const early = watch(all);
    await until(() => views.views() > 0);
    early.stop();
    views.release();
    const late = watch(all);
    await until(() => late.values.length === 1);
    late.stop();
    late.stop();
    await issues.insert(issue(2));
    expect(await all.run()).toHaveLength(2);
    expect(early.values).toEqual([]);
    expect(late.values).toHaveLength(1);
  });

  it("lets a subscriber that throws keep its subscription, and the others theirs", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { issues } = await openDb();
      const all = query((q) => q.from({ i: issues }).count());
      let calls = 0;
      all.subscribe(() => {
        calls++;
        throw new Error("from a subscriber");
      });
      const seen = watch(all);
      await until(() => seen.values.length === 1);
      await issues.insert(issue(1));
      await until(() => seen.values.length === 2);
      expect(seen.values).toEqual([0, 1]);
      expect(calls).toBe(2);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("a subscription that follows the changes without a read", () => {
  /** Counts the reads of the collection from now on. */
  function reads(issues: Database<typeof collections>["collections"]["issues"]): () => number {
    const { docs } = tableOf(issues);
    const spies = (["view", "query", "count", "getMany"] as const).map((method) => vi.spyOn(docs, method));
    return () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
  }
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves an exact count by the entries each write added to its ranges and removed from them", async () => {
    const { issues, views } = await openDb();
    await issues.insert([issue(1), issue(2), issue(3, { status: 2 })]);
    const open = query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).count());
    expect(open.explain()).toMatchObject({ kind: "index", index: "byStatus", exact: true });
    const seen = watch(open);
    await until(() => seen.values.length === 1);
    const read = reads(issues);
    const base = views.views();

    await issues.insert(issue(4));
    await until(() => seen.values.length === 2);
    await issues.update("i1", (draft) => {
      draft.status = 2;
    });
    await until(() => seen.values.length === 3);
    // The entry moves inside the range: the count stays.
    await issues.update("i2", (draft) => {
      draft.modified = 50;
    });
    await issues.update("i2", (draft) => {
      draft.title = "Renamed";
    });
    await issues.delete("i4");
    await until(() => seen.values.length === 4);
    await issues.update("i3", (draft) => {
      draft.status = 1;
    });
    await until(() => seen.values.length === 5);
    await issues.insert([issue(5), issue(6), issue(7, { status: 2 })]);
    await until(() => seen.values.length === 6);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.values).toEqual([2, 3, 2, 1, 2, 4]);
    expect(read()).toBe(0);
    expect(views.views()).toBe(base);
    expect(await open.run()).toBe(4);
  });

  it("follows a count of the whole collection, and the ranges of an inArray", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2, { status: 2 }), issue(3, { status: 3 })]);
    const all = watch(query((q) => q.from({ i: issues }).count()));
    const some = watch(query((q) => q.from({ i: issues }).where(({ i }) => inArray(i.status, [1, 3])).count()));
    await until(() => all.values.length === 1 && some.values.length === 1);
    const read = reads(issues);
    await issues.update("i2", (draft) => {
      draft.status = 3;
    });
    await until(() => some.values.length === 2);
    await issues.delete("i1");
    await until(() => some.values.length === 3 && all.values.length === 2);
    await issues.insert(issue(4, { status: 9 }));
    await until(() => all.values.length === 3);
    await issues.delete(["i3", "i4"]);
    await until(() => all.values.length === 4 && some.values.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(all.values).toEqual([3, 2, 3, 1]);
    expect(some.values).toEqual([2, 3, 2, 1]);
    expect(read()).toBe(0);
  });

  it("keeps a list with no limit in order for an insert, a delete, a move and an edit, and keeps the rows that did not change", async () => {
    const { issues, views } = await openDb();
    await issues.insert([issue(1), issue(2), issue(3, { status: 2 }), issue(5)]);
    const open = query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.modified, "desc"));
    const seen = watch(open);
    await until(() => seen.values.length === 1);
    const read = reads(issues);
    const base = views.views();
    const next = async (change: () => Promise<unknown>) => {
      const n = seen.values.length;
      await change();
      await until(() => seen.values.length === n + 1);
      return seen.values.at(-1) as Issue[];
    };

    expect(ids(seen.values[0])).toEqual(["i5", "i2", "i1"]);
    expect(ids(await next(() => issues.insert(issue(4))))).toEqual(["i5", "i4", "i2", "i1"]);
    const before = seen.values.at(-1) as Issue[];
    const renamed = await next(() => issues.update("i2", (draft) => void (draft.title = "Renamed")));
    expect(renamed.map((r) => r.title)).toEqual(["Issue 5", "Issue 4", "Renamed", "Issue 1"]);
    expect(renamed[0]).toBe(before[0]);
    expect(renamed[1]).toBe(before[1]);
    expect(renamed[3]).toBe(before[3]);
    expect(renamed).not.toBe(before);
    expect(ids(await next(() => issues.update("i1", (draft) => void (draft.modified = 9))))).toEqual(["i1", "i5", "i4", "i2"]);
    expect(ids(await next(() => issues.update("i3", (draft) => void (draft.status = 1))))).toEqual(["i1", "i5", "i4", "i3", "i2"]);
    expect(ids(await next(() => issues.update("i5", (draft) => void (draft.status = 2))))).toEqual(["i1", "i4", "i3", "i2"]);
    expect(ids(await next(() => issues.delete("i4")))).toEqual(["i1", "i3", "i2"]);
    expect(ids(await next(() => issues.insert([issue(6), issue(7), issue(8, { status: 2 })])))).toEqual(["i1", "i7", "i6", "i3", "i2"]);
    // A write that touches no row of the result is no new value.
    await issues.update("i8", (draft) => void (draft.title = "Elsewhere"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.values).toHaveLength(8);
    expect(read()).toBe(0);
    expect(views.views()).toBe(base);
    expect(await open.run()).toEqual(seen.values.at(-1));
  });

  it("places rows by the fields a select renames", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(3)]);
    const named = query((q) =>
      q
        .from({ i: issues })
        .where(({ i }) => eq(i.status, 1))
        .orderBy(({ i }) => i.modified)
        .select(({ i }) => ({ key: i.id, at: i.modified, title: i.title })),
    );
    const seen = watch(named);
    await until(() => seen.values.length === 1);
    const read = reads(issues);

    await issues.insert(issue(2));
    await until(() => seen.values.length === 2);
    expect(seen.values[1]).toEqual([
      { key: "i1", at: 1, title: "Issue 1" },
      { key: "i2", at: 2, title: "Issue 2" },
      { key: "i3", at: 3, title: "Issue 3" },
    ]);
    expect(seen.values[1]![0]).toBe(seen.values[0]![0]);
    await issues.update("i2", (draft) => void (draft.status = 5));
    await issues.update("i3", (draft) => void (draft.title = "Three"));
    await until(() => seen.values.length === 4);
    expect(seen.values[3]!.map((r) => r.title)).toEqual(["Issue 1", "Three"]);
    expect(read()).toBe(0);
    expect(await named.run()).toEqual(seen.values.at(-1));
  });

  it("reads again for a select that drops a field of the order, and for a plan on a text index", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(3)]);
    const dropped = query((q) =>
      q
        .from({ i: issues })
        .where(({ i }) => eq(i.status, 1))
        .orderBy(({ i }) => i.modified)
        .select(({ i }) => ({ title: i.title })),
    );
    const text = query((q) => q.from({ i: issues }).orderBy(({ i }) => i.modified));
    expect(text.explain()).toMatchObject({ kind: "index", index: "byModified" });
    const seen = [watch(dropped), watch(text)] as const;
    await until(() => seen.every((s) => s.values.length === 1));
    const read = reads(issues);

    await issues.insert(issue(2));
    await until(() => seen.every((s) => s.values.length === 2));
    expect(seen[0].values[1]).toEqual([{ title: "Issue 1" }, { title: "Issue 2" }, { title: "Issue 3" }]);
    expect(ids(seen[1].values[1] as Issue[])).toEqual(["i1", "i2", "i3"]);
    expect(read()).toBeGreaterThan(0);
  });

  it("places a document an index does not hold as a read does: it is not in the result", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const open = query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.modified));
    const seen = watch(open);
    await until(() => seen.values.length === 1);
    // docstore takes a document that has no value at an indexed field, and gives it no entry.
    await tableOf(issues).docs.put({ id: "i3", title: "No status", modified: 3 } as never);
    await issues.insert(issue(4));
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["i1", "i2", "i4"]);
    expect(await open.run()).toEqual(seen.values[1]);
  });

  it("reads again for a count with a residual filter and for a limited window", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const counted = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).where(({ i }) => ilike(i.title, "%issue%")).count()));
    const window = watch(query((q) => q.from({ i: issues }).orderBy(({ i }) => i.modified, "desc").limit(2)));
    await until(() => counted.values.length === 1 && window.values.length === 1);
    const read = reads(issues);

    await issues.insert(issue(3));
    await until(() => counted.values.length === 2 && window.values.length === 2);
    expect(counted.values).toEqual([2, 3]);
    expect(ids(window.values[1])).toEqual(["i3", "i2"]);
    expect(read()).toBeGreaterThan(0);
  });

  it("hands a burst of writes to the subscriber as one value", async () => {
    const { issues } = await openDb();
    const total = watch(query((q) => q.from({ i: issues }).count()));
    const list = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.modified)));
    await until(() => total.values.length === 1 && list.values.length === 1);
    await issues.insert([1, 2, 3, 4, 5].map((n) => issue(n)));
    await until(() => total.values.length === 2 && list.values.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(total.values).toEqual([0, 5]);
    expect(list.values.map((rows) => rows.length)).toEqual([0, 5]);
  });

  it("reads again after a gap, and goes on patching from the new result", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const total = watch(query((q) => q.from({ i: issues }).count()));
    const list = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.modified)));
    await until(() => total.values.length === 1 && list.values.length === 1);
    await tableOf(issues).docs.clear();
    await until(() => total.values.length === 2 && list.values.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const read = reads(issues);
    await issues.insert(issue(3));
    await until(() => total.values.length === 3 && list.values.length === 3);
    expect(total.values).toEqual([2, 0, 1]);
    expect(list.values.map(ids)).toEqual([["i1", "i2"], [], ["i3"]]);
    expect(read()).toBe(0);
  });
});

describe("reads of one collection", () => {
  it("answer every dirty query from one read, and a burst of writes with one more", async () => {
    const { issues, views } = await openDb();
    await issues.insert(issue(1));
    const base = query((q) => q.from({ i: issues }));
    const page = watch(query((q) => q.from({ i: issues }).orderBy(({ i }) => i.modified, "desc").limit(3)));
    const total = watch(query((q) => q.from({ i: issues }).count()));
    const untouched = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 7))));
    await until(() => page.values.length === 1 && total.values.length === 1 && untouched.values.length === 1);
    // The three first reads, and the one read of the change feed that tells it where the collection is.
    expect(views.views()).toBe(2);

    await issues.insert(issue(2));
    await until(() => page.values.length === 2 && total.values.length === 2);
    expect(views.views()).toBe(3);

    views.hold();
    for (const n of [3, 4, 5, 6]) await issues.insert(issue(n));
    views.release();
    await until(() => total.values.at(-1) === 6);
    expect(views.views()).toBe(5);
    expect(ids(page.values.at(-1))).toEqual(["i6", "i5", "i4"]);
    expect(untouched.values).toEqual([[]]);
    expect(await base.run()).toHaveLength(6);
  });

  it("read again after the collection is cleared", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const all = watch(query((q) => q.from({ i: issues })));
    const total = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).count()));
    await until(() => all.values.length === 1 && total.values.length === 1);
    await tableOf(issues).docs.clear();
    await until(() => all.values.length === 2 && total.values.length === 2);
    expect(all.values[1]).toEqual([]);
    expect(total.values).toEqual([2, 0]);
  });

  it("end on the right result when a clear lands while a read is in flight", async () => {
    const { issues, views } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const all = watch(query((q) => q.from({ i: issues }).orderBy(({ i }) => i.modified)));
    await until(() => all.values.length === 1);

    const reads = views.views();
    views.hold();
    await issues.insert(issue(3));
    await until(() => views.views() > reads);
    await tableOf(issues).docs.clear();
    await issues.insert(issue(4));
    views.release();
    await until(() => ids(all.values.at(-1))?.join() === "i4");
    // The read in flight saw the collection before the clear, so one result may be stale.
    expect(all.values.slice(1).map(ids)).toEqual([["i1", "i2", "i3"], ["i4"]]);
  });

  it("reach a subscriber of another handle on the same database", async () => {
    const name = freshName();
    const here = await openDb(name);
    const there = await openDb(name);
    await here.issues.insert(issue(1));
    const seen = watch(query((q) => q.from({ i: there.issues }).where(({ i }) => gt(i.modified, 0)).orderBy(({ i }) => i.modified)));
    // A handle learns of another handle's write a moment after it lands.
    const shows = (...want: string[]) => until(() => ids(seen.values.at(-1))?.join() === want.join(), () => `${want.join()}, last ${JSON.stringify(seen.values.at(-1))}`);
    await shows("i1");

    await here.issues.insert(issue(2));
    await shows("i1", "i2");
    await here.issues.update("i1", (draft) => {
      draft.modified = 5;
    });
    await shows("i2", "i1");
    await here.issues.delete("i2");
    await shows("i1");
    expect(seen.errors).toEqual([]);
  });
});

describe("the end of a subscription", () => {
  it("is a ClosedError when the database closes, and nothing is called after it", async () => {
    const { db, issues } = await openDb();
    await issues.insert(issue(1));
    const all = query((q) => q.from({ i: issues }));
    const settled = watch(all);
    await until(() => settled.values.length === 1);
    const reading = watch(all);
    const silent = all.subscribe(() => {});

    await db.close();
    for (const seen of [settled, reading]) {
      expect(seen.errors).toHaveLength(1);
      expect(seen.errors[0]).toBeInstanceOf(ClosedError);
      expect(seen.errors[0]).toMatchObject({ _tag: "ClosedError", code: "closed" });
    }
    expect(reading.values).toEqual([]);
    settled.stop();
    silent();

    const late = watch(all);
    expect(late.errors).toEqual([]);
    await until(() => late.errors.length === 1);
    expect(late.errors[0]).toMatchObject({ _tag: "ClosedError", code: "closed" });
    await expect(all.run()).rejects.toMatchObject({ _tag: "ClosedError", code: "closed" });
    expect(settled.values).toHaveLength(1);
  });

  it("is a ClosedError destroyed when the database is deleted under it", async () => {
    const name = freshName();
    const { issues } = await openDb(name);
    const seen = watch(query((q) => q.from({ i: issues })));
    await until(() => seen.values.length === 1);
    await destroyHarnessDb({ name, forceMemory: true });
    await until(() => seen.errors.length === 1);
    expect(seen.errors[0]).toMatchObject({ _tag: "ClosedError", code: "destroyed" });
  });

  it("is a ClosedError destroyed when the database is deleted while a read is in flight", async () => {
    const name = freshName();
    const { issues, views } = await openDb(name);
    const seen = watch(query((q) => q.from({ i: issues }).limit(10)));
    await until(() => seen.values.length === 1);
    const reads = views.views();
    views.hold();
    await issues.insert(issue(1));
    await until(() => views.views() > reads);
    await destroyHarnessDb({ name, forceMemory: true });
    await until(() => seen.errors.length === 1);
    expect(seen.errors[0]).toMatchObject({ _tag: "ClosedError", code: "destroyed" });
    views.release();
  });

  it("is the storage's failure when a read fails, and later writes call nothing", async () => {
    const { issues, views } = await openDb();
    const all = query((q) => q.from({ i: issues }).limit(10));
    const seen = watch(all);
    await until(() => seen.values.length === 1);
    views.fail(new CorruptDatabaseError("a block failed its checksum"));
    await issues.insert(issue(1));
    await until(() => seen.errors.length === 1);
    expect(seen.errors[0]).toMatchObject({ _tag: "StorageError", code: "corrupt" });
    await expect(all.run()).rejects.toMatchObject({ _tag: "StorageError", code: "corrupt" });

    views.fail(undefined);
    await issues.insert(issue(2));
    expect(await all.run()).toHaveLength(2);
    expect(seen.values).toHaveLength(1);
    expect(seen.errors).toHaveLength(1);
  });

  it("is a QueryError for a query that cannot run", async () => {
    const broken = query((q) => q.from({ i: { name: "not a collection" } as never }));
    expect(() => broken.explain()).toThrow(QueryError);
    await expect(broken.run()).rejects.toMatchObject({ _tag: "QueryError", code: "source" });
    const seen = watch(broken);
    await until(() => seen.errors.length === 1);
    expect(seen.errors[0]).toMatchObject({ _tag: "QueryError", code: "source" });
  });
});

describe("a query", () => {
  it("shares a base builder between a page and its count", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2), issue(3, { status: 2 }), issue(4)]);
    const filtered = (status: number[]) => query((q) => q.from({ i: issues }).where(({ i }) => inArray(i.status, status)));
    const page = query((q) => q.from({ i: issues }).where(({ i }) => inArray(i.status, [1])).orderBy(({ i }) => i.modified, "desc").offset(1).limit(2));
    const total = query((q) => q.from({ i: issues }).where(({ i }) => inArray(i.status, [1])).count());
    expect(ids(await page.run())).toEqual(["i2", "i1"]);
    expect(await total.run()).toBe(3);
    expect(ids(await filtered([2]).run())).toEqual(["i3"]);
    expect(page.explain()).toEqual({ kind: "index", index: "byStatus", ranges: 1, ordered: true, exact: true });
    expect(total.explain()).toEqual({ kind: "index", index: "byStatus", ranges: 1, ordered: false, exact: true });
  });

  it("does not see a document stored before an index on a field it lacks", async () => {
    // A known limit: only writes made under the current declaration are checked against its indexes.
    type Task = { id: string; title: string; due?: number | null };
    const name = freshName();
    const v1 = await openOn(await openKv(name), { version: 1, collections: { tasks: collection<Task>() } });
    await v1.collections.tasks.insert([{ id: "t1", title: "No due date" }, { id: "t2", title: "Due", due: 5 }]);
    await v1.close();

    const v2 = await openOn(await openKv(name), { version: 2, collections: { tasks: collection<Task>().index("byDue", "due") } });
    open.push(v2);
    const { tasks } = v2.collections;
    const undated = query((q) => q.from({ i: tasks }).where(({ i }) => eq(i.due, null)));
    const byDue = query((q) => q.from({ i: tasks }).orderBy(({ i }) => i.due).limit(10));
    expect(undated.explain()).toMatchObject({ kind: "index", index: "byDue" });
    expect(await undated.run()).toEqual([]);
    expect(ids(await byDue.run())).toEqual(["t2"]);
    expect(ids(await query((q) => q.from({ i: tasks })).run())).toEqual(["t1", "t2"]);

    await tasks.update("t1", (draft) => {
      draft.due = null;
    });
    expect(ids(await undated.run())).toEqual(["t1"]);
    expect(ids(await byDue.run())).toEqual(["t1", "t2"]);
  });
});

describe("a window that starts past rows", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  const leave = (draft: Issue) => {
    draft.status = 2;
  };
  /** The documents `i1` to `i6` and one of status 2, which no window reads, unless `docs` says others. */
  async function opened(order: "asc" | "desc", offset: number, docs = [...[1, 2, 3, 4, 5, 6].map((n) => issue(n)), issue(7, { status: 2 })]) {
    const ctx = await openDb();
    await ctx.issues.insert(docs);
    const window = query((q) => q.from({ i: ctx.issues }).where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.modified, order).offset(offset).limit(2));
    const seen = watch(window);
    await until(() => seen.values.length === 1);
    /** A change the window cannot see: no read, and no call. */
    const quiet = async (change: Promise<unknown>) => {
      const reads = ctx.views.views();
      await change;
      await tick();
      expect(ctx.views.views()).toBe(reads);
      expect(seen.values).toHaveLength(1);
    };
    return { ...ctx, seen, quiet };
  }

  it("reads again when a document leaves the rows it passes over, and not when one leaves after the window", async () => {
    const { issues, seen, quiet } = await opened("asc", 2);
    expect(ids(seen.values[0])).toEqual(["i3", "i4"]);
    await quiet(issues.update("i6", leave));
    await quiet(issues.update("i7", (draft) => void (draft.modified = 0)));
    await quiet(issues.delete("i7"));
    await issues.update("i1", leave);
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["i4", "i5"]);
    await issues.delete("i2");
    await until(() => seen.values.length === 3);
    expect(ids(seen.values[2])).toEqual(["i5"]);
  });

  it("does the same in a descending order, where the rows passed over are the greater ones", async () => {
    const { issues, seen, quiet } = await opened("desc", 1);
    expect(ids(seen.values[0])).toEqual(["i5", "i4"]);
    await quiet(issues.update("i1", leave));
    await quiet(issues.update("i2", leave));
    await issues.update("i6", leave);
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["i4", "i3"]);
  });

  it("places a document that ties with the last row on the sort field by its id", async () => {
    const tied = (id: string) => issue(0, { id, modified: 4 });
    const { issues, seen, quiet } = await opened("asc", 2, [issue(1), issue(2), tied("a4"), tied("b4"), tied("c4")]);
    expect(ids(seen.values[0])).toEqual(["a4", "b4"]);
    await quiet(issues.update("c4", leave));
    await issues.update("a4", leave);
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["b4"]);
  });
});

describe("a window past rows ordered by a nested field", () => {
  it("places a document by the value its index holds at that field", async () => {
    type Task = { id: string; meta: { due: number } };
    const views = holdViews(await openKv());
    const db = await openOn(views.db, { version: 1, collections: { tasks: collection<Task>().index("byDue", "meta.due") } });
    open.push(db);
    const { tasks } = db.collections;
    await tasks.insert([1, 2, 3, 4, 5, 6].map((n) => ({ id: `t${n}`, meta: { due: n } })));
    const window = query((q) => q.from({ t: tasks }).orderBy(({ t }) => t.meta.due).offset(2).limit(2));
    expect(window.explain()).toMatchObject({ kind: "index", index: "byDue" });
    const seen = watch(window);
    await until(() => seen.values.length === 1);
    expect(ids(seen.values[0])).toEqual(["t3", "t4"]);

    const reads = views.views();
    await tasks.delete("t6");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(views.views()).toBe(reads);
    await tasks.delete("t1");
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["t4", "t5"]);
  });
});

describe("a change that cannot say where its document was", () => {
  it("is read again by a window with an offset, which then shows the shifted rows", async () => {
    const { issues, views } = await openDb();
    await issues.insert([1, 2, 3, 4, 5, 6].map((n) => issue(n)));
    faultChanges(issues, "before");
    const window = query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.modified).offset(2).limit(2));
    const seen = watch(window);
    await until(() => seen.values.length === 1);
    const reads = views.views();

    await issues.update("i6", (draft) => {
      draft.status = 2;
    });
    await until(() => views.views() === reads + 1);
    await issues.delete("i1");
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["i4", "i5"]);
    expect(seen.values).toHaveLength(2);
    expect(seen.errors).toEqual([]);
  });

  it("is read again by a limited count, which is otherwise left alone by an edit", async () => {
    const { issues, views } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    faultChanges(issues, "before");
    const seen = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).limit(10).count()));
    await until(() => seen.values.length === 1);
    const reads = views.views();
    await issues.upsert(issue(2, { title: "Renamed" }));
    await until(() => views.views() === reads + 1);
    await issues.insert(issue(3));
    await until(() => seen.values.length === 2);
    expect(seen.values).toEqual([2, 3]);
  });
});

describe("a change whose document cannot be read", () => {
  it("is read again, so the subscription follows it and gets no error", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const docs = tableOf(issues).docs;
    const real = docs.changes.bind(docs);
    const unreadable = (change: object) =>
      new Proxy(change, {
        get(target, prop) {
          if (prop === "doc") throw new CorruptDatabaseError("not a JSON object");
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    vi.spyOn(docs, "changes").mockImplementation((listener) =>
      real((event) => listener(event.kind === "append" ? { ...event, changes: event.changes.map((c) => unreadable(c) as typeof c) } : event)),
    );
    const seen = watch(query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.modified)));
    await until(() => seen.values.length === 1);
    await issues.insert(issue(3));
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["i1", "i2", "i3"]);
    expect(seen.errors).toEqual([]);
  });
});

describe("a row the subscriber changes", () => {
  it("does not move where a limited result ends", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1), issue(5)]);
    const seen = watch(query((q) => q.from({ i: issues }).orderBy(({ i }) => i.modified).limit(2)));
    await until(() => seen.values.length === 1);
    (seen.values[0]![1] as Issue).modified = 0;
    await issues.insert(issue(3));
    await until(() => seen.values.length === 2);
    expect(ids(seen.values[1])).toEqual(["i1", "i3"]);
  });
});

describe("a search for % or _", () => {
  it("finds the text that holds them when they are escaped, through a text index", async () => {
    const { issues } = await openDb();
    await issues.insert([issue(1, { title: "Cut 5% off" }), issue(2, { title: "Cut 50 off" }), issue(3, { title: "snake_case" }), issue(4, { title: "snakecase" })]);
    const titled = (pattern: string) => query((q) => q.from({ i: issues }).where(({ i }) => ilike(i.title, pattern)).orderBy(({ i }) => i.modified));
    expect(titled("%5\\%%").explain()).toMatchObject({ kind: "index", index: "byModified" });
    expect(ids(await titled("%5\\%%").run())).toEqual(["i1"]);
    expect(ids(await titled("%e\\_c%").run())).toEqual(["i3"]);
  });
});

describe("a subscription that ends", () => {
  it("is logged when it has no error callback, unless the database closed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { db, issues } = await openDb();
      query((q) => q.from({ i: issues }).where(({ i }) => like(i.title, 5 as never))).subscribe(() => {});
      await until(() => logged.mock.calls.length === 1);
      expect(logged.mock.calls[0]?.[0]).toMatch(/subscription with no error callback ended/);
      expect(logged.mock.calls[0]?.[1]).toBeInstanceOf(QueryError);

      const seen: unknown[] = [];
      query((q) => q.from({ i: issues })).subscribe((rows) => seen.push(rows));
      await until(() => seen.length === 1);
      await db.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
