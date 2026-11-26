import { openDocStore, type Cursor, type DocStore } from "@opfs-lsm/docstore";
import { openDb, type Db } from "@opfs-lsm/kv";
import { CODES, schema, type Code, type Detail, type Filter, type Issue } from "./model.ts";
import type { SeedMessage, SeedRequest } from "./seed-worker.ts";
import { generateDetail } from "./seed.ts";

type Docs = DocStore<typeof schema>;
const issuesOf = (docs: Docs) => docs.collection("issues");
const detailsOf = (docs: Docs) => docs.collection("details");
type Issues = ReturnType<typeof issuesOf>;

export type Store = { readonly db: Db; readonly issues: Issues; readonly details: ReturnType<typeof detailsOf> };

export async function openStore(name: string): Promise<Store> {
  const db = await openDb({ name });
  const docs = await openDocStore(db, schema);
  return { db, issues: issuesOf(docs), details: detailsOf(docs) };
}

export type ReadPath = "index" | "ranges" | "scan" | "search";

/** The list under one filter, as stored when it is asked. It reads nothing until then. */
export type View = {
  readonly path: ReadPath;
  /** How many issues the list holds. */
  total(): Promise<number>;
  /** Rows `offset` to `offset + n` of the list, fewer at its end. */
  read(offset: number, n: number): Promise<Issue[]>;
};

/** Whether the list under `filter` holds `issue`. */
export function keeps(filter: Filter): (issue: Issue) => boolean {
  const needle = filter.q.toLowerCase();
  return (i) =>
    (filter.status.length === 0 || filter.status.includes(i.status)) &&
    (filter.priority.length === 0 || filter.priority.includes(i.priority)) &&
    (needle === "" || i.title.toLowerCase().includes(needle));
}

const SORT_KEY: Record<Filter["sort"], (i: Issue) => number> = {
  modified: (i) => i.modified,
  created: (i) => i.created,
  status: (i) => i.status * 1e15 + i.priority * 1e14 + i.modified,
  priority: (i) => i.priority * 1e15 + i.status * 1e14 + i.modified,
};

