import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useFateClient, useRefetch, type PersistenceSnapshot } from "react-fate";
import { createPage, TREE_REQUEST } from "../model/tree.ts";
import type { PageBody, PageId, SaveState } from "../model/types.ts";
import { useApp } from "./app.ts";

type Mutations = PersistenceSnapshot["mutations"];

const waiting = (mutations: Mutations) => mutations.filter((m) => m.status !== "failed");

const pendingByQueue = new WeakMap<Mutations, ReadonlySet<string>>();
const pendingIds = (mutations: Mutations): ReadonlySet<string> => {
  let ids = pendingByQueue.get(mutations);
  if (!ids) {
    ids = new Set(waiting(mutations).flatMap((m) => [(m.input as { id?: unknown } | undefined)?.id].filter((id): id is string => typeof id === "string")));
    pendingByQueue.set(mutations, ids);
  }
  return ids;
};

export function usePending(id: PageId): boolean {
  const session = useFateClient().persistence!;
  return useSyncExternalStore(session.subscribe, () => pendingIds(session.getSnapshot().mutations).has(id));
}

/** fate does not push server changes without live views, which this app leaves out. */
export function useRefetchOnDelivery(request: Parameters<typeof useRefetch>[0]): void {
  const refetch = useRefetch(request, { persist: TREE_REQUEST.persist });
  const session = useFateClient().persistence!;
  useEffect(() => {
    const ids = () => new Set(waiting(session.getSnapshot().mutations).map((m) => m.id));
    let queued = ids();
    return session.subscribe(() => {
      const now = ids();
      const all = new Set(session.getSnapshot().mutations.map((m) => m.id));
      const answered = [...queued].some((id) => !all.has(id));
      queued = now;
      if (answered) refetch().catch((err: unknown) => console.warn("pages could not refresh after a delivery", err));
    });
  }, [session, refetch]);
}

/**
 * Whether the device holds the page. fate answers a request by id with a ref even when the server found nothing,
 * and reading that ref throws, so a screen checks this before it reads.
 */
export function useHeld(id: PageId): boolean {
  const { store } = useFateClient();
  const entity = `Page:${id}`;
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(entity, listener), [store, entity]),
    () => store.read(entity) !== undefined,
  );
}

export type SyncStatus = {
  readonly kind: "offline" | "retrying" | "syncing" | "idle";
  readonly unsynced: number;
  readonly failed: Mutations;
};

const onlineEvents = (listener: () => void) => {
  addEventListener("online", listener);
  addEventListener("offline", listener);
  return () => {
    removeEventListener("online", listener);
    removeEventListener("offline", listener);
  };
};

export function useSyncStatus(): SyncStatus {
  const session = useFateClient().persistence!;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const online = useSyncExternalStore(onlineEvents, () => navigator.onLine);
  const unsynced = waiting(snapshot.mutations);
  const failed = snapshot.mutations.filter((m) => m.status === "failed");
  const kind = !online ? "offline" : unsynced.some((m) => m.error) ? "retrying" : unsynced.length > 0 ? "syncing" : "idle";
  return { kind, unsynced: unsynced.length, failed };
}

function expandedStore(key: string) {
  let open: ReadonlySet<string> = new Set();
  try {
    open = new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {}
  const listeners = new Set<() => void>();
  return {
    read: () => open,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(id: PageId, value: boolean) {
      if (open.has(id) === value) return;
      const next = new Set(open);
      if (value) next.add(id);
      else next.delete(id);
      open = next;
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {}
      for (const listener of listeners) listener();
    },
  };
}
const expandedStores = new Map<string, ReturnType<typeof expandedStore>>();

export function useExpanded(): { readonly isOpen: (id: PageId) => boolean; readonly set: (id: PageId, open: boolean) => void } {
  const { kind, db } = useApp();
  const key = `pages:expanded:${kind}:${db}`;
  let store = expandedStores.get(key);
  if (!store) expandedStores.set(key, (store = expandedStore(key)));
  const open = useSyncExternalStore(store.subscribe, store.read);
  return { isOpen: (id) => open.has(id), set: store.set };
}

export function useBody(id: PageId): { readonly body: PageBody | null; readonly error: Error | null } {
  const { leases } = useApp();
  const [state, setState] = useState<{ id: PageId; body: PageBody | null; error: Error | null }>({ id, body: null, error: null });
  useEffect(() => {
    let live = true;
    const lease = leases.lease(id);
    lease.body.then(
      (body) => live && setState({ id, body, error: null }),
      (error: unknown) => live && setState({ id, body: null, error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      live = false;
      lease.release();
    };
  }, [leases, id]);
  return state.id === id ? state : { body: null, error: null };
}

export function useSaveState(body: PageBody): SaveState {
  return useSyncExternalStore(body.save.subscribe, body.save.read);
}

export function useCreatePage(): (parent: PageId | null) => Promise<void> {
  const { fate } = useApp();
  const navigate = useNavigate();
  return useCallback(
    async (parent) => {
      const id = await createPage(fate, { parent });
      await navigate({ to: "/p/$pageId", params: { pageId: id } });
    },
    [fate, navigate],
  );
}
