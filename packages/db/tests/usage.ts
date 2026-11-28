// The code of the README, as an app writes it. It is compiled with the tests and never run.
import * as v from "valibot";
import { and, collection, deleteDatabase, eq, ilike, inArray, not, NotFoundError, openDatabase, query, ValidationError, type AnyDbError, type QueryRoot } from "../src/index.js";

declare function render(rows: readonly unknown[]): void;
declare function showError(error: AnyDbError): void;

export async function quickStart() {
  type Todo = { id: string; title: string; done: boolean; created: number };

  const db = await openDatabase({
    name: "app",
    version: 1,
    collections: {
      todos: collection<Todo>().index("byDone", ["done", "created"]),
    },
  });
  const { todos } = db.collections;

  const open = query((q) =>
    q
      .from({ t: todos })
      .where(({ t }) => eq(t.done, false))
      .orderBy(({ t }) => t.created),
  );
  open.subscribe((rows) => console.log(rows));
  await todos.insert({ id: "t1", title: "Buy milk", done: false, created: 1 });
}

export async function linearlite() {
  const Issue = v.strictObject({
    id: v.string(),
    title: v.pipe(v.string(), v.minLength(1)),
    status: v.picklist([0, 1, 2, 3, 4]),
    priority: v.picklist([0, 1, 2, 3, 4]),
    created: v.number(),
    modified: v.number(),
  });
  type Detail = { id: string; body: string };

  const db = await openDatabase({
    name: "linearlite",
    version: 3,
    collections: {
      issues: collection(Issue)
        .text("byModified", "modified", "title")
        .index("byCreated", "created")
        .index("byStatus", ["status", "priority", "modified"])
        .index("byPriority", ["priority", "status", "modified"]),
      details: collection<Detail>(),
    },
  });

  const { issues, details } = db.collections;

  const now = Date.now();
  const issue = (id: string) => ({
    id,
    title: "Fix login",
    status: 1 as const,
    priority: 0 as const,
    created: now,
    modified: now,
  });

  await issues.insert(issue("i1"));
  await issues.insert([issue("i2"), issue("i3")]);
  await issues.upsert([issue("i2"), issue("i4")]);
  const next = await issues.update("i1", (draft) => {
    draft.status = 3;
    draft.modified = Date.now();
  });
  await issues.delete("i1");
  await issues.delete(["i2", "i3"]);
  const stored = await issues.get("i4");

  const open = query((q) =>
    q
      .from({ i: issues })
      .where(({ i }) => and(inArray(i.status, [1, 2]), not(eq(i.priority, 4))))
      .orderBy(({ i }) => i.modified, "desc")
      .limit(50),
  );

  const rows = await open.run();
  const stop = open.subscribe(
    (rows) => render(rows),
    (error) => showError(error),
  );
  stop();
  open.explain();

  const filtered = (q: QueryRoot, status: (0 | 1 | 2 | 3 | 4)[]) => q.from({ i: issues }).where(({ i }) => inArray(i.status, status));

  const page = query((q) =>
    filtered(q, [1, 2])
      .orderBy(({ i }) => i.status)
      .orderBy(({ i }) => i.priority)
      .orderBy(({ i }) => i.modified)
      .offset(50)
      .limit(50),
  );
  const total = query((q) => filtered(q, [1, 2]).count());
  const search = query((q) => q.from({ i: issues }).where(({ i }) => ilike(i.title, "%login%")).select(({ i }) => ({ id: i.id, title: i.title })).findOne());

  try {
    await issues.update("i9", (draft) => {
      draft.title = "";
    });
  } catch (err) {
    if (err instanceof ValidationError) void err.issues;
    if (err instanceof NotFoundError) void err.id;
  }

  await db.close();
  await deleteDatabase("linearlite");
  return [details, next satisfies { status: 0 | 1 | 2 | 3 | 4 }, stored?.title, rows[0]?.title, await page.run(), (await total.run()) satisfies number, (await search.run())?.title satisfies string | undefined];
}

export async function indexedFields() {
  type Task = { id: string; title: string; due: number | null };
  const db = await openDatabase({ name: "tasks", version: 1, collections: { tasks: collection<Task>().index("byDue", "due") } });
  const { tasks } = db.collections;
  await tasks.insert({ id: "t1", title: "Later", due: null });
  await tasks.insert({ id: "t2", title: "No due" } as Task);
}
