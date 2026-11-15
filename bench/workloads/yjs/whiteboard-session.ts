import {
  applyPatchPlain,
  digestShapes,
  openWorkspace,
  scatterShape,
  type Board,
  type BoardId,
  type DocStorage,
  type Shape,
  type ShapeId,
  type Workspace,
} from "@opfs-lsm/example-whiteboard-yjs/model";
import type { YjsStore } from "../../core/families.ts";
import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { yieldTask } from "../../page/main-thread.ts";
import {
  EVENTS_PER_DRAG,
  EVENTS_PER_LASSO_DRAG,
  FRAME_MS,
  LASSO,
  editCommand,
  paceTo,
  pick,
  pointerPath,
  seededEnv,
} from "../whiteboard-lib.ts";

type Ctx = PhaseContext<"yjs">;

/** The workspace, the open board and the plain-data oracle: alive across the "same" phases of one tab. */
type Session = { readonly ws: Workspace; readonly board: Board; readonly oracle: Map<ShapeId, Shape> };
let session: Session | undefined;
let reopened: Session | undefined;

const SHAPES = { tiny: 100, small: 1_000, large: 5_000 } as const;
const DRAGS = { tiny: 3, small: 20, large: 100 } as const;
const LASSO_DRAGS = { tiny: 2, small: 5, large: 10 } as const;
const COMMANDS = { tiny: 100, small: 1_000, large: 1_000 } as const;
/** The board keeps 100 undo steps. */
const UNDO = { tiny: 20, small: 100, large: 100 } as const;

const live = (): Session => {
  if (!session) throw new Error("no open board: the earlier phase did not run in this tab");
  return session;
};

const storageOf = (store: YjsStore): DocStorage => ({ attach: (name, doc) => store.attach(name, doc) });

function phase(name: string, extra: Partial<Phase<"yjs">>, run: Phase<"yjs">["run"]): Phase<"yjs"> {
  return { name, page: "same", timed: true, ...extra, run };
}

/** Writes at pointer rate: `events` events at 120 Hz in real time, each timed as "move", then the drop's flush. */
async function dragOnce(ctx: Ctx, board: Board, oracle: Map<ShapeId, Shape>, ids: readonly ShapeId[], events: number): Promise<void> {
  const gesture = board.beginGesture({ kind: "translate", ids });
  const path = pointerPath(ctx.rng, events);
  const start = performance.now();
  for (const [i, input] of path.entries()) {
    await paceTo(start + i * FRAME_MS);
    await ctx.time("move", 0, async () => gesture.update(input, i * FRAME_MS));
  }
  const { patch } = gesture.end();
  applyPatchPlain(oracle, patch);
  await ctx.time("drop-flush", 0, () => board.flush());
}

/**
 * A session on one whiteboard: draw shapes, drag one, drag a lasso of 200, edit, undo and redo, flush, then reload
 * the tab and reopen the board. The headless model is the same for every contender; only the storage under it differs.
 * Pointer phases run in real time at 120 Hz with virtual event timestamps, so the model writes what it writes in an
 * app (a write every 32 ms of a drag). The board is compared with a plain-data oracle live and again after the reload.
 */
