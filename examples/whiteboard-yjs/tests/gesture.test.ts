import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openBoard } from "../src/model/board.ts";
import { applyPatchPlain, digestShapes } from "../src/model/digest.ts";
import { plan } from "../src/model/plan.ts";
import { boardId, penShape } from "../src/model/shapes.ts";
import type { Board, BoardOptions, Box, DocStorage, NewShape, Point, Shape, ShapeId, Style } from "../src/model/types.ts";
import { memoryStorage } from "../src/persistence/index.ts";
import { idCounter, testEnv } from "./support/env.ts";
import { seeded } from "./support/rng.ts";
import { disk } from "./support/disk.ts";
import { link, spyStorage } from "./support/storage.ts";

const id = boardId("g");
const DOC = "board/g";
const STYLE: Style = { stroke: "#123", fill: null, strokeWidth: 3 };
const rect = (x = 0, y = 0, w = 10, h = 10): NewShape => ({ kind: "rect", x, y, w, h, stroke: "#000", fill: null, strokeWidth: 2 });

const open = (storage: DocStorage = disk().storage, over: Partial<BoardOptions> = {}) =>
  openBoard({ id, storage, env: testEnv(idCounter("s")), autosaveMs: null, ...over });
const create = (board: Board, ...shapes: NewShape[]) => board.dispatch({ type: "create", shapes }).created;
const at = (board: Board, shape: ShapeId) => board.view().shapes.get(shape)!;
const stored = (storage: ReturnType<typeof memoryStorage>) => storage.updates.get(DOC)!.length;
const digestOf = (board: Board) => digestShapes(board.view().shapes);
const reopen = async (storage: DocStorage) => digestOf(await open(storage));

const STEP = 1000 / 120;

describe("how often a drag writes", () => {
  /** 120 events over one second at 120 Hz, the pointer 1 px further each time, then pointer up. */
  async function dragOneSecond(interval: number) {
    const storage = memoryStorage();
    const meter: string[] = [];
    const board = await open(storage, { gestureIntervalMs: interval, meter: (name) => meter.push(name) });
    const made = board.dispatch({ type: "create", shapes: [rect(5, 5), rect(50, 50)] });
    const [a] = made.created;
    const before = stored(storage);
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    for (let i = 1; i <= 120; i++) gesture.update({ dx: i, dy: 0 }, i * STEP);
    const applied = gesture.end();
    return { storage, board, a: a!, made, applied, writes: stored(storage) - before, meter };
  }

  const expected = [
    // Every event is a write.
    { interval: 0, writes: 120 },
    // The first event writes at t = 8.3 ms. Each later write waits for 32 ms to pass, which takes 4 events (33.3 ms),
    // so events 5, 9, ..., 117 write: 30 writes in all. Event 120 came after the last of them, so pointer up writes it.
    { interval: 32, writes: 31 },
    // Nothing is written until pointer up.
    { interval: Infinity, writes: 1 },
  ];

  for (const { interval, writes } of expected) {
    test(`interval ${interval}: ${writes} ${writes === 1 ? "update reaches" : "updates reach"} storage, and the final state is the same`, async () => {
      const run = await dragOneSecond(interval);
      assert.equal(run.writes, writes);
      assert.equal(run.meter.length, writes + 1, "the meter saw every update, and the create");
      assert.equal(run.meter.at(-1), DOC);

      assert.equal(at(run.board, run.a).x, 125);
      assert.deepEqual(
        [...run.applied.patch],
        [[run.a, { op: "set", edit: { x: 125 } }]],
        "the patch is the whole gesture, however many writes it took",
      );
      const oracle = new Map<ShapeId, Shape>();
      applyPatchPlain(oracle, run.made.patch);
      applyPatchPlain(oracle, run.applied.patch);
      assert.equal(digestShapes(oracle), digestOf(run.board));
      await run.board.close();
      assert.equal(await reopen(run.storage), digestShapes(oracle), "storage holds the same final state");
    });
  }

  test("what is not written yet is still painted: the view follows every event", async () => {
    const storage = memoryStorage();
    const board = await open(storage, { gestureIntervalMs: Infinity });
    const [a] = create(board, rect(5, 5));
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    let notified = 0;
    board.subscribe(() => notified++);
    for (let i = 1; i <= 50; i++) {
      gesture.update({ dx: i, dy: 2 * i }, i * STEP);
      assert.deepEqual([at(board, a!).x, at(board, a!).y], [5 + i, 5 + 2 * i]);
    }
    assert.equal(notified, 50, "one notification per event");
    assert.equal(stored(storage), 1, "the doc has only the create");
  });

  test("coalescing loses nothing: any interval ends where the pointer ended", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rng = seeded(seed);
      const events: { dx: number; dy: number; t: number }[] = [];
      let t = 0;
      for (let i = 0; i < 80; i++) {
        t += 1 + Math.floor(rng() * 20);
        events.push({ dx: (rng() - 0.5) * 300, dy: (rng() - 0.5) * 300, t });
      }
      const digests = new Set<string>();
      for (const interval of [0, 1, 32, 100, Infinity]) {
        const storage = disk().storage;
        const board = await open(storage, { gestureIntervalMs: interval });
        const ids = create(board, rect(0.1, 0.2), rect(7.3, 9.9), rect(-40.7, 3.3));
        const gesture = board.beginGesture({ kind: "translate", ids });
        for (const e of events) gesture.update(e, e.t);
        gesture.end();
        await board.close();
        digests.add(await reopen(storage));
      }
      assert.equal(digests.size, 1, `seed ${seed}: the intervals agree`);
    }
  });
});

