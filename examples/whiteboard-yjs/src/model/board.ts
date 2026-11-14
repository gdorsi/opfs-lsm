import * as Y from "yjs";
import { applyPatch, readShape, readShapes, shapesOf, watch } from "./doc.ts";
import { systemEnv } from "./env.ts";
import { trackFor, type Track } from "./gesture.ts";
import { plan, toApplied, type Scene } from "./plan.ts";
import { Saver } from "./save.ts";
import { shapeId } from "./shapes.ts";
import { byZ } from "./zorder.ts";
import type {
  Applied,
  Board,
  BoardId,
  BoardOptions,
  BoardView,
  Command,
  DocBinding,
  Env,
  Gesture,
  GestureInput,
  GestureStart,
  Patch,
  Shape,
  ShapeId,
  Viewport,
} from "./types.ts";

const UNDO_LIMIT = 100;
const GESTURE_INTERVAL_MS = 32;
const LOCAL = Symbol("whiteboard-yjs.local");
const HOME: Viewport = { x: 0, y: 0, zoom: 1 };

const boardDocName = (id: BoardId): string => `board/${id}`;

type Kind = GestureStart["kind"];
type Settings = Omit<BoardOptions, "id" | "storage" | "env">;

/** A gesture the board is running: its track, whether its undo step is open, and when it last wrote. */
type LiveGesture<K extends Kind> = { readonly track: Track<K>; opened: boolean; lastWriteT: number | undefined };

export class BoardLoadError extends Error {
  override name = "BoardLoadError";
  readonly boardId: BoardId;
  constructor(boardId: BoardId, options: { cause: unknown }) {
    super(`could not load board ${boardId}`, options);
    this.boardId = boardId;
  }
}

/** Loads the board's stored updates into a new Y.Doc and keeps storing every later one. Rejects with BoardLoadError. */
export async function openBoard({ id, storage, env = systemEnv, ...settings }: BoardOptions): Promise<Board> {
  const doc = new Y.Doc();
  let binding: DocBinding;
  try {
    binding = await storage.attach(boardDocName(id), doc);
  } catch (cause) {
    doc.destroy();
    throw new BoardLoadError(id, { cause });
  }
  return new LiveBoard(id, doc, binding, env, settings);
}

class LiveBoard implements Board {
  readonly id: BoardId;
  private readonly doc: Y.Doc;
  private readonly binding: DocBinding;
  private readonly env: Env;
  private readonly history: Y.UndoManager;
  private readonly unwatch: () => void;
  private readonly unsync: (() => void) | undefined;
  private readonly saver: Saver;
  private readonly settings: Settings;
  private readonly listeners = new Set<() => void>();

  private readonly shapes: Map<ShapeId, Shape>;
  private readonly bad: Set<ShapeId>;
  private order: ShapeId[];
  private orderShared = false;
  private selection: ReadonlySet<ShapeId> = new Set();
  private viewport = HOME;
  private current: BoardView;

  private gesture: LiveGesture<Kind> | undefined;
  private depth = 0;
  private dirty = false;
  private closing: Promise<void> | undefined;

  constructor(id: BoardId, doc: Y.Doc, binding: DocBinding, env: Env, settings: Settings) {
    this.id = id;
    this.doc = doc;
    this.binding = binding;
    this.env = env;
    this.settings = settings;
    this.saver = new Saver(binding, env.schedule, settings.autosaveMs, () => this.changed());
    const { shapes, bad } = readShapes(doc);
    this.shapes = shapes;
    this.bad = bad;
    this.order = [...shapes.values()].sort(byZ).map((s) => s.id);
    // stopCapturing() opens a step: at a command, or at the first write of a gesture. Infinity keeps every later write
    // of it in that step. Yjs times steps with the real clock, so any finite timeout splits a drag that runs long.
    this.history = new Y.UndoManager(shapesOf(doc), { trackedOrigins: new Set([LOCAL]), captureTimeout: Infinity });
    this.unwatch = watch(doc, (ids) => this.onChanged(ids));
    doc.on("update", this.onUpdate);
    this.unsync = settings.sync?.(boardDocName(id), doc);
    this.current = this.snapshot();
  }

