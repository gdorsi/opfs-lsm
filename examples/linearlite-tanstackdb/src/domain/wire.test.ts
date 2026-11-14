import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WireError } from "./parse.ts";
import { MAX_DETAIL_IDS, MAX_OPS, parseDetailRequest, parsePullRequest, parsePushRequest, parseUsername } from "./wire.ts";

const rejects = (fn: () => unknown) => assert.throws(fn, (e) => e instanceof WireError && e.status === 400);

describe("parsePushRequest", () => {
  it("parses an edit and a create into domain ops", () => {
    const { ops } = parsePushRequest({
      ops: [
        { stream: "issues", id: "i1", fields: { status: 2 }, clocks: { status: 7 } },
        { stream: "comments", id: "c1", create: true, fields: { issue_id: "i1", body: "hi" }, clocks: {} },
      ],
    });
    assert.deepEqual(ops[0], { stream: "issues", id: "i1", fields: { status: 2 }, clocks: { status: 7 } });
    assert.equal(ops[1]?.create, true);
  });

  it("rejects bad enums, lengths, shapes and unknown fields", () => {
    const op = (over: object) => ({ ops: [{ stream: "issues", id: "i1", fields: { status: 1 }, clocks: {}, ...over }] });
    rejects(() => parsePushRequest(null));
    rejects(() => parsePushRequest({ ops: "x" }));
    rejects(() => parsePushRequest(op({ stream: "labels" })));
    rejects(() => parsePushRequest(op({ fields: { status: 5 } })));
    rejects(() => parsePushRequest(op({ fields: { status: 1.5 } })));
    rejects(() => parsePushRequest(op({ fields: { priority: "high" } })));
    rejects(() => parsePushRequest(op({ fields: { title: "" } })));
    rejects(() => parsePushRequest(op({ fields: { title: "x".repeat(501) } })));
    rejects(() => parsePushRequest(op({ fields: { username: "root" } })));
    rejects(() => parsePushRequest(op({ fields: { constructor: 1 } })));
    rejects(() => parsePushRequest(op({ fields: {} })));
    rejects(() => parsePushRequest(op({ fields: { kanbanorder: "a/b" } })));
    rejects(() => parsePushRequest(op({ id: "a/b" })));
    rejects(() => parsePushRequest(op({ clocks: { title: 1 } })));
    rejects(() => parsePushRequest(op({ clocks: { status: -1 } })));
    rejects(() => parsePushRequest(op({ create: "yes" })));
    rejects(() => parsePushRequest({ ops: Array.from({ length: MAX_OPS + 1 }, () => op({}).ops[0]) }));
  });
});

describe("parsePullRequest", () => {
  it("defaults after and limit, and validates them", () => {
    assert.deepEqual(parsePullRequest(new URLSearchParams("stream=issues")), { stream: "issues", after: 0, limit: 1000 });
    assert.deepEqual(parsePullRequest(new URLSearchParams("stream=bodies&after=12&limit=5000")), { stream: "bodies", after: 12, limit: 5000 });
    rejects(() => parsePullRequest(new URLSearchParams("stream=x")));
    rejects(() => parsePullRequest(new URLSearchParams("stream=issues&after=-1")));
    rejects(() => parsePullRequest(new URLSearchParams("stream=issues&limit=0")));
    rejects(() => parsePullRequest(new URLSearchParams("stream=issues&limit=1e9")));
  });
});

describe("parseDetailRequest and parseUsername", () => {
  it("validate ids and user names", () => {
    assert.deepEqual(parseDetailRequest(new URLSearchParams("id=abc-1")), { ids: ["abc-1"] });
    assert.deepEqual(parseDetailRequest(new URLSearchParams("id=a&id=b&id=a")), { ids: ["a", "b"] });
    rejects(() => parseDetailRequest(new URLSearchParams("")));
    rejects(() => parseDetailRequest(new URLSearchParams("id=a&id=b c")));
    rejects(() => parseDetailRequest(new URLSearchParams(Array.from({ length: MAX_DETAIL_IDS + 1 }, (_, i) => `id=i${i}`).join("&"))));
    assert.equal(parseUsername(null), "anonymous");
    assert.equal(parseUsername("ada"), "ada");
    rejects(() => parseUsername("a b"));
  });
});
