/**
 * What the app and the page that frames it post to each other. Every time is in milliseconds. The times count
 * storage work only. `opened` and `first-rows` start once the kv wasm module is loaded, at the call that opens the
 * database. `first-rows` and `filter` end when the store returns the rows, before they are drawn.
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

export const post = (message: FromDemo) => {
  if (parent !== window) parent.postMessage({ source: SOURCE, ...message }, location.origin);
};

export const failed = (err: unknown) => {
  console.error(err);
  post({ type: "failed", message: err instanceof Error ? err.message : String(err) });
};
