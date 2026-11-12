import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kanbanBetween } from "./kanban.ts";

describe("kanbanBetween", () => {
  it("places a key between its neighbours", () => {
    const a = kanbanBetween(null, null);
    const c = kanbanBetween(a, null);
    const b = kanbanBetween(a, c);
    assert.ok(a < b && b < c);
  });

  it("places a key at either end of a column", () => {
    const only = kanbanBetween(null, null);
    assert.ok(kanbanBetween(null, only) < only);
    assert.ok(kanbanBetween(only, null) > only);
  });

  it("puts the key after `before` when the neighbours are out of order or equal", () => {
    const a = kanbanBetween(null, null);
    const b = kanbanBetween(a, null);
    assert.ok(kanbanBetween(b, a) > b);
    assert.ok(kanbanBetween(a, a) > a);
  });

  it("keeps finding room after many inserts at the same spot", () => {
    let low = kanbanBetween(null, null);
    const high = kanbanBetween(low, null);
    for (let i = 0; i < 200; i++) {
      const next = kanbanBetween(low, high);
      assert.ok(low < next && next < high);
      low = next;
    }
  });
});
