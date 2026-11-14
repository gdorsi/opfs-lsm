import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import { BoardLoadError, openBoard } from "../src/model/board.ts";
import { boardId } from "../src/model/shapes.ts";
import type { Board, DocStorage, NewShape, ShapeId } from "../src/model/types.ts";
import { memoryStorage } from "../src/persistence/index.ts";
import { idCounter, testEnv } from "./support/env.ts";
import { sortedIds } from "./support/scenes.ts";
import { disk } from "./support/disk.ts";
import { link, spyStorage } from "./support/storage.ts";

const id = boardId("b");
const DOC = "board/b";
const rect = (x = 0, y = 0): NewShape => ({ kind: "rect", x, y, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 });
const envOf = (prefix: string) => testEnv(idCounter(prefix));
const open = (storage: DocStorage = disk().storage, prefix = "s") => openBoard({ id, storage, env: envOf(prefix) });
const create = (board: Board, ...shapes: NewShape[]) => board.dispatch({ type: "create", shapes }).created;
const at = (board: Board, shape: ShapeId) => board.view().shapes.get(shape)!;

describe("dispatch", () => {
  test("shows the result in the view and stores it for the next open", async () => {
    const storage = disk().storage;
    const board = await open(storage);
    const [a, b] = create(board, rect(1, 2), rect(3, 4));
    board.dispatch({ type: "move", ids: [a!], dx: 10, dy: 10 });
    assert.deepEqual(board.view().order, [a, b]);
    assert.equal(at(board, a!).x, 11);
    await board.close();

    const again = await open(storage, "t");
    assert.deepEqual(again.view().order, [a, b]);
    assert.deepEqual([at(again, a!).x, at(again, a!).y, at(again, b!).x], [11, 12, 3]);
  });

  test("returns the patch and the ids it created", async () => {
    const board = await open();
    const { patch, created } = board.dispatch({ type: "create", shapes: [rect(), rect()] });
    assert.deepEqual(created, ["s1", "s2"]);
    assert.deepEqual([...patch.keys()], created);
    assert.deepEqual(board.dispatch({ type: "move", ids: created, dx: 1, dy: 0 }).created, []);
  });

  test("is one stored update, whatever the number of shapes", async () => {
    const storage = memoryStorage();
    const board = await open(storage);
    const ids = create(board, ...Array.from({ length: 50 }, (_, i) => rect(i)));
    const stored = () => storage.updates.get(DOC)!.length;
    assert.equal(stored(), 1);
    board.dispatch({ type: "move", ids, dx: 5, dy: 5 });
    board.dispatch({ type: "remove", ids: ids.slice(0, 10) });
    assert.equal(stored(), 3);
  });

  test("writes nothing, notifies no one and leaves the undo history alone when the command changes nothing", async () => {
    const storage = memoryStorage();
    const board = await open(storage);
    const [a] = create(board, rect());
    create(board, rect());
    board.undo();
    let calls = 0;
    board.subscribe(() => calls++);
    const stored = storage.updates.get(DOC)!.length;
    const before = board.view();
    board.dispatch({ type: "move", ids: [a!], dx: 0, dy: 0 });
    board.dispatch({ type: "remove", ids: [] });
    assert.equal(storage.updates.get(DOC)!.length, stored);
    assert.equal(calls, 0);
    assert.equal(board.view(), before);
    assert.equal(board.view().canRedo, true);
    assert.equal(board.undo(), true);
    assert.equal(board.undo(), false);
  });

  test("skips ids the board does not have", async () => {
    const board = await open();
    const [a] = create(board, rect());
    board.dispatch({ type: "move", ids: [a!, "ghost" as ShapeId], dx: 1, dy: 0 });
    assert.deepEqual([...board.view().shapes.keys()], [a]);
    assert.equal(at(board, a!).x, 1);
  });

  test("a closed board refuses writes instead of dropping them", async () => {
    const board = await open();
    await board.close();
    await board.close();
    assert.throws(() => board.dispatch({ type: "create", shapes: [rect()] }), Error);
    assert.throws(() => board.undo(), Error);
  });
});

