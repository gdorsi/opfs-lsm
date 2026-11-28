import { describe, expect, it } from "vitest";
import { QueryError } from "../src/errors.js";
import {
  and,
  compareRows,
  compareValues,
  compile,
  conditionOf,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  like,
  lt,
  lte,
  not,
  or,
  orderKeyOf,
  refProxy,
  type Condition,
  type Expression,
  type Ref,
} from "../src/expr.js";

type Doc = {
  id: string;
  n?: number | null;
  s?: string | null;
  b?: boolean;
  tags?: string[];
  meta?: { due?: number | null };
};
const i = refProxy("i") as Ref<Doc>;
const holds = (condition: Condition, doc: Doc) => compile([conditionOf(condition)], "i")(doc);

describe("the order of values", () => {
  it("is null, false, true, numbers, strings by code point, then anything else", () => {
    const sorted = [null, false, true, -1, 0, 2.5, "", "Z", "a", "a\u0000b", "aa", "￿", "\u{1F600}", ["x"]];
    for (let x = 0; x < sorted.length; x++) {
      for (let y = 0; y < sorted.length; y++) {
        expect(Math.sign(compareValues(sorted[x], sorted[y])), `${String(sorted[x])} against ${String(sorted[y])}`).toBe(Math.sign(x - y));
      }
    }
  });

  it("treats a missing value as null, -0 as 0, and two non-scalars as a tie", () => {
    expect(compareValues(undefined, null)).toBe(0);
    expect(compareValues(-0, 0) === 0).toBe(true);
    expect(compareValues(["a"], { b: 1 })).toBe(0);
  });
});

describe("the order of rows", () => {
  it("ends with id in the direction of the last field, and ascending without fields", () => {
    expect(orderKeyOf([])).toEqual({ paths: [["id"]], desc: [false] });
    expect(orderKeyOf([{ path: ["n"], desc: true }])).toEqual({ paths: [["n"], ["id"]], desc: [true, true] });
    expect(orderKeyOf([{ path: ["n"], desc: true }, { path: ["meta", "due"], desc: false }])).toEqual({
      paths: [["n"], ["meta", "due"], ["id"]],
      desc: [true, false, false],
    });
  });

  it("drops a field named twice and every field after id", () => {
    const key = orderKeyOf([
      { path: ["n"], desc: false },
      { path: ["n"], desc: true },
      { path: ["id"], desc: true },
      { path: ["s"], desc: false },
    ]);
    expect(key).toEqual({ paths: [["n"], ["id"]], desc: [false, true] });
  });

  it("sorts by each field in its direction, nulls and missing fields first ascending, then by id", () => {
    const rows: Doc[] = [{ id: "a", n: 2 }, { id: "b" }, { id: "c", n: 1 }, { id: "d", n: 2 }, { id: "e", n: null }];
    const by = (desc: boolean) => rows.toSorted((x, y) => compareRows(x, y, orderKeyOf([{ path: ["n"], desc }]))).map((r) => r.id);
    expect(by(false)).toEqual(["b", "e", "c", "a", "d"]);
    expect(by(true)).toEqual(["d", "a", "c", "e", "b"]);
  });
});