describe("resize", () => {
  const from: Box = { x: 0, y: 0, w: 100, h: 100 };

  test("maps the box onto the pointer's box at every write and ends exactly on it", async () => {
    const storage = disk().storage;
    const board = await open(storage, { gestureIntervalMs: 0 });
    const [a, b] = create(board, rect(0, 0, 50, 50), rect(50, 50, 50, 50));
    const gesture = board.beginGesture({ kind: "resize", ids: [a!, b!], from });
    gesture.update({ to: { x: 0, y: 0, w: 150, h: 100 } }, 0);
    assert.deepEqual([at(board, b!).x, at(board, b!).w], [75, 75]);
    gesture.update({ to: { x: 10, y: 20, w: 200, h: 300 } }, 8);
    const applied = gesture.end();
    assert.deepEqual([at(board, a!).x, at(board, a!).y, at(board, a!).w, at(board, a!).h], [10, 20, 100, 150]);
    assert.deepEqual([at(board, b!).x, at(board, b!).y, at(board, b!).w, at(board, b!).h], [110, 170, 100, 150]);
    assert.equal(applied.patch.size, 2);
    await board.close();
    assert.equal(await reopen(storage), digestShapes(new Map([[a!, at(board, a!)], [b!, at(board, b!)]])));
  });

  test("the pointer coming back to the start box restores the shapes", async () => {
    const board = await open(disk().storage, { gestureIntervalMs: 0 });
    const [a] = create(board, rect(10, 10, 40, 40));
    const before = digestOf(board);
    const gesture = board.beginGesture({ kind: "resize", ids: [a!], from });
    gesture.update({ to: { x: 0, y: 0, w: 300, h: 300 } }, 0);
    gesture.update({ to: from }, 8);
    assert.equal(digestOf(board), before);
    assert.equal(gesture.end().patch.size, 0);
  });
});

