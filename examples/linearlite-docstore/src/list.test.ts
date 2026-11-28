import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Database } from "@opfs-lsm/db";
import { openMemoryDatabase } from "@opfs-lsm/db/testing";
import { anyIssue, issueOf, PAGE, pageOf, totalOf } from "./list.ts";
import { DEFAULT_FILTER, schema, SORTS, type Filter, type Issue, type Store } from "./model.ts";
import { generate } from "./seed.ts";
import { createIssue, detailOf, editIssue } from "./store.ts";

/** Two handles on one database, as two tabs have. */
let dbs: Database<typeof schema.collections>[] = [];
let here: Store;
let there: Store;
before(async () => {
  const name = `linearlite-docstore-${process.pid}`;
  dbs = [await openMemoryDatabase({ name, ...schema }), await openMemoryDatabase({ name, ...schema })];
  [here, there] = dbs.map((db) => db.collections) as [Store, Store];
  await here.issues.upsert([...generate(400, 3)]);
});
after(() => Promise.all(dbs.map((db) => db.close())));

/** The list under `filter`, from every issue `store` holds: what the queries must give. Each sort ends on the id. */
async function expected(filter: Filter, store: Store): Promise<Issue[]> {
  const all = await everyIssue(store);
  const fields = { modified: ["modified"], created: ["created"], status: ["status", "priority", "modified"], priority: ["priority", "status", "modified"] } as const;
  const order = [...fields[filter.sort], "id"] as const;
  const sign = filter.dir === "desc" ? -1 : 1;
  return all
    .filter((i) => filter.status.length === 0 || filter.status.includes(i.status))
    .filter((i) => filter.priority.length === 0 || filter.priority.includes(i.priority))
    .filter((i) => i.title.toLowerCase().includes(filter.q.toLowerCase()))
    .sort((a, b) => {
      for (const field of order) if (a[field] !== b[field]) return a[field] < b[field] ? -sign : sign;
      return 0;
    });
}