describe("conditions", () => {
  it("eq holds for equal scalars, with a missing field equal to null", () => {
    expect(holds(eq(i.n, 1), { id: "a", n: 1 })).toBe(true);
    expect(holds(eq(i.n, 1), { id: "a", n: 2 })).toBe(false);
    expect(holds(eq(1, i.n), { id: "a", n: 1 })).toBe(true);
    expect(holds(eq(i.n, null), { id: "a" })).toBe(true);
    expect(holds(eq(i.n, null), { id: "a", n: null })).toBe(true);
    expect(holds(eq(i.n, null), { id: "a", n: 0 })).toBe(false);
    expect(holds(eq(i.meta.due, 3), { id: "a", meta: { due: 3 } })).toBe(true);
    expect(holds(eq(i.meta.due, null), { id: "a" })).toBe(true);
  });

  it("eq is false for an array or an object, even against itself", () => {
    const tags = i.tags as unknown as Ref<string>;
    expect(holds(eq(tags, tags), { id: "a", tags: ["x"] })).toBe(false);
  });

  it("gt, gte, lt and lte compare inside one type only", () => {
    expect(holds(gt(i.n, 1), { id: "a", n: 2 })).toBe(true);
    expect(holds(gt(i.n, 2), { id: "a", n: 2 })).toBe(false);
    expect(holds(gte(i.n, 2), { id: "a", n: 2 })).toBe(true);
    expect(holds(lt(i.n, 2), { id: "a", n: 1 })).toBe(true);
    expect(holds(lte(i.n, 2), { id: "a", n: 2 })).toBe(true);
    expect(holds(lt(5, i.n), { id: "a", n: 6 })).toBe(true);
    expect(holds(lt(i.n, 5), { id: "a", n: null })).toBe(false);
    expect(holds(lt(i.n, 5), { id: "a" })).toBe(false);
    expect(holds(gt(i.s, "a"), { id: "a", s: "b" })).toBe(true);
    expect(holds(gt(i.n as unknown as Ref<string>, "a"), { id: "a", n: 3 })).toBe(false);
    expect(holds(lt(i.s as unknown as Ref<number>, 5), { id: "a", s: "b" })).toBe(false);
    expect(holds(gt(i.b, false), { id: "a", b: true })).toBe(true);
  });

  it("compares strings by code point", () => {
    expect(holds(gt(i.s, "￿"), { id: "a", s: "\u{1F600}" })).toBe(true);
  });

  it("inArray holds for any listed value", () => {
    expect(holds(inArray(i.n, [1, 2]), { id: "a", n: 2 })).toBe(true);
    expect(holds(inArray(i.n, [1, 2]), { id: "a", n: 3 })).toBe(false);
    expect(holds(inArray(i.n, [1, null]), { id: "a" })).toBe(true);
    expect(holds(inArray(i.n, []), { id: "a", n: 1 })).toBe(false);
  });

  it("and, or and not combine conditions, and a boolean field alone is a condition", () => {
    const doc: Doc = { id: "a", n: 1, b: true };
    expect(holds(and(eq(i.n, 1), i.b), doc)).toBe(true);
    expect(holds(and(eq(i.n, 2), i.b), doc)).toBe(false);
    expect(holds(or(eq(i.n, 2), i.b), doc)).toBe(true);
    expect(holds(not(i.b), doc)).toBe(false);
    expect(holds(not(lt(i.n, 5)), { id: "a", n: null })).toBe(true);
    expect(holds(i.b, { id: "a" })).toBe(false);
  });

  it("like matches % as any run and _ as one character, on the whole string, by case", () => {
    expect(holds(like(i.s, "Fix%"), { id: "a", s: "Fix login" })).toBe(true);
    expect(holds(like(i.s, "fix%"), { id: "a", s: "Fix login" })).toBe(false);
    expect(holds(like(i.s, "%log_n"), { id: "a", s: "Fix login" })).toBe(true);
    expect(holds(like(i.s, "log"), { id: "a", s: "Fix login" })).toBe(false);
    expect(holds(like(i.s, "a.c(%"), { id: "a", s: "a.c(x" })).toBe(true);
    expect(holds(like(i.s, "a.c"), { id: "a", s: "abc" })).toBe(false);
    expect(holds(like(i.s, "_"), { id: "a", s: "\u{1F600}" })).toBe(true);
    expect(holds(like(i.s, "%"), { id: "a", s: "two\nlines" })).toBe(true);
    expect(holds(like(i.s, "%"), { id: "a", s: null })).toBe(false);
    expect(holds(like(i.s, "%"), { id: "a" })).toBe(false);
  });

  it("ilike ignores case, and both compare text in NFC", () => {
    expect(holds(ilike(i.s, "%LOGIN%"), { id: "a", s: "Fix Login now" })).toBe(true);
    expect(holds(ilike(i.s, "%οδοσ%"), { id: "a", s: "ΟΔΟΣ" })).toBe(true);
    expect(holds(like(i.s, "café"), { id: "a", s: "café" })).toBe(true);
    expect(holds(like(i.s, "cafe%"), { id: "a", s: "café" })).toBe(false);
  });

  it("refuses a field of another source, and a where that is not a condition", () => {
    const other = refProxy("j") as Ref<Doc>;
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (err) {
        return err instanceof QueryError ? err.code : "another error";
      }
      return "no error";
    };
    expect(code(() => compile([conditionOf(eq(other.n, 1))], "i"))).toBe("source");
    expect(code(() => compile([{ kind: "val", value: true }], "i"))).toBe("operand");
    expect(code(() => conditionOf(true as unknown as Expression<boolean>))).toBe("operand");
  });

  it("refuses an operator given a condition, a like given no string, and an inArray given no list", () => {
    const code = (condition: Condition) => {
      try {
        compile([conditionOf(condition)], "i");
      } catch (err) {
        return err instanceof QueryError ? `${err.code}: ${err.message}` : "another error";
      }
      return "no error";
    };
    expect(code(eq(and(eq(i.n, 1), eq(i.n, 2)) as never, true))).toBe("operand: an operator takes fields and values");
    expect(code(like(i.s, 5 as never))).toBe("operand: like takes a string pattern");
    expect(code(ilike(i.s, null as never))).toBe("operand: like takes a string pattern");
    expect(code(inArray(i.n, 5 as never))).toBe("operand: inArray takes a list of values");
    expect(code(inArray(i.n, i.tags as never))).toBe("operand: inArray takes a list of values");
  });

  it("gives a field reference no property but its names", () => {
    expect((i as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    expect((i as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
    expect(Object.keys(i)).toEqual([]);
  });
});