describe("draw", () => {
  const points: Point[] = Array.from({ length: 40 }, (_, i) => ({ x: 20 + i * 3, y: 30 + Math.sin(i / 3) * 25 }));

  test("writes once, at pen up, and the view shows the stroke growing before that", async () => {
    const storage = memoryStorage();
    const board = await open(storage, { gestureIntervalMs: 0 });
    const [below] = create(board, rect());
    const before = stored(storage);
    const gesture = board.beginGesture({ kind: "draw", style: STYLE });
    assert.equal(board.view().shapes.size, 1, "nothing is drawn before the first point");
    points.forEach((p, i) => {
      gesture.update(p, i * STEP);
      assert.equal(board.view().shapes.size, 2);
      const draft = board.view().shapes.get(board.view().order[1]!)!;
      assert.equal(draft.kind === "pen" && draft.points.length, 2 * (i + 1));
    });
    assert.equal(stored(storage), before, "storage saw nothing while the pen was down");

    const { patch, created } = gesture.end();
    assert.equal(stored(storage) - before, 1, "one put for the whole stroke");
    assert.equal(created.length, 1);
    assert.deepEqual([...patch.keys()], created);
    assert.deepEqual(board.view().order, [below, created[0]], "the stroke is in front");

    const expected = { ...penShape(points, STYLE), id: created[0]!, z: at(board, created[0]!).z };
    assert.deepEqual(at(board, created[0]!), expected);
    await board.close();
    const again = await open(storage);
    assert.deepEqual(again.view().shapes.get(created[0]!), expected);
  });

  test("a stroke of one point is a dot, and a gesture with no point leaves nothing", async () => {
    const storage = memoryStorage();
    const board = await open(storage);
    const empty = board.beginGesture({ kind: "draw", style: STYLE });
    assert.equal(empty.end().patch.size, 0);
    assert.equal(stored(storage), 0);
    const dot = board.beginGesture({ kind: "draw", style: STYLE });
    dot.update({ x: 4, y: 5 }, 0);
    const { created } = dot.end();
    assert.deepEqual([at(board, created[0]!).w, at(board, created[0]!).h], [0, 0]);
    assert.equal(board.view().canUndo, true);
    board.undo();
    assert.equal(board.view().shapes.size, 0);
  });

});

describe("cancel", () => {
  test("puts a drag back, in the view and in storage, and leaves no undo step", async () => {
    const storage = disk().storage;
    const board = await open(storage, { gestureIntervalMs: 0 });
    const ids = create(board, rect(1, 1), rect(2, 2), rect(3, 3));
    board.dispatch({ type: "style", ids, edit: { stroke: "#f00" } });
    const before = digestOf(board);
    const gesture = board.beginGesture({ kind: "translate", ids });
    for (let i = 1; i <= 30; i++) gesture.update({ dx: i * 3, dy: -i }, i * STEP);
    assert.notEqual(digestOf(board), before);
    gesture.cancel();
    assert.equal(digestOf(board), before);
    await board.flush();
    assert.equal(await reopen(storage), before, "storage holds the state from before the gesture");

    assert.equal(board.undo(), true);
    assert.equal(at(board, ids[0]!).stroke, "#000", "the next undo is the style command, not the gesture");
    assert.equal(board.undo(), true);
    assert.equal(board.view().shapes.size, 0);
  });

  test("puts back a drag that had not written yet", async () => {
    const storage = memoryStorage();
    const board = await open(storage, { gestureIntervalMs: Infinity });
    const [a] = create(board, rect(1, 1));
    const before = digestOf(board);
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    gesture.update({ dx: 50, dy: 50 }, 0);
    gesture.cancel();
    assert.equal(digestOf(board), before);
    assert.equal(stored(storage), 1);
  });

  test("removes a stroke that was never stored", async () => {
    const storage = memoryStorage();
    const board = await open(storage);
    const [a] = create(board, rect());
    board.select([a!]);
    const gesture = board.beginGesture({ kind: "draw", style: STYLE });
    gesture.update({ x: 1, y: 1 }, 0);
    gesture.update({ x: 9, y: 9 }, 8);
    gesture.cancel();
    assert.deepEqual([...board.view().order], [a]);
    assert.equal(stored(storage), 1);
    assert.deepEqual([...board.view().selection], [a]);
  });

  test("ends the redo history, like any edit", async () => {
    const board = await open(disk().storage, { gestureIntervalMs: 0 });
    const [a] = create(board, rect());
    board.dispatch({ type: "move", ids: [a!], dx: 5, dy: 0 });
    board.undo();
    assert.equal(board.view().canRedo, true);
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    gesture.update({ dx: 9, dy: 9 }, 0);
    gesture.cancel();
    assert.equal(board.view().canRedo, false);
    assert.equal(at(board, a!).x, 0);
  });
});

