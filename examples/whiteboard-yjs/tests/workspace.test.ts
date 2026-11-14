import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as Y from "yjs";
import { digestShapes, applyPatchPlain } from "../src/model/digest.ts";
import { BoardLoadError } from "../src/model/board.ts";
import { broadcastSync } from "../src/model/sync.ts";
import type { Applied, Board, BoardId, DocStorage, NewShape, Shape, ShapeId, Workspace, WorkspaceOptions } from "../src/model/types.ts";
import { openWorkspace } from "../src/model/workspace.ts";
import { memoryStorage } from "../src/persistence/index.ts";
import { disk } from "./support/disk.ts";
import { idCounter, testEnv } from "./support/env.ts";
import { crashDisk, flakyStorage } from "./support/storage.ts";

const rect = (x = 0, y = 0): NewShape => ({ kind: "rect", x, y, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 });
const digestOf = (board: Board) => digestShapes(board.view().shapes);
const titles = (ws: Workspace) => ws.boards().map((b) => b.title);

const live: Workspace[] = [];
afterEach(async () => {
  await Promise.allSettled(live.splice(0).map((ws) => ws.close()));
});
async function start(over: Partial<WorkspaceOptions> = {}, prefix = "w") {
  const env = testEnv(idCounter(prefix));
  const ws = await openWorkspace({ storage: disk().storage, env, autosaveMs: null, ...over });
  live.push(ws);
  return { ws, env };
}

describe("the board list", () => {
  test("lists boards oldest first, ties by id, and is the same array until it changes", async () => {
    const { ws, env } = await start();
    const first = ws.createBoard("First");
    await env.advance(5);
    const third = ws.createBoard("Third");
    const second = ws.createBoard("Second, same instant as Third");
    assert.deepEqual(ws.boards().map((b) => b.id), [first, third, second]);
    assert.ok(third < second);
    const list = ws.boards();
    assert.equal(ws.boards(), list);
    ws.renameBoard(first, "First, renamed");
    assert.notEqual(ws.boards(), list);
    assert.deepEqual(titles(ws), ["First, renamed", "Third", "Second, same instant as Third"]);
  });

  test("notifies for a change of the list and for a change of the save state, and for nothing else", async () => {
    const { ws } = await start();
    let calls = 0;
    ws.subscribe(() => calls++);
    const id = ws.createBoard("A");
    assert.equal(calls, 2, "the new entry, and saved becoming saving");
    ws.renameBoard(id, "A");
    ws.renameBoard("ghost" as BoardId, "B");
    assert.equal(calls, 2, "a rename to the same title and a rename of an unknown board change nothing");
    ws.renameBoard(id, "B");
    assert.equal(calls, 3, "the title; it was already saving");
  });

  test("is what a reopened workspace lists", async () => {
    const storage = disk().storage;
    const first = await start({ storage });
    const a = first.ws.createBoard("A");
    await first.env.advance(1);
    first.ws.createBoard("B");
    first.ws.renameBoard(a, "A2");
    await first.ws.close();
    const again = await start({ storage }, "x");
    assert.deepEqual(titles(again.ws), ["A2", "B"]);
  });

  test("skips index entries the workspace could not have written", async () => {
    const storage = disk().storage;
    const raw = new Y.Doc();
    const binding = await storage.attach("workspace", raw);
    const boards = raw.getMap<unknown>("boards");
    raw.transact(() => {
      boards.set("number", 7);
      boards.set("notitle", new Y.Map<unknown>([["createdAt", 1]]));
      boards.set("badtime", new Y.Map<unknown>([["title", "x"], ["createdAt", "yesterday"]]));
      boards.set("fine", new Y.Map<unknown>([["title", "Fine"], ["createdAt", 1]]));
    });
    await binding.detach();
    const { ws } = await start({ storage });
    assert.deepEqual(ws.boards().map((b) => [b.id, b.title]), [["fine", "Fine"]]);
  });

  test("an edit never writes the index: only creating, renaming and deleting do", async () => {
    const storage = memoryStorage();
    const { ws } = await start({ storage, gestureIntervalMs: 0 });
    const id = ws.createBoard("Busy");
    const board = await ws.openBoard(id);
    const writes = () => storage.updates.get("workspace")!.length;
    const before = writes();
    const [a] = board.dispatch({ type: "create", shapes: [rect(), rect(5, 5)] }).created;
    const drag = board.beginGesture({ kind: "translate", ids: [a!] });
    for (let i = 1; i <= 40; i++) drag.update({ dx: i, dy: i }, i * 8);
    drag.end();
    board.undo();
    board.dispatch({ type: "remove", ids: [a!] });
    await board.flush();
    assert.equal(writes(), before);
    ws.renameBoard(id, "Renamed");
    assert.equal(writes(), before + 1);
  });
});

