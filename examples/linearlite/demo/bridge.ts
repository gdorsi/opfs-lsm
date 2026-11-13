import type { AnyRouter } from "@tanstack/react-router";
import { parseIssueFilter, type IssueFilter } from "../src/client/filter.ts";
import type { Store } from "../src/client/store.ts";
import { PRIORITY_LABELS, STATUS_LABELS } from "../src/domain/model.ts";
import { countIssues, forgetHost, hostOf, storedBytes, writeIssues } from "./data.ts";
import { SOURCE, type FromDemo, type ToDemo } from "./protocol.ts";

const post = (message: FromDemo) => {
  if (parent !== window) parent.postMessage({ source: SOURCE, ...message }, location.origin);
};

/** Resolves with the time of the first task after the next frame is painted. */
const painted = () =>
  new Promise<number>((resolve) =>
    requestAnimationFrame(() => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => resolve(performance.now());
      port2.postMessage(0);
    }),
  );

/** The mark the list sets when it first holds rows. */
const FIRST_ROWS = "linearlite:first-rows";

export const failed = (err: unknown) => post({ type: "failed", message: err instanceof Error ? err.message : String(err) });

/**
 * Reports what is stored until two reads agree. Right after a large write the files of the runs that compaction
 * merged are still on disk, and the SharedWorker removes them over the next seconds.
 */
async function reportStored(store: Store): Promise<void> {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const now = await storedBytes(store);
    post({ type: "stored", stored: now });
    if (now.opfsBytes === last) return;
    last = now.opfsBytes;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

type Generating = { readonly phase: "generating" | "writing"; readonly written: number; readonly total: number };
type DemoState = { readonly hasIssues: boolean; readonly generating: Generating | undefined };

let state: DemoState = { hasIssues: false, generating: undefined };
const listeners = new Set<() => void>();
const update = (patch: Partial<DemoState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
export const demoState = () => state;
export const onDemoState = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export async function generateIssues(store: Store, count: number): Promise<void> {
  if (state.generating) return;
  try {
    const { generateMs, writeMs } = await writeIssues(store, count, (phase, written) => {
      update({ generating: { phase, written, total: count } });
      post({ type: "progress", phase, written, total: count });
    });
    post({ type: "generated", count, generateMs, writeMs });
    update({ hasIssues: true, generating: undefined });
    await hostOf(store);
    await reportStored(store);
  } catch (err) {
    update({ generating: undefined });
    failed(err);
  }
}

function describe(filter: IssueFilter, before: IssueFilter): string {
  const parts: string[] = [];
  if (String(filter.status) !== String(before.status)) parts.push(filter.status.length ? `Status: ${filter.status.map((c) => STATUS_LABELS[c]).join(", ")}` : "Status cleared");
  if (String(filter.priority) !== String(before.priority)) parts.push(filter.priority.length ? `Priority: ${filter.priority.map((c) => PRIORITY_LABELS[c]).join(", ")}` : "Priority cleared");
  if (filter.q !== before.q) parts.push(filter.q ? `Search "${filter.q}"` : "Search cleared");
  if (filter.sort !== before.sort || filter.dir !== before.dir) parts.push(`Sorted by ${filter.sort}, ${filter.dir === "asc" ? "ascending" : "descending"}`);
  return parts.join(" · ");
}

/**
 * Times every change of the list's filter from the navigation that makes it. `rowsMs` ends at the first frame painted
 * with rows of the new filter, or with the empty state; `totalMs` at the frame with the toolbar's count.
 */
function timeFilters(router: AnyRouter) {
  let run = 0;
  router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
    if (!fromLocation || toLocation.pathname !== "/" || fromLocation.pathname !== "/") return;
    const before = parseIssueFilter(fromLocation.search as Record<string, unknown>);
    const filter = parseIssueFilter(toLocation.search as Record<string, unknown>);
    const label = describe(filter, before);
    if (label === "") return;
    const mine = ++run;
    const t0 = performance.now();
    const main = document.querySelector(".main");
    const oldList = document.querySelector("#scroller, .empty");
    if (!main) return;
    let rowsMs: number | undefined;
    let done = false;
    const finish = (total: number | undefined, totalMs: number | undefined) => {
      if (done || rowsMs === undefined) return;
      done = true;
      observer.disconnect();
      clearTimeout(timeout);
      if (mine === run) post({ type: "filter", label, rowsMs, total, totalMs });
    };
    const check = () => {
      const list = document.querySelector("#scroller, .empty");
      const shown = list !== null && list !== oldList && (list.classList.contains("empty") || list.querySelector(".row") !== null);
      if (shown && rowsMs === undefined) {
        rowsMs = -1;
        void painted().then((t) => {
          rowsMs = t - t0;
          check();
        });
      }
      const count = document.getElementById("count")?.textContent ?? "";
      if (rowsMs !== undefined && rowsMs >= 0 && count !== "") void painted().then((t) => finish(Number(count.replace(/\D/g, "")), t - t0));
    };
    const observer = new MutationObserver(check);
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    const timeout = setTimeout(() => finish(undefined, undefined), 5000);
  });
}

/** Reports the open and the first painted rows of this page load, then answers the framing page. */
export async function startBridge(store: Store, router: AnyRouter, openedMs: number): Promise<void> {
  const issues = await countIssues(store, 1);
  update({ hasIssues: issues > 0 });
  post({ type: "opened", ms: openedMs, issues });

  void (async () => {
    if (issues === 0) return reportStored(store);
    const ms = await new Promise<number>((resolve) => {
      const seen = performance.getEntriesByName(FIRST_ROWS)[0];
      if (seen) return resolve(seen.startTime);
      new PerformanceObserver((list, observer) => {
        if (list.getEntriesByName(FIRST_ROWS).length === 0) return;
        observer.disconnect();
        void painted().then(resolve);
      }).observe({ type: "mark" });
    });
    post({ type: "first-rows", ms, host: await hostOf(store) });
    await reportStored(store);
  })().catch(failed);

  timeFilters(router);

  addEventListener("message", (e: MessageEvent<ToDemo & { source?: string }>) => {
    if (e.origin !== location.origin || e.data?.source !== SOURCE) return;
    const message = e.data;
    if (message.type === "generate") void generateIssues(store, message.count);
    else if (message.type === "measure") void reportStored(store).catch(failed);
    else if (message.type === "delete") {
      void store.db.dangerousDestroy().then(() => {
        forgetHost();
        post({ type: "deleted" });
      }, failed);
    }
  });
}
