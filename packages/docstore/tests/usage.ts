import { defineSchema, type DocStore, type Query } from "../src/index.js";

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
      byCreated: { on: "createdAt" },
      byTitle: { on: "titleSort" },
      search: { on: "createdAt", text: "title" },
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

// @ts-expect-error not a path of Todo
defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: { x: { on: "tite" } } } });
// @ts-expect-error text must be a string path
defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: { s: { on: "createdAt", text: "done" } } } });
// @ts-expect-error every collection of the type map must be declared
defineSchema<{ todos: Todo }>()({ version: 1, collections: {} });

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

type Note = { id: string; owner: string; slug: string; tags: string[]; updatedAt: number; body: string };

const notesSchema = defineSchema<{ notes: Note }>()({
  version: 3,
  collections: {
    notes: {
      bySlug: { on: "slug", unique: true },
      byOwnerUpdated: { on: ["owner", "updatedAt"] },
      byTag: { on: ["tags", "updatedAt"], multi: true },
      search: { on: ["owner", "updatedAt"], text: "body" },
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
  // @ts-expect-error the element type of tags is string
  { index: "byTag", eq: [1] },
  // @ts-expect-error a bound on the second component needs eq on the first
  { index: "byOwnerUpdated", gte: since },
];

// @ts-expect-error multi needs an array path first
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { m: { on: "owner", multi: true } } } });
// @ts-expect-error a text index cannot be unique
defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: { t: { on: "updatedAt", text: "body", unique: true } } } });
