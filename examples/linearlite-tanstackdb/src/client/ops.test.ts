import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyLocal } from "../domain/merge.ts";
import type { Comment, Issue, Stream } from "../domain/model.ts";
import { parsePushRequest } from "../domain/wire.ts";
import { backoffMs, Pager, pushOp } from "./ops.ts";

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
const comment: Comment = {
  key: "i1/c1",
  id: "c1",
  issue_id: "i1",
  body: "hi",
  username: "ada",
  created: 1,
  deleted: false,
  version: 0,
  dirty: { body: 7, deleted: 7 },
};

describe("pushOp", () => {
  it("sends nothing for a clean row", () => {
    assert.equal(pushOp("issues", issue()), undefined);
  });

  it("sends the current values of the dirty fields with their clocks", () => {
    const row = applyLocal(applyLocal(issue(), { status: 3 }, 10), { title: "Renamed" }, 11);
    assert.deepEqual(pushOp("issues", row), { stream: "issues", id: "i1", fields: { status: 3, title: "Renamed" }, clocks: { status: 10, title: 11 } });
  });

  it("creates a row the server has never seen with every mutable field", () => {
    const op = pushOp("issues", issue({ version: 0, dirty: { title: 4, status: 4, priority: 4, kanbanorder: 4, deleted: 4 } }));
    assert.deepEqual(op, {
      stream: "issues",
      id: "i1",
      fields: { title: "Sync", status: 1, priority: 2, kanbanorder: "a0", deleted: false },
      clocks: { title: 4, status: 4, priority: 4, kanbanorder: 4, deleted: 4 },
      create: true,
    });
  });

  it("creates a comment under its issue", () => {
    assert.deepEqual(pushOp("comments", comment)?.fields, { body: "hi", deleted: false, issue_id: "i1" });
  });

  it("builds ops the server's parser accepts unchanged", () => {
    const ops = [
      pushOp("issues", applyLocal(issue(), { priority: 0, deleted: true }, 3))!,
      pushOp("bodies", { id: "i1", description: "", version: 0, dirty: { description: 2 } })!,
      pushOp("comments", comment)!,
    ];
    assert.deepEqual(parsePushRequest(JSON.parse(JSON.stringify({ ops }))), { ops });
  });
});

describe("backoffMs", () => {
  it("doubles from 1 s and stops at 30 s", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe("Pager", () => {
  /** A server of two-row pages up to cursor `end` that fails the first ask of `down`, and every page asked of it. */
  const server = (end: number, down?: string) => {
    const asked: string[] = [];
    const pager = new Pager(async (stream: Stream, after: number) => {
      asked.push(`${stream}@${after}`);
      if (`${stream}@${after}` === down && asked.indexOf(down) === asked.length - 1) throw new Error("down");
      return { after, next: after + 2, more: after + 2 < end };
    });
    return { asked, pager };
  };

  it("asks for the next page as soon as a page arrives, and serves that cursor from it", async () => {
    const { asked, pager } = server(6);
    assert.equal((await pager.page("issues", 0)).after, 0);
    assert.deepEqual(asked, ["issues@0", "issues@2"]);
    assert.equal((await pager.page("issues", 2)).after, 2);
    assert.equal((await pager.page("issues", 4)).after, 4);
    assert.deepEqual(asked, ["issues@0", "issues@2", "issues@4"], "nothing past the last page");
  });

  it("asks again for another stream or cursor, and after forget", async () => {
    const { asked, pager } = server(100);
    await pager.page("issues", 0);
    await pager.page("bodies", 0);
    await pager.page("issues", 2);
    await pager.page("issues", 6);
    pager.forget();
    await pager.page("issues", 8);
    assert.deepEqual(asked, ["issues@0", "issues@2", "bodies@0", "bodies@2", "issues@2", "issues@4", "issues@6", "issues@8", "issues@8", "issues@10"]);
  });

  it("fails only the call that uses a page asked ahead that failed", async () => {
    const { pager } = server(100, "issues@2");
    await pager.page("issues", 0);
    await assert.rejects(pager.page("issues", 2), /down/);
    assert.equal((await pager.page("issues", 2)).after, 2);
    const failing = server(100, "issues@2");
    await failing.pager.page("issues", 0);
    failing.pager.forget();
    assert.equal((await failing.pager.page("bodies", 0)).after, 0);
  });
});