describe("view", () => {
  test("notifies once per command, once per undo, and stops after unsubscribe", async () => {
    const board = await open();
    let calls = 0;
    const stop = board.subscribe(() => calls++);
    const ids = create(board, rect(), rect(), rect());
    assert.equal(calls, 1);
    board.dispatch({ type: "move", ids, dx: 1, dy: 1 });
    assert.equal(calls, 2);
    board.undo();
    board.redo();
    assert.equal(calls, 4);
    stop();
    board.dispatch({ type: "remove", ids });
    assert.equal(calls, 4);
  });

  test("is the same object until something changes", async () => {
    const board = await open();
    const [a] = create(board, rect());
    const first = board.view();
    assert.equal(board.view(), first);
    board.dispatch({ type: "move", ids: [a!], dx: 1, dy: 0 });
    assert.notEqual(board.view(), first);
    assert.equal(first.canUndo, true);
  });

  test("keeps the order array through a move and replaces it for a create, a delete or a reorder", async () => {
    const board = await open();
    const ids = create(board, rect(), rect(), rect());
    const order = board.view().order;
    board.dispatch({ type: "move", ids, dx: 1, dy: 1 });
    board.dispatch({ type: "style", ids, edit: { stroke: "#f00" } });
    assert.equal(board.view().order, order);
    board.dispatch({ type: "reorder", ids: [ids[0]!], to: "front" });
    assert.notEqual(board.view().order, order);
    assert.deepEqual(board.view().order, [ids[1], ids[2], ids[0]]);
    const reordered = board.view().order;
    create(board, rect());
    assert.notEqual(board.view().order, reordered);
    board.dispatch({ type: "remove", ids: [ids[1]!] });
    assert.deepEqual(board.view().order, [ids[2], ids[0], "s4"]);
  });

  test("selection holds only shapes that exist and does not notify when it does not change", async () => {
    const board = await open();
    const [a, b] = create(board, rect(), rect());
    let calls = 0;
    board.subscribe(() => calls++);
    board.select([a!, "ghost" as ShapeId]);
    assert.deepEqual([...board.view().selection], [a]);
    board.select([a!]);
    assert.equal(calls, 1);
    board.select([a!, b!]);
    board.dispatch({ type: "remove", ids: [a!] });
    assert.deepEqual([...board.view().selection], [b]);
    board.undo();
    assert.deepEqual([...board.view().selection], [b]);
    board.select([]);
    assert.equal(board.view().selection.size, 0);
  });

  test("keeps the viewport and tells subscribers when it moves", async () => {
    const board = await open();
    assert.deepEqual(board.view().viewport, { x: 0, y: 0, zoom: 1 });
    let calls = 0;
    board.subscribe(() => calls++);
    board.setViewport({ x: 5, y: 6, zoom: 2 });
    board.setViewport({ x: 5, y: 6, zoom: 2 });
    assert.equal(calls, 1);
    assert.deepEqual(board.view().viewport, { x: 5, y: 6, zoom: 2 });
  });
});

describe("undo", () => {
  test("is one step per command, whatever it touched", async () => {
    const board = await open();
    const ids = create(board, rect(), rect(), rect());
    board.dispatch({ type: "move", ids, dx: 10, dy: 10 });
    board.dispatch({ type: "style", ids, edit: { stroke: "#f00" } });
    assert.equal(board.undo(), true);
    assert.deepEqual([at(board, ids[0]!).x, at(board, ids[2]!).stroke], [10, "#000"]);
    assert.equal(board.undo(), true);
    assert.deepEqual([at(board, ids[0]!).x, at(board, ids[1]!).x], [0, 0]);
    assert.equal(board.undo(), true);
    assert.equal(board.view().shapes.size, 0);
    assert.equal(board.undo(), false);
    assert.equal(board.view().canUndo, false);
  });

  test("brings a deleted shape back with all its fields", async () => {
    const board = await open();
    const [pen, text] = create(
      board,
      { kind: "pen", x: 1, y: 2, w: 3, h: 4, points: [0, 0, 100, 200], stroke: "#111", fill: null, strokeWidth: 1 },
      { kind: "text", x: 5, y: 6, w: 7, h: 8, text: "héllo", fontSize: 18, stroke: "#222", fill: "#eee", strokeWidth: 0.5 },
    );
    const before = structuredClone([at(board, pen!), at(board, text!)]);
    board.dispatch({ type: "remove", ids: [pen!, text!] });
    assert.equal(board.view().shapes.size, 0);
    board.undo();
    assert.deepEqual([at(board, pen!), at(board, text!)], before);
    assert.deepEqual(board.view().order, [pen, text]);
  });

  test("redoes what it undid, and a new command ends the redo history", async () => {
    const board = await open();
    const [a] = create(board, rect());
    board.dispatch({ type: "move", ids: [a!], dx: 7, dy: 0 });
    board.undo();
    assert.equal(board.view().canRedo, true);
    assert.equal(board.redo(), true);
    assert.equal(at(board, a!).x, 7);
    board.undo();
    board.dispatch({ type: "move", ids: [a!], dx: 1, dy: 0 });
    assert.equal(board.view().canRedo, false);
    assert.equal(board.redo(), false);
    assert.equal(at(board, a!).x, 1);
  });

  test("keeps the last 100 steps", async () => {
    const board = await open();
    const [a] = create(board, rect());
    for (let i = 0; i < 150; i++) board.dispatch({ type: "move", ids: [a!], dx: 1, dy: 0 });
    let undone = 0;
    while (board.undo()) undone++;
    assert.equal(undone, 100);
    assert.equal(at(board, a!).x, 50);
    while (board.redo());
    assert.equal(at(board, a!).x, 150);
  });

  test("is stored: a reopened board shows the undone state", async () => {
    const storage = disk().storage;
    const board = await open(storage);
    const [a] = create(board, rect());
    board.dispatch({ type: "move", ids: [a!], dx: 9, dy: 0 });
    board.undo();
    await board.close();
    assert.equal(at(await open(storage, "t"), a!).x, 0);
  });
});

