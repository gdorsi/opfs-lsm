import type { WriterId } from "./check.js";
import type { BusMessage, BusRow } from "./host/protocol.js";

/**
 * A row that lands within this long of the tab's last post waits, and one
 * message carries the rows of the wait (design.md, "Seeing other tabs'
 * writes"). The cost of a post is per message, and a tab that awaits each
 * put lands many rows in this time.
 */
export const ROW_POST_MS = 4;

/** Batches the rows a tab appended onto the layers channel. */
export type RowPost = {
  /**
   * Post a landed row, with the bytes of its ops. Posted at once unless
   * the tab posted within the last `rowPostMs`: then it waits for the
   * first landing past that time, or for the timer when no landing
   * follows. A hidden page posts every row at once.
   */
  readonly add: (row: BusRow, bytes: number) => void;
  /** Post the rows that wait, and stop. The caller adds no row after this, then closes the channel. */
  readonly close: () => void;
};

/** A page nobody looks at. The browser slows its timers, and can stop them. */
function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function rowPost(bus: BroadcastChannel, writerId: WriterId, rowPostMs: number): RowPost {
  /** Landed and not yet posted, in seq order, with the bytes of their ops. */
  let rows: BusRow[] = [];
  let bytes = 0;
  /** `performance.now()` of the last post. */
  let postedAt = Number.NEGATIVE_INFINITY;
  /** Posts the rows that no later landing posted. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  const post = () => {
    clearTimeout(timer);
    timer = undefined;
    if (rows.length === 0) return;
    const message: BusMessage = { kind: "rows", writerId, rows, bytes };
    rows = [];
    bytes = 0;
    postedAt = performance.now();
    bus.postMessage(message);
  };
  // Posts the rows that wait when the page is hidden, before the browser slows the timer.
  const hasDocument = typeof document !== "undefined";
  if (hasDocument) document.addEventListener("visibilitychange", post);
  return {
    add(row, rowBytes) {
      rows.push(row);
      bytes += rowBytes;
      if (pageHidden() || performance.now() - postedAt >= rowPostMs) post();
      else timer ??= setTimeout(post, rowPostMs);
    },
    close() {
      post();
      if (hasDocument) document.removeEventListener("visibilitychange", post);
    },
  };
}
