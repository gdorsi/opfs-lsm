/**
 * The page tree on fate: the entity, its views, roots and mutations, and the
 * commands the app, the bench and the tests call. fate owns the tree and the
 * titles; the bodies live in Automerge (bodies.ts). A create writes fate
 * only: a page's body seeds the first time it opens.
 */
import { clientRoot, createClient, mutation, view, type RequestOptions, type Transport } from "@nkzw/fate";
import { createPersistence, type PersistenceStorage } from "@nkzw/fate/persistence";
import { newPageId, parsePageId, type Bodies } from "./bodies.ts";
import type { PageId } from "./types.ts";

/** fate's persistence key and the server's receipt scope, which fate requires to be equal. One workspace per server. */
export const PERSISTENCE_KEY = "pages:workspace";
export const MAX_TITLE = 500;
/** A sidebar level asks for this many children at a time. */
export const CHILDREN_PAGE = 200;

/** Levels and page headers paint from the device and refresh in the background, and stay a month for offline reloads. */
export const TREE_REQUEST = { mode: "stale-while-revalidate", persist: { maxAge: 30 * 24 * 3600 * 1000 } } as const satisfies RequestOptions;

/** No rank and no timestamps: siblings are in creation order until pages can move. */
export type PageEntity = {
  readonly __typename: "Page";
  readonly id: PageId;
  readonly parentId: PageId | null;
  readonly title: string;
};

export type NewPage = { readonly id: PageId; readonly parentId: PageId | null; readonly title: string };
export type Rename = { readonly id: PageId; readonly title: string };

// Every fate view of the app is declared here, at module top level, and nowhere else. A production build numbers
// views in declaration order and persisted request keys contain that number, so a view declared in a code-split
// route would change id with the order routes load in, and an offline reload would miss the cached sidebar.
export const PageRowView = view<PageEntity>()({ id: true, title: true });
export const PageHeaderView = view<PageEntity>()({ id: true, parentId: true, title: true });
export const ChildListView = { items: { node: PageRowView }, pagination: { hasNext: true, nextCursor: true } } as const;

const roots = {
  /** One list per parent; `parent: null` is the top level. */
  children: clientRoot<PageEntity[], "Page", { readonly parent: PageId | null; readonly first?: number; readonly after?: string }>("Page"),
  page: clientRoot<PageEntity, "Page">("Page"),
};
const mutations = {
  createPage: mutation<PageEntity, NewPage, PageEntity>("Page"),
  renamePage: mutation<PageEntity, Rename, PageEntity>("Page"),
  /** Removes the page and its subtree on the server, and succeeds for a missing id. */
  deletePage: mutation<PageEntity, { readonly id: PageId }, null>("Page"),
};

/** `first` is fixed, so each parent has exactly one cached list. */
export const childrenRequest = (parent: PageId | null) => ({ children: { list: ChildListView, args: { parent, first: CHILDREN_PAGE } } }) as const;
export const pageRequest = (id: PageId) => ({ page: { id, view: PageHeaderView } }) as const;

export type TreeClientOptions = {
  /** `createHTTPTransport({ url: "/api/fate", live: false })` in the app; the same over an in-process fetch in tests. */
  readonly transport: Transport;
  readonly storage: PersistenceStorage;
  /** Replaces `navigator.onLine`, which Node does not have. */
  readonly online?: () => boolean;
};

export function createTreeClient(options: TreeClientOptions) {
  return createClient<[typeof roots, typeof mutations]>({
    roots,
    mutations,
    types: [{ type: "Page" }],
    transport: options.transport as never,
    persistence: createPersistence({ key: PERSISTENCE_KEY, storage: options.storage, ...(options.online && { online: options.online }) }),
  });
}
export type Fate = ReturnType<typeof createTreeClient>;

declare module "@nkzw/fate" {
  interface ClientRegistration {
    client: Fate;
  }
}

type Pending = Promise<{ error?: Error }> & { readonly locallyPersisted: Promise<void> };

/**
 * Resolves once fate stored the mutation on the device. The server answers
 * later, maybe after a reload; a refusal rolls the change back and stays in
 * the journal as `failed` until it is discarded.
 */
function stored(what: string, pending: Pending): Promise<void> {
  pending.then(
    ({ error }) => error && console.warn(`pages: the server refused ${what}`, error),
    (error: unknown) => console.warn(`pages: ${what} failed`, error),
  );
  return pending.locallyPersisted;
}

