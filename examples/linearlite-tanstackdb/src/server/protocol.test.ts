import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { ServerRow } from "../domain/model.ts";
import type { Stream } from "../domain/stores.ts";
import { WireError } from "../domain/parse.ts";
import type { PushOp } from "../domain/wire.ts";
import { memoryServer } from "./memory.ts";
import { syncServer, type SyncServer } from "./protocol.ts";
import { openServerDb, seedDb, sqliteTables } from "./sqlite.ts";

let dir: string;
const dbs: DatabaseSync[] = [];
before(() => {
  dir = mkdtempSync(join(tmpdir(), "linearlite-"));
});
after(() => {
  for (const db of dbs) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seeded(name: string, issues: number): DatabaseSync {
  const db = openServerDb(join(dir, `${name}.db`));
  dbs.push(db);
  seedDb(db, issues);
  return db;
}

const SERVERS: Record<string, () => SyncServer> = {
  sqlite: () => syncServer(sqliteTables(seeded("protocol", 1000))),
  memory: () => memoryServer({ issues: 1000 }),
};

const edit = (id: string, fields: object, clocks: Record<string, number> = {}): PushOp =>
  ({ stream: "issues", id, fields, clocks }) as PushOp;

for (const [name, open] of Object.entries(SERVERS)) {
  describe(`${name} server`, () => {
    let server: SyncServer;
    before(() => {
      server = open();
    });
    const pull = <S extends Stream>(stream: S, after: number, limit: number) => server.pull(stream, after, limit);
    const epoch = () => server.row("issues", "none").epoch;

    function pullAll<S extends Stream>(stream: S, limit: number, since = 0) {
      const rows: ServerRow<S>[] = [];
      let cursor = since;
      let pages = 0;
      for (;;) {
        const page = pull(stream, cursor, limit);
        rows.push(...page.rows);
        pages++;
        cursor = page.next;
        if (!page.more) return { rows, pages, cursor };
      }
    }

    describe("pull", () => {
      it("pages through every row of a stream exactly once, in version order", () => {
        const issues = pullAll("issues", 300);
        assert.equal(issues.rows.length, 1000);
        assert.equal(new Set(issues.rows.map((r) => r.id)).size, 1000);
        assert.equal(issues.pages, 4);
        assert.ok(issues.rows.every((r, i, all) => i === 0 || r.version > all[i - 1]!.version));
        assert.equal(issues.cursor, server.head());
        assert.equal(pullAll("bodies", 300).rows.length, 1000);
        const comments = pullAll("comments", 128);
        assert.ok(comments.rows.length > 400 && comments.rows.length < 600);
        assert.ok(comments.rows.every((r) => r.key === `${r.issue_id}/${r.id}`));
      });

      it("returns an empty, caught-up page after the head", () => {
        const head = server.head();
        const page = pull("issues", head, 100);
        assert.deepEqual({ rows: page.rows, more: page.more, next: page.next, head: page.head }, { rows: [], more: false, next: head, head });
      });
    });

    describe("push", () => {
      it("shows an edit in a later pull with a higher version, and counts tombstones", () => {
        const [first, second, third] = pull("issues", 0, 3).rows;
        const before = server.head();
        const res = server.push([edit(first!.id, { title: "Renamed", status: 3 }, { title: 4, status: 5 }), edit(second!.id, { deleted: true }), edit(third!.id, { deleted: true })], "grace");
        assert.equal(res.head, before + 1);
        assert.equal(res.epoch, epoch());
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
        const before = server.head();
        const ids = pull("issues", 0, 5).rows.map((r) => r.id);
        server.push(ids.map((id) => edit(id, { title: `batch ${id}` })), "ada");
        const { rows, pages } = pullAll("issues", 2, before);
        assert.equal(rows.length, ids.length);
        assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
        assert.equal(pages, 1);
      });

      it("is idempotent: the same op twice changes nothing the second time", () => {
        const id = pull("issues", 0, 1).rows[0]!.id;
        const op = edit(id, { title: "Once" }, { title: 9 });
        const seen: number[] = [];
        const off = server.onHead((h) => seen.push(h));
        const a = server.push([op], "ada");
        const b = server.push([op], "ada");
        off();
        assert.deepEqual(b.results, a.results);
        assert.equal(b.head, a.head);
        assert.deepEqual(seen, [a.head]);
      });

      it("creates an issue with its body and a comment, even when sent body first", () => {
        const before = server.head();
        const res = server.push(
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

        const d = server.detail(["i-new"]);
        assert.equal(d.bodies[0]?.description, "details");
        assert.deepEqual(d.comments.map((c) => [c.key, c.body, c.username]), [["i-new/c-new", "first!", "linus"]]);
        assert.equal(pull("issues", before, 10).rows[0]?.id, "i-new");

        server.push([{ stream: "comments", id: "c-new", fields: { body: "edited" }, clocks: { body: 4 } }], "linus");
        assert.equal(server.detail(["i-new"]).comments[0]?.body, "edited");
      });

      it("answers a detail request for several issues, with no body for an issue that has none", () => {
        const [a, b] = pull("bodies", 0, 2).rows.map((r) => r.id);
        const one = server.detail([a!]);
        const many = server.detail([a!, "no-such-issue", b!]);
        assert.deepEqual(many.bodies.map((r) => r.id), [a, b]);
        assert.deepEqual(many.comments.filter((c) => c.issue_id === a), one.comments);
        assert.ok(many.comments.every((c) => c.issue_id === a || c.issue_id === b));
        assert.deepEqual(server.detail(["no-such-issue"]), { bodies: [], comments: [] });
      });

      it("leaves the server unchanged when it refuses a single op", () => {
        const head = server.head();
        assert.throws(() => server.push([edit("never-created", { title: "x" }, { title: 1 })], "ada"), (e) => e instanceof WireError && e.status === 409);
        assert.equal(server.head(), head);
        assert.equal(server.row("issues", "never-created").row, null);
      });

      it("rolls the whole request back when one op is refused", () => {
        const head = server.head();
        const id = pull("issues", 0, 1).rows[0]!.id;
        const bad = () => server.push([edit(id, { title: "Never" }), edit("missing", { title: "x" })], "ada");
        assert.throws(bad, (e) => e instanceof WireError && e.status === 409);
        assert.equal(server.head(), head);
        assert.notEqual(pull("issues", 0, 1).rows[0]?.title, "Never");
        assert.throws(() => server.push([{ stream: "issues", id: "half", create: true, fields: { title: "x" }, clocks: {} }], "ada"), WireError);
        assert.throws(() => server.push([{ stream: "comments", id: "c9", create: true, fields: { issue_id: "nope", body: "x" }, clocks: {} }], "ada"), WireError);
      });
    });

    describe("row", () => {
      it("returns one row of any stream by its id, a tombstone as stored, and null for a missing id", () => {
        const issue = pull("issues", 0, 1).rows[0]!;
        assert.deepEqual(server.row("issues", issue.id), { row: issue, epoch: epoch() });
        assert.deepEqual(server.row("bodies", issue.id).row, pull("bodies", 0, 1000).rows.find((b) => b.id === issue.id));
        const comment = pull("comments", 0, 1).rows[0]!;
        assert.deepEqual(server.row("comments", comment.id).row, comment);

        server.push([edit(issue.id, { deleted: true })], "ada");
        assert.equal(server.row("issues", issue.id).row?.deleted, true);
        assert.equal(server.row("issues", "missing").row, null);
        assert.equal(server.row("comments", "missing").row, null);
      });
    });

  });
}

describe("sqlite epoch", () => {
  it("changes when the store is reseeded", () => {
    const db = seeded("reseed", 20);
    const server = syncServer(sqliteTables(db));
    const first = server.row("issues", "none").epoch;
    seedDb(db, 10);
    assert.notEqual(server.row("issues", "none").epoch, first);
    assert.equal(server.pull("issues", 0, 100).rows.length, 10);
    assert.equal(server.head(), server.pull("issues", 0, 1).head);
  });

  it("survives a reopen", () => {
    const path = join(dir, "reopen.db");
    const epoch = (db: DatabaseSync) => syncServer(sqliteTables(db)).row("issues", "none").epoch;
    const a = openServerDb(path);
    const first = epoch(a);
    a.close();
    const b = openServerDb(path);
    assert.equal(epoch(b), first);
    b.close();
  });
});
