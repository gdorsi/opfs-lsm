/**
 * The operations the tanstack contenders share, so the two sides of a family
 * differ only in the collection options they pass to createCollection. Every
 * write is one TanStack transaction, and it resolves on `when("settled")`:
 * this version has no `isPersisted`.
 */
import { and, createLiveQueryCollection, eq, gte, inArray, type Collection } from "@tanstack/db";
import { OWNERS, type CollectionStore, type OnDemandStore, type Todo, type TodoQuery } from "../core/families.ts";

type Todos = Collection<Todo, string, any>;

/** Row `i` at `version`: what every tanstack workload writes and checks against. */
export const todoRow = (i: number, version: number): Todo => ({
  id: todoId(i),
  title: `todo ${i} version ${version}: buy milk, eggs and bread`,
  done: version % 2 === 0,
  owner: ownerOf(i),
  createdAt: i,
});
export const todoId = (i: number) => `todo-${String(i).padStart(8, "0")}`;
export const ownerOf = (i: number) => `owner-${i % OWNERS}`;
export const rowBytes = (r: Todo) => JSON.stringify(r).length;

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

export function onDemandOps(c: Todos): Omit<OnDemandStore, "settle" | "stats" | "close"> {
  const { insertMany, updateMany } = collectionOps(c);
  return {
    insertMany,
    updateMany,
    hold: async (q) => {
      const live = createLiveQueryCollection({ query: (b) => select(b.from({ t: c }), q), startSync: true });
      const rows = (await live.toArrayWhenReady()) as Todo[];
      return { rows, release: () => live.cleanup() };
    },
  };
}

function select(from: any, q: TodoQuery): any {
  switch (q.kind) {
    case "owner":
      return from.where(({ t }: any) => eq(t.owner, q.owner));
    case "ids":
      return from.where(({ t }: any) => inArray(t.id, [...q.ids]));
    case "page":
      return from
        .where(({ t }: any) => and(eq(t.owner, q.owner), gte(t.createdAt, q.from)))
        .orderBy(({ t }: any) => t.createdAt)
        .limit(q.limit);
  }
}