  view(): BoardView {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  dispatch(command: Command): Applied {
    this.assertIdle();
    const patch = plan(this.current, command, () => shapeId(this.env.id()));
    if (patch.size === 0) return { patch, created: [] };
    this.makeRoom();
    this.history.stopCapturing();
    this.batch(() => applyPatch(this.doc, patch, LOCAL));
    return toApplied(patch);
  }

  select(ids: Iterable<ShapeId>): void {
    const next = new Set<ShapeId>();
    for (const id of ids) if (this.shapes.has(id)) next.add(id);
    if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id))) return;
    this.selection = next;
    this.changed();
  }

  setViewport(viewport: Viewport): void {
    const now = this.viewport;
    if (viewport.x === now.x && viewport.y === now.y && viewport.zoom === now.zoom) return;
    this.viewport = viewport;
    this.changed();
  }

  undo(): boolean {
    this.assertIdle();
    if (!this.history.canUndo()) return false;
    return this.batch(() => this.history.undo()) !== null;
  }

  redo(): boolean {
    this.assertIdle();
    if (!this.history.canRedo()) return false;
    return this.batch(() => this.history.redo()) !== null;
  }

  flush(): Promise<void> {
    return this.saver.flush();
  }

  beginGesture<K extends Kind>(start: Extract<GestureStart, { kind: K }>): Gesture<K> {
    this.assertIdle();
    const live: LiveGesture<K> = {
      track: trackFor(start, this.scene(), () => shapeId(this.env.id())),
      opened: false,
      lastWriteT: undefined,
    };
    this.gesture = live;
    return {
      update: (input, t) => this.updateGesture(live, input, t),
      end: () => this.endGesture(live),
      cancel: () => this.cancelGesture(live),
    };
  }

  private updateGesture<K extends Kind>(live: LiveGesture<K>, input: GestureInput[K], t: number): void {
    this.assertLive(live);
    live.track.aim(input);
    const interval = this.settings.gestureIntervalMs ?? GESTURE_INTERVAL_MS;
    const due = Number.isFinite(interval) && (live.lastWriteT === undefined || t - live.lastWriteT >= interval);
    this.batch(() => {
      for (const shape of live.track.shown(this.scene())) this.show(shape);
      if (due) {
        live.lastWriteT = t;
        this.store(live, live.track.due(this.scene()));
      }
    });
  }

  private endGesture<K extends Kind>(live: LiveGesture<K>): Applied {
    this.assertLive(live);
    this.gesture = undefined;
    const { net, rest } = live.track.finish(this.scene());
    if (net.size === 0) this.revert(live);
    else this.batch(() => this.store(live, rest));
    return toApplied(net);
  }

  private cancelGesture<K extends Kind>(live: LiveGesture<K>): void {
    this.assertLive(live);
    this.gesture = undefined;
    this.revert(live);
  }

  /** Writes to the doc under the gesture's undo step. The first write opens it, so a gesture that writes nothing leaves none. */
  private store(live: LiveGesture<Kind>, patch: Patch): void {
    if (patch.size === 0) return;
    if (!live.opened) {
      live.opened = true;
      this.makeRoom();
      this.history.stopCapturing();
    }
    applyPatch(this.doc, patch, LOCAL);
  }

  /** Undoes what the gesture wrote, drops its redo entry, and shows the doc again where the gesture had laid a preview. */
  private revert(live: LiveGesture<Kind>): void {
    const ids = new Set(live.track.touched());
    if (!live.opened && ids.size === 0) return;
    this.batch(() => {
      if (live.opened) {
        this.history.undo();
        this.history.clear(false, true);
      }
      this.onChanged(ids);
    });
  }

  /** Lays one shape of a gesture's preview over the view. The doc does not see it. */
  private show(shape: Shape): void {
    const known = this.shapes.has(shape.id);
    this.shapes.set(shape.id, shape);
    if (!known) this.orderInsert(shape);
    this.changed();
  }

  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    try {
      if (this.gesture) {
        const live = this.gesture;
        this.gesture = undefined;
        this.revert(live);
      }
      this.saver.close();
      this.unsync?.();
      await this.binding.detach();
    } finally {
      this.doc.off("update", this.onUpdate);
      this.unwatch();
      this.history.destroy();
      this.doc.destroy();
      this.listeners.clear();
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new Error(`board ${this.id} is closed`);
  }

  private assertIdle(): void {
    this.assertOpen();
    if (this.gesture) throw new Error(`board ${this.id} has a gesture in progress`);
  }

  private assertLive(live: LiveGesture<Kind>): void {
    if (this.gesture !== live) throw new Error("the gesture is over");
  }

  private scene(): Scene {
    return { shapes: this.shapes, order: this.order };
  }

  private readonly onUpdate = (update: Uint8Array): void => {
    this.settings.meter?.(boardDocName(this.id), update);
    this.saver.touch();
  };

  /** Runs a write that changes the view and publishes the view once, after it. */
  private batch<T>(write: () => T): T {
    this.depth++;
    this.dirty = true;
    try {
      return write();
    } finally {
      if (--this.depth === 0) this.publish();
    }
  }

  private changed(): void {
    this.dirty = true;
    if (this.depth === 0) this.publish();
  }

  private publish(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.current = this.snapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private snapshot(): BoardView {
    this.orderShared = true;
    return {
      id: this.id,
      shapes: this.shapes,
      order: this.order,
      selection: this.selection,
      viewport: this.viewport,
      canUndo: this.history.undoStack.length > 0,
      canRedo: this.history.redoStack.length > 0,
      save: this.saver.state(),
      skipped: this.bad.size,
    };
  }

  private onChanged(ids: ReadonlySet<ShapeId>): void {
    let removed = false;
    for (const id of ids) {
      const prev = this.shapes.get(id);
      const next = readShape(this.doc, id);
      if (prev && (typeof next === "string" || next.z !== prev.z)) this.orderRemove(prev);
      if (typeof next === "string") {
        if (prev) {
          this.shapes.delete(id);
          removed = true;
        }
        if (next === "bad") this.bad.add(id);
        else this.bad.delete(id);
      } else {
        this.shapes.set(id, next);
        this.bad.delete(id);
        if (!prev || next.z !== prev.z) this.orderInsert(next);
      }
    }
    if (removed && this.selection.size > 0) {
      this.selection = new Set([...this.selection].filter((id) => this.shapes.has(id)));
    }
    this.changed();
  }

  private mutableOrder(): ShapeId[] {
    if (this.orderShared) {
      this.order = this.order.slice();
      this.orderShared = false;
    }
    return this.order;
  }

  private orderInsert(shape: Shape): void {
    const at = this.lowerBound(shape);
    this.mutableOrder().splice(at, 0, shape.id);
  }

  private orderRemove(shape: Shape): void {
    const at = this.lowerBound(shape);
    this.mutableOrder().splice(at, 1);
  }

  /** Index of the first id that sorts at or after `shape`. */
  private lowerBound(shape: Shape): number {
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (byZ(this.shapes.get(this.order[mid]!)!, shape) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Dropping the oldest step bounds the stack. What it deleted stays in the doc until the next load. */
  private makeRoom(): void {
    const stack = this.history.undoStack;
    if (stack.length >= UNDO_LIMIT) stack.shift();
  }
}
