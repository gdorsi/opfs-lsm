import * as Y from "yjs";
import { BoardLoadError, boardDocName, openBoard } from "./board.ts";
import { systemEnv } from "./env.ts";
import { Saver } from "./save.ts";
import { boardId } from "./shapes.ts";
import type { Board, BoardId, BoardMeta, DocBinding, DocStorage, Env, SaveState, Workspace, WorkspaceOptions } from "./types.ts";

// Index doc "workspace": a top-level Y.Map "boards", BoardId -> Y.Map { title, createdAt, deleting? }.
// An edit never writes it: a board has no modifiedAt, so the list is ordered by createdAt.
const INDEX_DOC = "workspace";
const BOARDS = "boards";
const INDEX = Symbol("whiteboard-yjs.index");

type Entry = { readonly meta: BoardMeta; readonly deleting: boolean };
type Settings = Omit<WorkspaceOptions, "storage" | "env">;

/**
 * Loads the board list, finishes any board whose delete was interrupted, and resolves with the workspace ready.
 * An interrupted delete that still cannot finish (storage is failing) stays hidden and is tried again by the next
 * `openWorkspace`; it does not stop this one.
 */
export async function openWorkspace({ storage, env = systemEnv, ...settings }: WorkspaceOptions): Promise<Workspace> {
  const doc = new Y.Doc();
  let binding: DocBinding;
  try {
    binding = await storage.attach(INDEX_DOC, doc);
  } catch (error) {
    doc.destroy();
    throw error;
  }
  const workspace = new LiveWorkspace(doc, binding, storage, env, settings);
  await workspace.resume();
  return workspace;
}

