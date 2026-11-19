import { describe, expect, it } from "vitest";
import { collection } from "../src/index.js";

type Todo = { id: string; title: string; done: boolean; createdAt: number };

describe("collection", () => {
  it("declares each kind of index as the catalog reads it", () => {
    const todos = collection<Todo>()
      .index("byCreated", "createdAt")
      .index("open", ["done", "createdAt"])
      .unique("byTitle", "title")
      .text("search", "createdAt", "title");
    expect(todos.indexes).toEqual({
      byCreated: { by: "createdAt" },
      open: { by: ["done", "createdAt"] },
      byTitle: { by: "title", unique: true },
      search: { by: "createdAt", text: "title" },
    });
  });

  it("returns a new declaration and leaves the one it extends as it was", () => {
    const base = collection<Todo>().index("byCreated", "createdAt");
    const withTitle = base.unique("byTitle", "title");
    const withSearch = base.text("search", "createdAt", "title");
    expect(Object.keys(base.indexes)).toEqual(["byCreated"]);
    expect(Object.keys(withTitle.indexes)).toEqual(["byCreated", "byTitle"]);
    expect(Object.keys(withSearch.indexes)).toEqual(["byCreated", "search"]);
  });
});
