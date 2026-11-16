import * as A from "@automerge/automerge";
import { Repo, type DocHandle, type DocMetrics, type NetworkAdapterInterface, type StorageAdapterInterface } from "@automerge/automerge-repo";
import { findOrSeed, flushDoc, newPageId, openBodies, type Bodies } from "./bodies.ts";
import { LIST_ID, MAX_TITLE, readTree, type ListDoc, type ListTree } from "./list.ts";
import { saveFilter } from "./save-filter.ts";
import { LIST_SEED } from "./seed.ts";
import type { PageId, Tree, View } from "./types.ts";

export type NotesOptions = {
  /** Caller-owned storage. The model never closes it. */
  readonly storage: StorageAdapterInterface;
  /** Network adapters, such as the tab link. Opening never waits on them. */
  readonly network?: readonly NetworkAdapterInterface[];
  /** How long the Repo waits after a change before it saves. Defaults to automerge-repo's 100 ms. */
  readonly saveDebounceMs?: number;
  /** Automerge's own work, as automerge-repo reports it: `doc-loaded`, `doc-saved` and `doc-compacted` carry `durationMillis`. */
  readonly onDocMetrics?: (metrics: DocMetrics) => void;
};

export interface Notes {
  /** `read` returns the same Tree until the list doc changes. */
  readonly tree: View<Tree>;
  /** One change, at the end of `parent`'s level. The body is seeded the first time the page opens. */
  createPage(parent: PageId | null): PageId;
  /** Caps the title at MAX_TITLE. No change when the page is not reachable or already has that title. */
  renamePage(id: PageId, title: string): void;
  /** One change that deletes the page and every entry not reachable once it is gone. */
  deletePage(id: PageId): void;
  readonly bodies: Bodies;
  /** Resolves once every list doc change made before the call is stored. */
  flush(): Promise<void>;
  /** Closes every open body, then the Repo. The caller's storage stays open. */
  close(): Promise<void>;
}

/**
 * Resolves once the list doc is found or seeded. Every tab removes the body of
 * every id it sees that is not reachable, once: at open and on each change.
 */
export async function openNotes(options: NotesOptions): Promise<Notes> {
  const storage = saveFilter(options.storage);
  const repo = new Repo({
    storage,
    network: [...(options.network ?? [])],
    ...(options.saveDebounceMs !== undefined && { saveDebounceRate: options.saveDebounceMs }),
  });
  if (options.onDocMetrics) repo.on("doc-metrics", options.onDocMetrics);
  let list: DocHandle<ListDoc>;
  try {
    ({ handle: list } = await findOrSeed<ListDoc>(repo, storage, LIST_ID, LIST_SEED));
  } catch (error) {
    await repo.shutdown();
    throw error;
  }
  const bodies = openBodies(repo, storage);

  let tree: ListTree = readTree(list.fullDoc().pages);
  const reclaimed = new Set<PageId>();
  let removing = Promise.resolve();
  const reclaim = (ids: Iterable<PageId>) => {
    const gone = [...new Set(ids)].filter((id) => !tree.page(id) && !reclaimed.has(id));
    if (gone.length === 0) return;
    for (const id of gone) reclaimed.add(id);
    removing = removing.then(async () => {
      for (const id of gone) await bodies.remove(id).catch((error: unknown) => console.warn(`notes: could not remove the body of ${id}`, error));
    });
  };

  reclaim(Object.keys(list.fullDoc().pages) as PageId[]);
  const listeners = new Set<() => void>();
  const onChange = () => {
    const before = tree;
    tree = readTree(list.fullDoc().pages, before);
    reclaim([...before.ids(), ...(Object.keys(list.fullDoc().pages) as PageId[])]);
    for (const listener of listeners) listener();
  };
  list.on("change", onChange);

  return {
    tree: {
      read: () => tree,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    createPage(parent) {
      const id = newPageId();
      const last = tree.children(parent).at(-1);
      const lastCreated = last ? list.fullDoc().pages[last]!.created : 0;
      list.change((d) => {
        d.pages[id] = { parent, title: "", created: Math.max(Date.now(), lastCreated + 1) };
      });
      return id;
    },
    renamePage(id, title) {
      const next = title.slice(0, MAX_TITLE);
      if ((tree.page(id)?.title ?? next) === next) return;
      list.change((d) => A.updateText(d, ["pages", id, "title"], next));
    },
    deletePage(id) {
      const gone = new Set(tree.subtree(id));
      if (gone.size === 0) return;
      const drop = Object.keys(list.fullDoc().pages).filter((key) => gone.has(key as PageId) || !tree.page(key as PageId));
      list.change((d) => {
        for (const key of drop) delete d.pages[key];
      });
    },
    bodies,
    flush: () => flushDoc(repo, storage, LIST_ID),
    async close() {
      list.off("change", onChange);
      await removing;
      await bodies.close();
      await repo.shutdown();
    },
  };
}
