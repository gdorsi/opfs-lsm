import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openBoard } from "../src/model/board.ts";
import { applyPatchPlain, digestShapes } from "../src/model/digest.ts";
import { boardId } from "../src/model/shapes.ts";
import type { Command, DocStorage, Shape, ShapeId } from "../src/model/types.ts";
import { memoryStorage } from "../src/persistence/index.ts";
import { randomCommand } from "./support/commands.ts";
import { testEnv } from "./support/env.ts";
import { seeded } from "./support/rng.ts";
import { sortedIds } from "./support/scenes.ts";
import { lossyStorage } from "./support/storage.ts";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const COMMANDS = 400;
const id = boardId("fuzz");

function envOf() {
  let n = 0;
  return testEnv(() => `s${(++n).toString(36)}`);
}

/**
 * Drives COMMANDS random commands through a board on `storage`, replays the same patches on a plain Map, then
 * reopens the board from `storage` and checks it against the Map. Throws an AssertionError when it differs.
 */
async function roundTrip(storage: DocStorage, seed: number) {
  const rng = seeded(seed);
  const env = envOf();
  const board = await openBoard({ id, storage, env });
  const oracle = new Map<ShapeId, Shape>();
  const seen = new Map<Command["type"], number>();
  const kinds = new Set<string>();
  for (let i = 0; i < COMMANDS; i++) {
    const command = randomCommand(rng, board.view());
    const { patch } = board.dispatch(command);
    applyPatchPlain(oracle, patch);
    if (patch.size > 0) seen.set(command.type, (seen.get(command.type) ?? 0) + 1);
    for (const shape of oracle.values()) kinds.add(shape.kind);
    assert.equal(digestShapes(board.view().shapes), digestShapes(oracle), `live board differs after command ${i}`);
    assert.deepEqual(board.view().order, sortedIds(oracle.values()), `paint order differs after command ${i}`);
  }
  await board.flush();
  await board.close();

  const reopened = await openBoard({ id, storage, env });
  const expected = digestShapes(oracle);
  const actual = digestShapes(reopened.view().shapes);
  assert.ok(actual === expected, `reopened board differs from the oracle: ${actual} !== ${expected}`);
  assert.deepEqual(reopened.view().order, sortedIds(oracle.values()), "reopened paint order differs");
  return { seen, kinds, shapes: oracle.size };
}

describe("a board reopened from storage matches the oracle", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, async () => {
      const storage = memoryStorage();
      const { seen, kinds, shapes } = await roundTrip(storage, seed);
      assert.deepEqual([...seen.keys()].sort(), ["create", "duplicate", "move", "remove", "reorder", "resize", "style"]);
      assert.deepEqual([...kinds].sort(), ["arrow", "diamond", "ellipse", "pen", "rect", "text"]);
      assert.ok(shapes > 5, "the run ended with a board worth comparing");
      assert.ok(storage.updates.get("board/fuzz")!.length > COMMANDS / 2, "most commands were stored");
    });
  }
});

describe("the check can fail", () => {
  for (const seed of SEEDS) {
    test(`a storage that drops every 7th update is caught, seed ${seed}`, async () => {
      await assert.rejects(roundTrip(lossyStorage(7), seed), {
        name: "AssertionError",
        message: /reopened board differs from the oracle/,
      });
    });
  }
});

describe("undo", () => {
  for (const seed of SEEDS) {
    test(`k commands undone return the first digest and redone return the last, seed ${seed}`, async () => {
      const rng = seeded(seed);
      const storage = memoryStorage();
      const env = envOf();
      const board = await openBoard({ id, storage, env });
      const digests = [digestShapes(board.view().shapes)];
      for (let i = 0; i < 90; i++) {
        if (board.dispatch(randomCommand(rng, board.view())).patch.size > 0) digests.push(digestShapes(board.view().shapes));
      }
      const steps = digests.length - 1;
      assert.ok(steps > 60 && steps <= 100);

      const half = Math.floor(steps / 2);
      for (let step = steps - 1; step >= 0; step--) {
        assert.equal(board.undo(), true);
        assert.equal(digestShapes(board.view().shapes), digests[step], `after undoing to step ${step}`);
        if (step === half) {
          await board.flush();
          const peek = await openBoard({ id, storage, env });
          assert.equal(digestShapes(peek.view().shapes), digests[half], "the undone state is what storage holds");
        }
      }
      assert.equal(board.undo(), false);
      assert.equal(board.view().shapes.size, 0);

      for (let step = 1; step <= steps; step++) {
        assert.equal(board.redo(), true);
        assert.equal(digestShapes(board.view().shapes), digests[step], `after redoing to step ${step}`);
      }
      assert.equal(board.redo(), false);
    });
  }
});
