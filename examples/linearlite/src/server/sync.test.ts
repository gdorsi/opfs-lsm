import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { ServerRow, Stream } from "../domain/model.ts";
import { type PushOp, WireError } from "../domain/wire.ts";
import { openServerDb, readEpoch, readHead } from "./db.ts";
import { seedDb } from "./seed.ts";
import { detail, onHead, pull, push, row } from "./sync.ts";

let dir: string;
let db: DatabaseSync;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "linearlite-"));
  db = openServerDb(join(dir, "test.db"));
  seedDb(db, 1000);
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function pullAll<S extends Stream>(stream: S, limit: number, since = 0) {
  const rows: ServerRow<S>[] = [];
  let cursor = since;
  let pages = 0;
  for (;;) {
    const page = pull(db, stream, cursor, limit);
    rows.push(...page.rows);
    pages++;
    cursor = page.next;
    if (!page.more) return { rows, pages, cursor };
  }
}

const edit = (id: string, fields: object, clocks: Record<string, number> = {}): PushOp =>
  ({ stream: "issues", id, fields, clocks }) as PushOp;

describe("pull", () => {
  it("pages through every row of a stream exactly once, in version order", () => {
    const issues = pullAll("issues", 300);
    assert.equal(issues.rows.length, 1000);
    assert.equal(new Set(issues.rows.map((r) => r.id)).size, 1000);
    assert.equal(issues.pages, 4);
    assert.ok(issues.rows.every((r, i, all) => i === 0 || r.version > all[i - 1]!.version));
    assert.equal(issues.cursor, readHead(db));
    assert.equal(pullAll("bodies", 300).rows.length, 1000);
    const comments = pullAll("comments", 128);
    assert.ok(comments.rows.length > 400 && comments.rows.length < 600);
    assert.ok(comments.rows.every((r) => r.key === `${r.issue_id}/${r.id}`));
  });

  it("returns an empty, caught-up page after the head", () => {
    const head = readHead(db);
    const page = pull(db, "issues", head, 100);
    assert.deepEqual({ rows: page.rows, more: page.more, next: page.next, head: page.head }, { rows: [], more: false, next: head, head });
  });
});

