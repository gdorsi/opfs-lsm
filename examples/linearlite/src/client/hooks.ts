import { and, count, eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Body, Comment, Issue, StatusCode, Stream } from "../domain/model.ts";
import type { IssueFilter } from "./filter.ts";
import { backoffMs } from "./ops.ts";
import { filtered, windowQuery } from "./query.ts";
import { openedStore } from "./store.ts";
import { fetchDetail } from "./sync.ts";

const LIST_WINDOW = 100;
const COLUMN_WINDOW = 50;

type IssueWindow = { readonly rows: readonly Issue[]; readonly offset: number; setRange(start: number, end: number): void };

/** An ordered live query that holds only `[offset, offset + limit)` and moves with `setWindow`. `key` names the query. */
function useWindow(key: string, build: () => ReturnType<typeof windowQuery>, size: number): IssueWindow {
  const query = useMemo(build, [key]);
  const { data } = useLiveQuery(query);
  const [placed, setOffset] = useState({ query, offset: 0 });
  const offset = placed.query === query ? placed.offset : 0;
  const setRange = useCallback(
    (start: number, end: number) => {
      const next = { offset: Math.max(0, start), limit: Math.max(size, end - start) };
      const current = query.utils.getWindow();
      if (current?.offset === next.offset && current.limit === next.limit) return;
      void query.utils.setWindow(next);
      setOffset({ query, offset: next.offset });
    },
    [query, size],
  );
  return { rows: data, offset, setRange };
}

export function useIssueWindow(filter: IssueFilter): IssueWindow & { readonly total: number } {
  const { issues } = openedStore();
  const view = useWindow(JSON.stringify(filter), () => windowQuery(issues, filter, LIST_WINDOW), LIST_WINDOW);
  const { data } = useLiveQuery((q) =>
    filtered(q, issues, filter)
      .select(({ i }) => ({ n: count(i.id) }))
      .findOne(),
  );
  return { ...view, total: data?.n ?? 0 };
}

export function useBoardColumn(status: StatusCode, filter: IssueFilter): IssueWindow {
  const { issues } = openedStore();
  return useWindow(JSON.stringify([status, filter]), () => windowQuery(issues, filter, COLUMN_WINDOW, status), COLUMN_WINDOW);
}

export function useStatusCounts(filter: IssueFilter): readonly number[] {
  const { issues } = openedStore();
  const { data } = useLiveQuery((q) =>
    filtered(q, issues, filter)
      .groupBy(({ i }) => i.status)
      .select(({ i }) => ({ status: i.status, n: count(i.id) })),
  );
  return useMemo(() => {
    const counts = [0, 0, 0, 0, 0];
    for (const { status, n } of data) counts[status] = n;
    return counts;
  }, [data]);
}

export function useIssue(id: string): Issue | undefined {
  const { issues } = openedStore();
  const { data } = useLiveQuery((q) =>
    q
      .from({ i: issues })
      .where(({ i }) => and(eq(i.id, id), eq(i.deleted, false)))
      .findOne(),
  );
  return data;
}

export type IssueDetail =
  | { readonly kind: "loading" }
  | { readonly kind: "missing"; readonly comments: readonly Comment[] }
  | { readonly kind: "ready"; readonly body: Body; readonly comments: readonly Comment[] };

/**
 * The description and comments, read from kv while the view is mounted. A body this replica lacks (backfill has not
 * reached it) is fetched from the server, retried with backoff and on `online` until it answers; only an answer
 * without a body makes the detail "missing".
 */
export function useIssueDetail(id: string): IssueDetail {
  const { bodies, comments } = openedStore();
  const body = useLiveQuery((q) =>
    q
      .from({ b: bodies })
      .where(({ b }) => eq(b.id, id))
      .findOne(),
  );
  const thread = useLiveQuery((q) =>
    q
      .from({ c: comments })
      .where(({ c }) => and(eq(c.issue_id, id), eq(c.deleted, false)))
      .orderBy(({ c }) => c.created, "asc"),
  );
  const [fetched, setFetched] = useState<string | undefined>();
  const absent = body.isReady && body.data === undefined;
  useEffect(() => {
    if (!absent) return;
    let live = true;
    let failures = 0;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (!live || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      fetchDetail(id).then(
        () => {
          inFlight = false;
          if (live) setFetched(id);
        },
        (err: unknown) => {
          inFlight = false;
          if (!live) return;
          failures++;
          console.warn(`linearlite could not fetch issue ${id}, retrying in ${backoffMs(failures)} ms`, err);
          timer = setTimeout(attempt, backoffMs(failures));
        },
      );
    };
    addEventListener("online", attempt);
    attempt();
    return () => {
      live = false;
      clearTimeout(timer);
      removeEventListener("online", attempt);
    };
  }, [absent, id]);

  if (!body.isReady || !thread.isReady) return { kind: "loading" };
  if (body.data) return { kind: "ready", body: body.data, comments: thread.data };
  return fetched === id ? { kind: "missing", comments: thread.data } : { kind: "loading" };
}

export type SyncStatus =
  | { readonly kind: "starting"; readonly unsynced: number }
  | { readonly kind: "offline"; readonly unsynced: number }
  | { readonly kind: "syncing"; readonly stream: Stream; readonly cursor: number; readonly head: number; readonly unsynced: number }
  | { readonly kind: "idle"; readonly unsynced: number };

export function useSyncStatus(): SyncStatus {
  const { sync, dirtyIssues, outbox } = openedStore();
  const { data: state } = useLiveQuery((q) =>
    q
      .from({ s: sync })
      .where(({ s }) => eq(s.id, "sync"))
      .findOne(),
  );
  const { data: dirty } = useLiveQuery(dirtyIssues);
  const { data: marks } = useLiveQuery(outbox);
  const unsynced = dirty.length + marks.length;
  if (!state) return { kind: "starting", unsynced };
  if (!state.online) return { kind: "offline", unsynced };
  const behind = (["issues", "bodies", "comments"] as const).find((s) => !state.caughtUp[s]);
  if (behind) return { kind: "syncing", stream: behind, cursor: state.cursors[behind], head: state.head, unsynced };
  return { kind: "idle", unsynced };
}
