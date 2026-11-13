import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useFateClient, useRefetch, type PersistenceSnapshot } from "react-fate";
import { REQUEST } from "./fate.ts";

type Mutations = PersistenceSnapshot["mutations"];

/** The mutations still waiting for the server; a failed one waits for the user instead. */
const waiting = (mutations: Mutations) => mutations.filter((m) => m.status !== "failed");

/** Mutation inputs name an issue by `id` and a comment's issue by `issueId`. */
const named = (input: unknown): string[] => {
  const { id, issueId } = (input ?? {}) as { id?: unknown; issueId?: unknown };
  return [id, issueId].filter((x): x is string => typeof x === "string");
};

const pendingByQueue = new WeakMap<Mutations, ReadonlySet<string>>();
const pendingIds = (mutations: Mutations): ReadonlySet<string> => {
  let ids = pendingByQueue.get(mutations);
  if (!ids) pendingByQueue.set(mutations, (ids = new Set(waiting(mutations).flatMap((m) => named(m.input)))));
  return ids;
};

/** Whether a mutation that names the issue or comment `id` is still waiting for the server: the "not synced yet" dot. */
export function usePending(id: string): boolean {
  const session = useFateClient().persistence!;
  return useSyncExternalStore(session.subscribe, () => pendingIds(session.getSnapshot().mutations).has(id));
}

/**
 * Refetches `request` when the server answers a queued mutation, so the counts and orders an edit changed catch up.
 * fate does not push server changes without live views, which this app leaves out.
 */
export function useRefetchOnDelivery(request: Parameters<typeof useRefetch>[0]): void {
  const refetch = useRefetch(request, { persist: REQUEST.persist });
  const session = useFateClient().persistence!;
  useEffect(() => {
    const ids = () => new Set(waiting(session.getSnapshot().mutations).map((m) => m.id));
    let queued = ids();
    return session.subscribe(() => {
      const now = ids();
      const all = new Set(session.getSnapshot().mutations.map((m) => m.id));
      const answered = [...queued].some((id) => !all.has(id));
      queued = now;
      if (answered) refetch().catch((err: unknown) => console.warn("linearlite could not refresh after a delivery", err));
    });
  }, [session, refetch]);
}

/**
 * Whether the device holds the issue. fate answers a request by id with a ref even when the server found nothing,
 * and reading that ref throws, so a screen checks this before it reads.
 */
export function useHeld(id: string): boolean {
  const { store } = useFateClient();
  const entity = `Issue:${id}`;
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(entity, listener), [store, entity]),
    () => store.read(entity) !== undefined,
  );
}

export type SyncStatus = {
  /** `retrying`: the server did not answer the last delivery, and fate tries again. */
  readonly kind: "offline" | "retrying" | "syncing" | "idle";
  readonly unsynced: number;
  readonly failed: number;
  readonly error: string | undefined;
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
  const failed = snapshot.mutations.length - unsynced.length;
  const error = snapshot.error?.message ?? snapshot.mutations.find((m) => m.status === "failed")?.error;
  const kind = !online ? "offline" : unsynced.some((m) => m.error) ? "retrying" : unsynced.length > 0 ? "syncing" : "idle";
  return { kind, unsynced: unsynced.length, failed, error };
}
