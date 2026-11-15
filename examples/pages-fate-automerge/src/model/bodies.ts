/**
 * The bodies half of the headless model: one Repo over the save filter, and
 * an open `PageBody` per page.
 */
import {
  Repo,
  generateAutomergeUrl,
  parseAutomergeUrl,
  type DocHandle,
  type DocHandleChangePayload,
  type DocumentProgress,
  type NetworkAdapterInterface,
  type QueryState,
  type StorageAdapterInterface,
} from "@automerge/automerge-repo";
import { PagesError } from "./errors.ts";
import { saveFilter, type SaveEvent, type SaveFilter } from "./save-filter.ts";
import { SEED } from "./seed.ts";
import { applyEdits, toSpans, toTextEdits, type BodyDoc } from "./text-edits.ts";
import type { PageBody, PageId, SaveState, Span, TextEdit, View } from "./types.ts";

export type BodiesOptions = {
  /** Caller-owned body storage. The model never closes it. */
  readonly storage: StorageAdapterInterface;
  /** Network adapters, such as the server link and the tab link. `open` never waits on them. */
  readonly network?: readonly NetworkAdapterInterface[];
};

export interface Bodies {
  /**
   * Find-or-seed. A body that storage does not hold starts from the seed at
   * once, without waiting on the network; any copy a peer holds merges in
   * later. Rejects with `storage` when the stored body cannot be read.
   * Opening an id that is already open returns the same body.
   */
  open(id: PageId): Promise<PageBody>;
  /** Closes every open body, then the Repo. The caller's storage stays open. */
  close(): Promise<void>;
}

export function newPageId(): PageId {
  return parseAutomergeUrl(generateAutomergeUrl()).documentId;
}

export function openBodies(options: BodiesOptions): Bodies {
  const storage = saveFilter(options.storage);
  const repo = new Repo({ storage, network: [...(options.network ?? [])] });
  const open = new Map<PageId, Promise<PageBody>>();
  return {
    open(id) {
      let body = open.get(id);
      if (!body) {
        body = findOrSeed(repo, storage, id).then(
          ({ handle, seeded }) => new Body(id, handle, repo, storage, seeded, () => open.delete(id)),
        );
        open.set(id, body);
        body.catch(() => open.delete(id));
      }
      return body;
    },
    async close() {
      await Promise.allSettled([...open.values()].map(async (body) => (await body).close()));
      await repo.shutdown();
    },
  };
}

async function findOrSeed(
  repo: Repo,
  storage: SaveFilter,
  id: PageId,
): Promise<{ handle: DocHandle<BodyDoc>; seeded: boolean }> {
  const state = await storageAnswered(repo.findWithProgress<BodyDoc>(id));
  if (state.state === "ready") return { handle: state.handle, seeded: false };
  if (state.state === "failed") throw new PagesError("storage", `cannot open body ${id}`, { cause: state.error });
  if (storage.loadFailed(id)) {
    await repo.removeFromCache(id);
    throw new PagesError("storage", `cannot read body ${id}`);
  }
  // Importing over a stored body that is not loaded yet would hide it, so seed only once storage said it has none.
  return { handle: repo.import<BodyDoc>(SEED, { docId: id }), seeded: true };
}

/** Resolves once the doc has data or storage has said it holds none. Never waits on the network. */
function storageAnswered(progress: DocumentProgress<BodyDoc>): Promise<QueryState<BodyDoc>> {
  const answered = (state: QueryState<BodyDoc>) => state.state !== "loading" || state.sources.storage === "unavailable";
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

class Body implements PageBody {
  readonly id: PageId;
  readonly save: View<SaveState>;
  readonly #handle: DocHandle<BodyDoc>;
  readonly #repo: Repo;
  readonly #storage: SaveFilter;
  readonly #onClose: () => void;
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

  constructor(id: PageId, handle: DocHandle<BodyDoc>, repo: Repo, storage: SaveFilter, seeded: boolean, onClose: () => void) {
    this.id = id;
    this.#handle = handle;
    this.#repo = repo;
    this.#storage = storage;
    this.#onClose = onClose;
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

  async flush(): Promise<void> {
    // A save already in flight covers what it can; waiting for it keeps the flush from writing the same chunk twice.
    await this.#storage.idle(this.id);
    try {
      await this.#repo.flush([this.id]);
    } catch (error) {
      throw new PagesError("storage", `cannot save body ${this.id}`, { cause: error });
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      try {
        await this.flush();
      } finally {
        for (const stop of this.#stops) stop();
        this.#listeners.clear();
        await this.#repo.removeFromCache(this.id);
        this.#onClose();
      }
    })();
    return this.#closing;
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
    const next = this.#failure ?? (this.#dirty || this.#saving > 0 ? SAVING : SAVED);
    if (next === this.#saveState) return;
    this.#saveState = next;
    for (const listener of this.#saveListeners) listener();
  }
}
