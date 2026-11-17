import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";
import { defineContender } from "../../core/types.ts";
import type { Issue, Label, Project, User } from "../../datasets/tracker/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";
import { liveOps, type Collections, type Modify } from "../../page/tanstack-live.ts";

/** One docstore index per screen, each ending in the field the screen sorts by, so a live query reads its window in order. */
const schema = defineSchema<{ users: User; projects: Project; labels: Label; issues: Issue }>()({
  version: 1,
  collections: {
    users: {},
    projects: {},
    labels: {},
    issues: {
      byProjectStatus: { by: ["projectId", "status", "updatedAt"] },
      byAssignee: { by: ["assigneeId", "status", "updatedAt"] },
      byUpdated: { by: "updatedAt" },
    },
  },
});

export default defineContender({
  family: "tanstack-live",
  durability: "idb-default",
  fastPath:
    "docstoreCollectionOptions with syncMode on-demand, a collection per entity on openDocStore on openDb; issues indexed by [projectId, status, updatedAt], [assigneeId, status, updatedAt] and updatedAt, so a screen's where and order read one index range per pinned value; joined rows load by id; a batch's creates = insert, its changes to stored rows = utils.transact (one docstore modifyMany, which reads the rows itself)",
  engine: true,
  async open(name) {
    const kv = await openKv(name);
    const store = await openDocStore(kv, schema);
    const users = createCollection(docstoreCollectionOptions({ collection: store.collection("users"), syncMode: "on-demand" }));
    const projects = createCollection(docstoreCollectionOptions({ collection: store.collection("projects"), syncMode: "on-demand" }));
    const labels = createCollection(docstoreCollectionOptions({ collection: store.collection("labels"), syncMode: "on-demand" }));
    const issues = createCollection(docstoreCollectionOptions({ collection: store.collection("issues"), syncMode: "on-demand" }));
    const c: Collections = { users, projects, labels, issues };
    const transact = { users: users.utils.transact, projects: projects.utils.transact, labels: labels.utils.transact, issues: issues.utils.transact };
    const modify: Modify = (entity, ids, fold) => (transact[entity] as (ids: readonly string[], merge: typeof fold) => Promise<void>)(ids, fold);
    await Promise.all(Object.values(c).map((col) => col.preload()));
    const common = kvCommon(kv);
    return {
      ...common,
      ...liveOps(c, modify),
      close: async () => {
        await Promise.all(Object.values(c).map((col) => col.cleanup()));
        await common.close();
      },
    };
  },
});
