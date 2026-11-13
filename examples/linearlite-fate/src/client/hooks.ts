import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { alias, useListView, useRefetch, useRequest, useView, useViews, type InsertionTarget, type PersistenceSnapshot, type ViewRef } from "react-fate";
import { byKanbanOrder } from "../domain/kanban.ts";
import { CODES, totalOf, type Comment, type Issue, type StatusCode, type StatusCounts } from "../domain/model.ts";
import { columnArgs, filterArgs, windowArgs } from "./args.ts";
import { ColumnView, CommentsView, CommentView, IssueDetailView, IssueRowView, openedFate, REQUEST, WindowView, type Fate, type StorageKind } from "./fate.ts";
import type { IssueFilter } from "./filter.ts";
import { onScreen, useOnScreen } from "./screen.ts";

const COLUMN_PAGE = 50;
/** Reads the cache and restores it from the device; never fetches, suspends or throws. */
const CACHE_ONLY = { mode: "cache-only" } as const;

const session = () => openedFate().fate.persistence!;

const useSnapshot = (): PersistenceSnapshot => {
  const { subscribe, getSnapshot } = session();
  return useSyncExternalStore(subscribe, getSnapshot);
};

/** The mutations still waiting for the server; a failed one waits for the user instead. */
const waiting = (mutations: PersistenceSnapshot["mutations"]) => mutations.filter((m) => m.status !== "failed");

/** Mutation inputs name an issue by `id` and a comment's issue by `issueId`. */
const named = (input: unknown): string[] => {
  const { id, issueId } = (input ?? {}) as { id?: unknown; issueId?: unknown };
  return [id, issueId].filter((x): x is string => typeof x === "string");
};

/** Ids of issues and comments that a mutation still waiting for the server names. */
function usePendingIds(): ReadonlySet<string> {
  const { mutations } = useSnapshot();
  return useMemo(() => new Set(waiting(mutations).flatMap((m) => named(m.input))), [mutations]);
}

let delivered = 0;
let inQueue = new Set<string>();
const deliveredListeners = new Set<() => void>();
let watching = false;

const waitingIds = () => new Set(waiting(session().getSnapshot().mutations).map((m) => m.id));

function subscribeDelivered(listener: () => void): () => void {
  deliveredListeners.add(listener);
  if (!watching) {
    watching = true;
    inQueue = waitingIds();
    session().subscribe(() => {
      const all = new Set(session().getSnapshot().mutations.map((m) => m.id));
      let answered = 0;
      for (const id of inQueue) if (!all.has(id)) answered++;
      inQueue = waitingIds();
      if (answered === 0) return;
      delivered += answered;
      for (const l of deliveredListeners) l();
    });
  }
  return () => deliveredListeners.delete(listener);
}

/** Mutations the server has answered since the page opened. A screen refetches when it grows, so its counts and windows show what the server now holds. */
const useDelivered = (): number => useSyncExternalStore(subscribeDelivered, () => delivered);

function useRefetchOnDelivery(refetch: () => Promise<unknown>): void {
  const count = useDelivered();
  const first = useRef(count);
  useEffect(() => {
    if (count === first.current) return;
    refetch().catch((err: unknown) => console.warn("linearlite could not refresh after a delivery", err));
  }, [count, refetch]);
}

/** Drops the rows that read nothing and marks those a pending mutation names. */
const markDirty = <T extends { readonly id: string }>(rows: readonly (T | null | undefined)[], pending: ReadonlySet<string>) =>
  rows.flatMap((row) => (row ? [{ ...row, dirty: pending.has(row.id) }] : []));

function useIssueRows(refs: readonly (ViewRef<"Issue"> | null | undefined)[]): readonly Issue[] {
  const data = useViews(IssueRowView, refs);
  const pending = usePendingIds();
  return useMemo(() => markDirty(data, pending), [data, pending]);
}

/** Fetches `request` into the cache and persists it. A failure is returned, not thrown, so what the device holds stays on screen. */
function useFetched(request: Parameters<Fate["request"]>[0]): unknown {
  const { fate } = openedFate();
  const key = fate.getRequestKey(request);
  const [failed, setFailed] = useState<{ readonly key: string; readonly error: unknown }>();
  useEffect(() => {
    let current = true;
    setFailed(undefined);
    fate.request(request, REQUEST).catch((error: unknown) => current && setFailed({ key, error }));
    return () => {
      current = false;
    };
  }, [fate, key]);
  return failed?.key === key ? failed.error : undefined;
}

/**
 * The list's rows: one window of the filtered, sorted list, fetched by position, plus the total. Every read comes
 * from the cache, so a window the device holds paints without the server. Moving to a window that is not cached keeps
 * the rows of the last cached one on screen, and the list draws skeletons at the rows it lacks until the window
 * arrives. The error of a failed fetch reaches the screen only when there is nothing else to show: no rows, or rows of
 * another filter or sort.
 */