const everyIssue = async ({ issues }: Store): Promise<Issue[]> => {
  const all: Issue[] = [];
  for (let page = 0; ; page++) {
    const rows = await pageOf(issues, DEFAULT_FILTER, page).run();
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
};

/** The last value of a subscription, once it equals `want`. Fails after two seconds. */
async function settles<V>(query: { subscribe(next: (value: V) => void, error: (error: Error) => void): () => void }, want: () => Promise<V>, t: { after(fn: () => void): void }) {
  let last: V | undefined;
  let failure: Error | undefined;
  t.after(query.subscribe((value) => (last = value), (error) => (failure = error)));
  return async () => {
    const deadline = Date.now() + 2000;
    for (;;) {
      if (failure) throw failure;
      const wanted = await want();
      try {
        assert.deepEqual(last, wanted);
        return;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };
}

const filters: [string, Filter][] = [
  ["with no filter", DEFAULT_FILTER],
  ["under a status filter", { ...DEFAULT_FILTER, status: [1, 2] }],
  ["under both filters", { ...DEFAULT_FILTER, status: [0, 1, 2], priority: [1, 3] }],
  ["under a title search", { ...DEFAULT_FILTER, q: "lorem" }],
  ["under a filter and a search", { ...DEFAULT_FILTER, priority: [0, 4], q: "ipsum" }],
];

describe("the list's queries", () => {
  for (const [label, base] of filters) {
    it(`give each page and the total in the sort's order, ${label}`, async () => {
      for (const sort of SORTS) {
        for (const dir of ["asc", "desc"] as const) {
          const filter = { ...base, sort, dir };
          const want = await expected(filter, here);
          assert.equal(await totalOf(here.issues, filter).run(), want.length, `${sort} ${dir}`);
          for (const page of [0, 1, Math.floor(want.length / PAGE)]) {
            assert.deepEqual(await pageOf(here.issues, filter, page).run(), want.slice(page * PAGE, (page + 1) * PAGE), `${sort} ${dir}, page ${page}`);
          }
        }
      }
    });
  }

  it("read each page through an index in the list's order, so the read stops at the page's last row, and count without reading a document when no search runs", () => {
    for (const sort of SORTS) {
      for (const [label, base] of filters) {
        const filter = { ...base, sort };
        const page = pageOf(here.issues, filter, 3).explain();
        assert.equal(page.kind === "index" && page.ordered, true, `${sort} ${label}`);
        const total = totalOf(here.issues, filter).explain();
        assert.equal(total.kind === "index" && total.exact, filter.q === "", `${sort} ${label}`);
      }
    }
  });

  for (const [label, base] of filters) {
    it(`follow another tab's edits, creates and deletes, ${label}`, async (t) => {
      const filter: Filter = { ...base, sort: "priority", dir: "asc" };
      const pages = [0, 2].map((page) => ({ page, live: pageOf(here.issues, filter, page) }));
      const followed = [
        await settles(totalOf(here.issues, filter), async () => (await expected(filter, there)).length, t),
        ...(await Promise.all(pages.map(({ page, live }) => settles(live, async () => (await expected(filter, there)).slice(page * PAGE, (page + 1) * PAGE), t)))),
      ];
      for (const follows of followed) await follows();

      const ids = (await everyIssue(there)).map((i) => i.id);
      const fresh = [...generate(5, 7 + label.length)];
      for (let i = 0; i < 40; i++) {
        const id = ids[(i * 37) % ids.length]!;
        if (i % 8 === 0) await there.issues.insert(fresh[i / 8]!);
        else if (i % 8 === 5) await there.issues.delete(id);
        else if (i % 8 === 3) await editIssue(there, id, { title: `Lorem ipsum ${i}` });
        else await editIssue(there, id, { status: (i % 5) as Issue["status"], priority: ((i * 3) % 5) as Issue["priority"] });
      }
      for (const follows of followed) await follows();
    });
  }
});

describe("the writes", () => {
  it("edit an issue in one write that also moves its modified time, and leave a deleted issue deleted", async () => {
    const [issue] = [...generate(1, 99)] as [Issue];
    await here.issues.insert(issue);
    await editIssue(here, issue.id, { title: "Renamed", status: 3 });
    const stored = await issueOf(here.issues, issue.id).run();
    assert.deepEqual({ ...stored, modified: 0 }, { ...issue, title: "Renamed", status: 3, modified: 0 });
    assert.ok(stored!.modified > issue.modified);

    await here.issues.delete(issue.id);
    await editIssue(here, issue.id, { title: "Back" });
    assert.equal(await issueOf(here.issues, issue.id).run(), undefined);
  });

  it("refuse an empty title and store nothing", async () => {
    const [issue] = [...generate(1, 98)] as [Issue];
    await here.issues.insert(issue);
    await assert.rejects(editIssue(here, issue.id, { title: "" }), { _tag: "ValidationError", code: "invalid" });
    assert.deepEqual(await here.issues.get(issue.id), issue);
  });

  it("create an issue with its description, and make a generated issue's description once", async () => {
    await createIssue(here, "new-issue", { title: "Written by hand", status: 1, priority: 4, description: "As typed" });
    assert.equal((await issueOf(here.issues, "new-issue").run())?.title, "Written by hand");
    assert.deepEqual(await detailOf(here, "new-issue"), { id: "new-issue", description: "As typed", comments: [] });

    const [issue] = [...generate(1, 97)] as [Issue];
    await here.issues.insert(issue);
    const made = await detailOf(here, issue.id);
    assert.ok(made!.description.length > 0);
    assert.deepEqual(await here.details.get(issue.id), made);
    assert.deepEqual(await detailOf(here, issue.id), made);
    assert.equal(await detailOf(here, "no-such-issue"), undefined);
  });
});

describe("anyIssue", () => {
  it("is undefined only for a database with no issue", async () => {
    const empty = await openMemoryDatabase({ name: `linearlite-docstore-empty-${process.pid}`, ...schema });
    assert.equal(await anyIssue(empty.collections.issues).run(), undefined);
    await empty.close();
    assert.notEqual(await anyIssue(here.issues).run(), undefined);
  });
});
