import assert from "node:assert/strict";
import test from "node:test";
import {
  createTodo,
  decodeTodo,
  encodeTodo,
  idFromKey,
  sortTodos,
  todoKey,
} from "./model.mjs";

test("createTodo trims the title and rejects a blank one", () => {
  const todo = createTodo("  buy milk  ", 10, "a");
  assert.deepEqual(todo, {
    id: "a",
    title: "buy milk",
    done: false,
    createdAt: 10,
  });
  assert.equal(createTodo("   ", 10, "a"), null);
});

test("encode and decode keep title, done, and createdAt", () => {
  const todo = { id: "a", title: "buy milk", done: true, createdAt: 10 };
  assert.deepEqual(decodeTodo("a", encodeTodo(todo)), todo);
});

test("the key carries the id", () => {
  assert.equal(idFromKey(todoKey("abc")), "abc");
  assert.equal(idFromKey(new TextEncoder().encode("other/abc")), null);
});

test("a value that is not a todo decodes to null", () => {
  const bytes = new TextEncoder().encode("{");
  assert.equal(decodeTodo("a", bytes), null);
  const wrong = new TextEncoder().encode(
    JSON.stringify({ title: "x", done: "yes", createdAt: 1 }),
  );
  assert.equal(decodeTodo("a", wrong), null);
});

test("sortTodos orders by createdAt, then id", () => {
  const rows = sortTodos([
    { id: "b", title: "b", done: false, createdAt: 2 },
    { id: "c", title: "c", done: false, createdAt: 2 },
    { id: "a", title: "a", done: true, createdAt: 1 },
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["a", "b", "c"],
  );
});
