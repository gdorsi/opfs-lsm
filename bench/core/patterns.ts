/**
 * The access patterns the suite measures, each owned by exactly one
 * workload. A workload names the patterns it owns in `owns`; a goal workload
 * owns its dataset's patterns and one per goal. Another workload may hit a
 * pattern without owning it. `bench:smoke --check` fails when a pattern has
 * no owner or two.
 *
 * A kv pattern is owned by a kv workload, since that family compares raw kv
 * with IndexedDB, even where a document workload makes the same calls.
 */
export const PATTERNS = {
  "kv-single-put": "kv: one put, awaited until acknowledged",
  "kv-random-fill": "kv: batched random ingest, flush and compaction, W-Amp",
  "kv-point-get": "kv: point gets while compaction runs, then gets that hit and miss over warm pages",
  "kv-cold-open": "kv: opening the store in a fresh tab, the first get, then gets over its cold pages",
  "kv-second-tab": "kv: a second tab opening a store the first tab holds, then reading what the first tab just wrote",
  "kv-delete": "kv: batched random deletes, and the space compaction gives back",
  "kv-read-deleted": "kv: point gets and a cursor-paged scan over fresh tombstones, before compaction settles them",
  "kv-seq-fill": "kv: sequential ingest",
  "kv-scan": "kv: a full ordered scan, seeks followed by 10 or 100 nexts, reverse seeks, and scans bounded above with a limit past the bound",
  "kv-count": "kv: a count of the keys in a range, no value read",
  "kv-offset": "kv: a page of values an offset deep into a range",
  "kv-multi-get": "kv: a page of scattered keys in one read",
  "kv-zipfian-update": "kv: zipfian reads mixed with blind single-key updates",
  "kv-rmw": "kv: zipfian reads mixed with read-modify-writes of one key in one transaction",
  "kv-large-values": "kv: every value of a store of 8 KiB values, under keys with a long shared prefix, read in bulk in a fresh tab, by neighbouring and by scattered keys",
  "kv-compaction-memory": "kv: the memory peak of compaction",

  "doc-ingest": "documents: an import, then sync batches that patch stored rows, with index upkeep",
  "doc-read-during-sync": "documents: a list read while a large sync lands",
  "doc-edit": "documents: a bulk edit and single edits above the settled store",
  "doc-reread": "documents: lists and counts read right after the edit that changes them",
  "doc-index-count": "documents: a count over an index prefix, no row read",
  "doc-scattered-page": "documents: an index page whose rows are scattered in key order, joined N:1 and M:N to names",
  "doc-drained-range": "documents: an index range a bulk edit nearly emptied, above the settled levels",
  "doc-deep-window": "documents: a full window 90% deep into an ordered list, reached with an offset",
  "doc-key-hops": "documents: two unique-key hops, then a 1:N child range joined to authors",
  "doc-child-count": "documents: a child count per row of a page, over an IN-list ordered by another field",
  "doc-multi-entry": "documents: a filter through a multi-entry (array) index",
  "doc-in-list-top-n": "documents: an IN-list on one field across every project, merged top-N",
  "doc-newest-end": "documents: the newest end of a global time index under constant churn",
  "doc-group-by": "documents: a group-by count on a non-leading field, joined to names",
  "doc-substring": "documents: a substring match on titles that no equality or range answers",
  "doc-burst": "documents: the reads a board fires in the same task as it opens, timed to the last answer, and the same reads one after the other",

  "tanstack-eager": "TanStack DB, eager: persisting transactions, and loading every row in a fresh tab, settled and unsettled",
  "tanstack-on-demand": "TanStack DB, on demand: a live query that loads its own rows through an index",
  "tanstack-live-open": "TanStack DB: a screen's live query, joins and order and limit, to its first answer in a fresh tab",
  "tanstack-live-upkeep": "TanStack DB: keeping open screens current while sync batches land",

  "yjs-trace": "Yjs: an editing trace persisted, typed at one key per frame, reopened before and after a settle",
  "yjs-many-docs": "Yjs: many small documents written, then each loaded cold",
  "automerge-trace": "Automerge: an editing trace persisted, typed at one key per frame, reopened before and after a settle",
  "automerge-many-docs": "Automerge: many small documents written, then each loaded cold",
  "tanstack-query-cache": "TanStack Query: restoring a cache of one entry per query cold, and persisting refetch bursts",
} as const;

export type Pattern = keyof typeof PATTERNS;

/** Problems with the ownership of PATTERNS among `workloads`: a pattern owned twice or not at all, or a workload that owns none. */
export function ownershipProblems(workloads: readonly { readonly workload: string; readonly owns: readonly string[] }[]): string[] {
  const owners = new Map<string, string[]>(Object.keys(PATTERNS).map((p) => [p, []]));
  const problems: string[] = [];
  for (const w of workloads) {
    if (w.owns.length === 0) problems.push(`${w.workload} owns no pattern: a workload that only repeats an owner's pattern belongs in that owner`);
    for (const p of w.owns) {
      const list = owners.get(p);
      if (list) list.push(w.workload);
      else problems.push(`${w.workload} owns "${p}", which is not in bench/core/patterns.ts`);
    }
  }
  for (const [p, list] of owners) {
    if (list.length === 0) problems.push(`no workload owns "${p}"`);
    if (list.length > 1) problems.push(`"${p}" has ${list.length} owners: ${list.join(", ")}`);
  }
  return problems;
}
