/**
 * `count` and `offset` over rows and indexes. kv adds a count up from what
 * each write said it did to its key, so docstore has to say the truth for
 * every row and index entry it writes: these tests flush between writes, so
 * that each statement is the first one a run holds for its key.
 */
import type { Db } from "@opfs-lsm/kv";
import { ingest, readStats, settle } from "@opfs-lsm/kv/testing";
import { describe, expect, it } from "vitest";
import { defineSchema, openDocStore } from "../src/index.js";
import { freshName, openKv } from "./harness.js";

type Issue = { id: string; project: string; status: string; rank: number; tags?: string[]; slug?: string; title?: string };

const schema = defineSchema<{ issues: Issue; plain: { id: string; n: number } }>()({
  version: 1,
  collections: {
    issues: {
      byStatus: { by: ["project", "status", "rank"] },
      byTag: { by: "tags[]" },
      bySlug: { by: "slug", unique: true },
      search: { by: "project", text: "title" },
    },
    plain: {},
  },
});

const STATUSES = ["todo", "doing", "done"];
const issue = (i: number, patch: Partial<Issue> = {}): Issue => ({
  id: `i${String(i).padStart(5, "0")}`,
  project: `p${i % 3}`,
  status: STATUSES[i % 3]!,
  rank: i,
  tags: [`t${i % 4}`, `t${(i + 1) % 4}`],
  slug: `slug-${i}`,
  title: `issue number ${i}`,
  ...patch,
});

/** Bytes this handle read from run files. */
async function runBytesRead(kv: Db): Promise<number> {
  const read = (await readStats(kv)).tab.fs!.read;
  return Object.entries(read).reduce((n, [dir, io]) => (dir.startsWith("l") ? n + io.bytes : n), 0);
}