export default defineWorkload({
  family: "yjs",
  title: "whiteboard session: draw, drag, edit, undo, then reload and reopen the board",
  params: (size) => ({ entries: SHAPES[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 1, ops: 0, seed: 1 }),
  phases: [
    phase("draw", { mainThread: true }, async (ctx) => {
      const storage = storageOf(await ctx.store());
      const env = seededEnv(ctx.rng);
      const ws = await ctx.time("open-workspace", 0, () =>
        openWorkspace({ storage, env, autosaveMs: null, meter: (_doc, update) => ctx.bytes(update.byteLength) }),
      );
      const id = ws.createBoard("session");
      const board = await ctx.time("open-board", 0, () => ws.openBoard(id));
      const oracle = new Map<ShapeId, Shape>();
      session = { ws, board, oracle };
      for (let i = 0; i < ctx.params.entries; i++) {
        const shape = scatterShape(ctx.rng);
        const { patch } = await ctx.time("create", 0, async () => board.dispatch({ type: "create", shapes: [shape] }));
        applyPatchPlain(oracle, patch);
        await yieldTask();
      }
      ctx.carry.boardId = id;
    }),
    phase("drag", { mainThread: true }, async (ctx) => {
      const { board, oracle } = live();
      const ids = [...oracle.keys()];
      for (let d = 0; d < DRAGS[ctx.size]; d++) await dragOnce(ctx, board, oracle, [pick(ctx.rng, ids)], EVENTS_PER_DRAG);
    }),
    phase("multi-drag", { mainThread: true }, async (ctx) => {
      const { board, oracle } = live();
      const ids = [...oracle.keys()];
      const size = Math.min(LASSO, ids.length);
      for (let d = 0; d < LASSO_DRAGS[ctx.size]; d++) {
        const from = Math.floor(ctx.rng() * (ids.length - size + 1));
        await dragOnce(ctx, board, oracle, ids.slice(from, from + size), EVENTS_PER_LASSO_DRAG);
      }
    }),
    phase("edit-mix", { mainThread: true }, async (ctx) => {
      const { board, oracle } = live();
      for (let i = 0; i < COMMANDS[ctx.size]; i++) {
        const command = editCommand(ctx.rng, oracle);
        const { patch } = await ctx.time("command", 0, async () => board.dispatch(command));
        applyPatchPlain(oracle, patch);
        await yieldTask();
      }
      await ctx.time("flush", 0, () => board.flush());
    }),
    phase("undo-redo", { mainThread: true }, async (ctx) => {
      const { board } = live();
      const steps = UNDO[ctx.size];
      for (let i = 0; i < steps; i++) {
        ctx.check(await ctx.time("undo", 0, async () => board.undo()), `undo ${i} found no step`);
        await yieldTask();
      }
      for (let i = 0; i < steps; i++) {
        ctx.check(await ctx.time("redo", 0, async () => board.redo()), `redo ${i} found no step`);
        await yieldTask();
      }
      await ctx.time("flush", 0, () => board.flush());
    }),
    phase("check-live", { timed: false }, async (ctx) => {
      const { board, oracle } = live();
      const got = digestShapes(board.view().shapes);
      const want = digestShapes(oracle);
      ctx.check(got === want, `the live board is ${got}, the oracle ${want}`);
    }),
    phase("settle", { timed: false, footprint: true }, async (ctx) => {
      const { ws, board, oracle } = live();
      await ws.flush();
      ctx.carry.digest = digestShapes(oracle);
      ctx.carry.shapes = oracle.size;
      ctx.carry.liveLogicalBytes = JSON.stringify([...oracle.values()]).length;
      ctx.check(board.view().skipped === 0, "the live board skipped a stored shape");
      await ws.close();
      session = undefined;
      await (await ctx.store()).settle();
    }),
    phase("cold-open", { page: "fresh", mainThread: true }, async (ctx) => {
      const storage = storageOf(await ctx.store());
      const ws = await ctx.time("open-workspace", 0, () => openWorkspace({ storage, env: seededEnv(ctx.rng), autosaveMs: null }));
      const board = await ctx.time("open-board", 0, () => ws.openBoard(ctx.carry.boardId as BoardId));
      reopened = { ws, board, oracle: new Map() };
      await yieldTask();
    }),
    phase("check-cold", { timed: false }, async (ctx) => {
      if (!reopened) throw new Error("no reopened board: the cold-open phase did not run in this tab");
      const { ws, board } = reopened;
      const got = digestShapes(board.view().shapes);
      ctx.check(got === ctx.carry.digest, `the reopened board is ${got}, want ${String(ctx.carry.digest)}`);
      ctx.check(board.view().skipped === 0, `the reopened board skipped ${board.view().skipped} stored shapes`);
      const boards = ws.boards();
      ctx.check(boards.length === 1 && boards[0]!.id === ctx.carry.boardId && boards[0]!.title === "session", "the board list differs after the reload");
      await ws.close();
      reopened = undefined;
    }),
  ],
});
