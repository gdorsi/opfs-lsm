import { createLiveQueryCollection, type InitialQueryBuilder, type QueryBuilder } from "@tanstack/db";
import type { Body, Comment, Issue, StatusCode } from "../domain/model.ts";
import type { Anchor, Backend, SortValue, StatusCounts } from "./backend.ts";
import type { IssueFilter } from "./filter.ts";
import { listeners, memo, observe, watches, type Live, type Observed, type Snapshot, type Unsubscribe } from "./live.ts";
import { backoffMs } from "./ops.ts";
import { bodyOf, commentsOf, issueById, windowQuery } from "./query.ts";

export const LIST_WINDOW = 100;
const COLUMN_WINDOW = 50;
/** Rows past its anchor that the list's live query may hold before the list anchors again. */
const REACH = 1000;
/** Rows an anchor sits above the first row asked for, so a short scroll up stays in the same live query. */
const ABOVE = 200;

/** Ordered rows, the first of them `offset` rows down the order. */
export type WindowView = { readonly rows: readonly Issue[]; readonly offset: number };

/** An ordered window that `setRange` moves. */
export interface Window extends Live<WindowView> {
  setRange(from: number, to: number): void;
}

/** The list's window and its total, which is undefined until counted. */
export interface IssueList extends Live<WindowView & { readonly total: number | undefined }> {
  setRange(from: number, to: number): void;
}

/** The description and comments of an issue. `missing`: the server answered that it has no description. */
export type Thread =
  | { readonly kind: "loading" }
  | { readonly kind: "missing"; readonly comments: readonly Comment[] }
  | { readonly kind: "ready"; readonly body: Body; readonly comments: readonly Comment[] };

export interface Issues {
  list(filter: IssueFilter): IssueList;
  /** A board column: the issues with `status` under `filter`, in board order. */
  column(filter: IssueFilter, status: StatusCode): Window;
  /** Live issues under `filter` per status code; undefined until counted. */
  counts(filter: IssueFilter): Live<StatusCounts | undefined>;
  /** The issue as a live query reads it, or as the collection holds it, tombstone included, until that query is ready. */
  get(id: string): Live<Issue | undefined>;
  /**
   * Read from kv while subscribed. A thread whose description this replica lacks is fetched from the server, retried
   * with backoff and when the network comes back, until it answers.
   */
  thread(id: string): Live<Thread>;
}

/** The fields a count depends on: a sort change keeps the count. */
const counted = ({ status, priority, q }: IssueFilter) => JSON.stringify([status, priority, q]);

/** A live query dropped a moment after its last subscriber leaves, as `useLiveQuery` makes the queries it builds. */
const transient = (query: (q: InitialQueryBuilder) => QueryBuilder<any>) => observe(createLiveQueryCollection({ query, gcTime: 1, startSync: true }));

type WindowQuery = ReturnType<typeof windowQuery>;

/** The rows before an anchor's sort value, counted again on every change. */
type Counting = { readonly value: SortValue; count?: number; stop: Unsubscribe };

/**
 * The list's live query and the window in it. Without an anchor the query starts at the top of the order; with one it
 * starts at the anchor's sort value, `base` rows down the list. Windows up to `reach` rows into it move it.
 */
type Placement = {
  readonly anchor: Anchor | undefined;
  readonly query: WindowQuery;
  readonly observed: Observed;
  readonly offset: number;
  readonly reach: number;
};

const LOADING: Thread = { kind: "loading" };

