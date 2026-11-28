import type { IndexInfo } from "@opfs-lsm/docstore";
import { describe, expect, it } from "vitest";
import { IR, root, type Buildable, type QueryBuilder } from "../src/builder.js";
import type { Collection } from "../src/database.js";
import { and, eq, gt, gte, ilike, inArray, like, lt, lte, not, or, orderKeyOf, refProxy, type Ref } from "../src/expr.js";
import { entryInRanges, planQuery, summarize, type Plan } from "../src/plan.js";

type Issue = {
  id: string;
  title: string;
  status: number;
  priority: number;
  created: number;
  modified: number;
  assignee: string | null;
  key: string;
  done: boolean;
  tags: string[];
};

const sorted = (...by: string[]): IndexInfo => ({ kind: "sorted", by, unique: false });
/** The indexes of the LinearLite example, and a few more kinds. */
const indexes = new Map<string, IndexInfo>([
  ["byModified", { kind: "text", by: ["modified"], unique: false, text: "title" }],
  ["byCreated", sorted("created")],
  ["byStatus", sorted("status", "priority", "modified")],
  ["byPriority", sorted("priority", "status", "modified")],
  ["byKey", { kind: "sorted", by: ["key"], unique: true }],
]);

const issues = { name: "issues" } as Collection<Issue>;
const from = () => root.from({ i: issues });
type Q = QueryBuilder<{ readonly i: Issue }, Issue>;

function plan(query: Buildable<unknown>, over: ReadonlyMap<string, IndexInfo> = indexes): Plan {
  const ir = query[IR];
  return planQuery(ir, orderKeyOf(ir.orderBy), over);
}
const explain = (query: Buildable<unknown>) => summarize(plan(query));
const ranges = (query: Buildable<unknown>) => {
  const p = plan(query);
  return p.kind === "ranges" ? p.ranges : p.kind;
};