export function useIssueWindow(filter: IssueFilter) {
  const key = JSON.stringify(filter);
  const [placed, setPlaced] = useState({ key, offset: 0 });
  const offset = placed.key === key ? placed.offset : 0;
  const shown = useMemo(
    () => ({ issues: { args: windowArgs(filter, offset), list: WindowView }, counts: { args: filterArgs(filter), value: true as const } }),
    [key, offset],
  );
  const failure = useFetched(shown);
  const cached = useRequest(shown, CACHE_ONLY);
  useRefetchOnDelivery(useRefetch(shown));
  const shape = JSON.stringify({ ...shown.issues.args, offset: 0 });
  const here = cached && { result: cached, offset: shown.issues.args.offset, shape };
  const [last, setLast] = useState(here);
  if (here && here.result !== last?.result) setLast(here);
  const held = here ?? last;
  if (failure !== undefined && held?.shape !== shape) throw failure;
  const [items = []] = useListView(WindowView, held?.result.issues);
  const rows = useIssueRows(items.map((item) => item.node));
  const args = shown.issues.args;
  const newestFirst = args.offset === 0 && args.dir === "desc" && (args.sort === "modified" || args.sort === "created");
  useOnScreen(onScreen.top, "list", useMemo(() => (newestFirst && cached ? { filter: shown.counts.args, target: cached.issues } : undefined), [newestFirst, shown, cached]));
  /** Moves the window so it holds row `start`. */
  const setStart = useCallback(
    (start: number) => setPlaced((p) => {
      const next = windowArgs(filter, start).offset;
      return p.key === key && p.offset === next ? p : { key, offset: next };
    }),
    [key],
  );
  return { rows, offset: held?.offset ?? 0, setStart, total: held && totalOf(held.result.counts) };
}

/**
 * The board's counts and its five columns in one request, so the columns load together. Call it once per board and
 * hand the result to each column: every call refetches when a mutation is delivered.
 */
/** A column as both hooks read it: a connection for `useListView`, and a list a mutation can insert into. */
type ColumnConnection = InsertionTarget<"Issue"> & Parameters<typeof useListView>[1];

export function useBoard(filter: IssueFilter) {
  const key = JSON.stringify(filter);
  const request = useMemo(() => {
    const columns = CODES.flatMap((s) => {
      const args = columnArgs(s, filter, COLUMN_PAGE);
      return args ? [[`c${s}`, alias("column", { args, list: ColumnView })] as const] : [];
    });
    return { counts: { args: filterArgs(filter), value: true as const }, ...Object.fromEntries(columns) };
  }, [key]);
  const shown = useDeferredValue(request);
  const result = useRequest(shown, REQUEST) as { counts: StatusCounts } & Partial<Record<`c${StatusCode}`, ColumnConnection>>;
  useRefetchOnDelivery(useRefetch(shown));
  return { result, shownFilter: shown.counts.args };
}
export type Board = ReturnType<typeof useBoard>;

/**
 * One board column by `kanbanorder`, growing a page at a time. Its rows are sorted here too, so a card moved within
 * or into the column takes its place at once; the server orders them the same way.
 */
export function useBoardColumn({ result, shownFilter }: Board, status: StatusCode) {
  const connection = result[`c${status}`];
  const [items = [], loadNext] = useListView(ColumnView, connection);
  const rows = useIssueRows(items.map((item) => item.node));
  const sorted = useMemo(() => rows.toSorted(byKanbanOrder), [rows]);
  const top = sorted[0]?.kanbanorder ?? null;
  useOnScreen(onScreen.columns, status, useMemo(() => (connection ? { filter: shownFilter, target: connection, top } : undefined), [connection, shownFilter, top]));
  const loading = useRef(false);
  /** Loads the next page unless the column already holds `wanted` rows. */
  const loadUpTo = useCallback(
    (wanted: number) => {
      if (!loadNext || loading.current || wanted <= sorted.length) return;
      loading.current = true;
      loadNext()
        .catch((err: unknown) => console.warn("linearlite could not load more of a column", err))
        .finally(() => (loading.current = false));
    },
    [loadNext, sorted.length],
  );
  return { rows: sorted, loadUpTo };
}

/**
 * Whether the device holds the issue. fate answers a request by id with a ref even when the server found nothing,
 * and reading that ref throws, so a missing issue is read as null instead.
 */
function useHeld(id: string): boolean {
  const { store } = openedFate().fate;
  const entity = `Issue:${id}`;
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(entity, listener), [store, entity]),
    () => store.read(entity) !== undefined,
  );
}

/** The issue's row fields, from the list's cache entry when it holds them; undefined when there is no such issue. */
export function useIssue(id: string): Issue | undefined {
  const { issue } = useRequest({ issue: { id, view: IssueRowView } }, REQUEST);
  const row = useView(IssueRowView, useHeld(id) ? issue : null);
  const pending = usePendingIds();
  return row ? { ...row, dirty: pending.has(row.id) } : undefined;
}

/** `description` is undefined when there is no such issue. */
export type IssueDetail = { readonly description: string | undefined; readonly comments: readonly Comment[] };

/** The description and the comments, oldest first. Suspends until they are on the device. */
export function useIssueDetail(id: string): IssueDetail {
  const { issue } = useRequest({ issue: { id, view: IssueDetailView } }, REQUEST);
  const detail = useView(IssueDetailView, useHeld(id) ? issue : null);
  const [items = []] = useListView(CommentsView, detail?.comments);
  useOnScreen(onScreen.comments, id, detail?.comments);
  const data = useViews(CommentView, items.map((item) => item.node));
  const pending = usePendingIds();
  const comments = useMemo(() => markDirty(data, pending), [data, pending]);
  return { description: detail?.description, comments };
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
  const snapshot = useSnapshot();
  const online = useSyncExternalStore(onlineEvents, () => navigator.onLine);
  const unsynced = waiting(snapshot.mutations);
  const failed = snapshot.mutations.length - unsynced.length;
  const error = snapshot.error?.message ?? snapshot.mutations.find((m) => m.status === "failed")?.error;
  const kind = !online ? "offline" : unsynced.some((m) => m.error) ? "retrying" : unsynced.length > 0 ? "syncing" : "idle";
  return { kind, unsynced: unsynced.length, failed, error };
}

export const useStorageKind = (): StorageKind => openedFate().storage;
