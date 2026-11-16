import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keyAction, TOOL_KEYS, type KeySample } from "../../src/app/core/keys.ts";

const key = (k: string, over: Partial<KeySample> = {}): KeySample => ({ key: k, mod: false, shift: false, alt: false, repeat: false, ...over });
const mod = (k: string, over: Partial<KeySample> = {}) => key(k, { mod: true, ...over });

describe("keyAction", () => {
  test("history and selection shortcuts", () => {
    assert.deepEqual(keyAction(mod("z")), { type: "undo" });
    assert.deepEqual(keyAction(mod("Z", { shift: true })), { type: "redo" });
    assert.deepEqual(keyAction(mod("y")), { type: "redo" });
    assert.deepEqual(keyAction(mod("a")), { type: "selectAll" });
    assert.deepEqual(keyAction(mod("d")), { type: "duplicate" });
  });

  test("reorder and zoom shortcuts", () => {
    assert.deepEqual(keyAction(mod("]")), { type: "reorder", to: "forward" });
    assert.deepEqual(keyAction(mod("[")), { type: "reorder", to: "backward" });
    assert.deepEqual(keyAction(mod("}", { shift: true })), { type: "reorder", to: "front" });
    assert.deepEqual(keyAction(mod("{", { shift: true })), { type: "reorder", to: "back" });
    assert.deepEqual(keyAction(mod("0")), { type: "zoom", to: "reset" });
    assert.deepEqual(keyAction(mod("=")), { type: "zoom", to: "in" });
    assert.deepEqual(keyAction(mod("-")), { type: "zoom", to: "out" });
    assert.deepEqual(keyAction(key("!", { shift: true })), { type: "zoom", to: "fit" });
  });

  test("delete, Enter and the arrows with and without shift", () => {
    assert.deepEqual(keyAction(key("Delete")), { type: "delete" });
    assert.deepEqual(keyAction(key("Backspace")), { type: "delete" });
    assert.deepEqual(keyAction(key("Enter")), { type: "editText" });
    assert.deepEqual(keyAction(key("ArrowLeft")), { type: "nudge", dx: -1, dy: 0 });
    assert.deepEqual(keyAction(key("ArrowDown", { shift: true })), { type: "nudge", dx: 0, dy: 10 });
  });

  test("each tool letter picks its tool, but not with a modifier or on repeat", () => {
    for (const [tool, letter] of Object.entries(TOOL_KEYS)) {
      assert.deepEqual(keyAction(key(letter)), { type: "tool", tool }, `${letter} picks ${tool}`);
    }
    assert.equal(keyAction(key("r", { repeat: true })), undefined);
    assert.equal(keyAction(key("r", { shift: true })), undefined);
    assert.equal(keyAction(mod("r")), undefined);
  });

  test("unknown keys map to undefined", () => {
    assert.equal(keyAction(key("q")), undefined);
    assert.equal(keyAction(key("F5")), undefined);
  });
});
