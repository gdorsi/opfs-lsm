import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openBoard } from "../../src/model/board.ts";
import { boardId } from "../../src/model/shapes.ts";
import type { Board, Env, NewShape, SaveState } from "../../src/model/types.ts";
import { openWorkspace } from "../../src/model/workspace.ts";
import { BACKENDS, collectUnhandled, disk } from "../support/disk.ts";
import { idCounter } from "../support/env.ts";

const rect: NewShape = { kind: "rect", x: 0, y: 0, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 };
const AUTOSAVE_MS = 5;

/** The real clock and real timers: a real adapter acks a write on real time, which a virtual clock cannot wait for. */
const realEnv = (prefix: string): Env => ({
  id: idCounter(prefix),
  now: Date.now,
  schedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`never happened: ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function watch(read: () => SaveState["kind"], subscribe: (listener: () => void) => () => void): SaveState["kind"][] {
  const seen = [read()];
  subscribe(() => seen.at(-1) === read() || seen.push(read()));
  return seen;
}

for (const backend of BACKENDS) {
  if (backend === "memory") continue;
  describe(`the save state on ${backend}`, () => {
    test("a board goes saving, error, saved when the disk fails and then recovers", async (t) => {
      const unhandled = collectUnhandled(t);
      const d = disk(backend);
      const board: Board = await openBoard({ id: boardId("s"), storage: d.storage, env: realEnv("s"), autosaveMs: AUTOSAVE_MS });
      const seen = watch(() => board.view().save.kind, (listener) => board.subscribe(listener));

      board.dispatch({ type: "create", shapes: [rect] });
      assert.equal(board.view().save.kind, "saving");
      await until(() => board.view().save.kind === "saved", "the first edit is saved");

      d.failWrites!(true);
      board.dispatch({ type: "create", shapes: [rect] });
      await until(() => board.view().save.kind === "error", "the failed write shows as an error");
      board.dispatch({ type: "create", shapes: [rect] });
      assert.equal(board.view().save.kind, "error", "an edit does not hide the error");

      d.failWrites!(false);
      await until(() => board.view().save.kind === "saved", "autosave retries and saves");
      assert.deepEqual(seen, ["saved", "saving", "saved", "saving", "error", "saved"]);
      await board.close();

      const again = await openBoard({ id: boardId("s"), storage: d.storage, env: realEnv("t"), autosaveMs: null });
      assert.equal(again.view().shapes.size, 3, "the edit made while the disk was failing is stored");
      if (backend === "kv") assert.deepEqual(unhandled, []);
    });

    test("the board list does the same", async (t) => {
      collectUnhandled(t);
      const d = disk(backend);
      const ws = await openWorkspace({ storage: d.storage, env: realEnv("w"), autosaveMs: AUTOSAVE_MS });
      const kinds = watch(() => ws.save().kind, (listener) => ws.subscribe(listener));

      d.failWrites!(true);
      const id = ws.createBoard("A");
      await until(() => ws.save().kind === "error", "the failed write shows as an error");
      d.failWrites!(false);
      await until(() => ws.save().kind === "saved", "autosave retries and saves");
      assert.deepEqual(kinds, ["saved", "saving", "error", "saved"]);
      await ws.close();

      const again = await openWorkspace({ storage: d.storage, env: realEnv("x"), autosaveMs: null });
      assert.deepEqual(again.boards().map((b) => b.id), [id]);
      await again.close();
    });
  });
}
