import { and, eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Body, Comment, Issue, StatusCode } from "../domain/model.ts";
import { STREAMS, type Stream } from "../domain/stores.ts";
import { anchors, countBefore, countByStatus, countTotal, locate, type Anchor, type Pause } from "./counts.ts";
import type { IssueFilter } from "./filter.ts";
import { backoffMs } from "./ops.ts";
import { windowQuery } from "./query.ts";
import { openedStore, type IssueDocs } from "./store.ts";
import { fetchDetail, preloadDetails } from "./sync.ts";

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

/** A hidden tab paints no frame and wakes its timers about once a second, so a recount there does not pause. */
const recountPause = (): Pause | undefined => (document.hidden ? undefined : yieldTask);

/**
 * `read` of the stored issues, run again after every change to them. One read runs at a time. Changes during a read
 * start one more, four times that read's duration after it and at least 250 ms, so a first sync, which changes the
 * issues every few milliseconds, spends at most a fifth of the main thread counting them. A read after a change
 * pauses between steps in a visible tab, so it does not hold up a frame there; the first read for `key` does not,
 * since the screen waits on it. Undefined until the first read for `key` resolves, and without a `read`.
 */
function useIssueRead<T>(key: string, read: ((issues: IssueDocs, pause?: Pause) => Promise<T>) | undefined): T | undefined {
  const { docs } = openedStore();
  const [result, setResult] = useState<{ readonly key: string; readonly value: T }>();
  useEffect(() => {
    if (!read) return;
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
      if (live && again) timer = setTimeout(() => void run(recountPause()), Math.max(250, 4 * (performance.now() - t0)));
    };
    const off = issues.changes((event) => {
      if (event.kind === "closed") return;
      if (running || timer !== undefined) again = true;
      else void run(recountPause());
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

/** Rows past its anchor that the list's live query may hold before the list anchors again. */
const REACH = 1000;
/** Rows an anchor sits above the first row asked for, so a short scroll up stays in the same live query. */
const ABOVE = 200;

/**
 * The list's live query and the window in it. Without an anchor the query starts at the top of the order; with one
 * it starts at the anchor's sort value, `base` rows down the list. Windows up to `reach` rows into it move it.
 * `origin` is the filter's top query: a placement made under another filter, or under this one before a switch away
 * and back, is not used.
 */
type Placement = {
  readonly origin: ReturnType<typeof windowQuery>;
  readonly anchor: Anchor | undefined;
  readonly query: ReturnType<typeof windowQuery>;
  readonly offset: number;
  readonly reach: number;
};

/**
 * The list's rows. TanStack loads a window at offset N as the first N rows plus the window, so a window deep in the
 * unfiltered list gets its own live query that starts at the sort value of its first row (`locate`). Its rows sit
 * `base` rows down the list, where `base` counts the rows before that value and is counted again on every change.
 * A filtered list, and the list by title, keep one query from the top (`anchors`).
 */
export function useIssueWindow(filter: IssueFilter): IssueWindow & { readonly total: number | undefined } {
  const { issues, docs } = openedStore();
  const key = JSON.stringify(filter);
  const top = useMemo<Placement>(() => {
    const query = windowQuery(issues, filter, LIST_WINDOW);
    return { origin: query, anchor: undefined, query, offset: 0, reach: REACH };
  }, [key]);
  const [placed, setPlaced] = useState<Placement>();
  const placement = placed?.origin === top.origin ? placed : top;
  const { data } = useLiveQuery(placement.query);
  const { anchor } = placement;
  const before = useIssueRead(JSON.stringify([key, anchor?.value]), anchor && ((d) => countBefore(d, filter, anchor.value)));
  const base = anchor ? (before ?? anchor.base) : 0;
  const latest = useRef({ placement, base });
  latest.current = { placement, base };
  const asked = useRef(0);
  const setRange = useCallback(
    (from: number, to: number) => {
      const start = Math.max(0, from);
      const limit = Math.max(LIST_WINDOW, to - from);
      const ask = ++asked.current;
      const place = (anchor: Anchor | undefined, offset: number) =>
        setPlaced({ origin: top.origin, anchor, query: windowQuery(issues, filter, limit, undefined, { from: anchor?.value, offset }), offset, reach: offset + REACH });
      const move = (p: Placement, offset: number) => {
        const current = p.query.utils.getWindow();
        if (current?.offset !== offset || current.limit !== limit) void p.query.utils.setWindow({ offset, limit });
        if (p.offset !== offset) setPlaced({ ...p, offset, reach: Math.max(p.reach, offset + REACH) });
      };
      const { placement: p, base: b } = latest.current;
      if (!anchors(filter) || start < REACH) return p.anchor ? place(undefined, start) : move(p, start);
      if (p.anchor && start >= b && start - b <= p.reach) return move(p, start - b);
      void locate(docs.collection("issues"), filter, start - ABOVE).then(
        (found) => {
          if (ask !== asked.current) return;
          const now = latest.current.placement;
          if (!found) return place(undefined, start);
          if (now.anchor?.value === found.value) return move(now, start - found.base);
          place(found, start - found.base);
        },
        (err: unknown) => {
          console.warn("linearlite could not locate a row, loading the list from the top", err);
          if (ask === asked.current) place(undefined, start);
        },
      );
    },
    [top],
  );
  const total = useIssueRead(counted(filter), (d, pause) => countTotal(d, filter, pause));
  return { rows: data, offset: base + placement.offset, setRange, total };
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

/** Preload delay: a scroll that passes rows by does not ask for them. */
const PRELOAD_DELAY_MS = 200;

/** Loads the bodies and comments of the issues on screen, once `ids` has held still for a moment. */
export function usePreloadDetails(ids: readonly string[]): void {
  const key = ids.join(","); // ids are [A-Za-z0-9_-]
  useEffect(() => {
    if (key === "") return;
    const timer = setTimeout(() => void preloadDetails(key.split(",")), PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key]);
}

export type IssueDetail =
  | { readonly kind: "loading" }
  | { readonly kind: "missing"; readonly comments: readonly Comment[] }
  | { readonly kind: "ready"; readonly body: Body; readonly comments: readonly Comment[] };

/**
 * The description and comments, read from kv while the view is mounted. A body this replica lacks (its issue has not
 * been on screen) is fetched from the server, retried with backoff and on `online` until it answers; only an answer
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

/** Whether storage pressure waits for the user's confirmation, and the unsent body and comment edits a removal waits for. */
export function usePressure(): { readonly pending: boolean; readonly unsent: number } {
  const { sync, dirtyBodies, dirtyComments } = openedStore();
  const { data } = useLiveQuery((q) =>
    q
      .from({ s: sync })
      .where(({ s }) => eq(s.id, "sync"))
      .findOne(),
  );
  const { data: bodies } = useLiveQuery(dirtyBodies);
  const { data: comments } = useLiveQuery(dirtyComments);
  return { pending: data?.pressure === true, unsent: bodies.length + comments.length };
}

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
  const behind = STREAMS.find((s) => !state.caughtUp[s]);
  if (behind) return { kind: "syncing", stream: behind, cursor: state.cursors[behind], head: state.head, unsynced };
  return { kind: "idle", unsynced };
}