describe("the lists of LinearLite", () => {
  const sortBy = (q: Q, fields: readonly ("status" | "priority" | "modified")[], dir: "asc" | "desc" = "desc") =>
    fields.reduce((b, field) => b.orderBy(({ i }) => i[field], dir), q);

  it("reads an unfiltered page from the index of its sort, offset and limit included", () => {
    const page = sortBy(from(), ["modified"]).offset(100).limit(50);
    expect(explain(page)).toEqual({ kind: "index", index: "byModified", ranges: 1, ordered: true, exact: true });
    expect(ranges(page)).toEqual([{ index: "byModified", reverse: true }]);
  });

  it("reads a status filter sorted by status as one range per status, in order", () => {
    const page = sortBy(from().where(({ i }) => inArray(i.status, [2, 1])), ["status", "priority", "modified"], "asc").limit(50);
    expect(explain(page)).toEqual({ kind: "index", index: "byStatus", ranges: 2, ordered: true, exact: true });
    expect(ranges(page)).toEqual([
      { index: "byStatus", eq: [1] },
      { index: "byStatus", eq: [2] },
    ]);
  });

  it("reads the ranges of a descending sort from the last value down", () => {
    const page = sortBy(from().where(({ i }) => inArray(i.status, [1, 2])), ["status", "priority", "modified"]).limit(50);
    expect(ranges(page)).toEqual([
      { index: "byStatus", eq: [2], reverse: true },
      { index: "byStatus", eq: [1], reverse: true },
    ]);
  });

  it("reads a status and priority filter sorted by priority as one range per pair, from either index that holds both first", () => {
    const page = sortBy(
      from()
        .where(({ i }) => inArray(i.status, [1, 2]))
        .where(({ i }) => inArray(i.priority, [0, 3])),
      ["priority", "status", "modified"],
      "asc",
    ).limit(50);
    expect(explain(page)).toEqual({ kind: "index", index: "byStatus", ranges: 4, ordered: true, exact: true });
    expect(ranges(page)).toEqual([
      { index: "byStatus", eq: [1, 0] },
      { index: "byStatus", eq: [2, 0] },
      { index: "byStatus", eq: [1, 3] },
      { index: "byStatus", eq: [2, 3] },
    ]);
    const prioritiesOnly = sortBy(from().where(({ i }) => inArray(i.priority, [0, 3])), ["priority", "status", "modified"], "asc").limit(50);
    expect(ranges(prioritiesOnly)).toEqual([
      { index: "byPriority", eq: [0] },
      { index: "byPriority", eq: [3] },
    ]);
  });

  it("reads a status filter sorted by modified in the order of the sort, and filters", () => {
    const page = sortBy(from().where(({ i }) => inArray(i.status, [1, 2])), ["modified"]).limit(50);
    expect(explain(page)).toEqual({ kind: "index", index: "byModified", ranges: 1, ordered: true, exact: false });
  });

  it("reads a search through the words of the text index", () => {
    const page = sortBy(from().where(({ i }) => ilike(i.title, "%Fix login%")), ["modified"]).limit(50);
    expect(explain(page)).toEqual({ kind: "index", index: "byModified", ranges: 1, ordered: true, exact: false });
    expect(ranges(page)).toEqual([{ index: "byModified", match: expect.stringContaining("Fix login"), reverse: true }]);
  });

  it("counts a status filter in the entries of the status index", () => {
    const total = from().where(({ i }) => inArray(i.status, [1, 2])).count();
    expect(explain(total)).toEqual({ kind: "index", index: "byStatus", ranges: 1, ordered: false, exact: true });
    expect(ranges(total)).toEqual([{ index: "byStatus", eq: [[1, 2]] }]);
  });

  it("counts every document in the entries of the smallest index whose entries are their key, not in the rows", () => {
    const total = from().count();
    expect(explain(total)).toEqual({ kind: "index", index: "byCreated", ranges: 1, ordered: false, exact: true });
    expect(ranges(total)).toEqual([{ index: "byCreated" }]);
    expect(summarize(plan(total, new Map([["byModified", indexes.get("byModified")!]])))).toEqual({ kind: "scan", ordered: true, exact: true });
  });

  it("counts in the rows when no index decides the count alone", () => {
    expect(explain(from().where(({ i }) => eq(i.title, "x")).count())).toEqual({ kind: "scan", ordered: true, exact: false });
  });

  it("reads the filter of the README in the order of its sort", () => {
    const open = from()
      .where(({ i }) => and(inArray(i.status, [1, 2]), not(eq(i.priority, 4))))
      .orderBy(({ i }) => i.modified, "desc")
      .limit(50);
    expect(explain(open)).toEqual({ kind: "index", index: "byModified", ranges: 1, ordered: true, exact: false });
  });
});

