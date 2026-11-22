/**
 * Every results table of docs/benchmarks.md: the run it comes from and the
 * series each cell reads. `node bench/cli.ts docs` writes them into the page
 * between the `<!-- bench:table <id> -->` markers, and `docs --check` fails
 * when the page differs from what these runs generate. bench/README.md,
 * "Publishing a run", says how to point a table at a new run.
 */
import type { Table } from "./driver/docs.ts";

const FRAMEWORKS = {
  yjs: { "IndexedDB option": "yjs/y-indexeddb", "opfs-lsm": "yjs/kv" },
  automerge: { "IndexedDB option": "automerge/idb", "opfs-lsm": "automerge/kv" },
  fate: { "IndexedDB option": "fate/indexeddb", "opfs-lsm": "fate/kv" },
};

const GOALS = [
  { label: "Issues per status in a project", phase: "statusCounts" },
  { label: "First 50 todo issues, with assignee and label names", phase: "statusPage" },
  { label: "The column a sprint close just emptied", phase: "drainedPage" },
  { label: "Rows at 90% of a project's list", phase: "deepWindow" },
  { label: "An issue with its comments and their authors", phase: "issueThread" },
  { label: "First 50 open issues by priority, with comment counts", phase: "triagePage" },
  { label: "First 50 open issues with a label", phase: "labelPage" },
  { label: "First 50 open issues assigned to a person", phase: "myIssues" },
  { label: "The 50 most recently updated issues", phase: "recentActivity" },
  { label: "Open issues per person, top 10", phase: "assigneeLoad" },
  { label: "First 20 issues whose title contains a word", phase: "search" },
] as const;

