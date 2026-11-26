import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { createList, ROW } from "./list.ts";
import { DEFAULT_FILTER, type Filter, type Issue } from "./model.ts";
import { generate } from "./seed.ts";
import { placeBefore, storeOn, type IssueChange, type Store } from "./store.ts";

/** Two handles on one database, as two tabs have. */
let dbs: Db[] = [];
let here: Store;
let there: Store;
before(async () => {
  const name = `linearlite-docstore-${process.pid}`;
  dbs = [await openHarnessDb({ name, forceMemory: true }), await openHarnessDb({ name, forceMemory: true })];
  [here, there] = await Promise.all(dbs.map(storeOn)) as [Store, Store];
  await there.issues.putMany([...generate(400, 3)]);
  await here.db.sync();
});
after(() => Promise.all(dbs.map((db) => db.close())));

/** Every change this tab's feed reports from now on. */
function listen(store: Store): IssueChange[] {
  const heard: IssueChange[] = [];
  store.issues.changes((event) => event.kind === "append" && heard.push(...event.changes));
  return heard;
}

/** Waits until this tab has applied every write the other tab made. */
async function caughtUp(): Promise<void> {
  await here.db.sync();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("placeBefore", () => {
  it("gives where an issue was before another tab's write: none for a new one, its old values for an edit and a delete", async () => {
    const heard = listen(here);
    const [issue] = [...generate(1, 99)] as [Issue];
    await there.issues.put(issue);
    await there.issues.modify(issue.id, (i) => ({ ...i, title: "Renamed", status: 3, priority: 0, modified: i.modified + 1 }));
    await there.issues.delete(issue.id);
    await caughtUp();

    const { id, status, priority, created, modified } = issue;
    assert.deepEqual(heard.map(placeBefore), [undefined, { id, status, priority, created, modified }, { id, status: 3, priority: 0, created, modified: modified + 1 }]);
  });
});

describe("the list", () => {
  const filters: [string, Filter][] = [
    ["by modified", DEFAULT_FILTER],
    ["by created, ascending", { ...DEFAULT_FILTER, sort: "created", dir: "asc" }],
    ["by modified under a status filter", { ...DEFAULT_FILTER, status: [1, 2] }],
    ["by priority under both filters", { ...DEFAULT_FILTER, sort: "priority", status: [0, 1, 2], priority: [1, 3] }],
  ];

  for (const [label, filter] of filters) {
    it(`follows another tab's edits, creates and deletes without reading again, ${label}`, async () => {
      const list = createList(here);
      list.scroll(0, ROW * 30);
      const shown = list.show(filter);
      await shown.rows;
      await shown.total;
      let reads = 0;
      here.issues.changes((event) => {
        if (event.kind !== "append") return;
        if (list.apply(event.changes.map((c) => ({ before: placeBefore(c), after: c.doc }))) === undefined) reads++;
      });

      const ids = (await here.issues.queryIds({})).ids;
      const fresh = [...generate(5, 7 + label.length)];
      for (let i = 0; i < 40; i++) {
        const id = ids[(i * 37) % ids.length]!;
        if (i % 8 === 0) await there.issues.put(fresh[i / 8]!);
        else if (i % 8 === 5) await there.issues.delete(id);
        else await there.issues.modify(id, (issue) => ({ ...issue, status: (i % 5) as Issue["status"], priority: ((i * 3) % 5) as Issue["priority"], modified: issue.modified + i * 1e6 }));
      }
      await caughtUp();

      const want = createList(here);
      want.scroll(0, ROW * 30);
      const expected = want.show(filter);
      await expected.rows;
      const total = await expected.total;
      let got: Parameters<Parameters<typeof list.subscribe>[0]>[0] | undefined;
      let wanted: typeof got;
      list.subscribe((win) => (got = win));
      want.subscribe((win) => (wanted = win));
      assert.equal(reads, 0);
      assert.equal(got!.count, total);
      assert.deepEqual(got!.rows, wanted!.rows);
    });
  }

  it("reads again for a search, since no index entry holds the title an issue had", async () => {
    const list = createList(here);
    list.scroll(0, ROW * 30);
    const shown = list.show({ ...DEFAULT_FILTER, q: "lorem" });
    await shown.total;
    const [issue] = (await here.issues.query({ limit: 1 })).docs as [Issue];
    assert.equal(list.apply([{ before: issue, after: { ...issue, title: "lorem" } }]), undefined);
  });
});
