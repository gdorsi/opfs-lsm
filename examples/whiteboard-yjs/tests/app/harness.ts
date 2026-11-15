import { openBoard } from "../../src/model/board.ts";
import { boardId } from "../../src/model/shapes.ts";
import type { Board, NewShape, Shape, ShapeId } from "../../src/model/types.ts";
import { createController, type Controller, type PointerSample } from "../../src/app/core/input.ts";
import type { KeySample } from "../../src/app/core/keys.ts";
import type { Measure } from "../../src/app/core/text.ts";
import { memoryStorage } from "../../src/persistence/index.ts";
import { idCounter, testEnv } from "../support/env.ts";

export const fixedPitch: Measure = (line, px) => line.length * px * 0.6;

export const box = (kind: "rect" | "ellipse" | "diamond", x: number, y: number, w: number, h: number): NewShape => ({
  kind,
  x,
  y,
  w,
  h,
  stroke: "#000",
  fill: "#ccc",
  strokeWidth: 2,
});

export async function rig(seed: readonly NewShape[] = [], wrap: (board: Board) => Board = (board) => board, fit = false) {
  const storage = memoryStorage();
  const open = () => openBoard({ id: boardId("t"), storage, env: testEnv(idCounter("s")), autosaveMs: null });
  const board = await open();
  const ids = seed.length > 0 ? board.dispatch({ type: "create", shapes: seed }).created : [];
  const seen = wrap(board);
  const input: Controller = createController(seen, { measure: fixedPitch });
  input.send({ type: "stage", size: { w: 800, h: 600 } });
  if (!fit) board.setViewport({ x: 0, y: 0, zoom: 1 });

  let t = 0;
  const sample = (x: number, y: number, over: Partial<PointerSample> = {}): PointerSample => ({
    pointerId: 1,
    kind: "mouse",
    button: 0,
    screen: { x, y },
    shift: false,
    alt: false,
    mod: false,
    t: (t += 16),
    ...over,
  });
  const key = (k: string, over: Partial<KeySample> = {}): KeySample => ({ key: k, mod: false, shift: false, alt: false, repeat: false, ...over });

  return {
    storage,
    board,
    input,
    ids,
    open,
    at: (id: ShapeId): Shape => board.view().shapes.get(id)!,
    shapes: (): Shape[] => board.view().order.map((id) => board.view().shapes.get(id)!),
    selected: (): ShapeId[] => [...board.view().selection],
    down: (x: number, y: number, over?: Partial<PointerSample>) => input.send({ type: "down", p: sample(x, y, over) }),
    move: (x: number, y: number, over?: Partial<PointerSample>) => input.send({ type: "move", p: sample(x, y, over) }),
    up: (x: number, y: number, over?: Partial<PointerSample>) => input.send({ type: "up", p: sample(x, y, over) }),
    drag(from: readonly [number, number], to: readonly [number, number], over?: Partial<PointerSample>) {
      this.down(from[0], from[1], over);
      this.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, over);
      input.frame();
      this.move(to[0], to[1], over);
      input.frame();
      return this.up(to[0], to[1], over);
    },
    click(x: number, y: number, over?: Partial<PointerSample>) {
      this.down(x, y, over);
      return this.up(x, y, over);
    },
    keyDown: (k: string, over?: Partial<KeySample>) => input.send({ type: "key", down: true, key: key(k, over), t: (t += 16) }),
    keyUp: (k: string, over?: Partial<KeySample>) => input.send({ type: "key", down: false, key: key(k, over), t: (t += 16) }),
    tool: (tool: "select" | "rect" | "ellipse" | "diamond" | "arrow" | "text" | "pen") =>
      input.send({ type: "do", action: { type: "tool", tool } }),
    undoAll(): number {
      let n = 0;
      while (board.undo()) n++;
      return n;
    },
  };
}
