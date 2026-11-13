/**
 * What the demo and the page that frames it post to each other. Every time is in milliseconds. Times "since the
 * frame's navigation began" count from `performance.timeOrigin`, so they include fetching the frame's own files.
 */
export const SOURCE = "linearlite-demo";

/** `restarted`: the SharedWorker began after the stored issues were flushed, so this page did not find it running. */
export type Host = "restarted" | "alive" | "unknown";

export type FromDemo =
  | { readonly type: "opened"; readonly ms: number; readonly issues: number }
  | { readonly type: "first-rows"; readonly ms: number; readonly host: Host }
  | { readonly type: "progress"; readonly phase: "generating" | "writing"; readonly written: number; readonly total: number }
  | { readonly type: "generated"; readonly count: number; readonly generateMs: number; readonly writeMs: number }
  | { readonly type: "filter"; readonly label: string; readonly rowsMs: number; readonly total: number | undefined; readonly totalMs: number | undefined }
  | { readonly type: "deleted" }
  | { readonly type: "failed"; readonly message: string };

export type ToDemo = { readonly type: "generate"; readonly count: number } | { readonly type: "delete" };
