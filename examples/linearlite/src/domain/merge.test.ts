import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyLocal, kanbanBetween, mergeIncoming, restore } from "./merge.ts";
import type { Comment, Issue, ServerRow } from "./model.ts";

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "i1",
  title: "Sync",
  status: 1,
  priority: 2,
  kanbanorder: "a0",
  username: "ada",
  created: 1,
  modified: 1,
  deleted: false,
  version: 5,
  ...over,
});
const server = (over: Partial<Issue> = {}): ServerRow<"issues"> => {
  const { dirty: _dirty, ...row } = issue(over);
  return row;
};

describe("applyLocal", () => {
  it("patches fields and stamps each with the clock", () => {
    const next = applyLocal(issue(), { status: 3, title: "Renamed" }, 10);
    assert.equal(next.status, 3);
    assert.equal(next.title, "Renamed");
    assert.deepEqual(next.dirty, { status: 10, title: 10 });
    assert.equal(next.version, 5);
  });

  it("keeps older dirty fields and restamps a field edited again", () => {
    const first = applyLocal(issue(), { status: 3, title: "A" }, 10);
    const second = applyLocal(first, { title: "B" }, 11);
    assert.deepEqual(second.dirty, { status: 10, title: 11 });
  });

  it("ignores a field that already holds the value, returning the same row", () => {
    const row = issue();
    assert.equal(applyLocal(row, { status: 1 }, 10), row);
    assert.equal(applyLocal(row, {}, 10), row);
  });

  it("marks a delete as a dirty tombstone", () => {
    const next = applyLocal(issue(), { deleted: true }, 10);
    assert.equal(next.deleted, true);
    assert.deepEqual(next.dirty, { deleted: 10 });
  });
});