export function issueViews(
  backend: Backend,
  { fetchThread, online }: { fetchThread(id: string): Promise<unknown>; online(back: () => void): Unsubscribe },
): Issues {
  const issues = backend.collection("issues");
  const watched = watches();

  /**
   * TanStack loads a window at offset N as the first N rows plus the window, so a window deep in a list the backend
   * can anchor gets its own live query that starts at the sort value of its first row (`locate`). Its rows sit `base`
   * rows down the list, where `base` counts the rows before that value and is counted again on every change. Other
   * lists keep one query from the top.
   */
  function list(filter: IssueFilter): IssueList {
    const total = watched(`total ${counted(filter)}`, (emit: (total: number) => void) => backend.watchTotal(filter, emit));
    const anchoring = backend.anchor?.(filter);
    const top = windowQuery(issues, filter, LIST_WINDOW);
    let placement: Placement = { anchor: undefined, query: top, observed: observe(top), offset: 0, reach: REACH };
    let unwatch: Unsubscribe | undefined;
    let before: Counting | undefined;
    let asked = 0;

    const base = () => {
      const { anchor } = placement;
      if (!anchor) return 0;
      return (before?.value === anchor.value ? before.count : undefined) ?? anchor.base;
    };
    /** Counts the rows before the anchor again on every change, while subscribed. */
    const countAbove = () => {
      const value = placement.anchor?.value;
      if (before?.value === value) return;
      before?.stop();
      before = undefined;
      if (value === undefined || !anchoring) return;
      const counting: Counting = { value, stop: () => {} };
      counting.stop = anchoring.watchBase(value, (n) => {
        counting.count = n;
        notify();
      });
      before = counting;
    };
    const { notify, subscribe } = listeners((notify) => {
      unwatch = placement.observed.subscribe(notify);
      const untotal = total.subscribe(notify);
      countAbove();
      return () => {
        unwatch?.();
        unwatch = undefined;
        untotal();
        before?.stop();
        before = undefined;
      };
    });
    const place = (next: Placement) => {
      placement = next;
      if (unwatch) {
        unwatch();
        unwatch = next.observed.subscribe(notify);
        countAbove();
      }
      notify();
    };
    const view = memo((snapshot: Snapshot, offset: number, total: number | undefined) => ({ rows: snapshot.data as readonly Issue[], offset, total }));

    return {
      get: () => view(placement.observed.snapshot(), base() + placement.offset, total.get()),
      subscribe,
      setRange(from, to) {
        const start = Math.max(0, from);
        const limit = Math.max(LIST_WINDOW, to - from);
        const ask = ++asked;
        const anchorAt = (anchor: Anchor | undefined, offset: number) => {
          const query = windowQuery(issues, filter, limit, undefined, { from: anchor?.value, offset });
          place({ anchor, query, observed: observe(query), offset, reach: offset + REACH });
        };
        const move = (offset: number) => {
          const current = placement.query.utils.getWindow();
          if (current?.offset !== offset || current.limit !== limit) void placement.query.utils.setWindow({ offset, limit });
          if (placement.offset !== offset) place({ ...placement, offset, reach: Math.max(placement.reach, offset + REACH) });
        };
        if (!anchoring || start < REACH) return placement.anchor ? anchorAt(undefined, start) : move(start);
        const b = base();
        if (placement.anchor && start >= b && start - b <= placement.reach) return move(start - b);
        void anchoring.locate(start - ABOVE).then(
          (found) => {
            if (ask !== asked) return;
            if (!found) return anchorAt(undefined, start);
            if (placement.anchor?.value === found.value) return move(start - found.base);
            anchorAt(found, start - found.base);
          },
          (err: unknown) => {
            console.warn("linearlite could not locate a row, loading the list from the top", err);
            if (ask === asked) anchorAt(undefined, start);
          },
        );
      },
    };
  }

  function column(filter: IssueFilter, status: StatusCode): Window {
    const query = windowQuery(issues, filter, COLUMN_WINDOW, status);
    const observed = observe(query);
    let offset = 0;
    const { notify, subscribe } = listeners((notify) => observed.subscribe(notify));
    const view = memo((snapshot: Snapshot, offset: number) => ({ rows: snapshot.data as readonly Issue[], offset }));
    return {
      get: () => view(observed.snapshot(), offset),
      subscribe,
      setRange(start, end) {
        const next = { offset: Math.max(0, start), limit: Math.max(COLUMN_WINDOW, end - start) };
        const current = query.utils.getWindow();
        if (current?.offset === next.offset && current.limit === next.limit) return;
        void query.utils.setWindow(next);
        offset = next.offset;
        notify();
      },
    };
  }

  function get(id: string): Live<Issue | undefined> {
    const observed = transient(issueById(issues, id));
    return {
      get: () => (observed.snapshot().data as Issue | undefined) ?? issues.get(id),
      subscribe: (onChange) => observed.subscribe(onChange),
    };
  }

  function thread(id: string): Live<Thread> {
    const body = transient(bodyOf(backend.collection("bodies"), id));
    const comments = transient(commentsOf(backend.collection("comments"), id));
    let fetched = false;
    let fetching: Unsubscribe | undefined;
    const fetchUntilAnswered = () => {
      let live = true;
      let failures = 0;
      let inFlight = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const attempt = () => {
        if (!live || inFlight) return;
        clearTimeout(timer);
        inFlight = true;
        fetchThread(id).then(
          () => {
            inFlight = false;
            if (!live) return;
            fetched = true;
            notify();
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
      const off = online(attempt);
      attempt();
      return () => {
        live = false;
        clearTimeout(timer);
        off();
      };
    };
    /** Fetches while the replica lacks the body, and stops once it holds one. */
    const fetchWhileAbsent = () => {
      const s = body.snapshot();
      const absent = s.isReady && s.data === undefined;
      if (absent && !fetching) fetching = fetchUntilAnswered();
      else if (!absent && fetching) {
        fetching();
        fetching = undefined;
      }
    };
    const { notify, subscribe } = listeners((notify) => {
      const changed = () => {
        fetchWhileAbsent();
        notify();
      };
      const offs = [body.subscribe(changed), comments.subscribe(changed)];
      fetchWhileAbsent();
      return () => {
        for (const off of offs) off();
        fetching?.();
        fetching = undefined;
      };
    });
    const view = memo((body: Snapshot, comments: Snapshot, fetched: boolean): Thread => {
      if (!body.isReady || !comments.isReady) return LOADING;
      const thread = comments.data as readonly Comment[];
      if (body.data) return { kind: "ready", body: body.data as Body, comments: thread };
      return fetched ? { kind: "missing", comments: thread } : LOADING;
    });
    return { get: () => view(body.snapshot(), comments.snapshot(), fetched), subscribe };
  }

  return {
    list,
    column,
    counts: (filter) => watched(`status ${counted(filter)}`, (emit: (counts: StatusCounts) => void) => backend.watchCounts(filter, emit)),
    get,
    thread,
  };
}
