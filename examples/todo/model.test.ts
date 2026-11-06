/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTodos,
  createTodo,
  deleteTodo,
  generateTodos,
  normalizeFilter,
  readPage,
  toggleTodo,
  type ReadPageOptions,
  type Todo,
  type TodoStore,
  wordsOf,
} from "./model.ts";

const MAX_TIME = 10 ** 15 - 1;

const INDEXES = {
  byNewest: { field: "newest", cmp: (a: Todo, b: Todo) => a.newest - b.newest },
  byOldest: { field: "createdAt", cmp: (a: Todo, b: Todo) => a.createdAt - b.createdAt },
  byTitle: {
    field: "titleSort",
    cmp: (a: Todo, b: Todo) =>
      a.titleSort < b.titleSort ? -1 : a.titleSort > b.titleSort ? 1 : 0,
  },
};

/**
 * In-memory stand-in for a collections Table. Cursors are the id of the first
 * unconsumed row, matching the real table's opaque "next" key semantics.
 */
function fakeTable(
  initial: readonly Todo[] = [],
): TodoStore<string> & { rows: Map<string, Todo>; read: number } {
  const rows = new Map<string, Todo>();
  for (const todo of initial) rows.set(todo.id, { ...todo });

  function ordered(indexName: string): Todo[] {
    const spec = INDEXES[indexName as keyof typeof INDEXES];
    if (!spec) throw new Error(`unknown index: ${indexName}`);
    return [...rows.values()].sort((a, b) => spec.cmp(a, b) || a.id.localeCompare(b.id));
  }

  /** Cursor page of `sorted`, starting at the row whose id is `after`. */
  function cursorPage(sorted: Todo[], after: string | undefined, limit: number) {
    const start = after === undefined ? 0 : sorted.findIndex((todo) => todo.id === after);
    if (start < 0) throw new Error(`cursor not found: ${String(after)}`);
    const docs = sorted.slice(start, start + limit).map((todo) => ({ ...todo }));
    const next = sorted[start + limit];
    return { docs, next: next?.id };
  }

  return {
    rows,
    /** Docs returned by `page`, to check a search reads only matches. */
    read: 0,
    async put(todo) {
      rows.set(todo.id, { ...todo });
      return todo.id;
    },
    async putMany(todos) {
      for (const todo of todos) rows.set(todo.id, { ...todo });
    },
    async update(id, mutate) {
      const current = rows.get(id);
      if (!current) return undefined;
      const next = mutate(current);
      rows.set(id, { ...next });
      return next;
    },
    async delete(id) {
      return rows.delete(id);
    },
    async clear() {
      const count = rows.size;
      rows.clear();
      return count;
    },
    async page(indexName, { after, limit }: { after?: string; limit: number }) {
      const { docs, next } = cursorPage(ordered(indexName), after, limit);
      this.read += docs.length;
      return next === undefined ? { docs } : { docs, next };
    },
    async search(text, { after, limit }: { after?: string; limit: number }) {
      const wanted = wordsOf(text);
      if (wanted.length === 0) throw new RangeError("search text has no words");
      const matches = ordered("byNewest").filter((todo) => {
        const words = wordsOf(todo.title);
        return wanted.every((w) => words.some((t) => t.startsWith(w)));
      });
      const { docs, next } = cursorPage(matches, after, limit);
      this.read += docs.length;
      return next === undefined ? { docs } : { docs, next };
    },
  };
}

function makeTodos(count: number, now = 10_000): Todo[] {
  return Array.from({ length: count }, (_, i) => {
    const todo = createTodo(`Todo ${i}`, now - count + i + 1, `id${i}`);
    if (!todo) throw new Error("bad fixture");
    return todo;
  });
}

async function collectPages<Cursor>(
  table: TodoStore<Cursor>,
  options: Omit<ReadPageOptions<Cursor>, "after"> = {},
): Promise<Todo[][]> {
  const pages: Todo[][] = [];
  let after: Cursor | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await readPage(table, { ...options, after });
    pages.push(page.todos);
    if (page.next === undefined) return pages;
    after = page.next;
  }
  throw new Error("paging did not finish");
}

test("createTodo trims the title, rejects a blank one, and derives sort fields", () => {
  const todo = createTodo("  Buy Milk  ", 10, "a");
  assert.deepEqual(todo, {
    id: "a",
    title: "Buy Milk",
    done: false,
    createdAt: 10,
    newest: MAX_TIME - 10,
    titleSort: "buy milk",
  });
  assert.equal(createTodo("   ", 10, "a"), null);
});

test("a filter is trimmed and lowercased", () => {
  assert.equal(normalizeFilter("  BUTTER "), "butter");
  assert.equal(normalizeFilter("   "), "");
});

test("readPage walks every row once, newest first", async () => {
  const table = fakeTable(makeTodos(23));
  const pages = await collectPages(table, { sort: "newest", pageSize: 5 });

  assert.deepEqual(
    pages.map((page) => page.length),
    [5, 5, 5, 5, 3],
  );
  const ids = pages.flat().map((todo) => todo.id);
  assert.deepEqual(
    ids,
    Array.from({ length: 23 }, (_, i) => `id${22 - i}`),
  );
});

test("readPage sort=oldest walks oldest first across pages", async () => {
  const table = fakeTable(makeTodos(23));
  const pages = await collectPages(table, { sort: "oldest", pageSize: 5 });

  assert.deepEqual(
    pages.flat().map((todo) => todo.id),
    Array.from({ length: 23 }, (_, i) => `id${i}`),
  );
});

