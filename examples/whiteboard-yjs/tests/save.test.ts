import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openBoard } from "../src/model/board.ts";
import { boardId } from "../src/model/shapes.ts";
import type { Board, BoardOptions, NewShape, SaveState } from "../src/model/types.ts";
import { memoryStorage } from "../src/persistence/index.ts";
import { idCounter, testEnv } from "./support/env.ts";
import { flakyStorage, spyStorage } from "./support/storage.ts";

const id = boardId("s");
const rect: NewShape = { kind: "rect", x: 0, y: 0, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 };

function setup(over: Partial<BoardOptions> = {}) {
  const env = testEnv(idCounter("s"));
  const flaky = flakyStorage();
  return { env, ...flaky, open: () => openBoard({ id, storage: flaky.storage, env, ...over }) };
}

/** The distinct save states the view goes through, in order. */
function watchSave(board: Board): SaveState["kind"][] {
  const seen: SaveState["kind"][] = [board.view().save.kind];
  board.subscribe(() => {
    const kind = board.view().save.kind;
    if (seen.at(-1) !== kind) seen.push(kind);
  });
  return seen;
}

describe("the save state", () => {
  test("starts saved, becomes saving at the first write, and is saved again once autosave has flushed", async () => {
    const { env, control, open } = setup();
    const board = await open();
    const seen = watchSave(board);
    assert.equal(board.view().save.kind, "saved");
    board.dispatch({ type: "create", shapes: [rect] });
    assert.equal(board.view().save.kind, "saving");
    assert.equal(env.pending(), 1, "one flush is scheduled");

    await env.advance(399);
    assert.deepEqual([control.flushes, board.view().save.kind], [0, "saving"]);
    await env.advance(1);
    assert.deepEqual([control.flushes, board.view().save.kind], [1, "saved"]);
    assert.equal(env.pending(), 0, "nothing is scheduled while nothing is unsaved");
    assert.deepEqual(seen, ["saved", "saving", "saved"]);
  });

  test("goes saving, error, saved when storage fails and then recovers", async () => {
    const { env, control, open } = setup();
    const board = await open();
    const seen = watchSave(board);
    control.failing = true;
    board.dispatch({ type: "create", shapes: [rect] });
    await env.advance(400);
    const state = board.view().save;
    assert.equal(state.kind, "error");
    assert.equal(state.kind === "error" && state.error.message, "disk full");

    board.dispatch({ type: "create", shapes: [rect] });
    assert.equal(board.view().save.kind, "error", "an edit does not hide the error");
    await env.advance(400);
    assert.equal(board.view().save.kind, "error", "it retries, and fails again");
    assert.equal(control.flushes, 2);

    control.failing = false;
    await env.advance(400);
    assert.equal(board.view().save.kind, "saved");
    assert.deepEqual(seen, ["saved", "saving", "error", "saved"]);
    assert.equal(env.pending(), 0);
  });

  test("a manual flush drives the same state and rejects with the storage's error", async () => {
    const { control, open } = setup({ autosaveMs: null });
    const board = await open();
    board.dispatch({ type: "create", shapes: [rect] });
    control.failing = true;
    await assert.rejects(board.flush(), { message: "disk full" });
    assert.equal(board.view().save.kind, "error");
    control.failing = false;
    await board.flush();
    assert.equal(board.view().save.kind, "saved");
  });

  test("autosave is periodic: a drag that goes on for seconds is flushed while it goes on", async () => {
    const { env, control, open } = setup({ gestureIntervalMs: 32 });
    const board = await open();
    const [a] = board.dispatch({ type: "create", shapes: [rect] }).created;
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    const step = 1000 / 120;
    for (let i = 1; i <= 240; i++) {
      gesture.update({ dx: i, dy: 0 }, i * step);
      await env.advance(step);
    }
    assert.ok(control.flushes >= 4, `flushed ${control.flushes} times during a 2 s drag, not only after it`);
    assert.ok(control.flushes <= 6);
    gesture.end();
  });

  test("an update that arrives while a flush is in flight is flushed before the state says saved", async () => {
    const { env, control, open } = setup();
    const board = await open();
    const seen = watchSave(board);
    let release!: () => void;
    control.hold = new Promise<void>((resolve) => (release = resolve));
    board.dispatch({ type: "create", shapes: [rect] });
    await env.advance(400);
    assert.equal(control.flushes, 1, "the first flush is waiting on storage");

    board.dispatch({ type: "create", shapes: [rect] });
    control.hold = undefined;
    release();
    await env.settle();
    assert.equal(control.flushes, 2, "the second update got its own flush");
    assert.deepEqual(seen, ["saved", "saving", "saved"]);
  });

  test("an update from another tab is unsaved too", async () => {
    const { storage, docs } = spyStorage();
    const env = testEnv(idCounter("s"));
    const board = await openBoard({ id, storage, env });
    const doc = docs.get("board/s")!;
    doc.transact(() => doc.getMap("elsewhere").set("k", 1), "relay");
    assert.equal(board.view().save.kind, "saving");
    await env.advance(400);
    assert.equal(board.view().save.kind, "saved");
  });

  test("closing cancels the scheduled flush, since detaching storage flushes", async () => {
    const { env, control, open } = setup();
    const board = await open();
    board.dispatch({ type: "create", shapes: [rect] });
    assert.equal(env.pending(), 1);
    await board.close();
    assert.equal(env.pending(), 0);
    await env.advance(10_000);
    assert.equal(control.flushes, 0, "the autosave never ran");
  });

  test("autosaveMs null schedules nothing", async () => {
    const { env, control, open } = setup({ autosaveMs: null });
    const board = await open();
    board.dispatch({ type: "create", shapes: [rect] });
    assert.equal(env.pending(), 0);
    await env.advance(10_000);
    assert.deepEqual([control.flushes, board.view().save.kind], [0, "saving"]);
  });

  test("loading stored data is not an unsaved change", async () => {
    const storage = memoryStorage();
    const first = await openBoard({ id, storage, env: testEnv(idCounter("s")), autosaveMs: null });
    first.dispatch({ type: "create", shapes: [rect] });
    await first.close();
    const again = await openBoard({ id, storage, env: testEnv(idCounter("t")) });
    assert.equal(again.view().shapes.size, 1);
    assert.equal(again.view().save.kind, "saved");
  });
});
