import {
  type Repo,
  generateAutomergeUrl,
  isValidDocumentId,
  parseAutomergeUrl,
  type DocHandle,
  type DocHandleChangePayload,
  type DocumentId,
  type DocumentProgress,
  type QueryState,
} from "@automerge/automerge-repo";
import { PagesError } from "./errors.ts";
import type { SaveEvent, SaveFilter } from "./save-filter.ts";
import { SEED } from "./seed.ts";
import { applyEdits, toSpans, toTextEdits, type BodyDoc } from "./text-edits.ts";
import type { PageBody, PageId, SaveState, Span, TextEdit, View } from "./types.ts";

export interface Bodies {
  /**
   * Find-or-seed. A body that storage does not hold starts from the seed at
   * once, without waiting on the network; any copy a peer holds merges in
   * later. Rejects with `storage` when the stored body cannot be read.
   * Opening an id that is already open returns the same body; opening one
   * that is closing waits for the close, then loads it again.
   */
  open(id: PageId): Promise<PageBody>;
  /**
   * Deletes the body from this device and resolves once its keys are gone.
   * An open copy turns `removed`, and any copy the Repo holds, opened here or
   * synced from a peer, leaves memory, so no tab that joins later receives it.
   * Saves of the id are dropped for the rest of this Repo's life, so a peer's
   * copy cannot write it back. Idempotent.
   */
  remove(id: PageId): Promise<void>;
}

export function newPageId(): PageId {
  return parseAutomergeUrl(generateAutomergeUrl()).documentId;
}

export function parsePageId(raw: unknown): PageId | null {
  return isValidDocumentId(raw) ? raw : null;
}

export function openBodies(repo: Repo, storage: SaveFilter): Bodies & { close(): Promise<void> } {
  const open = new Map<PageId, Promise<Body>>();
  const closing = new Map<PageId, Promise<void>>();
  const onClosing = (id: PageId, done: Promise<void>) => {
    open.delete(id);
    closing.set(id, done);
    const forget = () => closing.get(id) === done && closing.delete(id);
    done.then(forget, forget);
  };
  return {
    open(id) {
      let body = open.get(id);
      if (!body) {
        const opened: Promise<Body> = (closing.get(id) ?? Promise.resolve())
          .catch(() => {})
          .then(() => findOrSeed<BodyDoc>(repo, storage, id, SEED))
          .then(({ handle, seeded }) => new Body(id, handle, repo, storage, seeded, (done) => onClosing(id, done)));
        body = opened;
        open.set(id, opened);
        opened.catch(() => open.get(id) === opened && open.delete(id));
      }
      return body;
    },
    async remove(id) {
      storage.block(id);
      const body = open.get(id);
      if (body) await (await body.catch(() => null))?.discard();
      await closing.get(id)?.catch(() => {});
      await repo.removeFromCache(id);
      await storage.idle(id);
      await storage.removeRange([id]);
    },
    async close() {
      await Promise.allSettled([...[...open.values()].map(async (body) => (await body).close()), ...closing.values()]);
    },
  };
}

export async function findOrSeed<T>(
  repo: Repo,
  storage: SaveFilter,
  id: DocumentId,
  seed: Uint8Array,
): Promise<{ handle: DocHandle<T>; seeded: boolean }> {
  const state = await storageAnswered(repo.findWithProgress<T>(id));
  if (state.state === "ready") return { handle: state.handle, seeded: false };
  if (state.state === "failed") throw new PagesError("storage", `cannot open ${id}`, { cause: state.error });
  if (storage.loadFailed(id)) {
    await repo.removeFromCache(id);
    throw new PagesError("storage", `cannot read ${id}`);
  }
  // Importing over a stored doc that is not loaded yet would hide it, so seed only once storage said it has none.
  return { handle: repo.import<T>(seed, { docId: id }), seeded: true };
}

export async function flushDoc(repo: Repo, storage: SaveFilter, id: DocumentId): Promise<void> {
  // A save already in flight covers what it can; waiting for it keeps the flush from writing the same chunk twice.
  await storage.idle(id);
  try {
    await repo.flush([id]);
  } catch (error) {
    throw new PagesError("storage", `cannot save ${id}`, { cause: error });
  }
}

function storageAnswered<T>(progress: DocumentProgress<T>): Promise<QueryState<T>> {
  const answered = (state: QueryState<T>) => state.state !== "loading" || state.sources.storage === "unavailable";
  const now = progress.peek();
  if (answered(now)) return Promise.resolve(now);
  return new Promise((resolve) => {
    const stop = progress.subscribe((state) => {
      if (!answered(state)) return;
      stop();
      resolve(state);
    });
  });
}

