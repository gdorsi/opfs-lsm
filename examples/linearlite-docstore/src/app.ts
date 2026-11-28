import type { LiveQuery, PlanSummary } from "@opfs-lsm/db";
import { destroyDb } from "@opfs-lsm/kv";
import { createSignal } from "solid-js";
import { anyIssue, pageOf, totalOf } from "./list.ts";
import { DEFAULT_FILTER, describe, type Filter, type Store } from "./model.ts";
import { failed, post } from "./protocol.ts";
import { createIssue, editIssue, writeIssues, type Draft } from "./store.ts";

/** A run of generated issues: the first ones into the empty database, or more beside the ones it holds. */
export type Generating = { readonly written: number; readonly count: number };

/**
 * A read the app times: the first page of a list and its total, from `from` until the store hands each over, before
 * it is drawn. Without a label it is the first list after the open.
 */
type Read = {
  readonly label: string | undefined;
  readonly from: number;
  plan?: PlanSummary;
  rows?: { readonly n: number; readonly at: number };
  total?: { readonly n: number; readonly at: number };
};

/** `query`, with `first` called on the first result of each subscription. */
function watched<V>(query: LiveQuery<V>, first: (value: V) => void): LiveQuery<V> {
  return {
    ...query,
    subscribe(next, error) {
      let seen = false;
      return query.subscribe((value) => {
        if (!seen) first(value);
        seen = true;
        next(value);
      }, error);
    },
  };
}

export type App = ReturnType<typeof createApp>;

/**
 * Everything the page does besides drawing: the filter and the open issue, the list's queries, the writes and the
 * timings it posts. `opening` says when the database was asked to open and how long that took.
 */
export function createApp(store: Store, name: string, opening: { readonly from: number; readonly ms: number }) {
  const [filter, setFilter] = createSignal(DEFAULT_FILTER);
  const [opened, setOpened] = createSignal<string>();
  const [generating, setGenerating] = createSignal<Generating>();
  let read: Read | undefined = { label: undefined, from: opening.from };
  let deleting = false;

  function landed(mine: Read) {
    if (read !== mine || !mine.rows) return;
    if (mine.label === undefined) {
      read = undefined;
      post({ type: "opened", ms: opening.ms, issues: mine.rows.n });
      if (mine.rows.n > 0) post({ type: "first-rows", ms: mine.rows.at - mine.from });
    } else if (mine.total && mine.plan) {
      read = undefined;
      post({ type: "filter", label: mine.label, plan: mine.plan, rowsMs: mine.rows.at - mine.from, total: mine.total.n, totalMs: mine.total.at - mine.from });
    }
  }

  const leave = () => {
    if (parent === window) location.reload();
    else post({ type: "deleted" });
  };

  return {
    store,
    filter,
    /** The id of the issue on the issue page, while the page is open. */
    opened,
    generating,

    /** Page `at` of the list under the filter. */
    page(at: number) {
      const query = pageOf(store.issues, filter(), at);
      const mine = read;
      if (at > 0 || !mine) return query;
      mine.plan = query.explain();
      return watched(query, (rows) => {
        mine.rows = { n: rows.length, at: performance.now() };
        landed(mine);
      });
    },

    /** How many issues the list under the filter holds. */
    total() {
      const query = totalOf(store.issues, filter());
      const mine = read;
      if (!mine) return query;
      return watched(query, (n) => {
        mine.total = { n, at: performance.now() };
        landed(mine);
      });
    },

    setFilter(patch: Partial<Filter>) {
      const next = { ...filter(), ...patch };
      read = { label: describe(next, filter()), from: performance.now() };
      setFilter(next);
    },

    open: (id: string) => void setOpened(id),
    close: () => void setOpened(undefined),

    edit(id: string, patch: Parameters<typeof editIssue>[2]) {
      editIssue(store, id, patch).catch(failed);
    },

    create(draft: Draft) {
      createIssue(store, crypto.randomUUID(), draft).catch(failed);
    },

    /** Writes `count` generated issues: the first ones into the empty database, or more beside the ones it holds. */
    async generate(count: number) {
      if (generating()) return;
      setGenerating({ written: 0, count });
      try {
        // The first issues are always the same ones. Later ones come from a seed of their own, so their ids are new.
        const empty = (await anyIssue(store.issues).run()) === undefined;
        const seed = empty ? 1 : crypto.getRandomValues(new Uint32Array(1))[0]! || 2;
        const { generateMs, writeMs } = await writeIssues(store, count, seed, (written) => {
          setGenerating({ written, count });
          post({ type: "progress", written, total: count });
        });
        post({ type: "generated", count, generateMs, writeMs });
      } finally {
        setGenerating(undefined);
      }
    },

    /** Removes the database. Every tab that has it open then starts over: see `gone`. */
    destroy() {
      deleting = true;
      destroyDb(name).then(leave, failed);
    },

    /** The database was removed, by this tab or another. The tab that removes it leaves once the removal is done. */
    gone() {
      if (!deleting) leave();
    },
  };
}