describe("opening a board", () => {
  test("returns the same Board while it is open, and a fresh one with the stored data after it closes", async () => {
    const { ws } = await start();
    const id = ws.createBoard("A");
    const [one, two] = await Promise.all([ws.openBoard(id), ws.openBoard(id)]);
    assert.equal(one, two);
    assert.equal(await ws.openBoard(id), one);
    one.dispatch({ type: "create", shapes: [rect(3, 3)] });
    await one.close();
    const again = await ws.openBoard(id);
    assert.notEqual(again, one);
    assert.equal(again.view().shapes.size, 1);
  });

  test("rejects with BoardLoadError for a board the workspace does not list", async () => {
    const { ws } = await start();
    const error = await ws.openBoard("ghost" as BoardId).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof BoardLoadError);
    assert.equal(error.boardId, "ghost");
  });

  test("rejects with BoardLoadError when storage fails, and the next try opens it", async () => {
    const inner = memoryStorage();
    let failing = false;
    const storage: DocStorage = {
      attach: (name, doc) => (failing && name.startsWith("board/") ? Promise.reject(new Error("storage down")) : inner.attach(name, doc)),
    };
    const { ws } = await start({ storage });
    const id = ws.createBoard("A");
    failing = true;
    await assert.rejects(ws.openBoard(id), BoardLoadError);
    failing = false;
    assert.equal((await ws.openBoard(id)).view().shapes.size, 0);
  });

  test("the workspace's settings reach its boards, and the meter sees the index and every board", async () => {
    const seen: string[] = [];
    const storage = memoryStorage();
    const { ws } = await start({ storage, gestureIntervalMs: Infinity, meter: (name) => seen.push(name) });
    const id = ws.createBoard("A");
    const board = await ws.openBoard(id);
    const [a] = board.dispatch({ type: "create", shapes: [rect()] }).created;
    const drag = board.beginGesture({ kind: "translate", ids: [a!] });
    for (let i = 1; i <= 30; i++) drag.update({ dx: i, dy: 0 }, i * 8);
    drag.end();
    assert.deepEqual(seen, ["workspace", `board/${id}`, `board/${id}`], "the create, then one write for the whole drag");
  });
});

