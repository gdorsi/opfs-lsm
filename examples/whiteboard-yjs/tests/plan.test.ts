import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { plan } from "../src/model/plan.ts";
import { penShape } from "../src/model/shapes.ts";
import type { Direction, PatchEntry, ShapeEdit, ShapeId } from "../src/model/types.ts";
import { after, counter, sceneOf, shape, sid, sortedIds } from "./support/scenes.ts";

const ids = (...names: string[]) => names.map(sid);
const style = { stroke: "#111", fill: null, strokeWidth: 2 };

function edits(patch: ReadonlyMap<ShapeId, PatchEntry>): Record<string, ShapeEdit | { op: string }> {
  return Object.fromEntries([...patch].map(([id, entry]) => [id, entry.op === "set" ? entry.edit : { op: entry.op }]));
}

describe("create", () => {
  test("puts every shape in front of the existing ones, in order", () => {
    const scene = sceneOf(shape("a", "a0"), shape("b", "a1"));
    const rect = { kind: "rect", x: 1, y: 2, w: 3, h: 4, ...style } as const;
    const patch = plan(scene, { type: "create", shapes: [rect, { ...rect, kind: "ellipse" }] }, counter());
    assert.deepEqual([...patch.keys()], ids("n1", "n2"));
    const next = after(scene, patch);
    assert.deepEqual(next.order, ids("a", "b", "n1", "n2"));
    assert.deepEqual(next.shapes.get(sid("n1")), { ...rect, id: "n1", z: next.shapes.get(sid("n1"))!.z });
    assert.equal(next.shapes.get(sid("n2"))!.kind, "ellipse");
  });

  test("on an empty board the first key is valid and the rest follow it", () => {
    const shapes = Array.from({ length: 3 }, () => ({ kind: "rect", x: 0, y: 0, w: 1, h: 1, ...style }) as const);
    const patch = plan(sceneOf(), { type: "create", shapes }, counter());
    assert.deepEqual(after(sceneOf(), patch).order, ids("n1", "n2", "n3"));
  });

  test("keeps a pen stroke's points as given", () => {
    const pen = penShape([{ x: 10, y: 20 }, { x: 30, y: 60 }, { x: 20, y: 40 }], style);
    const next = after(sceneOf(), plan(sceneOf(), { type: "create", shapes: [pen] }, counter()));
    const stored = next.shapes.get(sid("n1"))!;
    assert.equal(stored.kind, "pen");
    assert.deepEqual([stored.x, stored.y, stored.w, stored.h], [10, 20, 20, 40]);
    assert.deepEqual(stored.kind === "pen" && stored.points, [0, 0, 65535, 65535, 32768, 32768]);
  });

  test("creating nothing writes nothing", () => {
    assert.equal(plan(sceneOf(), { type: "create", shapes: [] }, counter()).size, 0);
  });
});

describe("move", () => {
  const scene = sceneOf(shape("a", "a0", { x: 5, y: 5 }), shape("b", "a1", { x: 7, y: 9 }));

  test("sets x and y of every named shape", () => {
    const patch = plan(scene, { type: "move", ids: ids("a", "b"), dx: 3, dy: -2 }, counter());
    assert.deepEqual(edits(patch), { a: { x: 8, y: 3 }, b: { x: 10, y: 7 } });
  });

  test("writes only the field that changed", () => {
    assert.deepEqual(edits(plan(scene, { type: "move", ids: ids("a"), dx: 4, dy: 0 }, counter())), { a: { x: 9 } });
  });

  test("a zero move, an empty list and unknown ids write nothing", () => {
    assert.equal(plan(scene, { type: "move", ids: ids("a", "b"), dx: 0, dy: 0 }, counter()).size, 0);
    assert.equal(plan(scene, { type: "move", ids: [], dx: 1, dy: 1 }, counter()).size, 0);
    assert.equal(plan(scene, { type: "move", ids: ids("ghost"), dx: 1, dy: 1 }, counter()).size, 0);
  });

  test("skips unknown ids and names a repeated id once", () => {
    const patch = plan(scene, { type: "move", ids: ids("a", "ghost", "a"), dx: 1, dy: 1 }, counter());
    assert.deepEqual([...patch.keys()], ids("a"));
  });
});

