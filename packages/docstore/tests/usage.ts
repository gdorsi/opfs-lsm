import * as v from "valibot";
import { z } from "zod";
import { collection, defineSchema, type DocStore, type IndexInfo, type Query } from "../src/index.js";

type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
  titleSort: string;
};

export const todoSchema = defineSchema({
  version: 1,
  collections: {
    todos: collection<Todo>()
      .index("byCreated", "createdAt")
      .index("byTitle", "titleSort")
      .text("search", "createdAt", "title"),
  },
});

type TodoQuery = Query<Todo, (typeof todoSchema)["collections"]["todos"]["indexes"]>;
declare const cursor: import("../src/index.js").Cursor | undefined;

export const todoQueries: TodoQuery[] = [
  { index: "byCreated", reverse: true, limit: 50, after: cursor },
  { index: "search", match: "buy mi", reverse: true, limit: 50 },
  { index: "byTitle", startsWith: "buy" },
  { startsWith: "2024-" },
  { index: "byCreated", gte: 0 },
  // @ts-expect-error not an index of todos
  { index: "byCreatd" },
  // @ts-expect-error createdAt is a number
  { index: "byCreated", gte: "2024" },
  // @ts-expect-error match is only for text indexes
  { index: "byCreated", match: "x" },
  // @ts-expect-error startsWith is only for string components
  { index: "byCreated", startsWith: "1" },
  // @ts-expect-error a single-component index has nothing after a full eq
  { index: "byCreated", eq: [1], gte: 2 },
];

// @ts-expect-error not a field of Todo
defineSchema({ version: 1, collections: { todos: collection<Todo>().index("x", "tite") } });
// @ts-expect-error text must be a string field
defineSchema({ version: 1, collections: { todos: collection<Todo>().text("s", "createdAt", "done") } });
// @ts-expect-error a collection is declared with collection()
defineSchema({ version: 1, collections: { todos: {} } });
// @ts-expect-error an index name is declared once
collection<Todo>().index("x", "createdAt").unique("x", "titleSort");
// @ts-expect-error the same name, as a text index
collection<Todo>().index("x", "createdAt").text("x", "createdAt", "title");

const withEmpty = defineSchema({
  version: 1,
  collections: { drafts: collection<Todo>(), todos: collection<Todo>().index("byCreated", "createdAt") },
});
export const emptyKeepsOthers: Query<Todo, (typeof withEmpty)["collections"]["todos"]["indexes"]> = { index: "byCreated", gte: 0 };
// @ts-expect-error a collection declared with no indexes has none to query
export const emptyHasNone: Query<Todo, (typeof withEmpty)["collections"]["drafts"]["indexes"]> = { index: "byCreated" };

type HasDate = { id: string; at: Date };
// @ts-expect-error a Date does not survive JSON
collection<HasDate>();
type HasBytes = { id: string; data: Uint8Array };
// @ts-expect-error a Uint8Array does not survive JSON
collection<HasBytes>();

export async function misuse(store: DocStore<typeof todoSchema>): Promise<void> {
  // @ts-expect-error not a collection of the schema
  store.collection("nope");
  // @ts-expect-error a put needs every field the type requires
  await store.collection("todos").put({ id: "x", title: "t" });
}

export async function snapshotsAndChanges(store: DocStore<typeof todoSchema>): Promise<void> {
  const todos = store.collection("todos");
  const kinds: IndexInfo["kind"][] = [...todos.indexes.values()].map((i) => i.kind);
  await todos.view(async (snap) => {
    const seq: number = snap.seq;
    const page = await snap.query({ index: "byCreated", gte: seq, limit: 10 });
    const first: string | undefined = page.docs[0]?.title;
    // @ts-expect-error not an index of todos
    await snap.query({ index: "byCreatd" });
    // @ts-expect-error createdAt is a number
    await snap.count({ index: "byCreated", gte: "2024" });
    return [kinds, first, await snap.getMany(["a"])];
  });
  await todos.modifyMany(["a", "b"], ([a, b]) => [a && { ...a, done: true }, b ? null : undefined]);
  // @ts-expect-error a todo has no such field
  await todos.modifyMany(["a"], () => [{ id: "a", nope: 1 }]);
  todos.changes((event) => {
    if (event.kind !== "append") return;
    for (const change of event.changes) {
      const doc: { title: string } | undefined = change.doc;
      void [change.id, change.deleted, doc];
    }
  });
}

