import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { digestShapes } from "../../src/model/digest.ts";
import type { Shape } from "../../src/model/types.ts";
import { toBoard } from "../../src/app/core/camera.ts";
import { naturalSize } from "../../src/app/core/text.ts";
import { box, fixedPitch, rig } from "./harness.ts";

const text = (over: Record<string, unknown> = {}) =>
  ({ kind: "text", x: 100, y: 100, w: 60, h: 25, text: "hello", fontSize: 20, stroke: "#000", fill: null, strokeWidth: 2, ...over }) as const;

describe("box tools", () => {
  test("a drag creates one selected shape whose box matches the drag, as one undo step", async () => {
    const r = await rig();
    r.tool("rect");
    r.drag([100, 100], [200, 180]);
    const [made] = r.shapes();
    assert.deepEqual(r.shapes().length, 1);
    assert.deepEqual([made!.kind, made!.x, made!.y, made!.w, made!.h], ["rect", 100, 100, 100, 80]);
    assert.deepEqual(r.selected(), [made!.id], "the new shape is selected");
    assert.equal(r.input.ui().tool, "select", "the tool is back to select");
    assert.equal(r.undoAll(), 1);
    assert.equal(r.shapes().length, 0, "undo removes it");
  });

  test("a click makes a 100 px shape centered on the pointer", async () => {
    const r = await rig();
    r.tool("ellipse");
    r.click(300, 300);
    const [made] = r.shapes();
    assert.deepEqual([made!.kind, made!.x, made!.y, made!.w, made!.h], ["ellipse", 250, 250, 100, 100]);
  });

  test("Escape mid-sizing creates nothing and clears the preview", async () => {
    const r = await rig();
    r.tool("rect");
    r.down(100, 100);
    r.move(200, 200);
    r.input.frame();
    assert.notEqual(r.input.overlay().preview, null, "the preview is drawn while sizing");
    r.keyDown("Escape");
    assert.equal(r.input.overlay().preview, null);
    r.up(200, 200);
    assert.equal(r.shapes().length, 0);
    assert.equal(r.board.view().canUndo, false);
  });

  test("each box tool creates its kind, shift makes a box square, an arrow keeps its direction in its signs", async () => {
    const r = await rig();
    for (const kind of ["rect", "ellipse", "diamond"] as const) {
      r.tool(kind);
      r.drag([300, 300], [250, 340], { shift: true });
      const made = r.shapes().at(-1)!;
      assert.deepEqual([made.kind, made.x, made.y, made.w, made.h], [kind, 250, 300, 50, 50], `${kind} is square and normalized`);
    }
    r.tool("arrow");
    r.drag([300, 300], [250, 340]);
    const arrow = r.shapes().at(-1)!;
    assert.deepEqual([arrow.kind, arrow.x, arrow.y, arrow.w, arrow.h, arrow.fill], ["arrow", 300, 300, -50, 40, null]);
  });
});

test("the board fits its content when the stage first has a size", async () => {
  const r = await rig([box("rect", 0, 0, 4000, 3000)], undefined, true);
  const v = r.board.view().viewport;
  assert.ok(v.zoom < 0.2, `zoom ${v.zoom} shows all of a 4000 x 3000 board in 800 x 600`);
  const middle = toBoard(v, { x: 400, y: 300 });
  assert.deepEqual([Math.round(middle.x), Math.round(middle.y)], [2000, 1500]);
});

describe("select and move", () => {
  test("a press selects, a drag is one translate and the up applies its own position", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50)]);
    const [a] = r.ids;
    r.down(120, 120);
    assert.deepEqual(r.selected(), [a], "the press selects an unselected shape");
    let published = 0;
    r.board.subscribe(() => published++);
    r.move(130, 125);
    r.move(140, 130);
    r.move(150, 140);
    r.input.frame();
    assert.equal(published, 1, "three pointer moves make one gesture update");
    r.up(160, 140);
    assert.deepEqual([r.at(a!).x, r.at(a!).y], [140, 120], "the up's own position is applied without another frame");
    assert.equal(r.board.undo(), true);
    assert.deepEqual([r.at(a!).x, r.at(a!).y], [100, 100], "one undo restores it");
  });

  test("a small wiggle is a click and moves nothing", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50)]);
    r.down(120, 120);
    r.move(122, 121);
    r.input.frame();
    r.up(122, 121);
    assert.equal(r.undoAll(), 1, "only the seed create");
  });

  test("shift-click toggles, a click inside a selection narrows it, a click on empty space clears", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50), box("rect", 300, 100, 50, 50)]);
    const [a, b] = r.ids;
    r.click(120, 120);
    r.click(320, 120, { shift: true });
    assert.deepEqual(r.selected(), [a, b], "shift adds");
    r.click(120, 120, { shift: true });
    assert.deepEqual(r.selected(), [b], "shift on a selected shape removes it");
    r.input.send({ type: "do", action: { type: "selectAll" } });
    r.click(320, 120);
    assert.deepEqual(r.selected(), [b], "a plain click narrows");
    r.click(600, 500, { shift: true });
    assert.deepEqual(r.selected(), [b], "shift on empty space keeps the selection");
    r.click(600, 500);
    assert.deepEqual(r.selected(), [], "a plain click on empty space clears it");
  });
});