/** The parent's cached child list, without a request. */
async function cachedChildren(fate: Fate, parent: PageId | null) {
  const observer = fate.observeRequest(childrenRequest(parent), { mode: "cache-only" });
  if (observer.getSnapshot().status === "pending") {
    await new Promise<void>((resolve) => {
      const stop = observer.subscribe(() => {
        if (observer.getSnapshot().status === "pending") return;
        stop();
        resolve();
      });
    });
  }
  const snapshot = observer.getSnapshot();
  return snapshot.status === "ready" ? snapshot.data?.children : undefined;
}

/**
 * Creates an untitled page at the end of `parent`'s children. fate inserts
 * only into a list it holds, so an uncached parent's list is asked for once;
 * when the server cannot answer, the page shows once the server confirms it.
 */
export async function createPage(fate: Fate, at: { readonly parent: PageId | null }): Promise<PageId> {
  const id = newPageId();
  const into =
    (await cachedChildren(fate, at.parent)) ??
    (await fate.request(childrenRequest(at.parent), TREE_REQUEST).then(
      (result) => result.children,
      () => undefined,
    ));
  const page = { id, parentId: at.parent, title: "" };
  // The server appends by seq, so the end of the list is where the page lands there too.
  await stored("a new page", fate.mutations.createPage({ input: page, optimistic: page, ...(into && { insert: { into, position: "after" } }) }));
  return id;
}

/** Trims and caps the title, and sends nothing when it did not change. */
export function renamePage(fate: Fate, id: PageId, title: string): Promise<void> {
  const next = title.trim().slice(0, MAX_TITLE);
  const current = fate.store.read(`Page:${id}`) as Partial<PageEntity> | undefined;
  if (current?.title === next) return Promise.resolve();
  return stored("a rename", fate.mutations.renamePage({ input: { id, title: next }, optimistic: { title: next } }));
}

/** Takes the page out of every cached list at once. Its body, and its children's, go when the server confirms. */
export function deletePage(fate: Fate, id: PageId): Promise<void> {
  return stored("a delete", fate.mutations.deletePage({ input: { id }, delete: true }));
}

type Watched = { readonly name: "createPage" | "deletePage"; readonly id: PageId; readonly failed: boolean };

/**
 * Removes the device's bodies of pages that no longer exist, read off fate's
 * journal. The journal survives reloads and every tab sees it, so a delete
 * confirmed after a reload or in another tab still frees its bodies. When an
 * entry leaves the journal:
 *
 * | Entry      | Last status | Meaning                    | Removes                                 |
 * | ---------- | ----------- | -------------------------- | --------------------------------------- |
 * | deletePage | not failed  | the server confirmed it    | the page and its cached descendants     |
 * | createPage | failed      | the refusal was discarded  | the page, seeded if it was opened       |
 *
 * Every tab runs one; removing an id twice is harmless.
 */
export function reclaimBodies(fate: Fate, bodies: Pick<Bodies, "remove">): () => void {
  const persistence = fate.persistence!;
  const watched = new Map<string, Watched>();
  let removing = Promise.resolve();
  const remove = (ids: () => Promise<readonly PageId[]>) => {
    removing = removing
      .then(async () => {
        for (const id of await ids()) await bodies.remove(id);
      })
      .catch((error: unknown) => console.warn("pages: could not remove a deleted page's body", error));
  };
  const onJournal = () => {
    const now = new Set<string>();
    for (const entry of persistence.getSnapshot().mutations) {
      if (entry.name !== "createPage" && entry.name !== "deletePage") continue;
      const id = parsePageId((entry.input as { id?: unknown } | undefined)?.id);
      if (!id) continue;
      now.add(entry.id);
      watched.set(entry.id, { name: entry.name, id, failed: entry.status === "failed" });
    }
    for (const [key, entry] of watched) {
      if (now.has(key)) continue;
      watched.delete(key);
      if (entry.name === "deletePage" && !entry.failed) remove(async () => [entry.id, ...(await cachedSubtree(fate, entry.id))]);
      if (entry.name === "createPage" && entry.failed) remove(async () => [entry.id]);
    }
  };
  onJournal();
  return persistence.subscribe(onJournal);
}

/** The descendants whose levels this device has cached, breadth first, without a request. An uncached level ends its branch. */
export async function cachedSubtree(fate: Fate, root: PageId): Promise<PageId[]> {
  const found: PageId[] = [];
  for (const queue: PageId[] = [root]; queue.length > 0; ) {
    const children = await cachedChildren(fate, queue.shift()!);
    for (const item of children?.items ?? []) {
      const id = item.node.id as PageId;
      found.push(id);
      queue.push(id);
    }
  }
  return found;
}
