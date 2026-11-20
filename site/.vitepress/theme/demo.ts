/**
 * Where the demo stands in the visitor's visit, from the app opening to the timing it tells. Every time is in
 * milliseconds.
 */
export type Visit =
  /** Before the app's first message. */
  | { kind: "waiting" }
  /** The app opened with no issue and nothing to write: it shows its own Generate button. */
  | { kind: "empty" }
  | { kind: "writing"; written: number; total: number }
  /** This page wrote the issues and has not reloaded since. */
  | { kind: "written"; count: number; writeMs: number }
  /** This page wrote the issues, then reloaded. */
  | { kind: "reopened"; ms: number }
  /** The app found issues an earlier visit stored. */
  | { kind: "returning"; ms: number }
  | { kind: "failed"; message: string };

export const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`);
export const n = (x: number) => Math.round(x).toLocaleString("en-US");