describe("deleting a board", () => {
  async function withBoards(storage: DocStorage) {
    const { ws, env } = await start({ storage });
    const ids: BoardId[] = [];
    for (const title of ["keep", "doomed", "other"]) {
      ids.push(ws.createBoard(title));
      await env.advance(1);
    }
    const [keep, doomed, other] = ids as [BoardId, BoardId, BoardId];
    for (const id of ids) {
      const board = await ws.openBoard(id);
      board.dispatch({ type: "create", shapes: [rect(1, 1), rect(2, 2)] });
    }
    return { storage, ws, keep, doomed, other };
  }

  test("hides the board at once and, when it resolves, its data and its entry are gone", async () => {
    const d = disk();
    const { storage, ws, keep, doomed, other } = await withBoards(d.storage);
    const open = await ws.openBoard(doomed);
    const deleting = ws.deleteBoard(doomed);
    assert.deepEqual(titles(ws), ["keep", "other"], "hidden before anything is cleared");
    await deleting;

    assert.equal(await d.holds(`board/${doomed}`), false);
    assert.throws(() => open.dispatch({ type: "create", shapes: [rect()] }), /closed/);
    await assert.rejects(ws.openBoard(doomed), BoardLoadError);
    assert.equal((await d.holds(`board/${keep}`)) && (await d.holds(`board/${other}`)), true);
    assert.equal((await ws.openBoard(keep)).view().shapes.size, 2);

    await ws.close();
    const raw = new Y.Doc();
    await (await storage.attach("workspace", raw)).detach();
    assert.deepEqual([...raw.getMap("boards").keys()].sort(), [keep, other].sort(), "no entry is left behind");
  });

  test("deleting an unknown board, or one twice, changes nothing", async () => {
    const storage = memoryStorage();
    const { ws, doomed } = await withBoards(storage);
    const writes = storage.updates.get("workspace")!.length;
    await ws.deleteBoard("ghost" as BoardId);
    assert.equal(storage.updates.get("workspace")!.length, writes);
    await Promise.all([ws.deleteBoard(doomed), ws.deleteBoard(doomed)]);
    await ws.deleteBoard(doomed);
    assert.deepEqual(titles(ws), ["keep", "other"]);
  });

  test("a delete that cannot finish keeps the board hidden, does not stop the workspace opening, and finishes later", async () => {
    const d = disk();
    const inner = d.storage;
    let failing = true;
    const storage: DocStorage = {
      async attach(name, doc) {
        const binding = await inner.attach(name, doc);
        return { ...binding, clear: () => (failing ? Promise.reject(new Error("clear failed")) : binding.clear()) };
      },
    };
    const first = await start({ storage });
    const id = first.ws.createBoard("stuck");
    (await first.ws.openBoard(id)).dispatch({ type: "create", shapes: [rect()] });
    await assert.rejects(first.ws.deleteBoard(id), { message: "clear failed" });
    assert.deepEqual(titles(first.ws), [], "still hidden");
    await first.ws.close();

    const second = await start({ storage }, "x");
    assert.deepEqual(titles(second.ws), [], "it opened, and the board is still hidden");
    assert.equal(await d.holds(`board/${id}`), true);
    await second.ws.close();

    failing = false;
    const third = await start({ storage }, "y");
    assert.deepEqual(titles(third.ws), []);
    assert.equal(await d.holds(`board/${id}`), false, "the next open finished it");
  });
});

