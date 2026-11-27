import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";
import { openOn } from "../src/database.js";
import { collection, DbError, ValidationError, type Collection, type Database, type Collections } from "../src/index.js";
import { freshName, openKv } from "./harness.js";

type Issue = { id: string; title: string; status: number; assignee?: string | null; tags?: string[]; meta?: { due: number | null } };
type User = { id: string; email: string | null; name: string };

const collections = {
  issues: collection<Issue>().index("byStatus", ["status", "meta.due"]).text("search", "status", "title").index("byTag", "tags[]"),
  users: collection<User>().unique("byEmail", "email"),
};

const open: Database<Collections>[] = [];
async function openDb<C extends Collections>(defs: C, name = freshName(), version = 1): Promise<Database<C>> {
  const db = await openOn(await openKv(name), { version, collections: defs });
  open.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

/** The tag and code of the DbError `run` rejects with. */
async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    if (err instanceof DbError) return `${err._tag} ${err.code}`;
    throw err;
  }
  return "no error";
}

const issue = (id: string, over: Partial<Issue> = {}): Issue => ({ id, title: `Issue ${id}`, status: 1, meta: { due: null }, ...over });

describe("writes and reads", () => {
  it("inserts, reads, updates and deletes documents", async () => {
    const { issues } = (await openDb(collections)).collections;
    await issues.insert(issue("a"));
    await issues.insert([issue("b"), issue("c", { status: 2 })]);
    expect(await issues.get("a")).toEqual(issue("a"));
    expect(await issues.get("zz")).toBeUndefined();
    expect(await issues.get("")).toBeUndefined();

    const updated = await issues.update("a", (draft) => {
      draft.status = 3;
      draft.title = "Renamed";
    });
    expect(updated).toEqual(issue("a", { status: 3, title: "Renamed" }));
    expect(await issues.get("a")).toEqual(updated);

    await issues.delete("a");
    await issues.delete(["b", "missing", ""]);
    expect(await Promise.all(["a", "b", "c"].map((id) => issues.get(id)))).toEqual([undefined, undefined, issue("c", { status: 2 })]);
    expect(issues.name).toBe("issues");
  });

  it("refuses an insert of an id that exists, and stores none of its documents", async () => {
    const { issues } = (await openDb(collections)).collections;
    await issues.insert(issue("a"));
    const again = issues.insert([issue("b"), issue("a", { title: "Other" })]);
    await expect(again).rejects.toMatchObject({ _tag: "ConflictError", code: "duplicate", collection: "issues", ids: ["a"] });
    expect(await issues.get("a")).toEqual(issue("a"));
    expect(await issues.get("b")).toBeUndefined();
  });

  it("upserts over what exists", async () => {
    const { issues } = (await openDb(collections)).collections;
    await issues.insert(issue("a"));
    await issues.upsert([issue("a", { title: "Replaced" }), issue("b")]);
    expect(await issues.get("a")).toEqual(issue("a", { title: "Replaced" }));
    expect(await issues.get("b")).toEqual(issue("b"));
  });

  it("refuses one id twice in a call", async () => {
    const { issues } = (await openDb(collections)).collections;
    expect(await failure(issues.insert([issue("a"), issue("a")]))).toBe("ValidationError id");
    expect(await failure(issues.upsert([issue("a"), issue("a")]))).toBe("ValidationError id");
    expect(await issues.get("a")).toBeUndefined();
  });

  it("reports a value a unique index already holds, with both ids", async () => {
    const { users } = (await openDb(collections)).collections;
    await users.insert({ id: "u1", email: "ada@example.com", name: "Ada" });
    const taken = users.insert({ id: "u2", email: "ada@example.com", name: "Other" });
    await expect(taken).rejects.toMatchObject({ _tag: "ConflictError", code: "unique", collection: "users", ids: ["u2", "u1"] });
    expect(await users.get("u2")).toBeUndefined();
  });
});