/** The boundary: one stored index entry. Undefined for anything the workspace could not have written. */
function readEntry(id: BoardId, fields: unknown): Entry | undefined {
  const raw: unknown = fields instanceof Y.Map ? fields.toJSON() : undefined;
  if (typeof raw !== "object" || raw === null) return undefined;
  const { title, createdAt, deleting } = raw as Record<string, unknown>;
  if (typeof title !== "string" || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
  return { meta: { id, title, createdAt }, deleting: deleting === true };
}

const byCreated = (a: BoardMeta, b: BoardMeta): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const same = (a: readonly BoardMeta[], b: readonly BoardMeta[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.title === b[i]!.title && x.createdAt === b[i]!.createdAt);

class LiveWorkspace implements Workspace {
  private readonly doc: Y.Doc;
  private readonly binding: DocBinding;
  private readonly storage: DocStorage;
  private readonly env: Env;
  private readonly settings: Settings;
  private readonly index: Y.Map<unknown>;
  private readonly saver: Saver;
  private readonly unsync: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly open = new Map<BoardId, Promise<Board>>();
  private readonly finishing = new Map<BoardId, Promise<void>>();

  private list: readonly BoardMeta[] = [];
  private known: ReadonlyMap<BoardId, BoardMeta> = new Map();
  private dying: readonly BoardId[] = [];
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(doc: Y.Doc, binding: DocBinding, storage: DocStorage, env: Env, settings: Settings) {
    this.doc = doc;
    this.binding = binding;
    this.storage = storage;
    this.env = env;
    this.settings = settings;
    this.index = doc.getMap(BOARDS);
    this.saver = new Saver(binding, env.schedule, settings.autosaveMs, () => this.notify());
    this.reload();
    this.index.observeDeep(this.onIndexChanged);
    doc.on("update", this.onUpdate);
    this.unsync = settings.sync?.(INDEX_DOC, doc);
  }

  boards(): readonly BoardMeta[] {
    return this.list;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  save(): SaveState {
    return this.saver.state();
  }

  createBoard(title: string): BoardId {
    this.assertOpen();
    const id = boardId(this.env.id());
    const createdAt = this.env.now();
    this.doc.transact(() => this.index.set(id, new Y.Map<unknown>([["title", title], ["createdAt", createdAt]])), INDEX);
    return id;
  }

  renameBoard(id: BoardId, title: string): void {
    this.assertOpen();
    const entry = this.index.get(id);
    if (!(entry instanceof Y.Map) || entry.get("deleting") === true || entry.get("title") === title) return;
    this.doc.transact(() => entry.set("title", title), INDEX);
  }

  /**
   * Three steps, in this order, so that a crash after any of them leaves nothing listed without its data and no data
   * without a listing that will collect it:
   *  1. Mark the entry `deleting`, which hides it, and wait until the mark is stored.
   *  2. Clear the board's stored updates.
   *  3. Remove the entry, and wait until that is stored.
   * Each step reads the state that exists and does what is left, so any workspace that finds a mark finishes the delete.
   * Clearing first would leave a listed board with nothing in it. Removing the entry first would leave data nothing points to.
   */
  async deleteBoard(id: BoardId): Promise<void> {
    this.assertOpen();
    const entry = this.index.get(id);
    if (!(entry instanceof Y.Map)) return;
    if (entry.get("deleting") !== true) this.doc.transact(() => entry.set("deleting", true), INDEX);
    await this.finish(id);
  }

  openBoard(id: BoardId): Promise<Board> {
    if (this.closed) return Promise.reject(new BoardLoadError(id, { cause: new Error("the workspace is closed") }));
    const cached = this.open.get(id);
    if (cached) return cached;
    if (!this.known.has(id)) {
      return Promise.reject(new BoardLoadError(id, { cause: new Error("no such board in the workspace") }));
    }
    const forget = () => {
      if (this.open.get(id) === opening) this.open.delete(id);
    };
    const opening: Promise<Board> = openBoard({ id, storage: this.storage, env: this.env, ...this.settings, onClose: forget });
    this.open.set(id, opening);
    opening.catch(forget);
    return opening;
  }

  async flush(): Promise<void> {
    const boards = await Promise.all([...this.open.values()].map((opening) => opening.catch(() => undefined)));
    await Promise.all([this.saver.flush(), ...boards.map((board) => board?.flush())]);
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.shutDown();
    return this.closing;
  }

  /** Finishes every delete that was marked and not completed. Never rejects: a failed delete stays marked. */
  async resume(): Promise<void> {
    if (this.closed) return;
    await Promise.allSettled(this.dying.map((id) => this.finish(id)));
  }

  private finish(id: BoardId): Promise<void> {
    let running = this.finishing.get(id);
    if (!running) {
      running = this.finishOnce(id).finally(() => this.finishing.delete(id));
      this.finishing.set(id, running);
    }
    return running;
  }

  private async finishOnce(id: BoardId): Promise<void> {
    await this.saver.flush();
    const opening = this.open.get(id);
    if (opening) await opening.then((board) => board.close(), () => undefined);
    const doc = new Y.Doc();
    try {
      const binding = await this.storage.attach(boardDocName(id), doc);
      await binding.clear();
    } finally {
      doc.destroy();
    }
    this.doc.transact(() => this.index.delete(id), INDEX);
    await this.saver.flush();
  }

  private async shutDown(): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await Promise.allSettled([...this.finishing.values()]);
    await Promise.all([...this.open.values()].map((opening) => attempt(() => opening.then((board) => board.close(), () => undefined))));
    this.saver.close();
    this.unsync?.();
    await attempt(() => this.binding.detach());
    this.index.unobserveDeep(this.onIndexChanged);
    this.doc.off("update", this.onUpdate);
    this.doc.destroy();
    this.listeners.clear();
    if (failures.length > 0) throw failures[0];
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("the workspace is closed");
  }

  private readonly onUpdate = (update: Uint8Array): void => {
    this.settings.meter?.(INDEX_DOC, update);
    this.saver.touch();
  };

  private readonly onIndexChanged = (): void => {
    if (this.reload()) this.notify();
    // After the transaction has ended, so the update that carries a delete mark is already on its way to storage.
    void Promise.resolve().then(() => this.resume());
  };

  /** Reads the index again. True when the visible list changed. */
  private reload(): boolean {
    const visible: BoardMeta[] = [];
    const dying: BoardId[] = [];
    this.index.forEach((fields, key) => {
      const entry = readEntry(boardId(key), fields);
      if (!entry) return;
      if (entry.deleting) dying.push(entry.meta.id);
      else visible.push(entry.meta);
    });
    visible.sort(byCreated);
    this.dying = dying;
    if (same(this.list, visible)) return false;
    this.list = visible;
    this.known = new Map(visible.map((meta) => [meta.id, meta]));
    return true;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