describe("two tabs", () => {
  async function pair() {
    const [one, two] = [spyStorage(), spyStorage()];
    const a = await open(one.storage, "a");
    const b = await open(two.storage, "b");
    return { a, b, link: () => link(one.docs.get(DOC)!, two.docs.get(DOC)!) };
  }

  test("each tab sees the other's commands and undo reverts only its own", async () => {
    const { a, b, link } = await pair();
    link();
    const [shape] = create(a, rect());
    assert.deepEqual(b.view().order, [shape]);
    a.dispatch({ type: "move", ids: [shape!], dx: 5, dy: 0 });
    b.dispatch({ type: "style", ids: [shape!], edit: { fill: "#f00" } });
    const [theirs] = create(b, rect(50, 50));
    assert.deepEqual([at(a, shape!).x, at(a, shape!).fill], [5, "#f00"]);

    a.undo();
    assert.deepEqual([at(a, shape!).x, at(a, shape!).fill], [0, "#f00"]);
    assert.deepEqual([at(b, shape!).x, at(b, shape!).fill], [0, "#f00"]);
    a.undo();
    assert.deepEqual([...a.view().order], [theirs]);
    assert.deepEqual([...b.view().order], [theirs]);
    assert.equal(a.undo(), false);
  });

  test("undo reports false for a step the other tab already made moot", async () => {
    const { a, b, link } = await pair();
    link();
    create(b, rect(50, 50));
    const mine = create(a, rect());
    b.dispatch({ type: "remove", ids: mine });
    assert.equal(a.view().canUndo, true);
    assert.equal(a.undo(), false);
    assert.equal(a.view().canUndo, false);
    assert.equal(a.view().order.length, 1);
  });

  test("a shape the other tab deleted leaves the view and the selection", async () => {
    const { a, b, link } = await pair();
    link();
    const [shape, other] = create(a, rect(), rect());
    a.select([shape!, other!]);
    b.dispatch({ type: "remove", ids: [shape!] });
    assert.deepEqual([...a.view().order], [other]);
    assert.deepEqual([...a.view().selection], [other]);
  });

  test("shapes created at the same z in both tabs are ordered by id in both", async () => {
    const { a, b, link } = await pair();
    const [fromA] = create(a, rect());
    const [fromB] = create(b, rect());
    assert.equal(a.view().shapes.get(fromA!)!.z, b.view().shapes.get(fromB!)!.z);
    link();
    assert.deepEqual(a.view().order, [fromA, fromB]);
    assert.deepEqual(b.view().order, [fromA, fromB]);
    assert.deepEqual(a.view().order, sortedIds(a.view().shapes.values()));
  });
});

describe("stored records the model cannot read", () => {
  async function storageWithJunk() {
    const storage = disk().storage;
    const raw = new Y.Doc();
    const binding = await storage.attach(DOC, raw);
    raw.getMap<Y.Map<unknown>>("shapes").set("junk", new Y.Map([["kind", "blob"]]));
    raw.getMap("shapes").set("number", 7);
    await binding.detach();
    return storage;
  }

  test("are left out of the view and counted", async () => {
    const storage = await storageWithJunk();
    const board = await open(storage);
    assert.equal(board.view().skipped, 2);
    assert.equal(board.view().shapes.size, 0);
    const [a] = create(board, rect());
    assert.deepEqual([...board.view().order], [a]);
    assert.equal(board.view().skipped, 2);
  });

  test("are counted when they arrive from another tab, and uncounted when they go", async () => {
    const { storage, docs } = spyStorage();
    const board = await open(storage);
    const shapes = docs.get(DOC)!.getMap<Y.Map<unknown>>("shapes");
    docs.get(DOC)!.transact(() => shapes.set("junk", new Y.Map([["kind", "blob"]])), "peer");
    assert.equal(board.view().skipped, 1);
    assert.equal(board.view().shapes.size, 0);
    docs.get(DOC)!.transact(() => shapes.delete("junk"), "peer");
    assert.equal(board.view().skipped, 0);
  });

  test("do not hide the shapes next to them after a reopen", async () => {
    const storage = await storageWithJunk();
    const board = await open(storage);
    const [a] = create(board, rect(4, 4));
    await board.close();
    const again = await open(storage, "t");
    assert.equal(at(again, a!).x, 4);
    assert.equal(again.view().skipped, 2);
  });
});

describe("opening", () => {
  test("rejects with BoardLoadError and the storage's error as the cause", async () => {
    const failure = new Error("disk gone");
    const storage: DocStorage = { attach: () => Promise.reject(failure) };
    const error = await open(storage).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof BoardLoadError);
    assert.equal(error.boardId, id);
    assert.equal(error.cause, failure);
  });

  test("flush resolves once storage has everything, and rejects with its error", async () => {
    const failure = new Error("quota");
    const inner = memoryStorage();
    let failing = false;
    const storage: DocStorage = {
      async attach(name, doc) {
        const binding = await inner.attach(name, doc);
        return { ...binding, flush: () => (failing ? Promise.reject(failure) : binding.flush()) };
      },
    };
    const board = await open(storage);
    create(board, rect());
    await board.flush();
    failing = true;
    await assert.rejects(board.flush(), failure);
  });
});