describe("the write gate", () => {
  it("requires a usable id", async () => {
    const { issues } = (await openDb(collections)).collections;
    for (const id of ["", "\uD800", "x".repeat(1025), 5, undefined]) {
      expect(await failure(issues.insert({ ...issue("a"), id } as Issue))).toBe("ValidationError id");
    }
    expect(await failure(issues.insert(null as unknown as Issue))).toBe("ValidationError id");
  });

  it("requires a value at every field a sorted or text index names, and takes null", async () => {
    const { issues } = (await openDb(collections)).collections;
    const { status: _, ...noStatus } = issue("a");
    const bad: unknown[] = [
      noStatus,
      { ...issue("a"), meta: undefined },
      { ...issue("a"), meta: {} },
      { ...issue("a"), status: [1] },
      { ...issue("a"), status: Infinity },
      { ...issue("a"), meta: { due: NaN } },
      { ...issue("a"), title: 5 },
      { ...issue("a"), title: undefined },
    ];
    for (const doc of bad) {
      await expect(issues.insert(doc as Issue)).rejects.toMatchObject({ _tag: "ValidationError", code: "indexed-field", collection: "issues", id: "a" });
      await expect(issues.upsert(doc as Issue)).rejects.toMatchObject({ _tag: "ValidationError", code: "indexed-field" });
    }
    expect(await issues.get("a")).toBeUndefined();
    const nulls = { id: "a", title: null, status: null, meta: { due: null } } as unknown as Issue;
    await issues.insert(nulls);
    expect(await issues.get("a")).toEqual(nulls);
  });

  it("leaves the fields of a multi index optional", async () => {
    const { issues } = (await openDb(collections)).collections;
    await issues.insert(issue("a"));
    await issues.insert(issue("b", { tags: ["x", "y"] }));
    expect((await issues.get("a"))?.tags).toBeUndefined();
  });

  it("reports a value the storage cannot index", async () => {
    const { users } = (await openDb(collections)).collections;
    expect(await failure(users.insert({ id: "u1", email: "lone \uD800", name: "Ada" }))).toBe("ValidationError indexed-field");
    expect(await users.get("u1")).toBeUndefined();
  });

  it("checks what update made of the document, and stores nothing it refuses", async () => {
    const { issues } = (await openDb(collections)).collections;
    await issues.insert(issue("a"));
    const cleared = issues.update("a", (draft) => {
      delete (draft as Partial<Issue>).status;
    });
    expect(await failure(cleared)).toBe("ValidationError indexed-field");
    const renamed = issues.update("a", (draft) => {
      draft.id = "b";
    });
    await expect(renamed).rejects.toMatchObject({ _tag: "ValidationError", code: "id", id: "a" });
    expect(await issues.get("a")).toEqual(issue("a"));
    expect(await issues.get("b")).toBeUndefined();
  });

  it("rejects an update of a missing document, and passes on what the callback throws", async () => {
    const { issues } = (await openDb(collections)).collections;
    await expect(issues.update("nope", () => {})).rejects.toMatchObject({ _tag: "NotFoundError", code: "missing", collection: "issues", id: "nope" });
    expect(await failure(issues.update("", () => {}))).toBe("NotFoundError missing");
    await issues.insert(issue("a"));
    const thrown = new Error("from the callback");
    const failed = issues.update("a", (draft) => {
      draft.title = "changed";
      throw thrown;
    });
    await expect(failed).rejects.toBe(thrown);
    expect(await issues.get("a")).toEqual(issue("a"));
  });
});

