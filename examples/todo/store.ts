/**
 * Page store for the todo example, headless like `model.ts`: holds the
 * database connection and all shared state, exposes actions. The React view
 * subscribes with `useSyncExternalStore` and never opens the db or owns async
 * state.
 *
 * The database is page state, so it opens once — at module level with
 * top-level await, exactly like the DOM version. A failed open leaves the
 * page read-only with the reason in the error line.
 */

import { openCollectionDb } from "@opfs-lsm/collections";
import {
  PAGE_SIZE,
  TODO_SCHEMA,
  clearTodos,
  createTodo,
  deleteTodo,
  generateTodos,
  readPage,
  toggleTodo,
  type SortKey,
  type Todo,
  type TodoStore,
} from "./model.ts";
// `?worker&url` types as a plain string; Vite bundles worker.ts as its own
// module-worker chunk.
import workerUrl from "./worker.ts?worker&url";

export const DB_NAME = new URLSearchParams(location.search).get("name") ?? "todos";

let openError: unknown;
const db = await openCollectionDb({
  name: DB_NAME,
  workerUrl,
  schema: TODO_SCHEMA,
}).catch((err: unknown) => {
  openError = err;
  return null;
});
// null when the page could not open the database (http origin, OPFS, …).
const table: TodoStore<Uint8Array> | null = db
  ? db.table<Todo>("todos")
  : null;
const open = db !== null;

export type TodoState = {
  readonly name: string;
  readonly open: boolean;
  readonly rows: readonly Todo[];
  readonly hasNext: boolean;
  /** Zero-based cursor-stack position; pages[n] is the first key of page n. */
  readonly pageIndex: number;
  readonly filter: string;
  readonly sort: SortKey;
  readonly progress: string;
  readonly error: string;
  readonly generation: number | undefined;
  /** True while a bulk job (generate / clear) is in flight. */
  readonly bulkBusy: boolean;
};

let state: TodoState = {
  name: DB_NAME,
  open,
  rows: [],
  hasNext: false,
  pageIndex: 0,
  filter: "",
  sort: "newest",
  progress: "",
  error:
    openError instanceof Error
      ? openError.message
      : openError === undefined
        ? ""
        : String(openError),
  generation: undefined,
  bulkBusy: false,
};

const listeners = new Set<() => void>();

/** Stable subscription for `useSyncExternalStore`. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Must return a cached object between mutations. */
export function getSnapshot(): TodoState {
  return state;
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error("store listener threw", err);
    }
  }
}

function setState(patch: Partial<TodoState>): void {
  state = { ...state, ...patch };
  notify();
}

function showError(err: unknown): void {
  setState({ error: err instanceof Error ? err.message : String(err) });
}

/** The cursor stack: pages[n] is the first key of page n. */
const pager = { pages: [undefined] as (Uint8Array | undefined)[], index: 0, next: undefined as Uint8Array | undefined };
let ticket = 0;
let chain: Promise<void> = Promise.resolve();
let busy = 0;
let changeTimer: number | undefined;

function resetPages(): void {
  pager.pages = [undefined];
  pager.index = 0;
  pager.next = undefined;
  setState({ pageIndex: 0 });
}

/** One page in the current sort order, guarded against out-of-order reads. */
async function refresh(): Promise<void> {
  if (!table) return;
  const mine = ++ticket;
  const page = await readPage(table, {
    after: pager.pages[pager.index],
    sort: state.sort,
    filter: state.filter,
    pageSize: PAGE_SIZE,
  });
  if (mine !== ticket) return;
  pager.next = page.next;
  setState({ rows: page.todos, hasNext: page.next !== undefined });
}

/** Serializes writes like the DOM version: one job at a time, refresh after. */
function run(fn: () => unknown): Promise<void> {
  busy += 1;
  const job = chain.then(async () => {
    try {
      await fn();
      setState({ error: "" });
    } catch (err) {
      showError(err);
    } finally {
      busy -= 1;
      await refresh().catch(showError);
    }
  });
  chain = job;
  return job;
}

function requireTable(): TodoStore<Uint8Array> {
  if (!table) throw new Error("database not open");
  return table;
}

export function addTodo(title: string): boolean {
  const todo = createTodo(title);
  if (!todo || !table) return false;
  resetPages();
  void run(() => table.put(todo));
  return true;
}

export function generate(count: number): void {
  const target = requireTable();
  resetPages();
  setState({ bulkBusy: true });
  void run(async () => {
    try {
      await generateTodos(target, count, {
        onProgress: (done, total) => {
          setState({ progress: `generated ${done} / ${total}` });
        },
      });
      setState({ progress: `generated ${count} todos` });
    } finally {
      setState({ bulkBusy: false });
    }
  });
}

export function clearAll(): void {
  const target = requireTable();
  resetPages();
  setState({ bulkBusy: true });
  void run(async () => {
    try {
      setState({ progress: "clearing" });
      const removed = await clearTodos(target);
      setState({ progress: `cleared ${removed} todos` });
    } finally {
      setState({ bulkBusy: false });
    }
  });
}

/**
 * Commit a filter substring. The view debounces typing; the store commits
 * immediately.
 */
export function setFilter(value: string): void {
  setState({ filter: value });
  resetPages();
  void refresh().catch(showError);
}

export function setSort(key: SortKey): void {
  setState({ sort: key });
  resetPages();
  void refresh().catch(showError);
}

export function prevPage(): void {
  if (pager.index === 0) return;
  pager.index -= 1;
  setState({ pageIndex: pager.index });
  void refresh().catch(showError);
}

export function nextPage(): void {
  const push = pager.next;
  if (!push) return;
  // Consume the cursor so a double click cannot push the same page twice.
  pager.next = undefined;
  pager.pages.length = pager.index + 1;
  pager.pages.push(push);
  pager.index += 1;
  setState({ pageIndex: pager.index });
  void refresh().catch(showError);
}

export function ingest(): void {
  if (!db) {
    showError(new Error("database not open"));
    return;
  }
  void run(async () => {
    const result = await db.ingest();
    setState({ generation: result.generation });
  });
}

/** Flip `done` (one read-modify-write; indexes do not change). */
export function toggleRow(todo: Todo): void {
  void run(() => toggleTodo(requireTable(), todo));
}

/** Delete one row. */
export function removeRow(todo: Todo): void {
  void run(() => deleteTodo(requireTable(), todo));
}

/** Open the second-window demo tab. */
export function openSecondWindow(): void {
  window.open(location.href, "_blank");
}

// ---- Module init ----

if (db) {
  db.kv.changes(() => {
    // A bulk write refreshes once when it finishes, not per batch.
    if (busy > 0) return;
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => {
      void refresh().catch(showError);
    }, 50);
  });
  await refresh().catch(showError);
}
