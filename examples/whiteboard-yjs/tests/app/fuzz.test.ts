import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyPatchPlain, digestShapes } from "../../src/model/digest.ts";
import type { Board, Patch, Shape, ShapeId } from "../../src/model/types.ts";
import type { Action } from "../../src/app/core/keys.ts";
import type { InputEvent, PointerSample } from "../../src/app/core/input.ts";
import { pick, seeded, type Rng } from "../support/rng.ts";
import { box, rig } from "./harness.ts";

function recording(board: Board, patches: Patch[]): Board {
  return {
    id: board.id,
    view: () => board.view(),
    subscribe: (listener) => board.subscribe(listener),
    dispatch: (command) => {
      const applied = board.dispatch(command);
      patches.push(applied.patch);
      return applied;
    },
    beginGesture: (start) => {
      const gesture = board.beginGesture(start);
      return {
        update: (input, t) => gesture.update(input, t),
        end: () => {
          const applied = gesture.end();
          patches.push(applied.patch);
          return applied;
        },
        cancel: () => gesture.cancel(),
      };
    },
    select: (ids) => board.select(ids),
    setViewport: (viewport) => board.setViewport(viewport),
    undo: () => board.undo(),
    redo: () => board.redo(),
    flush: () => board.flush(),
    close: () => board.close(),
  };
}

const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", " ", "Delete", "Shift", "Alt", "d", "r", "p", "a", "t", "v", "z", "Enter", "Backspace", "]", "0"];
const ACTIONS: Action[] = [
  { type: "undo" },
  { type: "redo" },
  { type: "delete" },
  { type: "duplicate" },
  { type: "selectAll" },
  { type: "editText" },
  { type: "reorder", to: "front" },
  { type: "reorder", to: "backward" },
  { type: "nudge", dx: 3, dy: -2 },
  { type: "style", edit: { stroke: "#0a0" } },
  { type: "style", edit: { fill: null, strokeWidth: 4 } },
  { type: "zoom", to: "in" },
  { type: "zoom", to: "fit" },
  { type: "tool", tool: "rect" },
  { type: "tool", tool: "pen" },
  { type: "tool", tool: "text" },
  { type: "tool", tool: "arrow" },
  { type: "tool", tool: "select" },
];

function event(rng: Rng, t: number, history: boolean): InputEvent | "frame" {
  const p = (): PointerSample => ({
    pointerId: pick(rng, [1, 1, 1, 2]),
    kind: pick(rng, ["mouse", "mouse", "touch", "pen"] as const),
    button: pick(rng, [0, 0, 0, 1]),
    screen: { x: Math.floor(rng() * 800), y: Math.floor(rng() * 600) },
    shift: rng() < 0.2,
    alt: rng() < 0.1,
    mod: false,
    t,
  });
  const roll = rng();
  if (roll < 0.18) return { type: "down", p: p() };
  if (roll < 0.4) return { type: "move", p: p() };
  if (roll < 0.55) return { type: "up", p: p() };
  if (roll < 0.58) return { type: "cancel", pointerId: pick(rng, [1, 2]) };
  if (roll < 0.6) return { type: "dblclick", p: p() };
  if (roll < 0.72) return "frame";
  if (roll < 0.8) {
    const key = pick(rng, KEYS);
    return { type: "key", down: rng() < 0.6, key: { key, mod: history && rng() < 0.2, shift: rng() < 0.2, alt: false, repeat: rng() < 0.3 }, t };
  }
  if (roll < 0.84) return { type: "wheel", screen: { x: rng() * 800, y: rng() * 600 }, dx: (rng() - 0.5) * 200, dy: (rng() - 0.5) * 200, zoom: rng() < 0.5 };
  if (roll < 0.9) {
    const action = pick(rng, ACTIONS);
    return { type: "do", action: !history && (action.type === "undo" || action.type === "redo") ? { type: "selectAll" } : action };
  }
  if (roll < 0.93) return { type: "text-input", draft: pick(rng, ["", "a", "two\nlines", "  "]) };
  if (roll < 0.96) return { type: "text-commit" };
  return { type: "abandon" };
}

describe("seeded event fuzz", () => {
  for (const history of [false, true]) {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      test(`seed ${seed}${history ? " with undo and redo" : ""}: nothing throws and the board matches the replayed patches`, async () => {
        const rng = seeded(seed);
        const seedShapes = Array.from({ length: 50 }, (_, i) =>
          box(pick(rng, ["rect", "ellipse", "diamond"] as const), (i % 10) * 70, Math.floor(i / 10) * 100, 60, 80),
        );
        const patches: Patch[] = [];
        const r = await rig(seedShapes, (board) => recording(board, patches));
        const oracle = new Map<ShapeId, Shape>(r.board.view().shapes);
        let t = 0;
        for (let i = 0; i < 2000; i++) {
          const e = event(rng, (t += 8), history);
          if (e === "frame") r.input.frame();
          else assert.doesNotThrow(() => r.input.send(e), `event ${i}: ${JSON.stringify(e)}`);
        }
        r.input.send({ type: "abandon" });
        r.input.send({ type: "text-commit" });
        assert.doesNotThrow(() => r.board.dispatch({ type: "remove", ids: [] }), "no gesture is left live");
        assert.ok(patches.length >= 20, `the run wrote ${patches.length} times: enough to mean something`);
        if (!history) {
          for (const patch of patches) applyPatchPlain(oracle, patch);
          assert.equal(digestShapes(r.board.view().shapes), digestShapes(oracle), "the board is what its patches say");
        }
      });
    }
  }
});