const SAVED: SaveState = { state: "saved" };
const SAVING: SaveState = { state: "saving" };
const REMOVED: SaveState = { state: "removed" };

class Body implements PageBody {
  readonly id: PageId;
  readonly save: View<SaveState>;
  readonly #handle: DocHandle<BodyDoc>;
  readonly #repo: Repo;
  readonly #storage: SaveFilter;
  readonly #onClosing: (done: Promise<void>) => void;
  readonly #listeners = new Set<(edits: readonly TextEdit[]) => void>();
  readonly #stops: (() => void)[];
  #applyingLocal = false;
  #closing: Promise<void> | null = null;

  /** A change no started save covers yet. A save covers every change made before it starts. */
  #dirty: boolean;
  #saving = 0;
  /** The error state of the last chunk save that failed, until one succeeds. */
  #failure: SaveState | null = null;
  #saveState: SaveState;
  readonly #saveListeners = new Set<() => void>();

  constructor(id: PageId, handle: DocHandle<BodyDoc>, repo: Repo, storage: SaveFilter, seeded: boolean, onClosing: (done: Promise<void>) => void) {
    this.id = id;
    this.#handle = handle;
    this.#repo = repo;
    this.#storage = storage;
    this.#onClosing = onClosing;
    this.#dirty = seeded;
    this.#saveState = seeded ? SAVING : SAVED;
    this.save = {
      read: () => this.#saveState,
      subscribe: (listener) => {
        this.#saveListeners.add(listener);
        return () => this.#saveListeners.delete(listener);
      },
    };

    const onHeads = () => {
      this.#dirty = true;
      this.#updateSaveState();
    };
    const onChange = ({ patches, patchInfo }: DocHandleChangePayload<BodyDoc>) => {
      if (this.#applyingLocal || this.#listeners.size === 0) return;
      const edits = toTextEdits(patches, patchInfo.after);
      if (edits.length > 0) for (const listener of this.#listeners) listener(edits);
    };
    handle.on("heads-changed", onHeads);
    handle.on("change", onChange);
    this.#stops = [
      () => handle.off("heads-changed", onHeads),
      () => handle.off("change", onChange),
      storage.watch(id, (event, error) => this.#onSave(event, error)),
    ];
  }

  spans(): readonly Span[] {
    return toSpans(this.#handle.fullDoc());
  }

  edit(edits: readonly TextEdit[]): void {
    if (this.#closing) throw new PagesError("invalid", `body ${this.id} is closed`);
    if (edits.length === 0) return;
    this.#applyingLocal = true;
    try {
      applyEdits((fn, options) => this.#handle.change(fn, options), edits);
    } catch (error) {
      throw error instanceof PagesError ? error : new PagesError("invalid", String(error), { cause: error });
    } finally {
      this.#applyingLocal = false;
    }
  }

  subscribe(listener: (edits: readonly TextEdit[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  flush(): Promise<void> {
    return flushDoc(this.#repo, this.#storage, this.id);
  }

  close(): Promise<void> {
    return this.#end(async () => {
      try {
        await this.flush();
      } finally {
        await this.#drop();
      }
    });
  }

  discard(): Promise<void> {
    if (!this.#closing) {
      this.#saveState = REMOVED;
      for (const listener of this.#saveListeners) listener();
    }
    return this.#end(() => this.#drop());
  }

  #end(run: () => Promise<void>): Promise<void> {
    if (!this.#closing) {
      this.#closing = run();
      this.#onClosing(this.#closing);
    }
    return this.#closing;
  }

  async #drop(): Promise<void> {
    for (const stop of this.#stops) stop();
    this.#listeners.clear();
    await this.#repo.removeFromCache(this.id);
  }

  #onSave(event: SaveEvent, error: unknown): void {
    if (event === "start") {
      this.#dirty = false;
      this.#saving++;
    } else {
      this.#saving--;
      this.#failure =
        event === "failed" ? { state: "error", error: new PagesError("storage", `cannot save body ${this.id}`, { cause: error }) } : null;
    }
    this.#updateSaveState();
  }

  #updateSaveState(): void {
    if (this.#saveState === REMOVED) return;
    const next = this.#failure ?? (this.#dirty || this.#saving > 0 ? SAVING : SAVED);
    if (next === this.#saveState) return;
    this.#saveState = next;
    for (const listener of this.#saveListeners) listener();
  }
}
