import { openDb, prefixBound } from "@opfs-lsm/kv";
import {
  TODO_PREFIX,
  createTodo,
  decodeTodo,
  encodeTodo,
  idFromKey,
  sortTodos,
  todoKey,
} from "./model.mjs";

const params = new URLSearchParams(location.search);
const dbName = params.get("name") ?? "todos";
const encoder = new TextEncoder();

const statusEl = byId("status");
const errorEl = byId("error");
const listEl = byId("list");
const generationEl = byId("generation");
const formEl = byId("add");
const titleInput = byId("title");
const ingestButton = byId("ingest");
const otherButton = byId("other");

let ticket = 0;
let chain = Promise.resolve();

statusEl.textContent = "opening";

const db = await openDb({
  name: dbName,
  workerUrl: new URL("./worker.js", import.meta.url),
}).catch((err) => {
  showError(err);
  statusEl.textContent = "not open";
  return null;
});

if (db) {
  db.changes(() => {
    refresh().catch(showError);
  });

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const todo = createTodo(titleInput.value);
    if (!todo) return;
    titleInput.value = "";
    run(() => db.put(todoKey(todo.id), encodeTodo(todo)));
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
  const job = chain.then(fn).then(() => refresh());
  chain = job.then(
    () => {
      errorEl.textContent = "";
    },
    (err) => {
      showError(err);
      return refresh().catch(showError);
    },
  );
  return chain;
}

async function refresh() {
  const mine = ++ticket;
  const todos = await readTodos();
  if (mine !== ticket) return;
  paint(todos);
}

async function readTodos() {
  const bounds = prefixBound(encoder.encode(TODO_PREFIX));
  const todos = [];
  for await (const entry of db.range(bounds)) {
    const id = idFromKey(entry.key);
    if (!id) continue;
    const todo = decodeTodo(id, entry.value);
    if (todo) todos.push(todo);
  }
  return sortTodos(todos);
}

async function toggle(id) {
  await db.transaction(async (tx) => {
    const current = await tx.get(todoKey(id));
    if (!current) return;
    const todo = decodeTodo(id, current);
    if (!todo) return;
    tx.put(todoKey(id), encodeTodo({ ...todo, done: !todo.done }));
  });
}

function paint(todos) {
  const count = todos.length;
  const noun = count === 1 ? "item" : "items";
  statusEl.textContent = `db ${dbName}, ${count} ${noun}`;
  listEl.replaceChildren();
  if (count === 0) {
    const empty = document.createElement("li");
    empty.id = "empty";
    empty.textContent = "No todos yet.";
    listEl.append(empty);
    return;
  }
  for (const todo of todos) {
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
    run(() => toggle(todo.id));
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
    run(() => db.delete(todoKey(todo.id)));
  });

  item.append(label, remove);
  return item;
}

function showError(err) {
  errorEl.textContent = err instanceof Error ? err.message : String(err);
}

function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