describe("the choice of a plan", () => {
  it("reads by id when the where names ids, and drops the ids no document can have", () => {
    expect(plan(from().where(({ i }) => eq(i.id, "i1")).findOne())).toEqual({ kind: "ids", ids: ["i1"] });
    expect(plan(from().where(({ i }) => and(inArray(i.id, ["b", "", "a", "\uD800"]), eq(i.status, 1))))).toEqual({ kind: "ids", ids: ["a", "b"] });
  });

  it("reads nothing when the where cannot hold, or the limit is 0", () => {
    const none = { kind: "none" };
    expect(plan(from().where(({ i }) => inArray(i.status, [])))).toEqual(none);
    expect(plan(from().where(({ i }) => and(eq(i.status, 1), eq(i.status, 2))))).toEqual(none);
    expect(plan(from().where(({ i }) => and(gt(i.created, 5), lt(i.created, 5))))).toEqual(none);
    expect(plan(from().where(({ i }) => gt(i.assignee, null as unknown as string)))).toEqual(none);
    expect(plan(from().limit(0))).toEqual(none);
    expect(plan(from().where(({ i }) => and(gte(i.created, 5), lte(i.created, 5))))).not.toEqual(none);
  });

  it("scans the rows when no index serves, in order only when the order is the id", () => {
    expect(explain(from())).toEqual({ kind: "scan", ordered: true, exact: true });
    expect(explain(from().orderBy(({ i }) => i.id, "desc"))).toEqual({ kind: "scan", ordered: true, exact: true });
    expect(explain(from().where(({ i }) => eq(i.assignee, "ada")))).toEqual({ kind: "scan", ordered: true, exact: false });
    expect(explain(from().orderBy(({ i }) => i.assignee))).toEqual({ kind: "scan", ordered: false, exact: true });
    expect(ranges(from().where(({ i }) => gte(i.id, "m")).orderBy(({ i }) => i.id, "desc"))).toEqual([{ gte: "m", reverse: true }]);
  });

  it("without a limit prefers the index that reads only matches to the one that reads in order", () => {
    const filtered = from().where(({ i }) => eq(i.status, 1)).orderBy(({ i }) => i.created);
    expect(explain(filtered)).toEqual({ kind: "index", index: "byStatus", ranges: 1, ordered: false, exact: true });
    expect(explain(filtered.limit(10))).toEqual({ kind: "index", index: "byCreated", ranges: 1, ordered: true, exact: false });
  });

  it("drops a field pinned to one value from the order", () => {
    const q = from()
      .where(({ i }) => and(eq(i.status, 1), eq(i.priority, 0)))
      .orderBy(({ i }) => i.status)
      .orderBy(({ i }) => i.modified)
      .limit(10);
    expect(explain(q)).toEqual({ kind: "index", index: "byStatus", ranges: 1, ordered: true, exact: true });
    expect(ranges(q)).toEqual([{ index: "byStatus", eq: [1, 0] }]);
  });

  it("keeps the list of a pinned field the order does not name, which docstore merges", () => {
    const q = from().where(({ i }) => and(eq(i.status, 1), inArray(i.priority, [3, 0]))).orderBy(({ i }) => i.modified).limit(10);
    expect(explain(q)).toEqual({ kind: "index", index: "byStatus", ranges: 1, ordered: true, exact: true });
    expect(ranges(q)).toEqual([{ index: "byStatus", eq: [1, [0, 3]] }]);
  });

  it("is not ordered when the index orders ties by another field, or the directions differ", () => {
    const byStatusOnly = from().where(({ i }) => inArray(i.status, [1, 2])).orderBy(({ i }) => i.status).limit(10);
    expect(explain(byStatusOnly)).toMatchObject({ ordered: false });
    const mixed = from().orderBy(({ i }) => i.status).orderBy(({ i }) => i.priority, "desc").orderBy(({ i }) => i.modified).limit(10);
    expect(explain(mixed)).toMatchObject({ ordered: false });
  });

  it("turns a comparison into a range inside the type of its value", () => {
    const one = (q: Q) => ranges(q);
    expect(one(from().where(({ i }) => gt(i.created, 5)))).toEqual([{ index: "byCreated", gt: 5, lt: "" }]);
    expect(one(from().where(({ i }) => lte(i.created, 5)))).toEqual([{ index: "byCreated", gt: true, lte: 5 }]);
    expect(one(from().where(({ i }) => and(gte(i.created, 5), lt(9, i.created), gt(i.created, 2), lt(i.created, 20))))).toEqual([
      { index: "byCreated", gt: 9, lt: 20 },
    ]);
    expect(one(from().where(({ i }) => gte(i.key, "m")))).toEqual([{ index: "byKey", gte: "m" }]);
    expect(one(from().where(({ i }) => lt(i.key, "m")))).toEqual([{ index: "byKey", gte: "", lt: "m" }]);
    expect(explain(from().where(({ i }) => gt(i.created, 5)))).toMatchObject({ exact: true });
  });

  it("bounds the field after the pinned ones", () => {
    const q = from().where(({ i }) => and(eq(i.status, 1), gt(i.priority, 2)));
    expect(ranges(q)).toEqual([{ index: "byStatus", eq: [1], gt: 2, lt: "" }]);
    expect(explain(q)).toMatchObject({ exact: true });
  });

  it("pins a field from an or of its values, and nothing from an or over two fields", () => {
    expect(ranges(from().where(({ i }) => or(eq(i.status, 2), inArray(i.status, [0, 2]))))).toEqual([{ index: "byStatus", eq: [[0, 2]] }]);
    expect(explain(from().where(({ i }) => or(eq(i.status, 2), eq(i.priority, 1))))).toEqual({ kind: "scan", ordered: true, exact: false });
  });

  it("gives a unique index one value per field", () => {
    expect(ranges(from().where(({ i }) => eq(i.key, "K-1")))).toEqual([{ index: "byKey", eq: ["K-1"] }]);
    expect(explain(from().where(({ i }) => inArray(i.key, ["K-1", "K-2"])))).toEqual({ kind: "scan", ordered: true, exact: false });
  });

  it("leaves to the filter a value an index key cannot hold", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(explain(from().where(({ i }) => eq(i.status, value)))).toEqual({ kind: "scan", ordered: true, exact: false });
    }
    expect(explain(from().where(({ i }) => eq(i.key, "x".repeat(300))))).toEqual({ kind: "scan", ordered: true, exact: false });
    expect(explain(from().where(({ i }) => gt(i.key, "\uD800")))).toEqual({ kind: "scan", ordered: true, exact: false });
  });

  it("uses a like only as the words of a text index", () => {
    expect(explain(from().where(({ i }) => like(i.key, "K-%")))).toEqual({ kind: "scan", ordered: true, exact: false });
    expect(explain(from().where(({ i }) => like(i.title, "%")))).toEqual({ kind: "scan", ordered: true, exact: false });
  });

  it("pins fewer fields once the values would pass 64 ranges", () => {
    const many = Array.from({ length: 9 }, (_, n) => n);
    const q = from().where(({ i }) => and(inArray(i.status, many), inArray(i.priority, many)));
    expect(ranges(q)).toEqual([{ index: "byStatus", eq: [many] }]);
    expect(explain(q)).toMatchObject({ exact: false });
  });
});