type Note = { id: string; owner: string; slug: string; tags: string[]; updatedAt: number; body: string };

const notesSchema = defineSchema({
  version: 3,
  collections: {
    notes: collection<Note>()
      .unique("bySlug", "slug")
      .index("byOwnerUpdated", ["owner", "updatedAt"])
      .index("byTag", ["tags[]", "updatedAt"])
      .text("search", ["owner", "updatedAt"], "body"),
  },
});

type NoteQuery = Query<Note, (typeof notesSchema)["collections"]["notes"]["indexes"]>;
declare const since: number;

export const noteQueries: NoteQuery[] = [
  { index: "byOwnerUpdated", eq: ["ann"], gte: since, reverse: true, limit: 20 },
  { index: "byOwnerUpdated", eq: ["ann", since] },
  { index: "byTag", eq: ["work"], limit: 20 },
  { index: "search", eq: ["ann"], match: "quarterly rep", reverse: true, limit: 20 },
  { index: "bySlug", eq: ["hello-world"] },
  // @ts-expect-error updatedAt is the second component: after eq ["ann"] the bound is a number
  { index: "byOwnerUpdated", eq: ["ann"], gte: "x" },
  { index: "byTag", eq: ["work", since] },
  { index: "byTag", eq: ["work"], gte: since },
  // @ts-expect-error the element type of tags is string
  { index: "byTag", eq: [1] },
  // @ts-expect-error updatedAt is the second component of byTag, a number
  { index: "byTag", eq: ["work", "x"] },
  // @ts-expect-error a bound on the second component needs eq on the first
  { index: "byOwnerUpdated", gte: since },
  { index: "byOwnerUpdated", eq: [["ann", "bob"]], gte: since, reverse: true, limit: 20 },
  { index: "byOwnerUpdated", eq: ["ann", [since, since + 1]] },
  { index: "byOwnerUpdated", eq: [["ann", "bob"], [since]] },
  { index: "byTag", eq: [["work", "home"]], gte: since, limit: 50 },
  { index: "search", eq: [["ann"]], match: "rep" },
  // @ts-expect-error the owners listed are strings
  { index: "byOwnerUpdated", eq: [[1]] },
  // @ts-expect-error after a list of owners the bound is a number: updatedAt
  { index: "byOwnerUpdated", eq: [["ann"]], gte: "x" },
  // @ts-expect-error the second slot takes numbers, whether a value or a list
  { index: "byOwnerUpdated", eq: ["ann", ["bob"]] },
  // @ts-expect-error eq has fixed every component, lists included, so no bound follows
  { index: "byOwnerUpdated", eq: ["ann", [since]], gte: since },
  // @ts-expect-error eq has fixed every component, so startsWith has none
  { index: "byOwnerUpdated", eq: ["ann", since], startsWith: "a" },
  // @ts-expect-error nor when a slot is a list
  { index: "byOwnerUpdated", eq: ["ann", [since]], startsWith: "a" },
  // @ts-expect-error a list holds values, not lists
  { index: "byOwnerUpdated", eq: [[["ann"]]] },
  // @ts-expect-error a unique index holds one document per value: use getMany
  { index: "bySlug", eq: [["hello-world"]] },
  // @ts-expect-error the rows have no lists either
  { eq: [["a"]] },
];

type Issue = { id: string; projectId: string; status: "todo" | "started" | "done"; updatedAt: number };
const issueSchema = defineSchema({
  version: 1,
  collections: { issues: collection<Issue>().index("byStatus", ["projectId", "status", "updatedAt"]) },
});
export const issueQueries: Query<Issue, (typeof issueSchema)["collections"]["issues"]["indexes"]>[] = [
  { index: "byStatus", eq: ["p", ["todo", "started"]], reverse: true, limit: 50 },
  { index: "byStatus", eq: [["p", "q"], ["todo"]], gt: since },
  // @ts-expect-error "open" is not a status of Issue
  { index: "byStatus", eq: ["p", ["open"]] },
  // @ts-expect-error after a list of statuses the bound is a number: updatedAt
  { index: "byStatus", eq: ["p", ["todo"]], gte: "x" },
];

