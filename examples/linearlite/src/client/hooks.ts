import { and, eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Body, Comment, Issue, StatusCode, Stream } from "../domain/model.ts";
import { countByStatus, countTotal, type Pause } from "./counts.ts";
import type { IssueFilter } from "./filter.ts";
import { backoffMs } from "./ops.ts";
import { windowQuery } from "./query.ts";
import { openedStore, type IssueDocs } from "./store.ts";
import { fetchDetail } from "./sync.ts";

export const LIST_WINDOW = 100;
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

const yieldTask: Pause = () => new Promise((resolve) => setTimeout(resolve));

/**
 * `read` of the stored issues, run again after every change to them. One read runs at a time. Changes during a read
 * start one more, four times that read's duration after it and at least 250 ms, so a first sync, which changes the
 * issues every few milliseconds, spends at most a fifth of the main thread counting them. A read after a change
 * pauses between steps, so it does not hold up a frame in this tab or any other; the first read for `key` does not,
 * since the screen waits on it. Undefined until the first read for `key` resolves.
 */
function useIssueRead<T>(key: string, read: (issues: IssueDocs, pause?: Pause) => Promise<T>): T | undefined {
  const { docs } = openedStore();
  const [result, setResult] = useState<{ readonly key: string; readonly value: T }>();
  useEffect(() => {
    const issues = docs.collection("issues");
    let live = true;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (pause?: Pause) => {
      timer = undefined;
      running = true;
      again = false;
      const t0 = performance.now();
      try {
        const value = await read(issues, pause);
        if (live) setResult({ key, value });
      } catch (err) {
        console.warn("linearlite could not count issues", err);
      }
      running = false;
      if (live && again) timer = setTimeout(() => void run(yieldTask), Math.max(250, 4 * (performance.now() - t0)));
    };
    const off = issues.changes((event) => {
      if (event.kind === "closed") return;
      if (running || timer !== undefined) again = true;
      else void run(yieldTask);
    });
    void run();
    return () => {
      live = false;
      clearTimeout(timer);
      off();
    };
  }, [docs, key]); // `key` names `read`
  return result?.key === key ? result.value : undefined;
}

/** The fields a count depends on: a sort change keeps the count. */
const counted = ({ status, priority, q }: IssueFilter) => JSON.stringify([status, priority, q]);

export function useIssueWindow(filter: IssueFilter): IssueWindow & { readonly total: number | undefined } {
  const { issues } = openedStore();
  const key = JSON.stringify(filter);
  const view = useWindow(key, () => windowQuery(issues, filter, LIST_WINDOW), LIST_WINDOW);
  const total = useIssueRead(counted(filter), (docs, pause) => countTotal(docs, filter, pause));
  return { ...view, total };
}

export function useBoardColumn(status: StatusCode, filter: IssueFilter): IssueWindow {
  const { issues } = openedStore();
  return useWindow(JSON.stringify([status, filter]), () => windowQuery(issues, filter, COLUMN_WINDOW, status), COLUMN_WINDOW);
}

/** Issues under `filter` per status code; undefined until counted. */
export function useStatusCounts(filter: IssueFilter): readonly number[] | undefined {
  return useIssueRead(counted(filter), (docs, pause) => countByStatus(docs, filter, pause));
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
  const { sync, dirtyIssues, dirtyBodies, dirtyComments } = openedStore();
  const { data: state } = useLiveQuery((q) =>
    q
      .from({ s: sync })
      .where(({ s }) => eq(s.id, "sync"))
      .findOne(),
  );
  const { data: issues } = useLiveQuery(dirtyIssues);
  const { data: bodies } = useLiveQuery(dirtyBodies);
  const { data: comments } = useLiveQuery(dirtyComments);
  const unsynced = issues.length + bodies.length + comments.length;
  if (!state) return { kind: "starting", unsynced };
  if (!state.online) return { kind: "offline", unsynced };
  const behind = (["issues", "bodies", "comments"] as const).find((s) => !state.caughtUp[s]);
  if (behind) return { kind: "syncing", stream: behind, cursor: state.cursors[behind], head: state.head, unsynced };
  return { kind: "idle", unsynced };
}
