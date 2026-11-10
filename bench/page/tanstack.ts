/**
 * The operations both tanstack contenders share, so the two sides differ only
 * in the collection options they pass to createCollection. Every write is one
 * TanStack transaction, and it resolves on `when("settled")`: this version has
 * no `isPersisted`.
 */
import type { Collection } from "@tanstack/db";
import type { CollectionStore, Todo } from "../core/families.ts";

type Todos = Collection<Todo, string, any>;

export function collectionOps(c: Todos): Omit<CollectionStore, "settle" | "stats" | "close"> {
  return {
    insertMany: async (rows) => {
      await c.insert([...rows]).when("settled");
    },
    insert: async (row) => {
      await c.insert(row).when("settled");
    },
    updateMany: async (ids, f) => {
      await c
        .update([...ids], (drafts) => {
          for (const draft of drafts) Object.assign(draft, f(draft));
        })
        .when("settled");
    },
    deleteMany: async (ids) => {
      await c.delete([...ids]).when("settled");
    },
    get: (id) => c.get(id),
    size: () => c.size,
  };
}