describe("push", () => {
  it("shows an edit in a later pull with a higher version, and counts tombstones", () => {
    const [first, second, third] = pull(db, "issues", 0, 3).rows;
    const before = readHead(db);
    const res = push(db, [edit(first!.id, { title: "Renamed", status: 3 }, { title: 4, status: 5 }), edit(second!.id, { deleted: true }), edit(third!.id, { deleted: true })], "grace");
    assert.equal(res.head, before + 1);
    assert.equal(res.epoch, readEpoch(db));
    assert.deepEqual(res.results[0]?.clocks, { title: 4, status: 5 });

    const { rows } = pullAll("issues", 100, before);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.version === before + 1));
    const renamed = rows.find((r) => r.id === first!.id)!;
    assert.equal(renamed.title, "Renamed");
    assert.equal(renamed.status, 3);
    assert.ok(renamed.version > first!.version);
    assert.ok(renamed.modified >= first!.modified);
    assert.equal(rows.filter((r) => r.deleted).length, 2);
    assert.equal(pullAll("issues", 100).rows.filter((r) => r.deleted).length, 2);
  });

  it("keeps a page whole when many rows share a version", () => {
    const before = readHead(db);
    const ids = pull(db, "issues", 0, 5).rows.map((r) => r.id);
    push(db, ids.map((id) => edit(id, { title: `batch ${id}` })), "ada");
    const { rows, pages } = pullAll("issues", 2, before);
    assert.equal(rows.length, ids.length);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    assert.equal(pages, 1);
  });

  it("is idempotent: the same op twice changes nothing the second time", () => {
    const id = pull(db, "issues", 0, 1).rows[0]!.id;
    const op = edit(id, { title: "Once" }, { title: 9 });
    const seen: number[] = [];
    const off = onHead((h) => seen.push(h));
    const a = push(db, [op], "ada");
    const b = push(db, [op], "ada");
    off();
    assert.deepEqual(b.results, a.results);
    assert.equal(b.head, a.head);
    assert.deepEqual(seen, [a.head]);
  });

  it("creates an issue with its body and a comment, even when sent body first", () => {
    const before = readHead(db);
    const res = push(
      db,
      [
        { stream: "comments", id: "c-new", create: true, fields: { issue_id: "i-new", body: "first!" }, clocks: { body: 3 } },
        { stream: "bodies", id: "i-new", create: true, fields: { description: "details" }, clocks: { description: 2 } },
        { stream: "issues", id: "i-new", create: true, fields: { title: "New", status: 0, priority: 4, kanbanorder: "a0V" }, clocks: { title: 1 } },
      ],
      "linus",
    );
    assert.equal(res.head, before + 1);
    const issue = res.results.find((r) => r.stream === "issues")!.row as ServerRow<"issues">;
    assert.equal(issue.username, "linus");
    assert.equal(issue.deleted, false);
    assert.equal(issue.version, before + 1);

    const d = detail(db, "i-new");
    assert.equal(d.body?.description, "details");
    assert.deepEqual(d.comments.map((c) => [c.key, c.body, c.username]), [["i-new/c-new", "first!", "linus"]]);
    assert.equal(pull(db, "issues", before, 10).rows[0]?.id, "i-new");

    push(db, [{ stream: "comments", id: "c-new", fields: { body: "edited" }, clocks: { body: 4 } }], "linus");
    assert.equal(detail(db, "i-new").comments[0]?.body, "edited");
  });

  it("rolls the whole request back when one op is refused", () => {
    const head = readHead(db);
    const id = pull(db, "issues", 0, 1).rows[0]!.id;
    const bad = () => push(db, [edit(id, { title: "Never" }), edit("missing", { title: "x" })], "ada");
    assert.throws(bad, (e) => e instanceof WireError && e.status === 409);
    assert.equal(readHead(db), head);
    assert.notEqual(pull(db, "issues", 0, 1).rows[0]?.title, "Never");
    assert.throws(() => push(db, [{ stream: "issues", id: "half", create: true, fields: { title: "x" }, clocks: {} }], "ada"), WireError);
    assert.throws(() => push(db, [{ stream: "comments", id: "c9", create: true, fields: { issue_id: "nope", body: "x" }, clocks: {} }], "ada"), WireError);
  });
});

describe("row", () => {
  it("returns one row of any stream by its id, a tombstone as stored, and null for a missing id", () => {
    const issue = pull(db, "issues", 0, 1).rows[0]!;
    assert.deepEqual(row(db, "issues", issue.id), { row: issue, epoch: readEpoch(db) });
    assert.deepEqual(row(db, "bodies", issue.id).row, pull(db, "bodies", 0, 1000).rows.find((b) => b.id === issue.id));
    const comment = pull(db, "comments", 0, 1).rows[0]!;
    assert.deepEqual(row(db, "comments", comment.id).row, comment);

    push(db, [edit(issue.id, { deleted: true })], "ada");
    assert.equal(row(db, "issues", issue.id).row?.deleted, true);
    assert.equal(row(db, "issues", "missing").row, null);
    assert.equal(row(db, "comments", "missing").row, null);
  });
});

describe("epoch", () => {
  it("changes when the store is reseeded", () => {
    const first = readEpoch(db);
    seedDb(db, 10);
    assert.notEqual(readEpoch(db), first);
    assert.equal(pullAll("issues", 100).rows.length, 10);
    assert.equal(readHead(db), pull(db, "issues", 0, 1).head);
  });

  it("survives a reopen", () => {
    const path = join(dir, "reopen.db");
    const a = openServerDb(path);
    const epoch = readEpoch(a);
    a.close();
    const b = openServerDb(path);
    assert.equal(readEpoch(b), epoch);
    b.close();
  });
});
