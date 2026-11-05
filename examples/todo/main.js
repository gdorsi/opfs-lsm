import { openCollectionDb } from "@opfs-lsm/collections";
import {
  PAGE_SIZE,
  TODO_SCHEMA,
  clearTodos,
  createTodo,
  deleteTodo,
  generateTodos,
  readPage,
  toggleTodo } from "./model.mjs";

const params = new URLSearchParams(location.search);
const dbName = params.get("name") ?? "todos";

const statusEl = byId("status");
const errorEl = byId("error");
const listEl = byId("list");
const generationEl = byId("generation");
const progressEl = byId("progress");
const formEl = byId("add");
const titleInput = byId("title");
const generateForm = byId("generate");
const countInput = byId("count");
const generateButton = byId("generate-button");
const clearButton = byId("clear");
const filterInput = byId("filter");
const sortSelect = byId("sort");
const prevButton = byId("prev");
const nextButton = byId("next");
const pageEl = byId("page");
const ingestButton = byId("ingest");
const otherButton = byId("other");

/** `pages` is the cursor stack: pages[n] is the first key of page n. */
const state = {
  filter: "",
  sort: "newest",
  pages: [undefined],
  index: 0,
  next: undefined };

let ticket = 0;
let chain = Promise.resolve();
let busy = 0;
let changeTimer;
let filterTimer;

statusEl.textContent = "opening";

const db = await openCollectionDb({
  name: dbName,
  schema: TODO_SCHEMA,
}).catch((err) => {
  showError(err);
  statusEl.textContent = "not open";
  return null;
});

const todos = db?.table("todos");

if (db && todos) {
  db.kv.changes(() => {
    // A bulk write refreshes once when it finishes, not per batch.
    if (busy > 0) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      refresh().catch(showError);
    }, 50);
  });

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const todo = createTodo(titleInput.value);
    if (!todo) return;
    titleInput.value = "";
    resetPages();
    run(() => todos.put(todo));
  });

  generateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const count = readCount();
    countInput.value = String(count);
    resetPages();
    generateButton.disabled = true;
    clearButton.disabled = true;
    run(async () => {
      try {
        await generateTodos(todos, count, {
          onProgress: (done, total) => {
            progressEl.textContent = `generated ${done} / ${total}`;
          } });
        progressEl.textContent = `generated ${count} todos`;
      } finally {
        generateButton.disabled = false;
        clearButton.disabled = false;
      }
    });
  });

  clearButton.addEventListener("click", () => {
    resetPages();
    generateButton.disabled = true;
    clearButton.disabled = true;
    run(async () => {
      try {
        progressEl.textContent = "clearing";
        const removed = await clearTodos(todos);
        progressEl.textContent = `cleared ${removed} todos`;
      } finally {
        generateButton.disabled = false;
        clearButton.disabled = false;
      }
    });
  });

  filterInput.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      state.filter = filterInput.value;
      resetPages();
      refresh().catch(showError);
    }, 120);
  });

  sortSelect.addEventListener("change", () => {
    state.sort = sortSelect.value;
    resetPages();
    refresh().catch(showError);
  });

  prevButton.addEventListener("click", () => {
    if (state.index === 0) return;
    state.index -= 1;
    refresh().catch(showError);
  });

  nextButton.addEventListener("click", () => {
    const next = state.next;
    if (!next) return;
    // Consume the cursor so a double click cannot push the same page twice.
    state.next = undefined;
    state.pages.length = state.index + 1;
    state.pages.push(next);
    state.index += 1;
    refresh().catch(showError);
  });

  ingestButton.addEventListener("click", () => {
    run(async () => {
      const result = await db.ingest();
      generationEl.textContent = `generation ${result.generation}`;
    });
  });

  otherButton.addEventListener("click", () => {
    window.open(location.href, "_blank");
  });

  await refresh();
}

function run(fn) {
  busy += 1;
  const job = chain.then(async () => {
    try {
      await fn();
      errorEl.textContent = "";
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

function resetPages() {
  state.pages = [undefined];
  state.index = 0;
  state.next = undefined;
}

async function refresh() {
  if (!todos) return;
  const mine = ++ticket;
  const after = state.pages[state.index];
  const page = await readPage(todos, {
    after,
    sort: state.sort,
    filter: state.filter,
    pageSize: PAGE_SIZE });
  if (mine !== ticket) return;
  paint(page);
}

function paint(page) {
  state.next = page.next;
  const count = page.todos.length;
  const noun = count === 1 ? "item" : "items";
  const filter = state.filter.trim();
  const filterNote = filter ? `, filter “${filter}”` : "";
  statusEl.dataset.sort = state.sort;
  statusEl.textContent = `db ${dbName}, page ${state.index + 1}, ${count} ${noun}${filterNote}`;

  pageEl.textContent = `Page ${state.index + 1}`;
  prevButton.disabled = state.index === 0;
  nextButton.disabled = !page.next;

  listEl.replaceChildren();
  if (count === 0) {
    const empty = document.createElement("li");
    empty.id = "empty";
    empty.textContent = filter
      ? `No todos match “${filter}”.`
      : state.index === 0
        ? "No todos yet."
        : "No todos on this page.";
    listEl.append(empty);
    return;
  }
  for (const todo of page.todos) {
    listEl.append(renderTodo(todo));
  }
}

function renderTodo(todo) {
  const item = document.createElement("li");
  item.dataset.id = todo.id;

  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = todo.done;
  box.addEventListener("change", () => {
    run(() => toggleTodo(todos, todo));
  });

  const title = document.createElement("span");
  title.textContent = todo.title;
  if (todo.done) title.className = "done";
  label.append(box, title);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Delete";
  remove.setAttribute("aria-label", `Delete ${todo.title}`);
  remove.addEventListener("click", () => {
    run(() => deleteTodo(todos, todo));
  });

  item.append(label, remove);
  return item;
}

function readCount() {
  const value = Math.trunc(Number(countInput.value));
  if (!Number.isFinite(value)) return 1000;
  return Math.max(1, value);
}

function showError(err) {
  errorEl.textContent = err instanceof Error ? err.message : String(err);
}

function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
