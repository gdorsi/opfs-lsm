import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";
import { defineContender } from "../../core/types.ts";
import type { Issue, Label, Project, User } from "../../datasets/tracker/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";
import { createIndexes, liveOps, writeHeld, type Collections } from "../../page/tanstack-live.ts";

const schema = defineSchema<{ users: User; projects: Project; labels: Label; issues: Issue }>()({
  version: 1,
  collections: { users: {}, projects: {}, labels: {}, issues: {} },
});

export default defineContender({
  family: "tanstack-live",
  durability: "idb-default",
  fastPath:
    "docstoreCollectionOptions, eager, a collection per entity on openDocStore on openDb, no docstore indexes; TanStack BTree indexes on the issue fields the screens filter and sort by; preload() reads each collection from one view; insert, update and delete with an array = one TanStack transaction = one putMany or deleteMany",
  engine: true,
  async open(name) {
    const kv = await openKv(name);
    const store = await openDocStore(kv, schema);
    const c: Collections = {
      users: createCollection(docstoreCollectionOptions({ collection: store.collection("users") })),
      projects: createCollection(docstoreCollectionOptions({ collection: store.collection("projects") })),
      labels: createCollection(docstoreCollectionOptions({ collection: store.collection("labels") })),
      issues: createCollection(docstoreCollectionOptions({ collection: store.collection("issues") })),
    };
    createIndexes(c, { byId: false });
    await Promise.all(Object.values(c).map((col) => col.preload()));
    const common = kvCommon(kv);
    return {
      ...common,
      ...liveOps(c, writeHeld(c)),
      close: async () => {
        await Promise.all(Object.values(c).map((col) => col.cleanup()));
        await common.close();
      },
    };
  },
});