describe("undo", () => {
  test("one gesture is one undo step, however many writes it took", async () => {
    const storage = memoryStorage();
    const board = await open(storage, { gestureIntervalMs: 0 });
    const [a] = create(board, rect());
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    for (let i = 1; i <= 60; i++) gesture.update({ dx: i, dy: 0 }, i * STEP);
    gesture.end();
    assert.equal(stored(storage), 61);
    assert.equal(at(board, a!).x, 60);

    assert.equal(board.undo(), true);
    assert.equal(at(board, a!).x, 0, "one undo returns to where the drag began");
    assert.equal(board.redo(), true);
    assert.equal(at(board, a!).x, 60, "and one redo to where it ended");
    board.undo();
    assert.equal(board.undo(), true);
    assert.equal(board.view().shapes.size, 0, "the step before the gesture is the create");
    assert.equal(board.undo(), false);
  });

  test("a stroke is one undo step", async () => {
    const board = await open(disk().storage);
    const gesture = board.beginGesture({ kind: "draw", style: STYLE });
    for (let i = 0; i < 20; i++) gesture.update({ x: i, y: i * 2 }, i * STEP);
    gesture.end();
    assert.equal(board.view().shapes.size, 1);
    assert.equal(board.undo(), true);
    assert.equal(board.view().shapes.size, 0);
    assert.equal(board.undo(), false);
  });

  test("a gesture that came back to its start leaves no step and no change in storage", async () => {
    const storage = disk().storage;
    const board = await open(storage, { gestureIntervalMs: 0 });
    const [a] = create(board, rect(4, 4));
    const before = digestOf(board);
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    gesture.update({ dx: 40, dy: 40 }, 0);
    gesture.update({ dx: 0, dy: 0 }, 8);
    assert.equal(gesture.end().patch.size, 0);
    assert.equal(digestOf(board), before);
    assert.equal(board.undo(), true);
    assert.equal(board.view().shapes.size, 0, "the only step is the create");
    await board.flush();
    assert.equal(await reopen(storage), digestShapes(new Map()), "storage matches the undone board");
  });

  test("a gesture that never moved writes nothing and opens no step", async () => {
    const storage = memoryStorage();
    const board = await open(storage);
    const [a] = create(board, rect());
    board.dispatch({ type: "move", ids: [a!], dx: 5, dy: 0 });
    board.undo();
    const before = stored(storage);
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    assert.equal(gesture.end().patch.size, 0);
    assert.equal(stored(storage), before);
    assert.equal(board.view().canRedo, true, "the redo history survives a click");
  });
});

describe("one gesture at a time", () => {
  test("commands, undo and a second gesture are refused until it ends", async () => {
    const board = await open();
    const [a] = create(board, rect());
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    assert.throws(() => board.dispatch({ type: "remove", ids: [a!] }), /gesture in progress/);
    assert.throws(() => board.undo(), /gesture in progress/);
    assert.throws(() => board.redo(), /gesture in progress/);
    assert.throws(() => board.beginGesture({ kind: "draw", style: STYLE }), /gesture in progress/);
    board.select([a!]);
    board.setViewport({ x: 1, y: 1, zoom: 2 });
    gesture.end();
    board.dispatch({ type: "remove", ids: [a!] });
  });

  test("a finished or cancelled gesture refuses more", async () => {
    const board = await open();
    const [a] = create(board, rect());
    const ended = board.beginGesture({ kind: "translate", ids: [a!] });
    ended.end();
    assert.throws(() => ended.update({ dx: 1, dy: 1 }, 0), /over/);
    assert.throws(() => ended.end(), /over/);
    assert.throws(() => ended.cancel(), /over/);
    const cancelled = board.beginGesture({ kind: "translate", ids: [a!] });
    cancelled.cancel();
    assert.throws(() => cancelled.update({ dx: 1, dy: 1 }, 0), /over/);
  });

  test("closing the board in the middle of a drag stores the state from before it", async () => {
    const storage = disk().storage;
    const board = await open(storage, { gestureIntervalMs: 0 });
    const [a] = create(board, rect(2, 2));
    const before = digestOf(board);
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    for (let i = 1; i <= 10; i++) gesture.update({ dx: i, dy: i }, i * STEP);
    await board.close();
    assert.throws(() => gesture.update({ dx: 1, dy: 1 }, 0), /over/);
    assert.equal(await reopen(storage), before);
  });
});