export const TABLES: readonly Table[] = [
  {
    id: "storage-calls",
    file: "2026-11-22T11-32-45-apple-m2-pro",
    columns: [
      { head: "Workload" },
      { head: "IndexedDB", at: "kv/idb" },
      { head: "kv", at: "kv/kv" },
      { head: "", ratio: { of: "kv", over: "IndexedDB" } },
    ],
    rows: [
      { label: "Random writes, batches of 1,000", workload: "kv/fillrandom", phase: "fillrandom", metric: "rate" },
      { label: "Random point reads", workload: "kv/fillrandom", phase: "readrandom", metric: "rate" },
      { label: "Reads of missing keys", workload: "kv/fillrandom", phase: "readmissing", metric: "rate" },
      { label: "Full ordered scan", workload: "kv/fillseq", phase: "readseq", metric: "rate" },
      { label: "Seeks of 100 keys", workload: "kv/fillseq", phase: "seekrandom-100", metric: "rate" },
      { label: "Single put, awaited one at a time", workload: "kv/fillrandom", phase: "fillsync", metric: "rate" },
      { label: "Read-modify-write in one transaction", workload: "kv/ycsb-a", phase: "ycsb-f", metric: "mean:rmw" },
      { label: "Every 8 KiB value in a fresh tab, 500 neighbouring keys a read", workload: "kv/large-values", phase: "readall-cold", metric: "rate" },
      { label: "Every 8 KiB value in a fresh tab, 500 scattered keys a read", workload: "kv/large-values", phase: "readscattered-cold", metric: "rate" },
      { label: "Opening the database in a fresh tab", workload: "kv/fillrandom", phase: "coldopen", metric: "mean:open" },
    ],
  },
  {
    id: "framework-adapters",
    file: "2026-11-22T11-44-02-apple-m2-pro",
    columns: [
      { head: "Framework" },
      { head: "Workload" },
      { head: "IndexedDB option", at: "tanstack/indexeddb" },
      { head: "opfs-lsm", at: "tanstack/kv" },
      { head: "", ratio: { of: "opfs-lsm", over: "IndexedDB option" } },
    ],
    rows: [
      { label: ["TanStack DB", "Open and load 91,000 rows"], workload: "tanstack/todos", phase: "coldopen", metric: "mean:open" },
      {
        label: ["TanStack DB", "Bulk insert, 100,000 rows in transactions of 1,000"],
        workload: "tanstack/todos",
        phase: "bulk-insert",
        metric: "rate",
        unit: "rows/s",
      },
      {
        label: ["TanStack DB", "Serial insert, one row per transaction"],
        workload: "tanstack/todos",
        phase: "serial-insert",
        metric: "rate",
        unit: "rows/s",
      },
      { label: ["Yjs", "Cold load of 500 notes"], workload: "yjs/many-docs", phase: "load", metric: "rate", unit: "notes/s", at: FRAMEWORKS.yjs },
      {
        label: ["Yjs", "Editing trace written in one burst, 25,700 updates with no yield between keystrokes"],
        workload: "yjs/trace",
        phase: "persist",
        metric: "rate",
        unit: "edits/s",
        at: FRAMEWORKS.yjs,
      },
      { label: ["Yjs", "One keystroke typed at 60 Hz, with its persistence"], workload: "yjs/trace", phase: "type", metric: "mean:key", at: FRAMEWORKS.yjs },
      { label: ["Automerge", "Cold load of 500 notes"], workload: "automerge/many-docs", phase: "load", metric: "rate", unit: "notes/s", at: FRAMEWORKS.automerge },
      { label: ["Automerge", "Write 500 notes"], workload: "automerge/many-docs", phase: "persist", metric: "rate", unit: "notes/s", at: FRAMEWORKS.automerge },
      {
        label: ["fate", "Cold load of 100 lists of 100 records"],
        workload: "fate/read-cache",
        phase: "cold-load",
        metric: "rate",
        unit: "records/s",
        at: FRAMEWORKS.fate,
      },
    ],
  },
  {
    id: "typing-reopening",
    file: "2026-11-22T11-44-02-apple-m2-pro",
    columns: [
      { head: "" },
      { head: "y-indexeddb", at: { workload: "yjs/trace", contender: "yjs/y-indexeddb" } },
      { head: "Yjs on kv", at: { workload: "yjs/trace", contender: "yjs/kv" } },
      { head: "automerge-repo IndexedDB", at: { workload: "automerge/trace", contender: "automerge/idb" } },
      { head: "Automerge on kv", at: { workload: "automerge/trace", contender: "automerge/kv" } },
      { head: "Yjs, kv vs y-indexeddb", ratio: { of: "Yjs on kv", over: "y-indexeddb" } },
      { head: "Automerge, kv vs IndexedDB", ratio: { of: "Automerge on kv", over: "automerge-repo IndexedDB" } },
    ],
    rows: [
      { label: "One keystroke, with its persistence", phase: "type", metric: "mean:key" },
      { label: "Frames dropped over 300 keystrokes", phase: "type", metric: "main:droppedFrames" },
      { label: "Cold open before the settle", phase: "reopen", metric: "wall" },
      { label: "Cold open after the settle", phase: "load", metric: "wall" },
    ],
  },
  {
    id: "on-demand-sqlite",
    file: "2026-11-22T11-54-07-apple-m2-pro",
    workload: "tanstack-ondemand/queries",
    columns: [
      { head: "Workload" },
      { head: "SQLite", at: "tanstack-ondemand/sqlite" },
      { head: "opfs-lsm", at: "tanstack-ondemand/kv" },
      { head: "", ratio: { of: "opfs-lsm", over: "SQLite" } },
    ],
    rows: [
      { label: "Cold open", phase: "coldopen", metric: "mean:open" },
      { label: "First query after a cold open, 6,250 rows", phase: "first-query", metric: "mean:owner" },
      { label: "Warm query of one owner, 6,250 rows", phase: "query-owner", metric: "rate", unit: "rows/s" },
      { label: "10 rows by id", phase: "query-ids", metric: "rate", unit: "queries/s" },
    ],
  },
  {
    id: "goals",
    file: "2026-11-22T11-58-43-apple-m2-pro",
    workload: "tracker/goals",
    unit: null,
    columns: [
      { head: "Goal" },
      { head: "Dexie", at: "tracker/dexie" },
      { head: "SQLite on OPFS", at: "tracker/sqlite" },
      { head: "docstore", at: "tracker/docstore" },
      { head: "docstore vs SQLite", ratio: { of: "docstore", over: "SQLite on OPFS" } },
    ],
    rows: [
      ...GOALS.map(({ label, phase }) => ({ label, phase, metric: ["mean:cold", "mean:warm"] as const })),
      { label: "Opening the store in a fresh tab, before the todo issues goal", phase: "statusPage", metric: "mean:open" },
    ],
  },
  {
    id: "writes",
    file: "2026-11-22T11-58-43-apple-m2-pro",
    workload: "tracker/goals",
    columns: [
      { head: "Writes" },
      { head: "Dexie", at: "tracker/dexie" },
      { head: "SQLite on OPFS", at: "tracker/sqlite" },
      { head: "docstore", at: "tracker/docstore" },
      { head: "docstore vs SQLite", ratio: { of: "docstore", over: "SQLite on OPFS" } },
    ],
    rows: [
      { label: "Import, mean of 47 batches of up to 1,000 rows", phase: "replay", metric: "mean:import" },
      { label: "Sync, mean of 851 batches of about 50 changes", phase: "replay", metric: "mean:sync" },
      { label: "One edit", phase: "recent", metric: "mean:edit" },
      { label: "Sprint close, 1,054 issues in one batch", phase: "recent", metric: "mean:bulk" },
      { label: "The 50 latest issues, read again after every 10th sync batch", phase: "replay", metric: "mean:read" },
    ],
  },
  {
    id: "live-queries",
    file: "2026-11-22T12-07-20-apple-m2-pro",
    workload: "tanstack-live/screens",
    columns: [
      { head: "" },
      { head: "IndexedDB, eager", at: "tanstack-live/indexeddb" },
      { head: "docstore, eager", at: "tanstack-live/kv" },
      { head: "docstore, on demand", at: "tanstack-live/kv-ondemand" },
      { head: "SQLite, on demand", at: "tanstack-live/sqlite" },
      { head: "on demand, docstore vs SQLite", ratio: { of: "docstore, on demand", over: "SQLite, on demand" } },
    ],
    rows: [
      { label: "Opening the collections in a fresh tab", phase: "open", metric: "mean:open" },
      { label: "First answer: a project's todo column", phase: "open", metric: "mean:statusPage" },
      { label: "First answer: open issues with a label", phase: "open", metric: "mean:labelPage" },
      { label: "First answer: a person's open issues", phase: "open", metric: "mean:myIssues" },
      { label: "First answer: the 50 latest issues", phase: "open", metric: "mean:recentActivity" },
      { label: "A sync batch, no screen open", phase: "sync", metric: "mean:sync" },
      { label: "A sync batch, four screens open", phase: "sync-live", metric: "mean:sync" },
      { label: "Frames dropped over 426 batches, screens open", phase: "sync-live", metric: "main:droppedFrames" },
    ],
  },
];
