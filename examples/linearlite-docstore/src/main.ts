import { destroyDb } from "@opfs-lsm/kv";
import "./app.css";
import { openCompose } from "./compose.ts";
import { createDetail } from "./detail.ts";
import { createList, type Change } from "./list.ts";
import { DEFAULT_FILTER, type Filter } from "./model.ts";
import { SOURCE, failed, painted, post, type ToDemo } from "./protocol.ts";
import { createIssue, forgetHost, hostOf, openStore, writeIssues } from "./store.ts";
import { createToolbar, describe } from "./toolbar.ts";

const params = new URLSearchParams(location.search);
const NAME = params.get("db") ?? "linearlite-docstore";
const COUNT = Number(params.get("count")) || 100_000;
const n = (x: number) => x.toLocaleString("en-US");

document.getElementById("root")!.innerHTML = `
<div class="app">
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark">L</span>LinearLite</div>
    <span class="nav active">All issues</span>
    <div class="spacer"></div>
    <div class="sync">
      <b>Local only</b>
      <button class="btn" id="more">Generate ${n(COUNT)} more</button>
      <div class="bar" id="more-bar" hidden><i></i></div>
      <button class="btn" id="delete">Delete the data</button>
    </div>
  </aside>
  <main class="main">
    <div class="topbar"></div>
    <div class="scroller" id="scroller"><div class="rows"></div></div>
    <div class="empty" hidden>
      <div id="start">
        <h2>No issues yet</h2>
        <p>They are generated in a dedicated WebWorker and stored in this browser.</p>
        <button class="btn primary" id="demo-generate">Generate ${n(COUNT)} issues</button>
      </div>
      <div class="demo-progress" hidden><h2></h2><p class="mono"></p><div class="bar"><i></i></div></div>
    </div>
    <div class="detail" hidden></div>
  </main>
</div>`;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const scroller = $("#scroller");
const empty = $(".empty");
const progress = $(".demo-progress");

/** The list, or the block that stands in for it while the database holds no issue. */
function showList(shown: boolean) {
  scroller.hidden = !shown;
  empty.hidden = shown;
  $("#start").hidden = false;
  progress.hidden = true;
}

async function main() {
  // Every time this app reports counts from here: the call that opens the database.
  const t0 = performance.now();
  const store = await openStore(NAME);
  const openedMs = performance.now() - t0;

  const detail = createDetail($(".detail"), store);
  const list = createList(scroller, store, (issue) => detail.open(issue));
  let filter: Filter = DEFAULT_FILTER;
  let run = 0;

  /**
   * Reads the list under the filter and its total, from the first row or, with `stay`, from the rows in view.
   * Resolves with the first page's rows and when they were painted.
   */
  function show(label?: string, stay = false) {
    const mine = ++run;
    const from = performance.now();
    if (!stay) toolbar.count(undefined);
    const shown = list.show(filter, stay);
    const counted = shown.total.then(async (total) => {
      if (mine === run) toolbar.count(total);
      return { total, at: await painted() };
    });
    const rows = shown.rows.then(async (rows) => ({ rows, rowsAt: await painted() }));
    void Promise.all([rows, counted]).then(([r, c]) => {
      if (label && mine === run) post({ type: "filter", label, rowsMs: r.rowsAt - from, total: c.total, totalMs: c.at - from });
    }, failed);
    return rows;
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

  const toolbar = createToolbar(
    $(".topbar"),
    (next) => {
      const label = describe(next, filter);
      filter = next;
      show(label).catch(failed);
    },
    () =>
      openCompose((draft) => {
        const id = crypto.randomUUID();
        born.add(id);
        if (scroller.hidden) showList(true);
        createIssue(store, id, draft).catch(failed);
      }),
  );

  // Every write to an issue, from this tab or another, arrives here. The list moves the rows it holds and its total
  // by what changed. It reads again only when it cannot tell what an issue was before: a gap, or a write by another
  // tab to an issue this one holds no copy of.
  store.issues.changes((event) => {
    if (event.kind === "gap") return void resync().catch(failed);
    if (event.kind !== "append") return;
    if (appending) {
      const open = filter.status.length === 0 && filter.priority.length === 0 && filter.q === "";
      const total = list.grow(open ? event.changes.length : event.changes.filter((c) => !c.deleted && list.keeps(c.doc!)).length);
      if (total !== undefined) toolbar.count(total);
      return;
    }
    const changes: Change[] = [];
    for (const change of event.changes) {
      const after = change.deleted ? undefined : change.doc;
      const before = detail.issue?.id === change.id ? detail.issue : list.find(change.id);
      if (!before && !born.delete(change.id)) return void resync().catch(failed);
      changes.push({ before, after });
      if (detail.issue?.id === change.id) detail.update(after);
    }
    const total = list.apply(changes);
    if (total === undefined) void resync().catch(failed);
    else toolbar.count(total);
  });

  let generating = false;
  /** Writes `count` generated issues: the first ones into the empty database, or more beside the ones it holds. */
  async function generate(count: number) {
    if (generating) return;
    generating = true;
    const first = scroller.hidden;
    const bar = $("#more-bar");
    try {
      $("#start").hidden = true;
      progress.hidden = false;
      bar.hidden = first;
      appending = true;
      // The first issues are always the same ones. Later ones come from a seed of their own, so their ids are new.
      const seed = first ? 1 : crypto.getRandomValues(new Uint32Array(1))[0]! || 2;
      const { generateMs, writeMs } = await writeIssues(store, count, seed, (phase, written) => {
        progress.querySelector("h2")!.textContent = phase === "generating" ? "Generating issues" : "Writing issues";
        progress.querySelector("p")!.textContent = `${n(written)} of ${n(count)}`;
        const done = `${phase === "writing" ? (written / count) * 100 : 0}%`;
        progress.querySelector("i")!.style.width = bar.querySelector("i")!.style.width = done;
        post({ type: "progress", phase, written, total: count });
      });
      appending = false;
      post({ type: "generated", count, generateMs, writeMs });
      if (first) showList(true);
      await show(undefined, !first);
      await hostOf(store);
    } finally {
      appending = false;
      generating = false;
      bar.hidden = true;
    }
  }

  const destroy = () =>
    store.db.dangerousDestroy().then(() => {
      forgetHost();
      if (parent === window) location.reload();
      else post({ type: "deleted" });
    }, failed);

  $("#demo-generate").onclick = $("#more").onclick = () => void generate(COUNT).catch(failed);
  $("#delete").onclick = () => void destroy();
  addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".backdrop")) detail.close();
  });
  addEventListener("message", (e: MessageEvent<ToDemo & { source?: string }>) => {
    if (e.origin !== location.origin || e.data?.source !== SOURCE) return;
    if (e.data.type === "generate") void generate(e.data.count).catch(failed);
    else if (e.data.type === "delete") void destroy();
  });

  const { rows, rowsAt } = await show();
  post({ type: "opened", ms: openedMs, issues: rows });
  if (rows === 0) showList(false);
  else post({ type: "first-rows", ms: rowsAt - t0, host: await hostOf(store) });
  void dropRetired();
}

/**
 * The docs home page's earlier demo, the TanStack DB build of LinearLite, kept its issues in a database of this name
 * with another schema. Removed in the background, once, so a visitor of that version gets the space back.
 */
const RETIRED = "opfs-lsm-home";

async function dropRetired(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await (await root.getDirectoryHandle("opfs-lsm")).getDirectoryHandle(RETIRED);
  } catch {
    return;
  }
  await destroyDb(RETIRED).catch(() => undefined);
}

main().catch(failed);
