import { createList, type Change } from "./list.ts";
import { DEFAULT_FILTER, describe, type Detail, type Filter, type Issue } from "./model.ts";
import { failed, post } from "./protocol.ts";
import { createIssue, detailOf, editIssue, forgetHost, hostOf, writeIssues, type Draft, type Store } from "./store.ts";

/** A run of generated issues: the first ones into the empty database, or more beside the ones it holds. */
export type Generating = { readonly first: boolean; readonly phase: "generating" | "writing"; readonly written: number; readonly count: number };

export type AppState = {
  /** The database holds no issue, so the list makes way for the Generate button. */
  readonly empty: boolean;
  readonly generating: Generating | undefined;
  readonly filter: Filter;
  /** The total beside the title. Undefined while a count is running. */
  readonly total: number | undefined;
  /** The issue on the issue page, as last stored, while the page is open. */
  readonly issue: Issue | undefined;
  /** The open issue's description and comments, once read. */
  readonly detail: Detail | undefined;
};

export type App = ReturnType<typeof createApp>;

/** Everything the page does besides drawing: reads, writes, the change feed and the timings it posts. */
export function createApp(store: Store) {
  const list = createList(store);
  let state: AppState = { empty: false, generating: undefined, filter: DEFAULT_FILTER, total: undefined, issue: undefined, detail: undefined };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AppState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let run = 0;

  /**
   * Reads the list under the filter and its total, from the first row or, with `stay`, from the rows in view.
   * Resolves with the first page's row count and when the store returned them, before they are drawn.
   */
  function show(label?: string, stay = false) {
    const mine = ++run;
    const from = performance.now();
    if (!stay) set({ total: undefined });
    const shown = list.show(state.filter, stay);
    const counted = shown.total.then((total) => {
      const at = performance.now();
      if (mine === run) set({ total });
      return { total, at };
    });
    void Promise.all([shown.rows, counted]).then(([r, c]) => {
      if (label && mine === run) post({ type: "filter", label, rowsMs: r.at - from, total: c.total, totalMs: c.at - from });
    }, failed);
    return shown.rows;
  }

  /** Issues this tab is writing for the first time: the change feed says what an issue is now, not that it is new. */
  const born = new Set<string>();
  /** Set while this tab writes generated issues, all of them new. */
  let appending = false;

  let syncing = false;
  let stale = false;
  /** Reads the rows in view and the total again, once at a time. */
  async function resync() {
    stale = true;
    if (syncing) return;
    syncing = true;
    try {
      while (stale) {
        stale = false;
        await show(undefined, true);
      }
    } finally {
      syncing = false;
    }
  }

  // Every write to an issue, from this tab or another, arrives here. The list moves the rows it holds and its total
  // by what changed. It reads again only when it cannot tell what an issue was before: a gap, or a write by another
  // tab to an issue this one holds no copy of.
  store.issues.changes((event) => {
    if (event.kind === "gap") return void resync().catch(failed);
    if (event.kind !== "append") return;
    if (appending) {
      const { status, priority, q } = state.filter;
      const open = status.length === 0 && priority.length === 0 && q === "";
      const total = list.grow(open ? event.changes.length : event.changes.filter((c) => !c.deleted && list.keeps(c.doc!)).length);
      if (total !== undefined) set({ total });
      return;
    }
    const changes: Change[] = [];
    for (const change of event.changes) {
      const after = change.deleted ? undefined : change.doc;
      const open = state.issue?.id === change.id;
      const before = open ? state.issue : list.find(change.id);
      if (!before && !born.delete(change.id)) return void resync().catch(failed);
      changes.push({ before, after });
      // A deleted issue closes the issue page.
      if (open) set(after ? { issue: after } : { issue: undefined, detail: undefined });
    }
    const total = list.apply(changes);
    if (total === undefined) void resync().catch(failed);
    else set({ total });
  });

  return {
    list,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: () => state,
    show,

    filter(patch: Partial<Filter>) {
      const next = { ...state.filter, ...patch };
      const label = describe(next, state.filter);
      set({ filter: next });
      show(label).catch(failed);
    },

    /** The first read: the database is empty when it returns no row. */
    async start() {
      const first = await show();
      if (first.rows === 0) set({ empty: true });
      return first;
    },

    open(issue: Issue) {
      set({ issue, detail: undefined });
      detailOf(store, issue).then((detail) => {
        if (state.issue?.id === issue.id) set({ detail });
      }, failed);
    },
    close: () => set({ issue: undefined, detail: undefined }),

    edit(id: string, patch: Parameters<typeof editIssue>[2]) {
      editIssue(store, id, patch).catch(failed);
    },

    create(draft: Draft) {
      const id = crypto.randomUUID();
      born.add(id);
      if (state.empty) set({ empty: false });
      createIssue(store, id, draft).catch(failed);
    },

    /** Writes `count` generated issues: the first ones into the empty database, or more beside the ones it holds. */
    async generate(count: number) {
      if (state.generating) return;
      const first = state.empty;
      set({ generating: { first, phase: "generating", written: 0, count } });
      try {
        appending = true;
        // The first issues are always the same ones. Later ones come from a seed of their own, so their ids are new.
        const seed = first ? 1 : crypto.getRandomValues(new Uint32Array(1))[0]! || 2;
        const { generateMs, writeMs } = await writeIssues(store, count, seed, (phase, written) => {
          set({ generating: { first, phase, written, count } });
          post({ type: "progress", phase, written, total: count });
        });
        appending = false;
        post({ type: "generated", count, generateMs, writeMs });
        if (first) set({ empty: false });
        await show(undefined, !first);
        await hostOf(store);
      } finally {
        appending = false;
        set({ generating: undefined });
      }
    },

    destroy() {
      store.db.dangerousDestroy().then(() => {
        forgetHost();
        if (parent === window) location.reload();
        else post({ type: "deleted" });
      }, failed);
    },
  };
}
