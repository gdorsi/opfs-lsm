import { useLiveInfiniteQuery, useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Issue, StatusCode } from "../domain/model.ts";
import type { StatusCounts, Unsubscribe } from "../model/backend.ts";
import type { IssueFilter } from "../model/filter.ts";
import { located, place, TOP, windowOf, type Placement } from "../model/list.ts";
import { bodyOf, columnQuery, commentsOf, issueById, listQuery, needsFilterFunction, syncRow, windowQuery } from "../model/query.ts";
import { pressureOf, syncStatus, type Pressure, type SyncStatus } from "../model/sync.ts";
import { threadOf, type Thread } from "../model/thread.ts";
import { model } from "./open.ts";

const COLUMN_PAGE = 50;

/** The fields a count depends on: a sort change keeps the count. */
const countKey = ({ status, priority, q }: IssueFilter) => JSON.stringify([status, priority, q]);

/** The last value a backend watch emitted for `key`, undefined until it emits. No key, no watch. */
function useWatched<T>(key: string | undefined, watch: (emit: (value: T) => void) => Unsubscribe): T | undefined {
  const [seen, setSeen] = useState<{ readonly key: string; readonly value: T }>();
  useEffect(() => (key === undefined ? undefined : watch((value) => setSeen({ key, value }))), [key]);
  return seen && seen.key === key ? seen.value : undefined;
}

/**
 * The list under `filter` from row `offset` on, and its total, which is undefined until counted. `setRange` asks for
 * other rows; a window deep in the list starts a live query at a sort value instead of loading every row above it.
 */
export function useIssueList(filter: IssueFilter) {
  const { index } = model();
  const key = JSON.stringify(filter);
  const anchoring = useMemo(() => index.anchor(filter), [key]);
  const [state, setState] = useState({ key, placement: TOP });
  const placement = state.key === key ? state.placement : TOP;
  const { anchor } = placement;
  const counted = useWatched(anchor && JSON.stringify([key, anchor.value]), (emit: (base: number) => void) => anchoring!.watchBase(anchor!.value, emit));
  const base = anchor ? (counted ?? anchor.base) : 0;
  const total = useWatched(countKey(filter), (emit: (total: number) => void) => index.watchTotal(filter, emit));
  const rows = useListRows(filter, placement);

  const asked = useRef(0);
  const setRange = useCallback(
    (from: number, to: number) => {
      const ask = ++asked.current;
      const step = place(placement, from, to, { canAnchor: anchoring !== undefined, base });
      const show = (next: (current: Placement) => Placement) =>
        setState((s) => {
          const current = s.key === key ? s.placement : TOP;
          const placed = next(current);
          return placed === current && s.key === key ? s : { key, placement: placed };
        });
      if (step.kind === "placed") return show(() => step.placement);
      anchoring!.locate(step.row).then(
        (found) => ask === asked.current && show((current) => located(current, step, found)),
        (err: unknown) => {
          console.warn("linearlite could not locate a row, loading the list from the top", err);
          if (ask === asked.current) show((current) => located(current, step, undefined));
        },
      );
    },
    [key, anchoring, placement, base],
  );

  return { rows, offset: base + placement.offset, total, setRange };
}

/**
 * The rows of the list's live query. `useLiveQuery` moves the window in place while only its offset and limit change.
 * A search for `%` or `_` filters with a function, which TanStack can neither hash nor move, so that live query is
 * built once per filter and moved with `setWindow`. Such a list never anchors.
 */
function useListRows(filter: IssueFilter, placement: Placement): readonly Issue[] {
  const { issues } = model().collections;
  const window = windowOf(placement);
  const literal = useMemo(() => (needsFilterFunction(filter) ? windowQuery(issues, filter, window) : undefined), [JSON.stringify(filter)]);
  useEffect(() => {
    const current = literal?.utils.getWindow();
    if (literal && (current?.offset !== window.offset || current.limit !== window.limit)) void literal.utils.setWindow(window);
  }, [literal, window.offset, window.limit]);
  const { data } = useLiveQuery((q) => literal ?? listQuery(issues, filter, window)(q));
  return data ?? [];
}

/** A board column: the issues with `status` under `filter`, in board order, a page at a time. */
export function useBoardColumn(status: StatusCode, filter: IssueFilter) {
  const { issues } = model().collections;
  const { data, hasNextPage, fetchNextPage } = useLiveInfiniteQuery(columnQuery(issues, filter, status), {
    pageSize: COLUMN_PAGE,
    // A search for `%` or `_` cannot be hashed, so the column names its query. Board order does not depend on the sort.
    queryKey: ["column", status, countKey(filter)],
  });
  return { rows: data, hasMore: hasNextPage, showMore: fetchNextPage };
}

/** Live issues under `filter` per status code; undefined until counted. */
export function useStatusCounts(filter: IssueFilter): StatusCounts | undefined {
  return useWatched(countKey(filter), (emit: (counts: StatusCounts) => void) => model().index.watchCounts(filter, emit));
}

/** The issue as its live query reads it, or as the collection holds it, tombstone included, until that query is ready. */
export function useIssue(id: string): Issue | undefined {
  const { issues } = model().collections;
  const { data } = useLiveQuery(issueById(issues, id));
  return data ?? issues.get(id);
}

/** The description and comments of issue `id`, from kv. A thread this replica lacks is fetched until the server answers. */
export function useIssueThread(id: string): Thread {
  const { collections, sync } = model();
  const body = useLiveQuery(bodyOf(collections.bodies, id));
  const comments = useLiveQuery(commentsOf(collections.comments, id));
  const absent = body.isReady && body.data === undefined;
  const [answered, setAnswered] = useState<string>();
  useEffect(() => (absent ? sync.loadThread(id, () => setAnswered(id)) : undefined), [id, absent]);
  return threadOf(body, comments, answered === id);
}

/** Loads the bodies and comments of the issues on screen, once `ids` has held still for a moment. */
export function usePreloadDetails(ids: readonly string[]): void {
  const key = ids.join(","); // ids are [A-Za-z0-9_-]
  useEffect(() => {
    const leave = new AbortController();
    void model().sync.preload(key === "" ? [] : key.split(","), leave.signal);
    return () => leave.abort();
  }, [key]);
}

export function useSyncStatus(): SyncStatus {
  const { collections, sync } = model();
  const { data: state } = useLiveQuery(syncRow(collections.sync));
  const unsynced = useLiveQuery(sync.outbox.issues).data.length + useUnsent();
  return syncStatus(state, unsynced);
}

export function usePressure(): Pressure {
  const { data: state } = useLiveQuery(syncRow(model().collections.sync));
  return pressureOf(state, useUnsent());
}

/** The bodies and comments with unsent edits. */
function useUnsent(): number {
  const { outbox } = model().sync;
  return useLiveQuery(outbox.bodies).data.length + useLiveQuery(outbox.comments).data.length;
}