describe("marquee", () => {
  const seed = [box("rect", 100, 100, 50, 50), box("rect", 300, 100, 50, 50), box("rect", 500, 100, 50, 50), box("rect", 380, 100, 50, 50)];

  test("selects only fully enclosed shapes, once, on pointer-up", async () => {
    const r = await rig(seed);
    const [a, b] = r.ids;
    r.down(50, 50);
    r.move(400, 200);
    r.input.frame();
    assert.deepEqual(r.selected(), [], "nothing is selected while the marquee is drawn");
    assert.notEqual(r.input.overlay().marquee, null);
    r.up(400, 200);
    assert.deepEqual(r.selected().sort(), [a, b].sort(), "the shape that sticks out is left alone");
    assert.equal(r.input.overlay().marquee, null);
  });

  test("shift adds to the selection", async () => {
    const r = await rig(seed);
    const [a, , c] = r.ids;
    r.click(520, 120);
    r.drag([50, 50], [200, 200], { shift: true });
    assert.deepEqual(r.selected().sort(), [a, c].sort());
  });

  test("Escape mid-marquee leaves the earlier selection", async () => {
    const r = await rig(seed);
    const [, , c] = r.ids;
    r.click(520, 120);
    r.down(50, 50);
    r.move(400, 200);
    r.input.frame();
    r.keyDown("Escape");
    r.up(400, 200);
    assert.deepEqual(r.selected(), [c]);
  });
});

describe("resize", () => {
  test("the se handle maps the box, and dragging past the nw corner flips it", async () => {
    const r = await rig([box("rect", 100, 100, 100, 100)]);
    const [a] = r.ids;
    r.click(150, 150);
    r.drag([200, 200], [300, 260]);
    assert.deepEqual([r.at(a!).x, r.at(a!).y, r.at(a!).w, r.at(a!).h], [100, 100, 200, 160]);
    r.board.undo();
    r.drag([100, 100], [250, 250]);
    assert.deepEqual([r.at(a!).x, r.at(a!).w, r.at(a!).h], [250, -50, -50]);
  });

  test("an arrow's end handle moves only the head", async () => {
    const r = await rig();
    r.tool("arrow");
    r.drag([100, 100], [200, 150]);
    const [arrow] = r.shapes();
    r.drag([200, 150], [240, 160]);
    assert.deepEqual([r.at(arrow!.id).x, r.at(arrow!.id).y, r.at(arrow!.id).w, r.at(arrow!.id).h], [100, 100, 140, 60]);
  });

  test("a text-only selection keeps its aspect", async () => {
    const r = await rig([text()]);
    const [t] = r.ids;
    r.click(110, 110);
    r.drag([160, 125], [260, 125]);
    const shape = r.at(t!);
    assert.equal(shape.w, 160);
    assert.ok(Math.abs(shape.h / shape.w - 25 / 60) < 0.01, `aspect kept, h is ${shape.h}`);
  });
});

describe("throw rules", () => {
  test("every action but zoom is refused during a drag, and the model would have thrown", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50)]);
    r.down(120, 120);
    r.move(160, 160);
    r.input.frame();
    for (const action of [{ type: "undo" }, { type: "redo" }, { type: "delete" }, { type: "duplicate" }, { type: "selectAll" }] as const) {
      assert.equal(r.input.send({ type: "do", action }), false, `${action.type} is refused`);
    }
    assert.equal(r.input.send({ type: "do", action: { type: "zoom", to: "in" } }), true, "zoom never writes the doc");
    assert.throws(() => r.board.undo(), /gesture in progress/, "the guard is the controller's: the model refuses too");
    r.input.send({ type: "abandon" });
    assert.doesNotThrow(() => r.board.dispatch({ type: "remove", ids: [] }));
  });
});