describe("a validator", () => {
  const Task = v.strictObject({
    id: v.string(),
    title: v.pipe(v.string(), v.minLength(1)),
    done: v.optional(v.boolean(), false),
    created: v.number(),
  });
  const tasksDef = { tasks: collection(Task).index("byCreated", "created") };

  it("checks every write, stores its output, and reports its issues", async () => {
    const { tasks } = (await openDb(tasksDef)).collections;
    await tasks.insert({ id: "t1", title: "Buy milk", created: 1 });
    expect(await tasks.get("t1")).toEqual({ id: "t1", title: "Buy milk", done: false, created: 1 });

    const empty = tasks.insert({ id: "t2", title: "", created: 2 }).catch((err: unknown) => err);
    const err = await empty;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "invalid", collection: "tasks", id: "t2" });
    expect((err as ValidationError).issues?.[0]?.message).toEqual(expect.any(String));
    expect(await failure(tasks.upsert({ id: "t2", title: "x", created: "soon" as never }))).toBe("ValidationError invalid");
    expect(await tasks.get("t2")).toBeUndefined();

    const cleared = tasks.update("t1", (draft) => {
      draft.title = "";
    });
    expect(await failure(cleared)).toBe("ValidationError invalid");
    const done = await tasks.update("t1", (draft) => {
      draft.done = true;
    });
    expect(done).toEqual({ id: "t1", title: "Buy milk", done: true, created: 1 });
  });

  it("must be synchronous", async () => {
    const Later = { ...Task, "~standard": { ...Task["~standard"], validate: async (value: unknown) => Task["~standard"].validate(value) } } as typeof Task;
    const { tasks } = (await openDb({ tasks: collection(Later) })).collections;
    expect(await failure(tasks.insert({ id: "t1", title: "x", created: 1 }))).toBe("ValidationError async");
    expect(await tasks.get("t1")).toBeUndefined();
  });
});

describe("open and close", () => {
  it("keeps documents across a close and an open", async () => {
    const name = freshName();
    const first = await openDb(collections, name);
    await first.collections.issues.insert(issue("a"));
    await first.close();
    const second = await openDb(collections, name);
    expect(await second.collections.issues.get("a")).toEqual(issue("a"));
  });

  it("rejects every call after close, and closes once", async () => {
    const db = await openDb(collections);
    const { issues } = db.collections;
    await issues.insert(issue("a"));
    const closed = db.close();
    expect(db.close()).toBe(closed);
    await closed;
    const calls = [issues.get("a"), issues.insert(issue("b")), issues.upsert(issue("b")), issues.update("a", () => {}), issues.delete("a")];
    for (const call of calls) expect(await failure(call)).toBe("ClosedError closed");
  });

  it("refuses a version stored with other indexes, and a schema docstore cannot take", async () => {
    const name = freshName();
    await (await openDb(collections, name)).close();
    const changed = { ...collections, users: collection<User>().index("byName", "name") };
    expect(await failure(openDb(changed, name))).toBe("SchemaError version");
    expect(await failure(openDb(collections, name, 0))).toBe("SchemaError catalog");
    expect(await failure(openDb({ issues: {} as never }))).toBe("SchemaError catalog");
    const raised = await openDb(changed, name, 2);
    await raised.collections.users.insert({ id: "u1", email: null, name: "Ada" });
  });
});

/** Never called: the compiler checks it. */
export function types(db: Database<typeof collections>, tasks: Collection<{ id: string; done: boolean }, { id: string; done?: boolean }>) {
  const { issues } = db.collections;
  void issues.insert({ id: "a", title: "t", status: 1 });
  // @ts-expect-error status is a number
  void issues.insert({ id: "a", title: "t", status: "open" });
  // @ts-expect-error not a collection of this database
  void db.collections.nope;
  void issues.update("a", (draft) => {
    // @ts-expect-error title is a string
    draft.title = 5;
  });
  void tasks.insert({ id: "t" });
  void tasks.get("t").then((task) => task?.done satisfies boolean | undefined);

  collection<Issue>().index("a", "status").index("b", ["status", "meta.due"]).unique("c", "title").text("d", "meta.due", "title").index("e", "tags[]");
  // @ts-expect-error not a field of Issue
  collection<Issue>().index("a", "nope");
  // @ts-expect-error an array field is written "tags[]"
  collection<Issue>().index("a", "tags");
  // @ts-expect-error an object is no index value
  collection<Issue>().index("a", "meta");
  // @ts-expect-error status is not text
  collection<Issue>().text("a", "status", "status");
  // @ts-expect-error the name is taken
  collection<Issue>().index("a", "status").unique("a", "title");
  // @ts-expect-error an interface-like type without a string id is no document
  collection<{ title: string }>();
}