describe("resize", () => {
  const from = { x: 0, y: 0, w: 100, h: 100 };

  test("scales each shape inside the box", () => {
    const scene = sceneOf(shape("a", "a0", { x: 10, y: 20, w: 30, h: 40 }));
    const patch = plan(scene, { type: "resize", ids: ids("a"), from, to: { x: 50, y: 0, w: 200, h: 50 } }, counter());
    assert.deepEqual(edits(patch), { a: { x: 70, y: 10, w: 60, h: 20 } });
  });

  test("scales an arrow's end with its start, whichever way it points", () => {
    const scene = sceneOf(shape("arrow", "a0", { kind: "arrow", x: 80, y: 80, w: -60, h: -40 }));
    const to = { x: 0, y: 0, w: 50, h: 200 };
    const next = after(scene, plan(scene, { type: "resize", ids: ids("arrow"), from, to }, counter()));
    const s = next.shapes.get(sid("arrow"))!;
    assert.deepEqual([s.x, s.y, s.w, s.h], [40, 160, -30, -80]);
  });

  test("moves a pen stroke's frame and never touches its points", () => {
    const scene = sceneOf(shape("p", "a0", { kind: "pen", x: 10, y: 10, w: 20, h: 20 }));
    const patch = plan(scene, { type: "resize", ids: ids("p"), from, to: { x: 0, y: 0, w: 200, h: 100 } }, counter());
    assert.deepEqual(edits(patch), { p: { x: 20, w: 40 } });
  });

  test("flips a shape when the target box is flipped", () => {
    const scene = sceneOf(shape("a", "a0", { x: 10, y: 0, w: 20, h: 100 }));
    const to = { x: 100, y: 0, w: -100, h: 100 };
    const next = after(scene, plan(scene, { type: "resize", ids: ids("a"), from, to }, counter()));
    const s = next.shapes.get(sid("a"))!;
    assert.deepEqual([s.x, s.w], [90, -20]);
  });

  test("translates when the source box has no extent on an axis", () => {
    const scene = sceneOf(shape("a", "a0", { x: 5, y: 5, w: 0, h: 10 }));
    const [from, to] = [{ x: 5, y: 0, w: 0, h: 10 }, { x: 9, y: 0, w: 0, h: 10 }];
    const patch = plan(scene, { type: "resize", ids: ids("a"), from, to }, counter());
    assert.deepEqual(edits(patch), { a: { x: 9 } });
  });

  test("mapping a box onto itself writes nothing", () => {
    const scene = sceneOf(shape("a", "a0", { x: 10, y: 20, w: 30, h: 40 }));
    assert.equal(plan(scene, { type: "resize", ids: ids("a"), from, to: from }, counter()).size, 0);
  });
});

describe("style", () => {
  const scene = sceneOf(shape("r", "a0"), shape("t", "a1", { kind: "text", text: "hi", fontSize: 16 }));

  test("sets colors and width on every shape and text only on text shapes", () => {
    const edit = { stroke: "#f00", text: "yo", fontSize: 20 };
    const patch = plan(scene, { type: "style", ids: ids("r", "t"), edit }, counter());
    assert.deepEqual(edits(patch), { r: { stroke: "#f00" }, t: { stroke: "#f00", text: "yo", fontSize: 20 } });
  });

  test("clears a fill with null and writes nothing when the value is already there", () => {
    const filled = sceneOf(shape("r", "a0", { fill: "#0f0" }));
    const cleared = plan(filled, { type: "style", ids: ids("r"), edit: { fill: null } }, counter());
    assert.deepEqual(edits(cleared), { r: { fill: null } });
    assert.equal(plan(filled, { type: "style", ids: ids("r"), edit: { fill: "#0f0", strokeWidth: 2 } }, counter()).size, 0);
  });

  test("ignores text on a shape that has none", () => {
    assert.equal(plan(scene, { type: "style", ids: ids("r"), edit: { text: "x", fontSize: 9 } }, counter()).size, 0);
  });
});