/** The list's order, the one its index gives: the sort's values, then the id. Negative when `a` comes first. */
export function orderOf(filter: Filter): (a: Issue, b: Issue) => number {
  const key = SORT_KEY[filter.sort];
  const sign = filter.dir === "desc" ? -1 : 1;
  return (a, b) => sign * (key(a) - key(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A run of entries of one index: the whole index, or the entries under a status, a priority, or both. */
type Range =
  | { readonly index: "byModified" | "byCreated" }
  | { readonly index: "byStatus" | "byPriority"; readonly eq: readonly [Code] | readonly [Code, Code] };

const sorted = (codes: readonly Code[]) => [...codes].sort((a, b) => a - b);

/** The ranges that hold exactly the issues under the status and priority filters, led by one of the two fields. */
function ranges(filter: Filter, lead: "status" | "priority"): Range[] {
  const index = lead === "status" ? "byStatus" : "byPriority";
  const first = filter[lead].length > 0 ? sorted(filter[lead]) : CODES;
  const second = sorted(lead === "status" ? filter.priority : filter.status);
  return first.flatMap((a): Range[] => (second.length === 0 ? [{ index, eq: [a] }] : second.map((b) => ({ index, eq: [a, b] }))));
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * A list that is its ranges one after the other, each in index order. The total is the ranges' entry counts. A page
 * starts at a cursor: the one a page before it left, or one reached by walking index entries without their documents.
 */
function rangeView(issues: Issues, list: readonly Range[], reverse: boolean, path: "index" | "ranges"): View {
  const order = reverse ? list.toReversed() : list;
  const query = (r: Range) => ({ ...r, ...(reverse && { reverse: true }) });
  let counted: Promise<number[]> | undefined;
  const counts = () => (counted ??= Promise.all(order.map((r) => issues.count(query(r)))));
  const cursors = order.map(() => new Map<number, Cursor>());

  /** The cursor after `skip` entries of range `i`: undefined at its start, null past its end. */
  async function cursorAt(i: number, skip: number): Promise<Cursor | undefined | null> {
    if (skip === 0) return undefined;
    const known = cursors[i]!;
    let base = 0;
    for (const at of known.keys()) if (at <= skip && at > base) base = at;
    if (base === skip) return known.get(base);
    const { next } = await issues.queryIds({ ...query(order[i]!), limit: skip - base, ...(base > 0 && { after: known.get(base) }) });
    if (next === undefined) return null;
    known.set(skip, next);
    return next;
  }

  return {
    path,
    total: () => counts().then(sum),
    async read(offset, n) {
      let i = 0;
      let skip = offset;
      if (offset > 0) {
        const sizes = await counts();
        while (i < order.length && skip >= sizes[i]!) skip -= sizes[i++]!;
      }
      const out: Issue[] = [];
      for (; out.length < n && i < order.length; i++, skip = 0) {
        const after = await cursorAt(i, skip);
        if (after === null) continue;
        const { docs, next } = await issues.query({ ...query(order[i]!), limit: n - out.length, ...(after !== undefined && { after }) });
        if (next !== undefined) cursors[i]!.set(skip + docs.length, next);
        out.push(...docs);
      }
      return out;
    },
  };
}

/**
 * The list by `modified` or `created` under a status or priority filter: it reads that sort's index in pages and
 * keeps the issues the filter lets through, only as far as the rows asked for. The total is counted from the
 * entries of the filter's ranges, so it does not wait for the scan.
 */
function scanView(issues: Issues, filter: Filter): View {
  const index = filter.sort === "created" ? "byCreated" : "byModified";
  const keep = keeps(filter);
  const matches: Issue[] = [];
  let after: Cursor | undefined;
  let done = false;
  let step = 256;
  let scanning: Promise<void> = Promise.resolve();

  const scanTo = (rows: number) =>
    (scanning = scanning.then(async () => {
      while (!done && matches.length < rows) {
        const { docs, next } = await issues.query({ index, limit: step, reverse: filter.dir === "desc", ...(after !== undefined && { after }) });
        for (const doc of docs) if (keep(doc)) matches.push(doc);
        after = next;
        done = next === undefined;
        step = Math.min(4096, step * 2);
      }
    }));

  const counted = ranges(filter, filter.status.length > 0 ? "status" : "priority");
  return {
    path: "scan",
    total: () => Promise.all(counted.map((r) => issues.count(r))).then(sum),
    async read(offset, n) {
      await scanTo(offset + n);
      return matches.slice(offset, offset + n);
    },
  };
}

/**
 * A title search. The text index narrows the issues to the titles holding every word of the query, a substring test
 * makes it exact, and the result is filtered and sorted in memory.
 */
function searchView(issues: Issues, filter: Filter): View {
  let found: Promise<Issue[]> | undefined;
  const rows = () =>
    (found ??= issues
      .query({ index: "byModified", match: filter.q })
      .then(({ docs }) => docs.filter(keeps(filter)).sort(orderOf(filter))));
  return { path: "search", total: () => rows().then((r) => r.length), read: async (offset, n) => (await rows()).slice(offset, offset + n) };
}

/** How the list under `filter` is read. Each case reads through an index: see the README, "Reads". */
export function viewOf({ issues }: Store, filter: Filter): View {
  const reverse = filter.dir === "desc";
  if (filter.q !== "") return searchView(issues, filter);
  if (filter.sort === "status" || filter.sort === "priority") return rangeView(issues, ranges(filter, filter.sort), reverse, "ranges");
  if (filter.status.length > 0 || filter.priority.length > 0) return scanView(issues, filter);
  return rangeView(issues, [{ index: filter.sort === "created" ? "byCreated" : "byModified" }], reverse, "index");
}

/** One write: the issue with `patch` over it and a new `modified`. Resolves with the stored issue. */
export const editIssue = ({ issues }: Store, id: string, patch: Partial<Pick<Issue, "title" | "status" | "priority">>) =>
  issues.modify(id, (issue) => ({ ...issue, ...patch, modified: Date.now() }));

/** The issue's description and comments: read, or made from its id and stored when it is opened for the first time. */
export async function detailOf({ details }: Store, issue: Issue): Promise<Detail> {
  const stored = await details.get(issue.id);
  if (stored) return stored;
  const made = generateDetail(issue);
  await details.put(made);
  return made;
}

/** Issues per `putMany`, which is one kv transaction. kv takes 8 MiB per transaction and counts 256 bytes per key. */
const BATCH = 2000;
/** The first transaction is small, so the list has rows after a few milliseconds of writing. */
const FIRST = 200;

/** Generates `count` issues in a dedicated WebWorker and yields each batch as it arrives. Returns the time generating took. */
async function* seed(count: number, from: number): AsyncGenerator<Issue[], number> {
  const worker = new Worker(new URL("./seed-worker.ts", import.meta.url), { type: "module" });
  const arrived: SeedMessage[] = [];
  let failure: Error | undefined;
  let wake = () => {};
  worker.onerror = (e) => {
    failure = new Error(e.message);
    wake();
  };
  worker.onmessage = (e: MessageEvent<SeedMessage>) => {
    arrived.push(e.data);
    wake();
  };
  worker.postMessage({ count, seed: from, first: FIRST, batch: BATCH } satisfies SeedRequest);
  try {
    for (;;) {
      if (failure) throw failure;
      const message = arrived.shift();
      if (!message) await new Promise<void>((resolve) => (wake = resolve));
      else if ("done" in message) return message.generateMs;
      else yield message.issues;
    }
  } finally {
    worker.terminate();
  }
}

/**
 * Writes `count` generated issues, each batch as the worker hands it over, and calls `written` after each with the
 * number stored so far. Each issue is its document plus an entry in every index. `writeMs` is the time the writes
 * took, from each call to its acknowledgement. The ids follow from `from`, the generator's seed, so two calls with
 * different seeds write different issues.
 */
export async function writeIssues(
  { issues }: Store,
  count: number,
  from: number,
  written: (issues: number) => Promise<void>,
): Promise<{ generateMs: number; writeMs: number }> {
  const batches = seed(count, from);
  let writeMs = 0;
  let stored = 0;
  try {
    for (;;) {
      const next = await batches.next();
      if (next.done) return { generateMs: next.value, writeMs };
      const t0 = performance.now();
      await issues.putMany(next.value);
      writeMs += performance.now() - t0;
      stored += next.value.length;
      await written(stored);
    }
  } finally {
    // Ends the generator, which stops its worker, when a write fails before the last batch.
    await batches.return(0);
  }
}

export type Draft = Pick<Issue, "title" | "status" | "priority"> & { readonly description: string };

/** A new issue under `id`, with its description: two writes, the description first. */
export async function createIssue({ issues, details }: Store, id: string, { description, ...fields }: Draft): Promise<void> {
  const now = Date.now();
  await details.put({ id, description, comments: [] });
  await issues.put({ id, ...fields, username: "you", created: now, modified: now });
}