export async function entryValues(store: DocStore<typeof notesSchema>): Promise<unknown[]> {
  const notes = store.collection("notes");
  const byTag: [string, number][] = (await notes.queryEntries({ index: "byTag", eq: ["work"] })).entries.map((e) => e.values);
  const bySlug: [string][] = (await notes.queryEntries({ index: "bySlug" })).entries.map((e) => e.values);
  const rows: [string][] = (await notes.queryEntries({ limit: 1 })).entries.map((e) => e.values);
  const inView = await notes.view((snap) => snap.queryEntries({ index: "search", eq: ["ann"], match: "rep" }));
  const search: [string, number][] = inView.entries.map((e) => e.values);
  // @ts-expect-error updatedAt is a number
  const wrong: [string, string][] = (await notes.queryEntries({ index: "byOwnerUpdated" })).entries.map((e) => e.values);
  // @ts-expect-error revers is not a query option
  await notes.queryEntries({ index: "byTag", revers: true });
  // @ts-expect-error the element type of tags is string
  await notes.queryEntries({ index: "byTag", eq: [1] });
  return [byTag, bySlug, rows, search, wrong];
}

const coveringSchema = defineSchema({
  version: 1,
  collections: {
    notes: collection<Note>()
      .index("list", ["owner", "updatedAt"], { include: ["slug", "tags"] })
      .index("byTag", ["tags[]", "updatedAt"], { include: ["slug"] })
      .index("plain", "owner"),
  },
});

export async function entryFields(store: DocStore<typeof coveringSchema>): Promise<unknown[]> {
  const notes = store.collection("notes");
  const list = (await notes.queryEntries({ index: "list", eq: ["ann"] })).entries;
  const fields: Pick<Note, "slug" | "tags">[] = list.map((e) => e.fields);
  const slugs: string[] = (await notes.view((snap) => snap.queryEntries({ index: "byTag" }))).entries.map((e) => e.fields.slug);
  // @ts-expect-error body is not included
  list.map((e) => e.fields.body);
  // @ts-expect-error an index without include has no fields
  (await notes.queryEntries({ index: "plain" })).entries.map((e) => e.fields);
  // @ts-expect-error the rows have no fields
  (await notes.queryEntries({})).entries.map((e) => e.fields);
  return [fields, slugs];
}

// @ts-expect-error include takes fields of the document
collection<Note>().index("x", "owner", { include: ["titel"] });
// @ts-expect-error include takes top-level fields
collection<{ id: string; a: number; m: { n: string } }>().index("x", "a", { include: ["m.n"] });
// @ts-expect-error include takes at least one field
collection<Note>().index("x", "owner", { include: [] });
// @ts-expect-error a unique index takes no include
collection<Note>().unique("x", "slug", { include: ["owner"] });
// @ts-expect-error a text index takes no include
collection<Note>().text("x", "owner", "body", { include: ["slug"] });

// @ts-expect-error [] marks an array field, and owner is a string
defineSchema({ version: 1, collections: { notes: collection<Note>().index("m", "owner[]") } });
// @ts-expect-error an array field needs the [] mark
defineSchema({ version: 1, collections: { notes: collection<Note>().index("m", "tags") } });
// @ts-expect-error only the first field may be an array
defineSchema({ version: 1, collections: { notes: collection<Note>().index("m", ["updatedAt", "tags[]"]) } });
// @ts-expect-error a text index cannot start with an array field
defineSchema({ version: 1, collections: { notes: collection<Note>().text("t", "tags[]", "body") } });
// @ts-expect-error a misspelled field inside a list
defineSchema({ version: 1, collections: { notes: collection<Note>().index("u", ["owner", "updatedAtt"]) } });
// @ts-expect-error an empty list of fields
defineSchema({ version: 1, collections: { notes: collection<Note>().index("u", []) } });

