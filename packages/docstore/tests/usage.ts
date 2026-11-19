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
