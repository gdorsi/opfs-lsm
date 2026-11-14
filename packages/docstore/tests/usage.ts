import { defineSchema, type DocStore, type IndexInfo, type Query } from "../src/index.js";

type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
  titleSort: string;
};

export const todoSchema = defineSchema<{ todos: Todo }>()({
  version: 1,
  collections: {
    todos: {
      byCreated: { by: "createdAt" },
      byTitle: { by: "titleSort" },
      search: { by: "createdAt", text: "title" },
    },
  },
});

type TodoQuery = Query<Todo, (typeof todoSchema)["collections"]["todos"]>;
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
defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: { x: { by: "tite" } } } });
// @ts-expect-error text must be a string field
defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: { s: { by: "createdAt", text: "done" } } } });
// @ts-expect-error every collection of the type map must be declared
defineSchema<{ todos: Todo }>()({ version: 1, collections: {} });
// @ts-expect-error only collections of the type map can be declared, empty or not
defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: {}, drafts: {} } });

const withEmpty = defineSchema<{ drafts: Todo; todos: Todo }>()({
  version: 1,
  collections: { drafts: {}, todos: { byCreated: { by: "createdAt" } } },
});
export const emptyKeepsOthers: Query<Todo, (typeof withEmpty)["collections"]["todos"]> = { index: "byCreated", gte: 0 };
// @ts-expect-error a collection declared with no indexes has none to query
export const emptyHasNone: Query<Todo, (typeof withEmpty)["collections"]["drafts"]> = { index: "byCreated" };

type HasDate = { id: string; at: Date };
// @ts-expect-error a Date does not survive JSON
defineSchema<{ events: HasDate }>();
type HasBytes = { id: string; data: Uint8Array };
// @ts-expect-error a Uint8Array does not survive JSON
defineSchema<{ blobs: HasBytes }>();

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

const notesSchema = defineSchema<{ notes: Note }>()({
  version: 3,
  collections: {
    notes: {
      bySlug: { by: "slug", unique: true },
      byOwnerUpdated: { by: ["owner", "updatedAt"] },
      byTag: { by: ["tags[]", "updatedAt"] },
      search: { by: ["owner", "updatedAt"], text: "body" },
    },
  },
});

type NoteQuery = Query<Note, (typeof notesSchema)["collections"]["notes"]>;
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

// @ts-expect-error [] marks an array field, and owner is a string
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { m: { by: "owner[]" } } } });
// @ts-expect-error an array field needs the [] mark
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { m: { by: "tags" } } } });
// @ts-expect-error only the first field may be an array
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { m: { by: ["updatedAt", "tags[]"] } } } });
// @ts-expect-error a text index cannot start with an array field
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { t: { by: "tags[]", text: "body" } } } });
// @ts-expect-error a text index cannot be unique
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { t: { by: "updatedAt", text: "body", unique: true } } } });
// @ts-expect-error uniqe is not an option
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { u: { by: "slug", uniqe: true } } } });
// @ts-expect-error on is the old name of by
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { u: { on: "slug" } } } });
// @ts-expect-error a misspelled field inside a list
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { u: { by: ["owner", "updatedAtt"] } } } });
// @ts-expect-error an empty list of fields
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { u: { by: [] } } } });
