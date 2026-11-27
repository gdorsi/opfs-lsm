import { describe, expect, it } from "vitest";
import { root, type Buildable } from "../src/builder.js";
import type { Collection } from "../src/database.js";
import { QueryError } from "../src/errors.js";
import { and, eq, gt, ilike, inArray, like, lt, not, or, type Ref } from "../src/expr.js";

type Issue = {
  id: string;
  title: string;
  status: 0 | 1 | 2;
  created: number;
  due?: number;
  assignee: string | null;
  done?: boolean;
  tags: string[];
  meta?: { estimate: number; sprint?: string };
};
type User = { id: string; name: string };

const issues = { name: "issues" } as Collection<Issue>;
const users = { name: "users" } as Collection<User>;
const from = () => root.from({ i: issues });

/** Never called: the compiler checks it, and `@ts-expect-error` fails the build where a line it marks compiles. */
export function types() {
  const rows: Buildable<readonly Issue[]> = from()
    .where(({ i }) => and(eq(i.status, 1), gt(i.created, 5), lt(5, i.due), eq(i.assignee, null), eq(i.due, null)))
    .where(({ i }) => or(inArray(i.status, [0, 2]), not(ilike(i.title, "%x%")), like(i.assignee, "a%")))
    .where(({ i }) => i.done)
    .where(({ i }) => and(i.done, eq(i.meta.estimate, 3), eq(i.meta.sprint, null), gt(i.created, i.due)))
    .orderBy(({ i }) => i.meta.estimate, "desc")
    .orderBy(({ i }) => i.due)
    .offset(10)
    .limit(5);
  const one: Buildable<Issue | undefined> = from().findOne();
  const total: Buildable<number> = from().count();
  const picked: Buildable<readonly { readonly id: string; readonly due: number | null; readonly estimate: number | null; readonly tags: string[] }[]> = from().select(
    ({ i }) => ({ id: i.id, due: i.due, estimate: i.meta.estimate, tags: i.tags }),
  );
  const field = "created" as "created" | "status";
  from().orderBy(({ i }) => i[field]);

  // @ts-expect-error status is a number
  from().where(({ i }) => eq(i.status, "x"));
  // @ts-expect-error status is 0, 1 or 2
  from().where(({ i }) => eq(i.status, 7));
  // @ts-expect-error status is a number
  from().where(({ i }) => eq("x", i.status));
  // @ts-expect-error title is a string
  from().where(({ i }) => gt(i.title, 5));
  // @ts-expect-error a comparison takes no null
  from().where(({ i }) => gt(i.due, null));
  // @ts-expect-error status is a number
  from().where(({ i }) => inArray(i.status, ["a"]));
  // @ts-expect-error status is not text
  from().where(({ i }) => like(i.status, "%"));
  // @ts-expect-error tags is an array, which no operator compares
  from().where(({ i }) => eq(i.tags, "a"));
  // @ts-expect-error a string field is not a condition
  from().where(({ i }) => i.title);
  // @ts-expect-error not a field of Issue
  from().where(({ i }) => eq(i.nope, 1));
  // @ts-expect-error the alias is i
  from().where(({ j }) => eq(j.status, 1));
  // @ts-expect-error an array orders nothing
  from().orderBy(({ i }) => i.tags);
  // @ts-expect-error an object orders nothing
  from().orderBy(({ i }) => i.meta);
  // @ts-expect-error a condition is not a field
  from().orderBy(({ i }) => eq(i.status, 1));
  // @ts-expect-error select takes fields
  from().select(({ i }) => ({ open: eq(i.status, 1) }));
  // @ts-expect-error a count is a number
  const wrong: Buildable<readonly Issue[]> = from().count();
  return [rows, one, total, picked, wrong];
}

describe("the builder", () => {
  it("refuses an orderBy or a select that is not a field of its collection", () => {
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (err) {
        return err instanceof QueryError ? err.code : "another error";
      }
      return "no error";
    };
    const other = root.from({ u: users });
    let name!: Ref<string>;
    other.where(({ u }) => ((name = u.name), eq(u.name, "ada")));
    expect(code(() => from().orderBy(() => name))).toBe("operand");
    expect(code(() => from().orderBy(({ i }) => eq(i.status, 1) as never))).toBe("operand");
    expect(code(() => from().orderBy(({ i }) => i as never))).toBe("operand");
    expect(code(() => from().select(({ i }) => ({ open: eq(i.status, 1) as never })))).toBe("operand");
    expect(code(() => from().where(() => true as never))).toBe("operand");
  });

  it("takes one collection", () => {
    expect(() => root.from({ i: issues, u: users } as never)).toThrow(QueryError);
    expect(() => root.from({} as never)).toThrow(QueryError);
  });

  it("refuses a limit or an offset that is not a count", () => {
    expect(() => from().limit(-1)).toThrow(RangeError);
    expect(() => from().limit(1.5)).toThrow(RangeError);
    expect(() => from().offset(Number.NaN)).toThrow(RangeError);
    expect(() => from().offset(0).limit(0)).not.toThrow();
  });
});