describe("reorder", () => {
  const scene = sceneOf(shape("a", "a0"), shape("b", "a1"), shape("c", "a2"), shape("d", "a3"));
  const run = (pickIds: string[], to: Direction, from = scene) =>
    plan(from, { type: "reorder", ids: ids(...pickIds), to }, counter());
  const order = (pickIds: string[], to: Direction, from = scene) => after(from, run(pickIds, to, from)).order;

  test("front and back", () => {
    assert.deepEqual(order(["b"], "front"), ids("a", "c", "d", "b"));
    assert.deepEqual(order(["c"], "back"), ids("c", "a", "b", "d"));
  });

  test("forward and backward move one step past the nearest shape not picked", () => {
    assert.deepEqual(order(["b"], "forward"), ids("a", "c", "b", "d"));
    assert.deepEqual(order(["c"], "backward"), ids("a", "c", "b", "d"));
    assert.deepEqual(order(["a", "c"], "forward"), ids("b", "a", "d", "c"));
    assert.deepEqual(order(["b", "d"], "backward"), ids("b", "a", "d", "c"));
    assert.deepEqual(order(["a", "b"], "forward"), ids("c", "a", "b", "d"));
  });

  test("keeps the picked shapes in their current relative order", () => {
    assert.deepEqual(order(["c", "a"], "front"), ids("b", "d", "a", "c"));
    assert.deepEqual(order(["d", "b"], "back"), ids("b", "d", "a", "c"));
  });

  test("writes only the picked shapes' keys", () => {
    assert.deepEqual([...run(["b", "c"], "front").keys()], ids("b", "c"));
  });

  test("writes nothing when the order would not change", () => {
    assert.equal(run(["d"], "front").size, 0);
    assert.equal(run(["c", "d"], "front").size, 0);
    assert.equal(run(["a"], "back").size, 0);
    assert.equal(run(["d"], "forward").size, 0);
    assert.equal(run(["a"], "backward").size, 0);
    assert.equal(run(["ghost"], "front").size, 0);
  });

  test("lands after shapes with an equal key when it cannot go between them", () => {
    const tied = sceneOf(shape("a", "a0"), shape("b", "a0"), shape("c", "a0"));
    assert.deepEqual(order(["a"], "forward", tied), ids("b", "c", "a"));
    assert.deepEqual(order(["c"], "front", tied), ids("a", "b", "c"));
    assert.deepEqual(order(["a"], "front", tied), ids("b", "c", "a"));
  });

  test("breaks equal keys by id", () => {
    assert.deepEqual(sortedIds(sceneOf(shape("b", "a0"), shape("a", "a0")).shapes.values()), ids("a", "b"));
  });

  test("moving a run forward and back again restores the order without growing the keys", () => {
    const start = sceneOf(shape("a", "a0"), shape("b", "a1"), shape("c", "a2"), shape("d", "a3"), shape("e", "a4"));
    let current = start;
    for (let i = 0; i < 40; i++) {
      current = after(current, plan(current, { type: "reorder", ids: ids("c", "d"), to: "forward" }, counter()));
      assert.deepEqual(current.order, ids("a", "b", "e", "c", "d"));
      current = after(current, plan(current, { type: "reorder", ids: ids("c", "d"), to: "backward" }, counter()));
      assert.deepEqual(current.order, start.order);
    }
    const longest = Math.max(...[...current.shapes.values()].map((s) => s.z.length));
    assert.ok(longest <= 6, `key length ${longest}`);
  });
});

describe("duplicate", () => {
  test("copies the shapes in front, in their relative order, offset, with new ids", () => {
    const scene = sceneOf(shape("a", "a0", { x: 1, y: 2 }), shape("b", "a1", { kind: "pen", x: 5, y: 5 }), shape("c", "a2"));
    const patch = plan(scene, { type: "duplicate", ids: ids("b", "a", "ghost"), dx: 10, dy: 20 }, counter());
    const next = after(scene, patch);
    assert.deepEqual(next.order, ids("a", "b", "c", "n1", "n2"));
    const [first, second] = [next.shapes.get(sid("n1"))!, next.shapes.get(sid("n2"))!];
    assert.deepEqual([first.kind, first.x, first.y], ["rect", 11, 22]);
    assert.deepEqual([second.kind, second.x, second.y], ["pen", 15, 25]);
    assert.deepEqual(second.kind === "pen" && second.points, [0, 0, 65535, 65535]);
    assert.deepEqual(next.shapes.get(sid("a")), scene.shapes.get(sid("a")));
  });

  test("writes nothing for unknown ids", () => {
    assert.equal(plan(sceneOf(shape("a", "a0")), { type: "duplicate", ids: ids("ghost"), dx: 1, dy: 1 }, counter()).size, 0);
  });
});

describe("remove", () => {
  const scene = sceneOf(shape("a", "a0"), shape("b", "a1"));

  test("deletes the named shapes and skips unknown ones", () => {
    const patch = plan(scene, { type: "remove", ids: ids("a", "ghost") }, counter());
    assert.deepEqual(edits(patch), { a: { op: "del" } });
    assert.deepEqual(after(scene, patch).order, ids("b"));
  });

  test("removing nothing writes nothing", () => {
    assert.equal(plan(scene, { type: "remove", ids: [] }, counter()).size, 0);
  });
});
