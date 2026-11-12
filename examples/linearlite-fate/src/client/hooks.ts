import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { alias, useListView, useRefetch, useRequest, useView, useViews, type PersistenceSnapshot, type ViewRef } from "react-fate";
import type { Comment, Issue, StatusCode, StatusCounts } from "../domain/model.ts";
import { columnArgs, filterArgs, LIST_WINDOW, windowArgs } from "./args.ts";
import { ColumnView, CommentsView, CommentView, IssueDetailView, IssueRowView, openedFate, REQUEST, WindowView, type Fate, type StorageKind } from "./fate.ts";
import type { IssueFilter } from "./filter.ts";
import { onScreen, useOnScreen } from "./screen.ts";

export { LIST_WINDOW };
const COLUMN_PAGE = 50;
/** Reads the cache and restores it from the device; never fetches, suspends or throws. */
const CACHE_ONLY = { mode: "cache-only" } as const;
const STATUS_CODES = [0, 1, 2, 3, 4] as const;

type IssueWindow = { readonly rows: readonly Issue[]; readonly offset: number; setRange(start: number, end: number): void };

const useSnapshot = (): PersistenceSnapshot => {
  const session = openedFate().fate.persistence!;
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
};

/** Mutation inputs name an issue by `id` and a comment's issue by `issueId`. */
const named = (input: unknown): string[] => {
  const { id, issueId } = (input ?? {}) as { id?: unknown; issueId?: unknown };
  return [id, issueId].filter((x): x is string => typeof x === "string");
};

/** Ids of issues and comments that a mutation still waiting for the server names. */
function usePendingIds(): ReadonlySet<string> {
  const { mutations } = useSnapshot();
  return useMemo(() => new Set(mutations.filter((m) => m.status !== "failed").flatMap((m) => named(m.input))), [mutations]);
}

let delivered = 0;
let inQueue = new Set<string>();
const deliveredListeners = new Set<() => void>();
let watching: (() => void) | undefined;

/** Mutations the server has answered since the page opened. A screen refetches when it grows, so its counts and windows show what the server now holds. */
function useDelivered(): number {
  return useSyncExternalStore(
    (listener) => {
      deliveredListeners.add(listener);
      const session = openedFate().fate.persistence!;
      const waiting = () => new Set(session.getSnapshot().mutations.flatMap((m) => (m.status === "failed" ? [] : [m.id])));
      if (!watching) {
        inQueue = waiting();
        watching = session.subscribe(() => {
          const all = new Set(session.getSnapshot().mutations.map((m) => m.id));
          const answered = [...inQueue].filter((id) => !all.has(id)).length;
          inQueue = waiting();
          if (answered === 0) return;
          delivered += answered;
          for (const l of deliveredListeners) l();
        });
      }
      return () => deliveredListeners.delete(listener);
    },
    () => delivered,
  );
}

function useRefetchOnDelivery(refetch: () => Promise<unknown>): void {
  const count = useDelivered();
  const first = useRef(count);
  useEffect(() => {
    if (count === first.current) return;
    refetch().catch((err: unknown) => console.warn("linearlite could not refresh after a delivery", err));
  }, [count, refetch]);
}

function useIssueRows(refs: readonly (ViewRef<"Issue"> | null | undefined)[]): readonly Issue[] {
  const data = useViews(IssueRowView, refs);
  const pending = usePendingIds();
  return useMemo(() => data.flatMap((row) => (row ? [{ ...row, dirty: pending.has(row.id) }] : [])), [data, pending]);
}

const sum = (counts: StatusCounts) => counts.reduce((a, b) => a + b, 0);

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
export function useIssueWindow(filter: IssueFilter): IssueWindow & { readonly total: number | undefined } {
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
  const setRange = useCallback(
    (start: number) => setPlaced((p) => {
      const next = windowArgs(filter, start).offset;
      return p.key === key && p.offset === next ? p : { key, offset: next };
    }),
    [key],
  );
  return { rows, offset: held?.offset ?? 0, setRange, total: held && sum(held.result.counts) };
}

/** The board's counts and its five columns in one request, so the columns load together. */
function useBoard(filter: IssueFilter) {
  const key = JSON.stringify(filter);
  const request = useMemo(() => {
    const columns = STATUS_CODES.flatMap((s) => {
      const args = columnArgs(s, filter, COLUMN_PAGE);
      return args ? [[`c${s}`, alias("column", { args, list: ColumnView })] as const] : [];
    });
    return { counts: { args: filterArgs(filter), value: true as const }, ...Object.fromEntries(columns) };
  }, [key]);
  const shown = useDeferredValue(request);
  const result = useRequest(shown, REQUEST) as { counts: StatusCounts } & Record<string, Parameters<typeof useListView>[1]>;
  useRefetchOnDelivery(useRefetch(shown));
  return result;
}

/**
 * One board column by `kanbanorder`, growing a page at a time. Its rows are sorted here too, so a card moved within
 * or into the column takes its place at once; the server orders them the same way.
 */
export function useBoardColumn(status: StatusCode, filter: IssueFilter): IssueWindow {
  const connection = useBoard(filter)[`c${status}`];
  const [items = [], loadNext] = useListView(ColumnView, connection);
  const rows = useIssueRows(items.map((item) => item.node));
  const sorted = useMemo(() => rows.toSorted((a, b) => (a.kanbanorder < b.kanbanorder ? -1 : a.kanbanorder > b.kanbanorder ? 1 : a.id < b.id ? -1 : 1)), [rows]);
  const top = sorted[0]?.kanbanorder ?? null;
  useOnScreen(onScreen.columns, status, useMemo(() => (connection ? { target: connection as never, top } : undefined), [connection, top]));
  const loading = useRef(false);
  const setRange = useCallback(
    (_start: number, end: number) => {
      if (!loadNext || loading.current || end <= sorted.length) return;
      loading.current = true;
      loadNext()
        .catch((err: unknown) => console.warn("linearlite could not load more of a column", err))
        .finally(() => (loading.current = false));
    },
    [loadNext, sorted.length],
  );
  return { rows: sorted, offset: 0, setRange };
}

export function useStatusCounts(filter: IssueFilter): StatusCounts {
  return useBoard(filter).counts;
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

export type IssueDetail =
  | { readonly kind: "missing"; readonly comments: readonly Comment[] }
  | { readonly kind: "ready"; readonly body: { readonly description: string }; readonly comments: readonly Comment[] };

/** The description and the comments, oldest first. Suspends until they are on the device. */
export function useIssueDetail(id: string): IssueDetail {
  const { issue } = useRequest({ issue: { id, view: IssueDetailView } }, REQUEST);
  const detail = useView(IssueDetailView, useHeld(id) ? issue : null);
  const [items = []] = useListView(CommentsView, detail?.comments);
  useOnScreen(onScreen.comments, id, detail?.comments as never);
  const data = useViews(CommentView, items.map((item) => item.node));
  const pending = usePendingIds();
  const comments = data.flatMap((c) => (c ? [{ ...c, dirty: pending.has(c.id) }] : []));
  return detail ? { kind: "ready", body: { description: detail.description }, comments } : { kind: "missing", comments };
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
  const waiting = snapshot.mutations.filter((m) => m.status !== "failed");
  const failed = snapshot.mutations.length - waiting.length;
  const error = snapshot.error?.message ?? snapshot.mutations.find((m) => m.status === "failed")?.error;
  const kind = !online ? "offline" : waiting.some((m) => m.error) ? "retrying" : waiting.length > 0 ? "syncing" : "idle";
  return { kind, unsynced: waiting.length, failed, error };
}

export const useStorageKind = (): StorageKind => openedFate().storage;