describe("what the planner leaves to the filter", () => {
  const nested = new Map<string, IndexInfo>([["byNested", sorted("n.m")], ...indexes]);
  type Nested = { id: string; n: { m: number }; "n.m": number; "": number; other: number };
  const docs = { name: "docs" } as Collection<Nested>;
  const only = () => root.from({ d: docs });
  const scan = { kind: "scan", ordered: true, exact: false };

  it("reads a nested field through its index, and a field whose name holds a dot or is empty through none", () => {
    expect(summarize(plan(only().where(({ d }) => eq(d.n.m, 1)), nested))).toMatchObject({ kind: "index", index: "byNested" });
    expect(summarize(plan(only().where(({ d }) => eq(d["n.m"], 1)), nested))).toEqual(scan);
    expect(summarize(plan(only().where(({ d }) => gt(d[""], 1)), nested))).toEqual(scan);
  });

  it("reads no index for a condition that is no comparison of one field with values", () => {
    expect(explain(from().where(({ i }) => i.done))).toEqual(scan);
    expect(explain(from().where(({ i }) => eq(i.status, i.priority)))).toEqual(scan);
    expect(explain(from().where(() => eq(1 as never, 2)))).toEqual(scan);
    expect(explain(from().where(({ i }) => inArray(i.status, i.tags as never)))).toEqual(scan);
    expect(explain(from().where(({ i }) => inArray(i.status, "12" as never)))).toEqual(scan);
    expect(explain(from().where(({ i }) => gt(i.created, i.modified)))).toEqual(scan);
    expect(explain(from().where(({ i }) => like(i.title, i.key as never)))).toEqual(scan);
    expect(explain(from().where(({ i }) => like(i.title, 5 as never)))).toEqual(scan);
  });

  it("reads no index for a node that is no function, which a query that compiles never holds", () => {
    const ir = { ...from()[IR], where: [{ kind: "val", value: true } as const, { kind: "ref", alias: "i", path: ["done"] } as const] };
    expect(summarize(planQuery(ir, orderKeyOf(ir.orderBy), indexes))).toEqual(scan);
  });

  it("reads no index for a field of another source", () => {
    const other = refProxy("j") as Ref<Issue>;
    expect(explain(from().where(() => eq(other.status, 1)))).toEqual(scan);
    expect(explain(from().where(() => gt(other.created, 1)))).toEqual(scan);
  });

  it("keeps the tighter bound, and the open one when two bounds on one side are equal", () => {
    const one = (where: (i: Ref<Issue>) => ReturnType<typeof and>) => ranges(from().where(({ i }) => where(i)));
    expect(one((i) => and(gte(i.created, 5), gt(i.created, 5)))).toEqual([{ index: "byCreated", gt: 5, lt: "" }]);
    expect(one((i) => and(gt(i.created, 5), gte(i.created, 5)))).toEqual([{ index: "byCreated", gt: 5, lt: "" }]);
    expect(one((i) => and(lte(i.created, 5), lt(i.created, 5)))).toEqual([{ index: "byCreated", gt: true, lt: 5 }]);
    expect(one((i) => and(lt(i.created, 5), lte(i.created, 5)))).toEqual([{ index: "byCreated", gt: true, lt: 5 }]);
    expect(one((i) => and(gt(i.created, 5), gt(i.created, 9)))).toEqual([{ index: "byCreated", gt: 9, lt: "" }]);
    expect(one((i) => and(gt(i.created, 9), gt(i.created, 5)))).toEqual([{ index: "byCreated", gt: 9, lt: "" }]);
  });
});