describe("count and offset", () => {
  it("stay exact for rows and every kind of index as documents are put, changed and deleted across flushes", async () => {
    const kv = await openKv(freshName());
    const store = await openDocStore(kv, schema);
    const issues = store.collection("issues");
    const model = new Map<string, Issue>();
    const check = async (label: string) => {
      const docs = [...model.values()];
      expect(await issues.count({}), `${label}: rows`).toBe(docs.length);
      for (const project of ["p0", "p1", "p2"]) {
        const inProject = docs.filter((d) => d.project === project);
        expect(await issues.count({ index: "byStatus", eq: [project] }), `${label}: ${project}`).toBe(inProject.length);
        expect(await issues.count({ index: "search", eq: [project] }), `${label}: search ${project}`).toBe(inProject.length);
        for (const status of STATUSES) {
          const column = inProject.filter((d) => d.status === status).sort((a, b) => a.rank - b.rank);
          expect(await issues.count({ index: "byStatus", eq: [project, status] }), `${label}: ${project} ${status}`).toBe(column.length);
          const offset = column.length >> 1;
          const page = await issues.queryIds({ index: "byStatus", eq: [project, status], offset, limit: 5 });
          expect(page.ids, `${label}: ${project} ${status} at ${offset}`).toEqual(column.slice(offset, offset + 5).map((d) => d.id));
          const back = await issues.query({ index: "byStatus", eq: [project, status], offset, limit: 5, reverse: true });
          expect(back.docs.map((d) => d.id)).toEqual([...column].reverse().slice(offset, offset + 5).map((d) => d.id));
        }
      }
      for (const tag of ["t0", "t1", "t2", "t3"]) {
        expect(await issues.count({ index: "byTag", eq: [tag] }), `${label}: ${tag}`).toBe(docs.filter((d) => d.tags?.includes(tag)).length);
      }
      expect(await issues.count({ index: "bySlug" }), `${label}: slugs`).toBe(docs.filter((d) => d.slug !== undefined).length);
    };
    const put = async (docs: Issue[]) => {
      await issues.putMany(docs);
      for (const d of docs) model.set(d.id, d);
    };

    await put(Array.from({ length: 300 }, (_, i) => issue(i)));
    await check("inserted");
    await ingest(kv);
    await check("inserted, flushed");

    // Every kind of change, each as the first write of its keys since the flush.
    await put([issue(1, { status: "done" }), issue(2, { tags: ["t3"] }), issue(4, { title: "renamed" }), issue(5, { slug: "moved" })]);
    await issues.modify(issue(7).id, (d) => ({ ...d, project: "p2", status: "todo" }));
    await issues.deleteMany([issue(9).id, issue(10).id, "missing"]);
    for (const id of [issue(9).id, issue(10).id]) model.delete(id);
    model.set(issue(7).id, { ...issue(7), project: "p2", status: "todo" });
    await issues.put(issue(11, { slug: undefined as unknown as string, tags: [] }));
    model.set(issue(11).id, issue(11, { slug: undefined as unknown as string, tags: [] }));
    await check("changed");
    await ingest(kv);
    await check("changed, flushed");

    // The same rows again, back and forth, with a flush between each step.
    for (let round = 0; round < 6; round++) {
      await put(Array.from({ length: 40 }, (_, i) => issue(i * 7, { status: STATUSES[(i + round) % 3]!, rank: i * 7 + round })));
      await issues.deleteMany(Array.from({ length: 10 }, (_, i) => issue(200 + round * 10 + i).id));
      for (let i = 0; i < 10; i++) model.delete(issue(200 + round * 10 + i).id);
      await check(`round ${round}`);
      await ingest(kv);
      await check(`round ${round}, flushed`);
    }
    await settle(kv);
    await check("settled");
    await kv.close();
  });

  it("read the blocks at the ends of a range, not the range", async () => {
    const name = freshName();
    let kv = await openKv(name);
    let store = await openDocStore(kv, schema);
    const n = 6_000;
    for (let at = 0; at < n; at += 500) {
      await store.collection("issues").putMany(Array.from({ length: 500 }, (_, i) => issue(at + i, { project: "p0", title: "x".repeat(400) })));
      if (at % 2_000 === 1_500) await ingest(kv);
    }
    await settle(kv);
    await store.collection("issues").deleteMany(Array.from({ length: 100 }, (_, i) => issue(i * 17).id));
    await ingest(kv);
    await kv.close();

    kv = await openKv(name);
    store = await openDocStore(kv, schema);
    const issues = store.collection("issues");
    const before = await runBytesRead(kv);
    expect(await issues.count({})).toBe(n - 100);
    expect(await issues.count({ gte: issue(1_000).id, lt: issue(5_000).id })).toBe(4_000 - Array.from({ length: 100 }, (_, i) => i * 17).filter((i) => i >= 1_000 && i < 5_000).length);
    expect(await issues.count({ index: "byStatus", eq: ["p0"] })).toBe(n - 100);
    expect(await issues.count({ index: "byStatus", eq: ["p0", "todo"] })).toBe(n / 3 - 34);
    // A window 90% into the rows, and one into an index, from either end.
    expect((await issues.queryIds({ offset: 5_300, limit: 3 })).ids).toHaveLength(3);
    expect((await issues.queryIds({ index: "byStatus", eq: ["p0"], offset: 5_300, limit: 3, reverse: true })).ids).toHaveLength(3);
    const counted = (await runBytesRead(kv)) - before;
    // Every row, read in full, for comparison.
    expect((await issues.queryIds({})).ids).toHaveLength(n - 100);
    const walked = (await runBytesRead(kv)) - before - counted;
    expect(counted).toBeLessThan(walked / 4);
    await kv.close();
  });

  it("of a collection with no index is exact, by a scan until its blind puts are merged down", async () => {
    const kv = await openKv(freshName());
    const plain = (await openDocStore(kv, schema)).collection("plain");
    await plain.putMany(Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, n: i })));
    await ingest(kv);
    await plain.putMany(Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, n: -i })));
    await plain.delete("r3");
    expect(await plain.count({})).toBe(49);
    expect((await plain.queryIds({ offset: 47, limit: 5 })).ids).toEqual(["r8", "r9"]);
    await settle(kv);
    expect(await plain.count({})).toBe(49);
    await kv.close();
  });
});