const Task = v.object({
  id: v.string(),
  title: v.pipe(v.string(), v.minLength(1)),
  done: v.optional(v.boolean(), false),
  createdAt: v.number(),
  tags: v.optional(v.array(v.string()), []),
});

const Person = z.object({
  id: z.string(),
  email: z.email().optional(),
  joined: z.date().transform((d) => d.getTime()),
});

export const validated = defineSchema({
  version: 1,
  collections: {
    tasks: collection(Task)
      .index("byCreated", "createdAt")
      .index("byTag", ["tags[]", "createdAt"])
      .text("search", "createdAt", "title"),
    people: collection(Person).unique("byEmail", "email").index("byJoined", "joined"),
    notes: collection<Note>().index("byOwner", ["owner", "updatedAt"]),
    drafts: collection(Task),
  },
});

export async function validatedWrites(store: DocStore<typeof validated>): Promise<unknown[]> {
  const tasks = store.collection("tasks");
  const people = store.collection("people");
  await tasks.put({ id: "t1", title: "Buy milk", createdAt: 1 });
  const task = await tasks.get("t1");
  const done: boolean | undefined = task?.done;
  const tags: string[] | undefined = task?.tags;
  // @ts-expect-error createdAt has no default
  await tasks.put({ id: "t2", title: "x" });
  // @ts-expect-error done is a boolean
  await tasks.put({ id: "t2", title: "x", createdAt: 1, done: "yes" });
  await tasks.modify("t1", (t) => ({ ...t, done: !t.done }));
  await tasks.modifyMany(["t1"], ([t]) => [t && { ...t, tags: [...t.tags, "home"] }]);

  await people.put({ id: "p1", joined: new Date() });
  // @ts-expect-error a write takes the input of joined, a Date
  await people.put({ id: "p1", joined: 0 });
  const joined: number | undefined = (await people.get("p1"))?.joined;
  // @ts-expect-error the stored form holds joined as a number, which the input does not accept
  await people.modify("p1", (p) => ({ ...p, email: "a@b.c" }));
  await people.modify("p1", (p) => ({ ...p, joined: new Date(p.joined) }));

  const recent = await people.query({ index: "byJoined", gte: 0 });
  // @ts-expect-error joined is stored as a number
  await people.query({ index: "byJoined", gte: new Date() });
  // @ts-expect-error not an index of tasks
  await tasks.query({ index: "byJoined" });
  await tasks.query({ index: "byTag", eq: ["home"], gte: 0 });
  // @ts-expect-error tags hold strings
  await tasks.query({ index: "byTag", eq: [1] });
  await tasks.query({ index: "search", match: "milk" });

  const notes = store.collection("notes");
  await notes.put({ id: "n1", owner: "ann", slug: "s", tags: [], updatedAt: 1, body: "" });
  await notes.query({ index: "byOwner", eq: ["ann"], gte: 0 });
  // @ts-expect-error a collection with no validator takes its document type
  await notes.put({ id: "n2" });
  // @ts-expect-error drafts has no index
  await store.collection("drafts").query({ index: "byCreated" });
  return [done, tags, joined, recent];
}

// @ts-expect-error joined is a number in the stored form, and so is not a string field
collection(Person).text("s", "id", "joined");
// @ts-expect-error not a field of the validator's output
collection(Task).index("x", "titel");
// @ts-expect-error a Date does not survive JSON
collection(v.object({ id: v.string(), at: v.date() }));
// @ts-expect-error a document needs a string id
collection(z.object({ id: z.number() }));
// @ts-expect-error an index name is declared once, with a validator too
collection(Task).index("x", "createdAt").index("x", "title");

const Visit = v.object({ id: v.string(), at: v.pipe(v.date(), v.transform((d) => d.getTime())) });
const visitSchema = defineSchema({ version: 1, collections: { visits: collection(Visit).index("byAt", "at") } });

export async function transformedWrites(store: DocStore<typeof visitSchema>): Promise<void> {
  const visits = store.collection("visits");
  await visits.put({ id: "v1", at: new Date() });
  await visits.modify("v1", (x) => ({ ...x, at: new Date(x.at) }));
  // @ts-expect-error at is a number in the stored form, and the input takes a Date
  await visits.modify("v1", (x) => ({ ...x }));
}