describe("the entries inside the ranges of a plan", () => {
  const inside = (query: Buildable<unknown>, ...entries: (readonly unknown[])[]) => {
    const p = plan(query);
    if (p.kind !== "ranges") throw new Error("not ranges");
    return entries.map((values) => entryInRanges(p, values as never));
  };

  it("matches a slot that pins a value, or lists several", () => {
    expect(inside(from().where(({ i }) => eq(i.status, 1)), [1, 7, 9], [2, 7, 9], [0, 7, 9])).toEqual([true, false, false]);
    expect(inside(from().where(({ i }) => inArray(i.status, [3, 1])), [1, 0, 0], [3, 0, 0], [2, 0, 0])).toEqual([true, true, false]);
  });

  it("matches in any of the ranges of a plan", () => {
    const q = from().where(({ i }) => inArray(i.status, [1, 3])).orderBy(({ i }) => i.status).orderBy(({ i }) => i.priority).orderBy(({ i }) => i.modified);
    expect(plan(q)).toMatchObject({ ranges: [{ eq: [1] }, { eq: [3] }] });
    expect(inside(q, [1, 0, 0], [3, 0, 0], [2, 0, 0])).toEqual([true, true, false]);
  });

  it("excludes the entry at an open bound and includes the one at a closed bound, after the pinned slots", () => {
    const open = from().where(({ i }) => and(eq(i.status, 1), gt(i.priority, 2), lt(i.priority, 5)));
    expect(inside(open, [1, 2, 0], [1, 3, 0], [1, 4, 0], [1, 5, 0], [2, 3, 0])).toEqual([false, true, true, false, false]);
    const closed = from().where(({ i }) => and(eq(i.status, 1), gte(i.priority, 2), lte(i.priority, 5)));
    expect(inside(closed, [1, 1, 0], [1, 2, 0], [1, 5, 0], [1, 6, 0])).toEqual([false, true, true, false]);
  });

  it("keeps a bound inside the type of its value", () => {
    expect(inside(from().where(({ i }) => gt(i.created, 5)), [6], [5], ["x"], [true], [null])).toEqual([true, false, false, false, false]);
    expect(inside(from().where(({ i }) => lte(i.created, 5)), [5], [-1], [6], ["x"], [false])).toEqual([true, true, false, false, false]);
  });
});