describe("cancel", () => {
  for (const [name, cancel] of [
    ["Escape", (r: Awaited<ReturnType<typeof rig>>) => r.keyDown("Escape")],
    ["blur", (r: Awaited<ReturnType<typeof rig>>) => r.input.send({ type: "abandon" })],
    ["pointercancel", (r: Awaited<ReturnType<typeof rig>>) => r.input.send({ type: "cancel", pointerId: 1 })],
  ] as const) {
    test(`${name} mid-drag reverts the shape, leaves no undo step and stores the original`, async () => {
      const r = await rig([box("rect", 100, 100, 50, 50)]);
      const [a] = r.ids;
      const before = digestShapes(r.board.view().shapes);
      const undoable = r.board.view().canUndo;
      r.down(120, 120);
      r.move(200, 200);
      r.input.frame();
      assert.equal(r.at(a!).x, 180, "the preview moved");
      cancel(r);
      r.up(200, 200);
      assert.equal(r.at(a!).x, 100);
      assert.equal(r.board.view().canUndo, undoable);
      await r.board.close();
      assert.equal(digestShapes((await r.open()).view().shapes), before, "storage holds the original");
    });
  }
});

describe("pen", () => {
  test("a stroke is thinned before the model, ends as one pen shape and one undo step", async () => {
    const r = await rig();
    r.tool("pen");
    r.down(100, 100);
    for (let i = 1; i <= 100; i++) r.move(100 + i * 0.5, 100);
    r.input.frame();
    r.up(150, 100);
    const [pen] = r.shapes();
    assert.equal(r.shapes().length, 1);
    assert.equal(pen!.kind, "pen");
    const points = pen!.kind === "pen" ? pen!.points.length / 2 : 0;
    assert.ok(points >= 24 && points <= 27, `${points} points reach the model from 101 samples`);
    assert.equal(r.undoAll(), 1);
  });

  test("Escape writes nothing", async () => {
    const r = await rig();
    r.tool("pen");
    r.down(100, 100);
    r.move(150, 150);
    r.input.frame();
    r.keyDown("Escape");
    r.up(150, 150);
    assert.equal(r.shapes().length, 0);
    assert.equal(r.board.view().canUndo, false);
  });

  test("a second touch cancels the stroke and starts a pinch", async () => {
    const r = await rig();
    r.tool("pen");
    r.down(300, 300, { pointerId: 1, kind: "touch" });
    r.move(310, 310, { pointerId: 1, kind: "touch" });
    r.input.frame();
    r.down(400, 300, { pointerId: 2, kind: "touch" });
    r.move(500, 300, { pointerId: 2, kind: "touch" });
    r.input.frame();
    assert.equal(r.shapes().length, 0, "the stroke was cancelled");
    const spread = Math.hypot(190, 10) / Math.hypot(90, 10);
    assert.ok(Math.abs(r.board.view().viewport.zoom - spread) < 1e-9, "the fingers moved apart: zoom follows the distance");
    r.up(500, 300, { pointerId: 2, kind: "touch" });
    r.up(310, 310, { pointerId: 1, kind: "touch" });
    assert.equal(r.board.view().canUndo, false);
  });
});

describe("text", () => {
  test("a click opens the editor, typing then commit creates one text of its natural size", async () => {
    const r = await rig();
    r.tool("text");
    r.click(200, 200);
    const editing = r.input.ui().editing;
    assert.notEqual(editing, null, "the editor is open");
    assert.equal(editing!.target, null);
    r.input.send({ type: "text-input", draft: "hello" });
    r.input.send({ type: "text-commit" });
    const [made] = r.shapes();
    assert.equal(r.shapes().length, 1);
    const natural = naturalSize("hello", editing!.fontSize, fixedPitch);
    assert.deepEqual([made!.kind, made!.w, made!.h], ["text", natural.w, natural.h]);
    assert.deepEqual(r.selected(), [made!.id]);
    assert.equal(r.input.ui().editing, null);
    assert.equal(r.input.ui().tool, "select");
    assert.equal(r.undoAll(), 1);
  });

  test("a blank commit creates nothing", async () => {
    const r = await rig();
    r.tool("text");
    r.click(200, 200);
    r.input.send({ type: "text-input", draft: "  " });
    r.input.send({ type: "text-commit" });
    assert.equal(r.shapes().length, 0);
    assert.equal(r.board.view().canUndo, false);
  });

  test("editing a text changes text, w and h in one undo step", async () => {
    const r = await rig([text()]);
    const [t] = r.ids;
    r.input.send({ type: "dblclick", p: { pointerId: 1, kind: "mouse", button: 0, screen: { x: 110, y: 110 }, shift: false, alt: false, mod: false, t: 1 } });
    assert.equal(r.input.ui().editing!.target, t);
    assert.equal(r.input.overlay().editing, t, "the scene skips the text under the editor");
    r.input.send({ type: "text-input", draft: "hello\nworld!" });
    r.input.send({ type: "text-commit" });
    assert.deepEqual([r.at(t!).kind === "text" && (r.at(t!) as Extract<Shape, { kind: "text" }>).text, r.at(t!).w, r.at(t!).h], ["hello\nworld!", 72, 50]);
    assert.equal(r.board.undo(), true);
    const restored = r.at(t!) as Extract<Shape, { kind: "text" }>;
    assert.deepEqual([restored.text, restored.w, restored.h], ["hello", 60, 25], "one undo restores the text and its box");
  });

  test("an empty draft removes the text", async () => {
    const r = await rig([text()]);
    r.input.send({ type: "do", action: { type: "selectAll" } });
    assert.equal(r.input.send({ type: "do", action: { type: "editText" } }), true);
    r.input.send({ type: "text-input", draft: "" });
    r.input.send({ type: "text-commit" });
    assert.equal(r.shapes().length, 0);
  });

  test("a pointer-down while editing commits and does not select", async () => {
    const r = await rig([box("rect", 400, 400, 50, 50)]);
    r.tool("text");
    r.click(200, 200);
    r.input.send({ type: "text-input", draft: "x" });
    r.down(420, 420);
    r.up(420, 420);
    const text = r.shapes().find((s) => s.kind === "text")!;
    assert.deepEqual(r.selected(), [text.id], "the new text is selected, not the rect under the click");
  });
});

