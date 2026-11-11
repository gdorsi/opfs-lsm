import assert from "node:assert/strict";
import { test } from "node:test";
import type { IndexInfo } from "@opfs-lsm/docstore";
import {
  and,
  compileSingleRowExpression,
  eq,
  gt,
  ilike,
  inArray,
  IR,
  isNull,
  lt,
  or,
  toBooleanPredicate,
  type LoadSubsetOptions,
} from "@tanstack/db";
import { MAX_RANGES, planLoad } from "../src/plan.ts";

const ref = (path: string) => new IR.PropRef(path.split("."));
const sorted = (...on: string[]): IndexInfo => ({ kind: "sorted", on, unique: false });

const INDEXES = new Map<string, IndexInfo>([
  ["byStatus", sorted("deleted", "status", "modified")],
  ["byModified", sorted("deleted", "modified")],
  ["tags", { kind: "multi", on: ["tags"], unique: false }],
  ["search", { kind: "text", on: ["deleted", "modified"], unique: false, text: "title" }],
]);

const desc = (path: string, nulls: "first" | "last" = "last"): IR.OrderBy => [
  { expression: ref(path), compareOptions: { direction: "desc", nulls, stringSort: "lexical" } },
];

const plan = (options: LoadSubsetOptions) => planLoad(options, INDEXES).map((r) => r.plan);

test("a pinned id reads those documents", () => {
  assert.deepEqual(plan({ where: inArray(ref("id"), ["a", "b"]) }), [{ kind: "ids", ids: ["a", "b"] }]);
  assert.deepEqual(plan({ where: and(eq(ref("status"), 1), eq(ref("id"), "a")) }), [{ kind: "ids", ids: ["a"] }]);
});

test("a where that pins no index prefix scans", () => {
  assert.deepEqual(plan({ where: eq(ref("status"), 1) }), [{ kind: "scan" }]);
  assert.deepEqual(plan({ where: or(eq(ref("deleted"), false), eq(ref("status"), 1)) }), [{ kind: "scan" }]);
});

test("an in that matches nothing reads nothing", () => {
  assert.deepEqual(plan({ where: and(eq(ref("deleted"), false), inArray(ref("status"), [])) }), [{ kind: "ranges", ranges: [] }]);
  assert.deepEqual(plan({ where: and(eq(ref("deleted"), false), eq(ref("deleted"), true)) }), [{ kind: "ranges", ranges: [] }]);
});

test("a null in an in list pins nothing, as TanStack's in matches no null row", () => {
  const match = compileSingleRowExpression(inArray(ref("status"), [1, null]));
  assert.equal(toBooleanPredicate(match({ status: null })), false);
  assert.equal(toBooleanPredicate(match({ status: 1 })), true);
  const pinned = (values: (number | null)[]) => plan({ where: and(eq(ref("deleted"), false), inArray(ref("status"), values)) });
  assert.deepEqual(pinned([1, null]), pinned([1]));
  assert.equal(pinned([1])[0]!.kind, "ranges");
});

test("an ordered limited load reads the index whose prefix is pinned, one range per pinned value, in order", () => {
  const where = and(eq(ref("deleted"), false), inArray(ref("status"), [1, 3]));
  assert.deepEqual(plan({ where, orderBy: desc("modified"), limit: 20, offset: 0 }), [
    {
      kind: "ranges",
      ranges: [
        { index: "byStatus", eq: [false, 1], reverse: true },
        { index: "byStatus", eq: [false, 3], reverse: true },
      ],
      first: { order: { path: "modified", reverse: true, nulls: "last", lexical: true }, limit: 20 },
    },
  ]);
});

test("nulls on the other side of the index split each range into its null rows and the rest", () => {
  const [p] = plan({ where: eq(ref("deleted"), false), orderBy: desc("modified", "first"), limit: 5 });
  assert.deepEqual(p, {
    kind: "ranges",
    ranges: [
      { index: "byModified", eq: [false, null], reverse: true },
      { index: "byModified", eq: [false], gt: null, reverse: true },
    ],
    first: { order: { path: "modified", reverse: true, nulls: "first", lexical: true }, limit: 5 },
  });
});

