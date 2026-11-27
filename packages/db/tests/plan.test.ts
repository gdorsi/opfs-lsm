import type { IndexInfo } from "@opfs-lsm/docstore";
import { describe, expect, it } from "vitest";
import { IR, root, type Buildable, type QueryBuilder } from "../src/builder.js";
import type { Collection } from "../src/database.js";
import { and, eq, gt, gte, ilike, inArray, like, lt, lte, not, or, orderKeyOf } from "../src/expr.js";
import { planQuery, summarize, type Plan } from "../src/plan.js";

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
  ["byTag", { kind: "multi", by: ["tags[]"], unique: false }],
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

  it("never reads a multi index, and uses a like only as the words of a text index", () => {
    expect(explain(from().where(({ i }) => eq(i.tags as never, "a")))).toEqual({ kind: "scan", ordered: true, exact: false });
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
