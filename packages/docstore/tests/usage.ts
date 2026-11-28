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
      const created: number | undefined = change.before("byCreated")[0]?.values[0];
      // @ts-expect-error a text index's entries hold the words, which a write can replace in place
      change.before("search");
      // @ts-expect-error not an index of todos
      change.before("byCreatd");
      void [change.id, change.deleted, doc, created];
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

// An index picked at runtime: the query must suit each index it can be.
declare const sortBy: "byOwnerUpdated" | "byTag" | "bySlug" | "search";
declare const listed: "byOwnerUpdated" | "byTag";
declare const prefix: readonly [string] | readonly [string, number];
export const pickedQueries: NoteQuery[] = [
  { index: sortBy, reverse: true, limit: 20 },
  { index: sortBy, gte: "a" },
  { index: listed, eq: ["ann"], gte: since },
  { index: listed, eq: [["ann", "bob"]] },
  { index: listed, eq: prefix },
  { index: "byOwnerUpdated", eq: prefix },
  // @ts-expect-error byOwnerUpdated is not a text index
  { index: listed, match: "x" },
  { index: "search", match: "x" },
  // @ts-expect-error bySlug is unique: no lists
  { index: sortBy, eq: [["ann", "bob"]] },
  // @ts-expect-error bySlug has one component
  { index: sortBy, eq: prefix },
  // @ts-expect-error the first component of each is a string
  { index: listed, gte: since },
  // @ts-expect-error eq fixes every component of bySlug, so no bound follows
  { index: "bySlug" as "bySlug" | "byTag", eq: ["a"], gte: since },
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

const includeSchema = defineSchema({
  version: 1,
  collections: {
    notes: collection<Note>()
      .index("list", ["owner", "updatedAt"], { include: ["slug", "tags"] })
      .index("byTag", ["tags[]", "updatedAt"], { include: ["slug"] })
      .index("plain", "owner"),
  },
});

export async function entryFields(store: DocStore<typeof includeSchema>): Promise<unknown[]> {
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
  const picked = await notes.queryEntries({ index: "list" as "list" | "plain", limit: 10 });
  const first: string | undefined = picked.entries[0] && "fields" in picked.entries[0] ? picked.entries[0].fields.slug : undefined;
  // @ts-expect-error plain has no fields, so a picked index of the two may have none
  picked.entries.map((e) => e.fields);
  return [fields, slugs, first];
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

type Task = { id: string; title: string; done: boolean; createdAt: number; tags: string[] };
type Person = { id: string; email?: string; joined: number };

export const indexed = defineSchema({
  version: 1,
  collections: {
    tasks: collection<Task>()
      .index("byCreated", "createdAt")
      .index("byTag", ["tags[]", "createdAt"])
      .text("search", "createdAt", "title"),
    people: collection<Person>().unique("byEmail", "email").index("byJoined", "joined"),
    notes: collection<Note>().index("byOwner", ["owner", "updatedAt"]),
    drafts: collection<Task>(),
  },
});

export async function indexedWrites(store: DocStore<typeof indexed>): Promise<unknown[]> {
  const tasks = store.collection("tasks");
  const people = store.collection("people");
  await tasks.put({ id: "t1", title: "Buy milk", done: false, createdAt: 1, tags: [] });
  const task = await tasks.get("t1");
  const done: boolean | undefined = task?.done;
  const tags: string[] | undefined = task?.tags;
  // @ts-expect-error createdAt is required
  await tasks.put({ id: "t2", title: "x", done: false, tags: [] });
  // @ts-expect-error done is a boolean
  await tasks.put({ id: "t2", title: "x", createdAt: 1, done: "yes", tags: [] });
  await tasks.modify("t1", (t) => ({ ...t, done: !t.done }));
  await tasks.modifyMany(["t1"], ([t]) => [t && { ...t, tags: [...t.tags, "home"] }]);

  await people.put({ id: "p1", joined: 0 });
  // @ts-expect-error joined is a number
  await people.put({ id: "p1", joined: new Date() });
  const joined: number | undefined = (await people.get("p1"))?.joined;

  const recent = await people.query({ index: "byJoined", gte: 0 });
  // @ts-expect-error joined is a number
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
  // @ts-expect-error drafts has no index
  await store.collection("drafts").query({ index: "byCreated" });
  return [done, tags, joined, recent];
}

// @ts-expect-error joined is a number, and so is not a string field
collection<Person>().text("s", "id", "joined");
// @ts-expect-error not a field of Task
collection<Task>().index("x", "titel");
// @ts-expect-error a document needs a string id
collection<{ id: number }>();
// @ts-expect-error an index name is declared once
collection<Task>().index("x", "createdAt").index("x", "title");