describe("a crash in the middle of a delete", () => {
  const ids = {} as { keep: BoardId; doomed: BoardId; other: BoardId };
  const digests = new Map<BoardId, string>();

  /** Three boards with data on a disk, flushed. The workspace is left open: it is the process that may die. */
  async function world() {
    const disk = crashDisk();
    const env = testEnv(idCounter("w"));
    const ws = await openWorkspace({ storage: disk.storage, env, autosaveMs: null });
    for (const title of ["keep", "doomed", "other"] as const) {
      ids[title] = ws.createBoard(title);
      await env.advance(1);
      const board = await ws.openBoard(ids[title]);
      board.dispatch({ type: "create", shapes: Array.from({ length: 12 }, (_, i) => rect(i, i)) });
      board.dispatch({ type: "move", ids: [...board.view().shapes.keys()].slice(0, 4), dx: 3, dy: 3 });
      digests.set(ids[title], digestOf(board));
      await board.close();
    }
    await ws.flush();
    return { disk, ws };
  }

  /** What the disk says, read without running any of the model's code on it. */
  function onDisk(disk: ReturnType<typeof crashDisk>) {
    const raw = new Y.Doc();
    (disk.stored("workspace") ?? []).forEach((update) => Y.applyUpdate(raw, update));
    const entry = raw.getMap<Y.Map<unknown>>("boards").get(ids.doomed);
    return {
      listed: entry !== undefined && entry.get("deleting") !== true,
      marked: entry !== undefined && entry.get("deleting") === true,
      absent: entry === undefined,
      data: disk.stored(`board/${ids.doomed}`) !== undefined,
    };
  }

  test("is finished by the next open, and at no point is a listed board empty or its data left without a listing", async () => {
    const full = await world();
    full.disk.dieAfter(Infinity);
    await full.ws.deleteBoard(ids.doomed);
    const operations = full.disk.operations;
    assert.ok(operations >= 5, `a delete takes ${operations} storage operations`);

    const outcomes: string[] = [];
    for (let crashAfter = 0; crashAfter <= operations; crashAfter++) {
      const { disk, ws } = await world();
      disk.dieAfter(crashAfter);
      await ws.deleteBoard(ids.doomed).then(
        () => assert.equal(crashAfter, operations, "only the complete delete completes"),
        (error: Error) => assert.equal(error.message, "the process died"),
      );

      const at = onDisk(disk);
      const label = `crash after operation ${crashAfter}`;
      assert.ok(!at.listed || at.data, `${label}: the board is listed on disk with no data`);
      assert.ok(!at.absent || !at.data, `${label}: data is on disk with no entry to collect it`);

      disk.restart();
      const env = testEnv(idCounter("r"));
      const reopened = await openWorkspace({ storage: disk.storage, env, autosaveMs: null });
      live.push(reopened);
      const listed = reopened.boards().some((b) => b.id === ids.doomed);
      const after = onDisk(disk);
      if (listed) {
        assert.ok(after.listed && after.data, `${label}: listed, so its data must be there`);
        assert.equal(digestOf(await reopened.openBoard(ids.doomed)), digests.get(ids.doomed), `${label}: the data is intact`);
      } else {
        assert.ok(after.absent && !after.data, `${label}: gone means the entry and the data are both gone`);
      }
      for (const kept of [ids.keep, ids.other]) {
        assert.equal(digestOf(await reopened.openBoard(kept)), digests.get(kept), `${label}: the other boards are untouched`);
      }
      outcomes.push(listed ? "listed" : "gone");
    }
    const firstGone = outcomes.indexOf("gone");
    assert.ok(firstGone > 0, `a crash before the mark is stored leaves the board as it was: ${outcomes}`);
    assert.ok(outcomes.slice(firstGone).every((o) => o === "gone"), `once the mark is stored the delete is only ever finished: ${outcomes}`);
    assert.equal(outcomes.at(-1), "gone");
  });
});

describe("the save state of the board list", () => {
  test("goes saving, error, saved like a board's, and a change in it does not change the list", async () => {
    const { storage, control } = flakyStorage();
    const env = testEnv(idCounter("w"));
    const ws = await openWorkspace({ storage, env });
    live.push(ws);
    const kinds = [ws.save().kind];
    ws.subscribe(() => ws.save().kind === kinds.at(-1) || kinds.push(ws.save().kind));
    control.failing = true;
    ws.createBoard("A");
    const list = ws.boards();
    await env.advance(400);
    assert.equal(ws.save().kind, "error");
    control.failing = false;
    await env.advance(400);
    assert.equal(ws.save().kind, "saved");
    assert.deepEqual(kinds, ["saved", "saving", "error", "saved"]);
    assert.equal(ws.boards(), list);
  });
});

