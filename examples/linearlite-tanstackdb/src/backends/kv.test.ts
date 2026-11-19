import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DocStoreError } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import type { Body, Issue, PriorityCode, StatusCode, SyncState } from "../domain/model.ts";
import { parseIssueFilter, SORT_FIELDS } from "../model/filter.ts";
import { windowQuery } from "../model/query.ts";
import { openKvBackend, schema, type KvBackend } from "./kv.ts";

const sorted = (...by: string[]) => ({ kind: "sorted", by, unique: false });

const INDEXES = {
  issues: {
    byCreated: sorted("deleted", "created"),
    byTitle: sorted("deleted", "title"),
    byPriority: sorted("deleted", "priority", "priorityOrder"),
    byStatus: { kind: "text", by: ["deleted", "status", "statusOrder"], unique: false, text: "title" },
    search: { kind: "text", by: ["deleted", "modified"], unique: false, text: "title" },
    pending: sorted("pending"),
  },
  bodies: { pending: sorted("pending") },
  comments: { byIssue: sorted("issue_id"), pending: sorted("pending") },
  sync: {},
};

const N = 500;
const WINDOW = 20;

let db: Db;
let backend: KvBackend;
before(async () => {
  db = await openHarnessDb({ name: `linearlite-kv-${process.pid}`, forceMemory: true });
  backend = await openKvBackend(db);
  const issues: Issue[] = Array.from({ length: N }, (_, n) => ({
    id: `i${n}`,
    title: `Issue ${n}`,
    status: ((n * 3) % 5) as StatusCode,
    priority: (n % 5) as PriorityCode,
    kanbanorder: `a${n}`,
    username: "ada",
    created: n,
    modified: (n * 37) % N,
    deleted: false,
    version: 1,
  }));
  await backend.transact("issues", issues, (_, issue) => issue);
});
after(async () => {
  await backend.close();
  await db.close();
});

describe("the kv backend", () => {
  it("declares the indexes DESIGN.md, 'Indexes' lists, at the stored format", () => {
    assert.equal(schema.version, 5);
    for (const [name, indexes] of Object.entries(INDEXES)) {
      assert.deepEqual(Object.fromEntries(backend.docs.collection(name as keyof typeof INDEXES).indexes), indexes, name);
    }
  });

  it("loads about one window of issues for a list by modified or by priority, not the fifth that share a priority", async () => {
    for (const sort of ["modified", "priority"] as const) {
      const query = windowQuery(backend.collection("issues"), parseIssueFilter({ sort, dir: "desc" }), WINDOW);
      await query.preload();
      const held = backend.collection("issues").size;
      await query.cleanup();
      assert.ok(held < 2 * WINDOW, `${sort}: holds ${held} issues`);
    }
  });

  it("lets go of a window's issues within a second of its last subscriber leaving", async () => {
    const issues = backend.collection("issues");
    const query = windowQuery(issues, parseIssueFilter({ sort: "created", dir: "asc" }), WINDOW);
    await query.preload();
    assert.ok(issues.has("i0"), "the window holds the first issue created");
    for (let waited = 0; issues.has("i0") && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(issues.has("i0"), false);
  });

  it("counts a search that reads documents across several pages of them", async () => {
    const filter = parseIssueFilter({ q: "issue " });
    const total = await new Promise<number>((resolve) => {
      const off = backend.watchTotal(filter, (n) => (resolve(n), queueMicrotask(off)));
    });
    assert.equal(total, N, "every title holds \"issue \"");
  });

  it("anchors the unfiltered list under every sort but title, whose index orders an emoji after U+FF21 and whose list orders it before", () => {
    const [emoji, fullwidth] = ["\u{1F600}", "\uFF21"];
    assert.ok(emoji < fullwidth, "the list's order");
    assert.ok(Buffer.compare(Buffer.from(emoji), Buffer.from(fullwidth)) > 0, "the index's order");
    for (const sort of SORT_FIELDS) {
      for (const dir of ["asc", "desc"] as const) assert.equal(backend.anchor(parseIssueFilter({ sort, dir })) !== undefined, sort !== "title", `${sort} ${dir}`);
    }
    for (const filtered of [{ q: "a" }, { status: "1" }, { priority: "2" }]) assert.equal(backend.anchor(parseIssueFilter(filtered)), undefined, JSON.stringify(filtered));
  });

  describe("validates every write against the row's schema", () => {
    const edited: Issue = {
      id: "edited",
      title: "Edited",
      status: 3,
      priority: 2,
      kanbanorder: "a1",
      username: "ada",
      created: 5,
      modified: 1000,
      deleted: false,
      version: 2,
      dirty: { title: 1000, status: 1000 },
      pending: true,
    };

    it("stores a row as it is, with the sort keys of an issue, `dirty` and `pending`", async () => {
      await backend.transact("issues", [edited], (_, row) => row);
      assert.deepEqual((await backend.read("issues", ["edited"]))[0], { ...edited, priorityOrder: 230_000_000_001_000, statusOrder: "3a1" });

      const { dirty: _dirty, pending: _pending, ...acknowledged } = edited;
      const clean: Issue = { ...acknowledged, id: "clean", version: 3 };
      await backend.transact("issues", [clean], (_, row) => row);
      const [back] = await backend.read("issues", ["clean"]);
      assert.deepEqual(back, { ...clean, priorityOrder: 230_000_000_001_000, statusOrder: "3a1" });
      assert.equal("dirty" in back!, false);
      assert.equal("pending" in back!, false);

      const body: Body = { id: "edited", description: "text", version: 1, dirty: { description: 7 }, pending: true };
      await backend.transact("bodies", [body], (_, row) => row);
      assert.deepEqual((await backend.read("bodies", ["edited"]))[0], body);

      const state: SyncState = {
        id: "sync",
        format: 4,
        epoch: null,
        cursors: { issues: 1, bodies: 2, comments: 3 },
        head: 3,
        online: true,
        caughtUp: { issues: true, bodies: false, comments: true },
        evict: "asked",
      };
      await backend.transact("sync", [state], (_, row) => row);
      assert.deepEqual((await backend.read("sync", ["sync"]))[0], state);
    });

    it("rejects a row of the wrong shape with \"invalid\" and stores nothing", async () => {
      const wrong: [string, object][] = [
        ["a status that is no code", { ...edited, id: "w1", status: 7 }],
        ["a title that is no string", { ...edited, id: "w2", title: 1 }],
        ["a missing field", { ...edited, id: "w3", kanbanorder: undefined }],
        ["a key the schema does not list", { ...edited, id: "w4", labels: [] }],
        ["a `pending` that is not true", { ...edited, id: "w5", pending: false }],
      ];
      for (const [what, row] of wrong) {
        const id = (row as { id: string }).id;
        await assert.rejects(
          backend.transact("issues", [{ id }], () => row as never),
          (e) => e instanceof DocStoreError && e.code === "invalid" && e.issues !== undefined,
          what,
        );
        assert.equal((await backend.read("issues", [id]))[0], undefined, what);
      }
      await assert.rejects(
        backend.transact("sync", [{ id: "sync" }], () => ({ id: "sync", evict: "later" }) as never),
        (e) => e instanceof DocStoreError && e.code === "invalid",
      );
      assert.equal((await backend.read("sync", ["sync"]))[0]!.evict, "asked", "the stored sync row is untouched");
    });
  });
});
