import { destroyDb } from "@opfs-lsm/kv";
import "./app.css";
import { createList } from "./list.ts";
import { DEFAULT_FILTER, type Filter } from "./model.ts";
import { SOURCE, failed, painted, post, type ToDemo } from "./protocol.ts";
import { forgetHost, hostOf, openStore, viewOf, writeIssues } from "./store.ts";
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
    <div class="sync"><b>Local only</b><span>docstore on kv, no server</span><button class="btn" id="delete">Delete the data</button></div>
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

  const list = createList(scroller);
  let filter: Filter = DEFAULT_FILTER;
  let run = 0;

  /** Reads the list under the filter and its total. Resolves with the first page's rows and when they were painted. */
  async function show(label?: string) {
    const mine = ++run;
    const from = performance.now();
    const view = viewOf(store, filter);
    toolbar.count(undefined);
    const counted = view.total.then(async (total) => {
      if (mine === run) toolbar.count(total);
      return { total, at: await painted() };
    });
    const rows = await list.show(view);
    const rowsAt = await painted();
    void counted.then(({ total, at }) => {
      if (label && mine === run) post({ type: "filter", label, rowsMs: rowsAt - from, total, totalMs: at - from });
    }, failed);
    return { rows, rowsAt };
  }

  const toolbar = createToolbar($(".topbar"), (next) => {
    const label = describe(next, filter);
    filter = next;
    show(label).catch(failed);
  });

  let generating = false;
  async function generate(count: number) {
    if (generating) return;
    generating = true;
    try {
      showList(false);
      $("#start").hidden = true;
      progress.hidden = false;
      const { generateMs, writeMs } = await writeIssues(store, count, (phase, written) => {
        progress.querySelector("h2")!.textContent = phase === "generating" ? "Generating issues" : "Writing issues";
        progress.querySelector("p")!.textContent = `${n(written)} of ${n(count)}`;
        progress.querySelector("i")!.style.width = `${(written / count) * 100}%`;
        post({ type: "progress", phase, written, total: count });
      });
      post({ type: "generated", count, generateMs, writeMs });
      showList(true);
      await show();
      await hostOf(store);
    } finally {
      generating = false;
    }
  }

  const destroy = () =>
    store.db.dangerousDestroy().then(() => {
      forgetHost();
      if (parent === window) location.reload();
      else post({ type: "deleted" });
    }, failed);

  $("#demo-generate").onclick = () => void generate(COUNT).catch(failed);
  $("#delete").onclick = () => void destroy();
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