describe("mergeIncoming", () => {
  it("stores an incoming row for a row it does not have", () => {
    const incoming = server();
    assert.deepEqual(mergeIncoming(undefined, incoming), incoming);
  });

  it("does not store a tombstone for a row it never had", () => {
    assert.equal(mergeIncoming(undefined, server({ deleted: true })), undefined);
  });

  it("leaves the row when the incoming one is stale or the same version", () => {
    const local = issue({ version: 5 });
    assert.equal(mergeIncoming(local, server({ version: 4, title: "old" })), undefined);
    assert.equal(mergeIncoming(local, server({ version: 5, title: "same" })), undefined);
  });

  it("takes a newer incoming row over a clean local one", () => {
    const next = mergeIncoming(issue(), server({ version: 6, title: "Server", modified: 9 }));
    assert.equal(next?.title, "Server");
    assert.equal(next?.modified, 9);
    assert.equal(next?.version, 6);
    assert.equal(next?.dirty, undefined);
  });

  it("keeps dirty fields local and takes the rest", () => {
    const local = applyLocal(issue(), { title: "Mine" }, 10);
    const next = mergeIncoming(local, server({ version: 6, title: "Theirs", status: 4 }));
    assert.equal(next?.title, "Mine");
    assert.equal(next?.status, 4);
    assert.equal(next?.version, 6);
    assert.deepEqual(next?.dirty, { title: 10 });
  });

  it("applying the same incoming twice gives the same result", () => {
    const local = applyLocal(issue(), { title: "Mine" }, 10);
    const incoming = server({ version: 6, status: 4 });
    const once = mergeIncoming(local, incoming);
    assert.ok(once);
    assert.equal(mergeIncoming(once, incoming), undefined);
  });

  it("deletes a clean row whose incoming version is a tombstone", () => {
    assert.equal(mergeIncoming(issue(), server({ version: 6, deleted: true })), null);
  });

  it("keeps a tombstoned row that still has unsent edits", () => {
    const local = applyLocal(issue(), { title: "Mine" }, 10);
    const next = mergeIncoming(local, server({ version: 6, deleted: true }));
    assert.ok(next);
    assert.equal(next.deleted, true);
    assert.deepEqual(next.dirty, { title: 10 });
  });

  describe("ack", () => {
    it("clears a field whose clock matches the acked one", () => {
      const local = applyLocal(issue({ version: 5 }), { title: "Mine", status: 3 }, 10);
      const next = mergeIncoming(local, server({ version: 7, title: "Mine", status: 3 }), { title: 10 });
      assert.deepEqual(next?.dirty, { status: 10 });
      assert.equal(next?.title, "Mine");
      assert.equal(next?.version, 7);
    });

    it("drops the dirty map once every field is confirmed", () => {
      const local = applyLocal(issue(), { title: "Mine" }, 10);
      const next = mergeIncoming(local, server({ version: 7, title: "Mine" }), { title: 10 });
      assert.equal(next?.dirty, undefined);
    });

    it("keeps a field dirty when the acked clock is older than its current one", () => {
      const sent = applyLocal(issue(), { title: "First" }, 10);
      const editedAgain = applyLocal(sent, { title: "Second" }, 12);
      const next = mergeIncoming(editedAgain, server({ version: 7, title: "First" }), { title: 10 });
      assert.equal(next?.title, "Second");
      assert.deepEqual(next?.dirty, { title: 12 });
      assert.equal(next?.version, 7);
    });

    it("deletes the row when the acked tombstone leaves it clean", () => {
      const local = applyLocal(issue(), { deleted: true }, 10);
      assert.equal(mergeIncoming(local, server({ version: 7, deleted: true }), { deleted: 10 }), null);
    });

    it("keeps an acked tombstone that was edited again in flight", () => {
      const local = applyLocal(applyLocal(issue(), { deleted: true }, 10), { title: "x" }, 11);
      const next = mergeIncoming(local, server({ version: 7, deleted: true }), { deleted: 10 });
      assert.ok(next);
      assert.deepEqual(next.dirty, { title: 11 });
    });

    it("replaying an ack changes nothing", () => {
      const local = applyLocal(issue(), { title: "Mine" }, 10);
      const incoming = server({ version: 7, title: "Mine" });
      const once = mergeIncoming(local, incoming, { title: 10 });
      assert.ok(once);
      assert.equal(mergeIncoming(once, incoming, { title: 10 }), undefined);
    });

    it("replaying an acked tombstone leaves the already deleted row alone", () => {
      assert.equal(mergeIncoming(undefined, server({ version: 7, deleted: true }), { deleted: 10 }), undefined);
    });

    it("clears dirty fields when the acked row is not newer than what a pull already merged", () => {
      const local = { ...applyLocal(issue({ version: 8 }), { title: "Mine" }, 10) };
      const next = mergeIncoming(local, server({ version: 7, title: "Mine" }), { title: 10 });
      assert.equal(next?.dirty, undefined);
      assert.equal(next?.version, 8);
      assert.equal(next?.title, "Mine");
    });
  });

  it("merges a row without a deleted flag (a body)", () => {
    const local = { id: "i1", description: "a", version: 1 };
    assert.deepEqual(mergeIncoming(local, { id: "i1", description: "b", version: 2 }), { id: "i1", description: "b", version: 2 });
  });

  it("merges a comment by its key", () => {
    const row: ServerRow<"comments"> = { key: "i1/c1", id: "c1", issue_id: "i1", body: "x", username: "ada", created: 1, deleted: false, version: 3 };
    const local: Comment = { ...row, version: 0, dirty: { body: 4 } };
    const next = mergeIncoming(local, row);
    assert.equal(next?.version, 3);
    assert.deepEqual(next?.dirty, { body: 4 });
  });
});

describe("restore", () => {
  const edited = () => applyLocal(issue({ version: 9 }), { title: "Mine", status: 4 }, 20);

  it("replaces a row whose edit the server refused with the server's row, clean, even when its version is older", () => {
    const back = restore(edited(), server({ title: "Theirs", version: 5 }));
    assert.deepEqual(back, server({ title: "Theirs", version: 5 }));
    assert.equal((back as Issue).dirty, undefined);
  });

  it("deletes a row the server has never had, which is what a refused create leaves", () => {
    assert.equal(restore(edited(), null), null);
  });

  it("deletes a row the server holds as a tombstone", () => {
    assert.equal(restore(edited(), server({ deleted: true, version: 12 })), null);
  });

  it("leaves a row that is no longer stored alone", () => {
    assert.equal(restore(undefined, server()), undefined);
  });
});

describe("kanbanBetween", () => {
  it("sorts strictly between its neighbours", () => {
    const mid = kanbanBetween("a0", "a1");
    assert.ok("a0" < mid && mid < "a1");
    const head = kanbanBetween(null, "a0");
    assert.ok(head < "a0");
    const tail = kanbanBetween("a0", null);
    assert.ok(tail > "a0");
    assert.ok(kanbanBetween(null, null).length > 0);
  });

  it("places a drop just after its predecessor when equal keys collide", () => {
    const key = kanbanBetween("a1", "a1");
    assert.ok(key > "a1");
    assert.ok(kanbanBetween("a2", "a1") > "a2");
  });
});
