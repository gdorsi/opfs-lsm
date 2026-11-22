import { createCollection, createIndexedDB, indexedDBCollectionOptions } from "@tanstack/db";
import { defineContender } from "../../core/types.ts";
import type { Issue, Label, Project, User } from "../../datasets/tracker/types.ts";
import { createIndexes, liveOps, writeHeld, type Collections } from "../../page/tanstack-live.ts";

export default defineContender({
  family: "tanstack-live",
  durability: "idb-default",
  fastPath:
    "indexedDBCollectionOptions on createIndexedDB, eager (its only mode), an object store per entity; TanStack BTree indexes on the issue fields the screens filter and sort by; preload() getAll; insert, update and delete in one createTransaction whose mutationFn calls utils.acceptMutations = one IndexedDB readwrite transaction",
  engine: false,
  async open(name) {
    const db = await createIndexedDB({ name: `tanstack-live-${name}`, version: 1, stores: ["users", "projects", "labels", "issues"] });
    const c: Collections = {
      users: createCollection(indexedDBCollectionOptions({ db, name: "users", getKey: (r: User) => r.id })),
      projects: createCollection(indexedDBCollectionOptions({ db, name: "projects", getKey: (r: Project) => r.id })),
      labels: createCollection(indexedDBCollectionOptions({ db, name: "labels", getKey: (r: Label) => r.id })),
      issues: createCollection(indexedDBCollectionOptions({ db, name: "issues", getKey: (r: Issue) => r.id })),
    };
    createIndexes(c, { byId: false });
    await Promise.all(Object.values(c).map((col) => col.preload()));
    return {
      ...liveOps(c, writeHeld(c)),
      settle: async () => {},
      stats: async () => undefined,
      close: async () => {
        await Promise.all(Object.values(c).map((col) => col.cleanup()));
        db.close();
      },
    };
  },
});
