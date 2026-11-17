import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import type { Issue, PriorityCode, StatusCode } from "../domain/model.ts";
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
});
