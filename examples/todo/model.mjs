const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TODO_PREFIX = "todo/";

export function createTodo(title, now = Date.now(), id = crypto.randomUUID()) {
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  return { id, title: trimmed, done: false, createdAt: now };
}

export function todoKey(id) {
  return encoder.encode(`${TODO_PREFIX}${id}`);
}

export function encodeTodo(todo) {
  return encoder.encode(
    JSON.stringify({
      title: todo.title,
      done: todo.done,
      createdAt: todo.createdAt,
    }),
  );
}

export function decodeTodo(id, bytes) {
  let raw;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.title !== "string") return null;
  if (typeof raw.done !== "boolean") return null;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) {
    return null;
  }
  return { id, title: raw.title, done: raw.done, createdAt: raw.createdAt };
}

export function idFromKey(keyBytes) {
  const text = decoder.decode(keyBytes);
  if (!text.startsWith(TODO_PREFIX)) return null;
  const id = text.slice(TODO_PREFIX.length);
  if (id.length === 0) return null;
  return id;
}

export function sortTodos(todos) {
  return todos
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
