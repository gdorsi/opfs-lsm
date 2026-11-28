import { createEffect, createRoot, createSignal, flush, isPending } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { openOn } from "../src/database.js";
import { ClosedError, collection, eq, query, type Collections, type Database, type LiveQuery } from "../src/index.js";
import { useLiveQuery } from "../src/solid.js";
import { openKv, until } from "./harness.js";

type Issue = { id: string; title: string; status: number; modified: number };

const collections = { issues: collection<Issue>().index("byStatus", ["status", "modified"]) };

const open: Database<Collections>[] = [];
const roots: (() => void)[] = [];
async function openDb() {
  const db = await openOn(await openKv(), { version: 1, collections });
  open.push(db);
  return db.collections.issues;
}
afterEach(async () => {
  for (const dispose of roots.splice(0)) dispose();
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const issue = (n: number, over: Partial<Issue> = {}): Issue => ({ id: `i${n}`, title: `Issue ${n}`, status: 1, modified: n, ...over });

/** What an effect that reads `read` saw: each value, and each error thrown at it. */
function watch<V>(read: () => V): { readonly values: V[]; readonly errors: unknown[] } {
  const seen = { values: [] as V[], errors: [] as unknown[] };
  createEffect(read, { effect: (value) => void seen.values.push(value), error: (error) => void seen.errors.push(error) });
  return seen;
}

/** Runs `body` under a root that the test's end disposes. */
function mount<R>(body: () => R): R {
  return createRoot((dispose) => {
    roots.push(dispose);
    return body();
  });
}

const byStatus = (issues: Awaited<ReturnType<typeof openDb>>, status: number) =>
  query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, status)).orderBy(({ i }) => i.modified));

describe("useLiveQuery", () => {
  it("gives a list whose rows are matched by id: a change to one document reaches only what reads the changed field", async () => {
    const issues = await openDb();
    await issues.insert([issue(1), issue(2), issue(3)]);
    const { rows, titles, firstModified } = mount(() => {
      const rows = useLiveQuery(() => byStatus(issues, 1));
      return { rows, titles: watch(() => rows().map((r) => r.title)), firstModified: watch(() => rows()[0]!.modified) };
    });
    await until(() => titles.values.length === 1);
    expect(titles.values[0]).toEqual(["Issue 1", "Issue 2", "Issue 3"]);
    const before = [...rows()];

    await issues.update("i2", (draft) => {
      draft.title = "Renamed";
    });
    await until(() => titles.values.length === 2);
    expect(titles.values[1]).toEqual(["Issue 1", "Renamed", "Issue 3"]);
    expect(rows().every((row, i) => row === before[i])).toBe(true);
    expect(firstModified.values).toEqual([1]);

    await issues.update("i1", (draft) => {
      draft.modified = 9;
    });
    await until(() => titles.values.length === 3);
    expect(titles.values[2]).toEqual(["Renamed", "Issue 3", "Issue 1"]);
    expect(rows()[2]).toBe(before[0]);
    expect(rows()[0]).toBe(before[1]);
  });

  it("gives a count and one row, and undefined when there is none", async () => {
    const issues = await openDb();
    await issues.insert([issue(1), issue(2)]);
    const { total, one } = mount(() => ({
      total: watch(useLiveQuery(() => query((q) => q.from({ i: issues }).count()))),
      one: watch(useLiveQuery(() => query((q) => q.from({ i: issues }).where(({ i }) => eq(i.id, "i2")).findOne()))),
    }));
    await until(() => total.values.length === 1 && one.values.length === 1);
    expect(total.values).toEqual([2]);
    expect(one.values[0]).toEqual(issue(2));

    await issues.delete("i2");
    await until(() => total.values.length === 2 && one.values.length === 2);
    expect(total.values[1]).toBe(1);
    expect(one.values[1]).toBeUndefined();
  });

  it("moves the subscription when a signal the query function reads changes, and keeps the last result until the new one is read", async () => {
    const issues = await openDb();
    await issues.insert([issue(1), issue(2, { status: 2 })]);
    const built: LiveQuery<readonly Issue[]>[] = [];
    const [status, setStatus] = createSignal(1);
    const { rows, ids } = mount(() => {
      const rows = useLiveQuery(() => {
        built.push(byStatus(issues, status()));
        return built.at(-1)!;
      });
      return { rows, ids: watch(() => rows().map((r) => r.id)) };
    });
    await until(() => ids.values.length === 1);
    expect(ids.values[0]).toEqual(["i1"]);

    setStatus(2);
    flush();
    expect(built.length).toBe(2);
    expect(rows().map((r) => r.id)).toEqual(["i1"]);
    expect(isPending(rows)).toBe(true);
    await until(() => ids.values.length === 2);
    expect(ids.values[1]).toEqual(["i2"]);
    expect(isPending(rows)).toBe(false);

    await issues.insert(issue(3));
    await issues.insert(issue(4, { status: 2 }));
    await until(() => ids.values.length === 3);
    expect(ids.values[2]).toEqual(["i2", "i4"]);
  });

  it("stops the subscription when its owner is disposed", async () => {
    const live = byStatus(await openDb(), 1);
    let subscribed = 0;
    const counted: typeof live = {
      ...live,
      subscribe(next, error) {
        subscribed++;
        const stop = live.subscribe(next, error);
        return () => {
          subscribed--;
          stop();
        };
      },
    };
    const dispose = createRoot((dispose) => {
      watch(useLiveQuery(() => counted));
      return dispose;
    });
    await until(() => subscribed === 1);
    dispose();
    expect(subscribed).toBe(0);
  });

  it("throws the error that ended the subscription at what reads the result", async () => {
    const issues = await openDb();
    await issues.insert(issue(1));
    const seen = mount(() => watch(useLiveQuery(() => byStatus(issues, 1))));
    await until(() => seen.values.length === 1);
    await open.pop()!.close();
    await until(() => seen.errors.length === 1);
    expect(seen.errors[0]).toBeInstanceOf(ClosedError);
  });

  it("throws an error of the query function at what reads the result", async () => {
    const seen = mount(() => watch(useLiveQuery(() => query((q) => q.from({ i: {} as never })))));
    await until(() => seen.errors.length === 1);
    expect(seen.errors[0]).toMatchObject({ _tag: "QueryError", code: "source" });
  });
});
