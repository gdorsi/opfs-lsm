import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { openBoard as OpenBoard } from "../src/model/board.ts";
import type { Board, NewShape, ShapeId } from "../src/model/types.ts";
import type { memoryStorage as MemoryStorage } from "../src/persistence/index.ts";
import { idCounter, testEnv } from "./support/env.ts";

// Yjs times its undo steps with the real clock, and lib0 keeps a reference to Date.now when it loads. A fake that
// replaces Date.now afterwards changes nothing. So the fake goes in first, and everything that loads Yjs is imported
// after it (a static import would load Yjs first). Each test file runs in its own process, so this reaches no other test.
let clock = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => clock;
const { openBoard }: { openBoard: typeof OpenBoard } = await import("../src/model/board.ts");
const { memoryStorage }: { memoryStorage: typeof MemoryStorage } = await import("../src/persistence/index.ts");
Date.now = realNow;

const rect: NewShape = { kind: "rect", x: 0, y: 0, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 };
const open = (gestureIntervalMs = 0) =>
  openBoard({
    id: "u" as never,
    storage: memoryStorage(),
    env: testEnv(idCounter("s")),
    autosaveMs: null,
    gestureIntervalMs,
  });
const x = (board: Board, shape: ShapeId) => board.view().shapes.get(shape)!.x;

describe("undo steps do not depend on how long a gesture takes", () => {
  test("a drag whose writes are seconds apart is one step", async () => {
    const board = await open();
    const [a] = board.dispatch({ type: "create", shapes: [rect] }).created;
    const gesture = board.beginGesture({ kind: "translate", ids: [a!] });
    for (let i = 1; i <= 5; i++) {
      clock += 1000;
      gesture.update({ dx: i * 10, dy: 0 }, i * 8);
    }
    gesture.end();
    assert.equal(x(board, a!), 50);
    assert.equal(board.undo(), true);
    assert.equal(x(board, a!), 0, "one undo returns to where the drag began");
    assert.equal(board.undo(), true);
    assert.equal(board.view().shapes.size, 0, "the next step is the create");
  });

  test("commands made in the same instant stay separate steps", async () => {
    const board = await open();
    const [a] = board.dispatch({ type: "create", shapes: [rect] }).created;
    board.dispatch({ type: "move", ids: [a!], dx: 1, dy: 0 });
    board.dispatch({ type: "move", ids: [a!], dx: 1, dy: 0 });
    assert.equal(board.undo(), true);
    assert.equal(x(board, a!), 1);
    assert.equal(board.undo(), true);
    assert.equal(x(board, a!), 0);
  });
});