describe("viewport", () => {
  test("ctrl-wheel zooms about the pointer, a plain wheel pans", async () => {
    const r = await rig();
    const before = toBoard(r.board.view().viewport, { x: 400, y: 300 });
    r.input.send({ type: "wheel", screen: { x: 400, y: 300 }, dx: 0, dy: -100, zoom: true });
    const zoomed = r.board.view().viewport;
    assert.ok(zoomed.zoom > 1);
    const after = toBoard(zoomed, { x: 400, y: 300 });
    assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
    r.input.send({ type: "wheel", screen: { x: 0, y: 0 }, dx: 0, dy: 100, zoom: false });
    assert.ok(r.board.view().viewport.y > zoomed.y, "scrolling down shows lower board");
  });

  test("a wheel mid-drag re-aims: the shape stays under the pointer", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50)]);
    const [a] = r.ids;
    r.down(120, 120);
    r.move(140, 120);
    r.input.frame();
    r.input.send({ type: "wheel", screen: { x: 140, y: 120 }, dx: 50, dy: 0, zoom: false });
    r.input.frame();
    assert.equal(r.at(a!).x, 170);
    r.up(140, 120);
  });

  test("space plus a drag pans and creates nothing", async () => {
    const r = await rig();
    r.keyDown(" ");
    r.drag([100, 100], [160, 130]);
    r.keyUp(" ");
    const v = r.board.view().viewport;
    assert.deepEqual([v.x, v.y], [-60, -30]);
    assert.equal(r.shapes().length, 0);
  });
});

describe("actions", () => {
  test("delete removes the selection, duplicate selects the copies 16 px away, reorder changes the order", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50), box("rect", 300, 100, 50, 50)]);
    const [a, b] = r.ids;
    r.click(120, 120);
    r.keyDown("d", { mod: true });
    const copy = r.selected()[0]!;
    assert.deepEqual([r.at(copy).x, r.at(copy).y], [116, 116]);
    r.input.send({ type: "do", action: { type: "reorder", to: "back" } });
    assert.equal(r.board.view().order[0], copy);
    r.keyDown("Delete");
    assert.deepEqual([...r.board.view().order], [a, b]);
  });

  test("a held arrow key is one gesture and one undo step", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50)]);
    const [a] = r.ids;
    r.click(120, 120);
    r.keyDown("ArrowRight");
    r.keyDown("ArrowRight", { repeat: true });
    r.keyDown("ArrowDown", { shift: true });
    assert.equal(r.input.send({ type: "do", action: { type: "undo" } }), false, "other actions wait for the key to be released");
    r.keyUp("ArrowRight");
    assert.equal(r.at(a!).x, 102, "one key is still held");
    r.keyUp("ArrowDown");
    assert.deepEqual([r.at(a!).x, r.at(a!).y], [102, 110]);
    assert.equal(r.board.undo(), true);
    assert.deepEqual([r.at(a!).x, r.at(a!).y], [100, 100], "one undo reverts every key press");
  });

  test("blur mid-nudge reverts it", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50)]);
    const [a] = r.ids;
    r.click(120, 120);
    r.keyDown("ArrowLeft");
    r.input.send({ type: "abandon" });
    assert.equal(r.at(a!).x, 100);
    assert.doesNotThrow(() => r.board.undo());
  });

  test("a style action restyles the selection and the next shape drawn", async () => {
    const r = await rig([box("rect", 100, 100, 50, 50)]);
    const [a] = r.ids;
    r.click(120, 120);
    r.input.send({ type: "do", action: { type: "style", edit: { stroke: "#f00" } } });
    assert.equal(r.at(a!).stroke, "#f00");
    assert.equal(r.input.ui().style.stroke, "#f00");
    r.tool("rect");
    r.drag([300, 300], [350, 350]);
    assert.equal(r.shapes().at(-1)!.stroke, "#f00");
  });
});
