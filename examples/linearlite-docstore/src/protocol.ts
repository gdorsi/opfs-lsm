import type { PlanSummary } from "@opfs-lsm/db";
import { record, report, type Kpi } from "./telemetry.ts";

/**
 * What the app and the page that frames it post to each other. Every time is in milliseconds. The times count
 * storage work only. `opened` and `first-rows` start once the kv wasm module is loaded, at the call that opens the
 * database. `first-rows` and `filter` end when the store returns the rows, before they are drawn.
 */
export const SOURCE = "linearlite-demo";

export type FromDemo =
  | { readonly type: "opened"; readonly ms: number; readonly issues: number }
  | { readonly type: "first-rows"; readonly ms: number }
  | { readonly type: "progress"; readonly written: number; readonly total: number }
  | { readonly type: "generated"; readonly count: number; readonly generateMs: number; readonly writeMs: number }
  | { readonly type: "filter"; readonly label: string; readonly plan: PlanSummary; readonly rowsMs: number; readonly total: number; readonly totalMs: number }
  | { readonly type: "deleted" }
  | { readonly type: "failed"; readonly message: string };

export type ToDemo = { readonly type: "generate"; readonly count: number } | { readonly type: "delete" };

const KPIS: { readonly [T in FromDemo["type"]]: ((message: Extract<FromDemo, { type: T }>) => Kpi) | null } = {
  opened: (m) => ({ name: "linearlite.open", ms: m.ms, attributes: { "linearlite.first_page_rows": m.issues } }),
  "first-rows": (m) => ({ name: "linearlite.first_rows", ms: m.ms, attributes: {} }),
  filter: (m) => ({
    name: "linearlite.filter",
    ms: m.rowsMs,
    attributes: {
      "linearlite.read_path": m.plan.kind === "index" ? m.plan.index : m.plan.kind,
      "linearlite.read_exact": "exact" in m.plan && m.plan.exact,
      "linearlite.total": m.total,
      "linearlite.total_duration_ms": m.totalMs,
    },
  }),
  generated: (m) => ({
    name: "linearlite.write",
    ms: m.writeMs,
    attributes: { "linearlite.count": m.count, "linearlite.generate_duration_ms": m.generateMs },
  }),
  progress: null,
  deleted: null,
  failed: null,
};

export const post = (message: FromDemo) => {
  const kpi = (KPIS[message.type] as ((message: FromDemo) => Kpi) | null)?.(message);
  if (kpi) record(kpi);
  if (parent !== window) parent.postMessage({ source: SOURCE, ...message }, location.origin);
};

export const failed = (err: unknown) => {
  console.error(err);
  report(err);
  post({ type: "failed", message: err instanceof Error ? err.message : String(err) });
};