test("readPage sort=title is case-insensitive and tie-breaks by id", async () => {
  const table = fakeTable([
    createTodo("Apple", 4, "b")!,
    createTodo("apple", 3, "a")!,
    createTodo("banana", 2, "d")!,
    createTodo("Cherry", 1, "c")!,
  ]);

  const page = await readPage(table, { sort: "title", pageSize: 10 });
  assert.deepEqual(
    page.todos.map((todo) => todo.id),
    ["a", "b", "d", "c"],
  );

  const pages = await collectPages(table, {
    sort: "title",
    pageSize: 1,
  });
  assert.deepEqual(
    pages.flat().map((todo) => todo.id),
    ["a", "b", "d", "c"],
  );
});

test("readPage rejects an unknown sort", async () => {
  await assert.rejects(
    // "sideways" fits through the widened `SortKey | (string & {})` union and
    // hits the runtime guard, like any JS caller passing a bad string.
    readPage(fakeTable(), { sort: "sideways" }),
    /unknown sort/,
  );
});

test("readPage filters across chunks without skipping or repeating, reading only matches", async () => {
  const todos: Todo[] = Array.from({ length: 40 }, (_, i) =>
    createTodo(i % 3 === 0 ? `alpha ${i}` : `beta ${i}`, i + 1, `id${i}`)!,
  );
  const table = fakeTable(todos);
  const pages = await collectPages(table, {
    sort: "newest",
    filter: " ALP ",
    pageSize: 3,
  });
  const ids = pages.flat().map((todo) => todo.id);
  const want = todos.filter((_, i) => i % 3 === 0).reverse().map((t) => t.id);
  assert.deepEqual(ids, want);
  for (const page of pages) assert.ok(page.length <= 3);
  assert.equal(table.read, want.length);
});

test("readPage with a filter reads newest first whatever the sort", async () => {
  const table = fakeTable(makeTodos(12));
  for (const sort of ["oldest", "title"] as const) {
    const page = await readPage(table, { sort, filter: "todo", pageSize: 4 });
    assert.deepEqual(page.todos.map((t) => t.id), ["id11", "id10", "id9", "id8"]);
  }
});

test("readPage requires every filter word to start a title word", async () => {
  const table = fakeTable([
    createTodo("buy oat milk", 1, "a")!,
    createTodo("buy milk", 2, "b")!,
    createTodo("milkshake", 3, "c")!,
    createTodo("sell milk", 4, "d")!,
  ]);
  const page = await readPage(table, { filter: "milk bu", pageSize: 10 });
  assert.deepEqual(page.todos.map((t) => t.id), ["b", "a"]);
  assert.equal(table.read, 2);
});

test("readPage returns an empty page when nothing matches", async () => {
  const table = fakeTable(makeTodos(10));
  const page = await readPage(table, { filter: "zzzz", pageSize: 5 });
  assert.deepEqual(page.todos, []);
  assert.equal(page.next, undefined);
});

test("generateTodos writes every row in batches with repeatable titles", async () => {
  const progress: number[][] = [];
  const table = fakeTable();
  const written = await generateTodos(table, 25, {
    now: 1000,
    seed: 7,
    chunkSize: 10,
    onProgress: (done, total) => progress.push([done, total]),
  });

  assert.equal(written, 25);
  assert.deepEqual(progress, [
    [10, 25],
    [20, 25],
    [25, 25],
  ]);

  const { todos } = await readPage(table, { pageSize: 100 });
  assert.equal(todos.length, 25);
  assert.equal(new Set(todos.map((todo) => todo.id)).size, 25);
  assert.equal(todos[0].createdAt, 1000);
  assert.equal(todos[24].createdAt, 976);
  for (const todo of todos) {
    assert.equal(todo.done, false);
    assert.match(todo.title, /^[A-Z][a-z]+(?: [a-z]+){1,4}$/);
  }

  const oldest = await readPage(table, { sort: "oldest", pageSize: 100 });
  assert.equal(oldest.todos[0].createdAt, 976);
  assert.equal(oldest.todos[24].createdAt, 1000);

  const byTitle = await readPage(table, { sort: "title", pageSize: 100 });
  const sortedTitles = byTitle.todos.map((todo) => todo.title.toLowerCase());
  assert.deepEqual(sortedTitles, sortedTitles.slice().sort());

  const again = fakeTable();
  await generateTodos(again, 25, { now: 1000, seed: 7, chunkSize: 10 });
  const titles = (await readPage(again, { pageSize: 100 })).todos.map(
    (todo) => todo.title,
  );
  assert.deepEqual(titles, todos.map((todo) => todo.title));
});

test("generateTodos writes in batches of chunkSize rows", async () => {
  const table = fakeTable();
  const sizes: number[] = [];
  const putMany = table.putMany.bind(table);
  table.putMany = async (docs) => {
    sizes.push(docs.length);
    return putMany(docs);
  };
  await generateTodos(table, 2500, { seed: 3, chunkSize: 1000 });
  assert.equal(table.rows.size, 2500);
  assert.deepEqual(sizes, [1000, 1000, 500]);
});

test("clearTodos deletes every row", async () => {
  const table = fakeTable(makeTodos(30));
  assert.equal(await clearTodos(table), 30);
  const page = await readPage(table, { pageSize: 10 });
  assert.deepEqual(page.todos, []);
  assert.equal(table.rows.size, 0);
});

test("toggleTodo flips done and deleteTodo removes the row", async () => {
  const todo = createTodo("buy milk", 10, "a")!;
  const table = fakeTable([todo]);

  await toggleTodo(table, todo);
  let page = await readPage(table, { sort: "newest", pageSize: 10 });
  assert.equal(page.todos[0].done, true);

  await toggleTodo(table, todo);
  page = await readPage(table, { sort: "newest", pageSize: 10 });
  assert.equal(page.todos[0].done, false);

  await deleteTodo(table, todo);
  page = await readPage(table, { sort: "newest", pageSize: 10 });
  assert.deepEqual(page.todos, []);
});