describe("two workspaces over BroadcastChannel", () => {
  const relay = broadcastSync(BroadcastChannel);

  async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let turns = 0; turns < 5000; turns++) {
      if (await done()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail(`never happened: ${what}`);
  }

  const tab = (name: string, storage: DocStorage = disk().storage) => start({ storage, sync: relay, gestureIntervalMs: 0 }, name);

  class Oracle {
    readonly shapes = new Map<ShapeId, Shape>();
    apply(applied: Applied): Applied {
      applyPatchPlain(this.shapes, applied.patch);
      return applied;
    }
    get digest(): string {
      return digestShapes(this.shapes);
    }
  }

  test("converge on the board list and on the oracle's digest, and a late workspace gets the diff", async () => {
    const a = await tab("a");
    const b = await tab("b");
    const oracle = new Oracle();

    const plan = a.ws.createBoard("Plan");
    await until(() => titles(b.ws).length === 1, "b lists the board a created");
    b.ws.renameBoard(plan, "Roadmap");
    const mine = await a.ws.openBoard(plan);
    const theirs = await b.ws.openBoard(plan);

    const made = oracle.apply(mine.dispatch({ type: "create", shapes: [rect(0, 0), rect(50, 0), rect(100, 0)] })).created;
    oracle.apply(theirs.dispatch({ type: "create", shapes: [rect(0, 50)] }));
    await until(() => digestOf(theirs) === digestOf(mine) && theirs.view().shapes.size === 4, "b has a's shapes and a has b's");
    const drag = theirs.beginGesture({ kind: "translate", ids: [made[0]!, made[1]!] });
    for (let i = 1; i <= 25; i++) drag.update({ dx: i * 2, dy: -i }, i * 8);
    oracle.apply(drag.end());
    oracle.apply(mine.dispatch({ type: "remove", ids: [made[2]!] }));
    await until(() => digestOf(mine) === oracle.digest && digestOf(theirs) === oracle.digest, "both boards reach the oracle");
    await until(() => titles(a.ws)[0] === "Roadmap", "a sees the new title");

    const late = await tab("c");
    assert.deepEqual(titles(late.ws), [], "it opened with nothing");
    await until(() => titles(late.ws).length === 1, "the late workspace is sent the board list");
    assert.deepEqual(titles(late.ws), ["Roadmap"]);
    const caught = await late.ws.openBoard(plan);
    await until(() => digestOf(caught) === oracle.digest, "the late board is sent the diff");
    assert.equal(caught.view().shapes.size, 3);
  });

  test("a delete reaches the other tab: it closes its copy, clears its own storage and stops listing the board", async () => {
    const [aDisk, bDisk] = [disk(), disk()];
    const a = await tab("a", aDisk.storage);
    const b = await tab("b", bDisk.storage);
    const id = a.ws.createBoard("Doomed");
    await until(() => titles(b.ws).length === 1, "b lists it");
    const mine = await a.ws.openBoard(id);
    const theirs = await b.ws.openBoard(id);
    mine.dispatch({ type: "create", shapes: [rect(), rect(9, 9)] });
    await until(() => theirs.view().shapes.size === 2, "b has the shapes");
    await theirs.flush();
    assert.equal(await bDisk.holds(`board/${id}`), true);

    await a.ws.deleteBoard(id);
    await until(() => titles(b.ws).length === 0, "b stops listing it");
    await until(async () => !(await bDisk.holds(`board/${id}`)), "b clears what it had stored");
    assert.equal(await aDisk.holds(`board/${id}`), false);
    assert.throws(() => theirs.dispatch({ type: "create", shapes: [rect()] }), /closed/);
    await assert.rejects(b.ws.openBoard(id), BoardLoadError);
  });

  test("two workspaces on one storage, as two tabs of one origin are, also converge", async () => {
    const storage = disk().storage;
    const a = await tab("a", storage);
    const b = await tab("b", storage);
    const id = a.ws.createBoard("Shared");
    await until(() => titles(b.ws).length === 1, "b lists it");
    const [mine, theirs] = [await a.ws.openBoard(id), await b.ws.openBoard(id)];
    const oracle = new Oracle();
    oracle.apply(mine.dispatch({ type: "create", shapes: [rect(1, 1)] }));
    oracle.apply(theirs.dispatch({ type: "create", shapes: [rect(2, 2)] }));
    await until(() => digestOf(mine) === oracle.digest && digestOf(theirs) === oracle.digest, "both reach the oracle");
    await mine.flush();
    await theirs.flush();
    await a.ws.close();
    await b.ws.close();
    const again = await start({ storage }, "z");
    assert.equal(digestOf(await again.ws.openBoard(id)), oracle.digest, "the doubled stored updates load to the same board");
  });
});
