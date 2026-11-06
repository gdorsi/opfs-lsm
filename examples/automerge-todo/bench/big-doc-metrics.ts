export const ADAPTERS = ["kv", "idb", "mem"] as const;
export type Adapter = (typeof ADAPTERS)[number];

/** One side of the comparison. `walBytes` overrides kv's ingest trigger (`maxWalBytes`). */
export type Variant = { label: string; adapter: Adapter; walBytes?: number };

/**
 * `trace:<n>` replays automerge's editing trace (data/edits.json, 260k keystrokes
 * of a LaTeX paper) into one text field, `n` keystrokes per change.
 * Any other value is a saved document, as a path inside automerge's
 * rust/benchmark-battery (for example `data/moby-dick.automerge`), imported whole.
 */
export type Workload = { kind: "trace"; perChange: number } | { kind: "import"; file: string };

export function parseWorkload(spec: string): Workload {
  const trace = /^trace:(\d+)$/.exec(spec);
  return trace ? { kind: "trace", perChange: Number(trace[1]) } : { kind: "import", file: spec };
}

export const METRICS = [
  { name: "open", describe: "construct storage until usable, after Chrome's first storage touch" },
  { name: "write", describe: "build or import the doc, then repo.flush()" },
  { name: "flush", describe: "the final repo.flush() alone" },
  { name: "load", describe: "new storage + Repo, find the doc, read it (median of loads)" },
  { name: "loadMax", describe: "slowest of those loads" },
] as const;
export type MetricName = (typeof METRICS)[number]["name"];

export type Params = { workload: string; loads: number };

export type RunResult = {
  variant: Variant;
  params: Params;
  metrics: Record<MetricName, number>;
  checks: {
    changes: number;
    docBytes: number;
    /** Loads whose heads and content matched the doc as written. */
    goodLoads: number;
    ingests: number;
    errors: string[];
  };
};