describe("another tab changes the board under a gesture", () => {
  async function pair(gestureIntervalMs: number) {
    const [one, two] = [spyStorage(), spyStorage()];
    const mine = await open(one.storage, { env: testEnv(idCounter("a")), gestureIntervalMs });
    const theirs = await open(two.storage, { env: testEnv(idCounter("b")) });
    link(one.docs.get(DOC)!, two.docs.get(DOC)!);
    return { mine, theirs };
  }

  test("a shape deleted meanwhile stays deleted, and the gesture ends without it", async () => {
    const { mine, theirs } = await pair(0);
    const [a, b] = create(mine, rect(), rect(100, 100));
    const gesture = mine.beginGesture({ kind: "translate", ids: [a!, b!] });
    gesture.update({ dx: 10, dy: 0 }, 0);
    theirs.dispatch({ type: "remove", ids: [a!] });
    gesture.update({ dx: 20, dy: 0 }, 8);
    assert.deepEqual([...mine.view().order], [b]);
    const applied = gesture.end();
    assert.deepEqual([...applied.patch.keys()], [b]);
    assert.deepEqual([...theirs.view().order], [b]);
    assert.equal(at(theirs, b!).x, 120);
    assert.equal(digestOf(mine), digestOf(theirs));
  });

  test("a restyle by the other tab shows through the preview, and the move merges with it", async () => {
    const { mine, theirs } = await pair(Infinity);
    const [a] = create(mine, rect());
    const gesture = mine.beginGesture({ kind: "translate", ids: [a!] });
    gesture.update({ dx: 10, dy: 0 }, 0);
    theirs.dispatch({ type: "style", ids: [a!], edit: { stroke: "#0a0" } });
    gesture.update({ dx: 30, dy: 0 }, 8);
    assert.deepEqual([at(mine, a!).x, at(mine, a!).stroke], [30, "#0a0"], "nothing is written yet, and the style is theirs");
    gesture.end();
    assert.deepEqual([at(theirs, a!).x, at(theirs, a!).stroke], [30, "#0a0"]);
    assert.equal(digestOf(mine), digestOf(theirs));
  });

  test("a stroke lands in front of a shape the other tab added while the pen was down", async () => {
    const { mine, theirs } = await pair(0);
    const gesture = mine.beginGesture({ kind: "draw", style: STYLE });
    gesture.update({ x: 0, y: 0 }, 0);
    gesture.update({ x: 5, y: 5 }, 8);
    const [added] = create(theirs, rect());
    const { created } = gesture.end();
    assert.deepEqual(mine.view().order, [added, created[0]]);
    assert.deepEqual(theirs.view().order, [added, created[0]]);
  });
});

describe("plan stays the one place that knows what a command means", () => {
  test("a translate gesture's patch is the move command's patch", async () => {
    const board = await open(disk().storage);
    const ids = create(board, rect(1.5, 2.5), rect(9, 9));
    const view = board.view();
    const expected = plan(view, { type: "move", ids, dx: 12.25, dy: -3 }, () => "unused" as ShapeId);
    const gesture = board.beginGesture({ kind: "translate", ids });
    gesture.update({ dx: 5, dy: 5 }, 0);
    gesture.update({ dx: 12.25, dy: -3 }, 50);
    assert.deepEqual(gesture.end().patch, expected);
  });
});
