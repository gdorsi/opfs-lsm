/**
 * React view of the todo example.
 *
 * A pure subscriber: `useSyncExternalStore` reads the module store's snapshot
 * and the handlers dispatch store actions. No effects, no async state in the
 * component — the store owns the database, the write chain, and change
 * subscriptions. The TanStack Redact Vite plugin swaps the React runtime at
 * build time; the imports below stay ordinary React.
 */

import { useRef, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  addTodo,
  clearAll,
  generate,
  getSnapshot,
  ingest,
  nextPage,
  openSecondWindow,
  prevPage,
  removeRow,
  setFilter,
  setSort,
  subscribe,
  toggleRow,
} from "./store.ts";
import type { SortKey, Todo } from "./model.ts";

function App() {
  const view = useSyncExternalStore(subscribe, getSnapshot);

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const countInputRef = useRef<HTMLInputElement | null>(null);
  // Filter typing commits to the store after a debounce, like the DOM version.
  const filterTimerRef = useRef<number | undefined>(undefined);

  const onAddSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = titleInputRef.current;
    if (!input) return;
    if (addTodo(input.value)) input.value = "";
  };

  const onGenerateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const count = readCount(countInputRef.current?.value ?? "1000");
    const input = countInputRef.current;
    if (input) input.value = String(count);
    generate(count);
  };

  const onClear = () => {
    clearAll();
  };

  const onFilterInput = (event: FormEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    window.clearTimeout(filterTimerRef.current);
    filterTimerRef.current = window.setTimeout(() => {
      setFilter(value);
    }, 120);
  };

  // The select only offers the three known sorts.
  const onSortChange = (event: FormEvent<HTMLSelectElement>) => {
    setSort(event.currentTarget.value as SortKey);
  };

  const noun = view.rows.length === 1 ? "item" : "items";
  const trimmed = view.filter.trim();
  const filterNote = trimmed ? `, filter “${trimmed}”` : "";
  const statusText = !view.open
    ? "not open"
    : `db ${view.name}, page ${view.pageIndex + 1}, ${view.rows.length} ${noun}${filterNote}`;

  const emptyText = !view.open
    ? ""
    : trimmed
      ? `No todos match “${trimmed}”.`
      : view.pageIndex === 0
        ? "No todos yet."
        : "No todos on this page.";

  return (
    <main>
      <h1>Todos</h1>
      <p className="lede">Shared list. Open a second window to see the same rows.</p>
      <p id="status" aria-live="polite">
        {statusText}
      </p>
      <p id="generation">
        {view.generation === undefined ? "" : `generation ${view.generation}`}
      </p>
      <p id="progress">{view.progress}</p>
      <p id="error" role="alert">
        {view.error}
      </p>
      <form id="add" className="row" onSubmit={onAddSubmit}>
        <label htmlFor="title">New todo</label>
        <input
          id="title"
          name="title"
          type="text"
          autoComplete="off"
          ref={titleInputRef}
          required
        />
        <button type="submit">Add</button>
      </form>
      <form id="generate" className="row" onSubmit={onGenerateSubmit}>
        <label htmlFor="count">Generate random todos</label>
        <input
          id="count"
          name="count"
          type="number"
          inputMode="numeric"
          min="1"
          step="1"
          defaultValue="1000"
          ref={countInputRef}
        />
        <button id="generate-button" type="submit" disabled={view.bulkBusy}>
          Generate
        </button>
      </form>
      <div className="toolbar">
        <input
          id="filter"
          type="search"
          autoComplete="off"
          placeholder="Filter todos"
          aria-label="Filter todos"
          onInput={onFilterInput}
        />
        <select
          id="sort"
          aria-label="Sort todos"
          title={trimmed ? "Search results are newest first" : undefined}
          value={trimmed ? "newest" : view.sort}
          disabled={trimmed !== ""}
          onChange={onSortChange}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="title">Title A–Z</option>
        </select>
        <button id="clear" type="button" disabled={view.bulkBusy} onClick={onClear}>
          Clear all
        </button>
      </div>
      <nav className="pager" aria-label="Pages">
        <button id="prev" type="button" disabled={view.pageIndex === 0} onClick={prevPage}>
          Prev
        </button>
        <span id="page" aria-live="polite">
          Page {view.pageIndex + 1}
        </span>
        <button id="next" type="button" disabled={!view.hasNext} onClick={nextPage}>
          Next
        </button>
      </nav>
      <ul id="list">
        {view.rows.length === 0 ? (
          emptyText ? <li id="empty">{emptyText}</li> : null
        ) : (
          view.rows.map((todo) => <TodoRow key={todo.id} todo={todo} />)
        )}
      </ul>
      <p className="actions">
        <button id="ingest" type="button" onClick={ingest}>
          Ingest
        </button>
        <button id="other" type="button" onClick={openSecondWindow}>
          Open second window
        </button>
      </p>
    </main>
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  return (
    <li data-id={todo.id}>
      <label>
        <input
          type="checkbox"
          checked={todo.done}
          onChange={() => toggleRow(todo)}
        />
        <span className={todo.done ? "done" : undefined}>{todo.title}</span>
      </label>
      <button
        type="button"
        aria-label={`Delete ${todo.title}`}
        onClick={() => removeRow(todo)}
      >
        Delete
      </button>
    </li>
  );
}

function readCount(value: string): number {
  const count = Math.trunc(Number(value));
  if (!Number.isFinite(count)) return 1000;
  return Math.max(1, count);
}

// No StrictMode: all side effects live in the store, so the double-mount
// would only re-subscribe. Omitted for parity with the DOM version.
createRoot(document.getElementById("root")!).render(<App />);