test("a bound on the order path needs no null split and narrows the range", () => {
  const where = and(eq(ref("deleted"), false), gt(ref("modified"), 10));
  const [p] = plan({ where, orderBy: desc("modified", "first"), limit: 5 });
  assert.deepEqual(p && p.kind === "ranges" && p.ranges, [{ index: "byModified", eq: [false], gt: 10, reverse: true }]);
});

test("the tie load reads the tied rows from the index", () => {
  const where = and(eq(ref("deleted"), false), eq(ref("modified"), 7));
  assert.deepEqual(plan({ where }), [{ kind: "ranges", ranges: [{ index: "byModified", eq: [false, 7] }] }]);
});

test("a locale order is still read from the index, marked so a read meeting a string reads its ranges whole", () => {
  const orderBy: IR.OrderBy = [{ expression: ref("modified"), compareOptions: { direction: "asc", nulls: "first", stringSort: "locale" } }];
  assert.deepEqual(plan({ where: eq(ref("deleted"), false), orderBy, limit: 5 }), [
    {
      kind: "ranges",
      ranges: [{ index: "byModified", eq: [false] }],
      first: { order: { path: "modified", reverse: false, nulls: "first", lexical: false }, limit: 5 },
    },
  ]);
});

test("a text index is read only for a like on its text, and then with the pattern's words", () => {
  const where = and(eq(ref("deleted"), false), ilike(ref("title"), "%Bug fix%"));
  assert.deepEqual(plan({ where, orderBy: desc("modified"), limit: 5 }), [
    {
      kind: "ranges",
      ranges: [{ index: "search", eq: [false], match: "bug fix", reverse: true }],
      first: { order: { path: "modified", reverse: true, nulls: "last", lexical: true }, limit: 5 },
    },
  ]);
  const [noLike] = plan({ where: eq(ref("deleted"), false), orderBy: desc("modified"), limit: 5 });
  assert.ok(noLike?.kind === "ranges" && noLike.ranges.every((r) => r.index === "byModified"));
});

test("a multi index is never read", () => {
  assert.deepEqual(plan({ where: eq(ref("tags"), "x") }), [{ kind: "scan" }]);
});

test("past MAX_RANGES pinned combinations, the index pins fewer components", () => {
  const many = Array.from({ length: MAX_RANGES + 1 }, (_, i) => i);
  const [p] = plan({ where: and(eq(ref("deleted"), false), inArray(ref("status"), many)) });
  assert.ok(p?.kind === "ranges");
  assert.deepEqual(
    p.ranges.map((r) => r.eq),
    [[false]],
  );
});

test("a cursor is two reads, the first rows after it and every row tied with it", () => {
  const where = eq(ref("deleted"), false);
  const cursor = { whereFrom: lt(ref("modified"), 5), whereCurrent: eq(ref("modified"), 5) };
  const reads = planLoad({ where, orderBy: desc("modified"), cursor, limit: 3, offset: 9 }, INDEXES);
  assert.deepEqual(
    reads.map((r) => r.plan),
    [
      {
        kind: "ranges",
        ranges: [{ index: "byModified", eq: [false], lt: 5, reverse: true }],
        first: { order: { path: "modified", reverse: true, nulls: "last", lexical: true }, limit: 3 },
      },
      { kind: "ranges", ranges: [{ index: "byModified", eq: [false, 5] }] },
    ],
  );
});

test("a where on a value no index can hold, or on a virtual property, is residual", () => {
  assert.deepEqual(plan({ where: and(isNull(ref("deleted")), eq(ref("$synced"), true)) }), [{ kind: "scan" }]);
  assert.deepEqual(plan({ where: eq(ref("deleted"), null) }), [{ kind: "scan" }]);
});
