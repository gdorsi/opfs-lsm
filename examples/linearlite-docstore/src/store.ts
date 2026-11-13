import { openDocStore, type Cursor, type DocStore } from "@opfs-lsm/docstore";
import { openDb, type Db } from "@opfs-lsm/kv";
import { readStats } from "@opfs-lsm/kv/testing";
import { CODES, schema, type Code, type Detail, type Filter, type Issue } from "./model.ts";
import type { Host } from "./protocol.ts";
import type { SeedMessage } from "./seed-worker.ts";
import { generateDetail } from "./seed.ts";

type Docs = DocStore<typeof schema>;
const issuesOf = (docs: Docs) => docs.collection("issues");
const detailsOf = (docs: Docs) => docs.collection("details");
type Issues = ReturnType<typeof issuesOf>;
type IssueQuery = Parameters<Issues["query"]>[0];

export type Store = { readonly db: Db; readonly issues: Issues; readonly details: ReturnType<typeof detailsOf> };

export async function openStore(name: string): Promise<Store> {
  const db = await openDb({ name });
  const docs = await openDocStore(db, schema);
  return { db, issues: issuesOf(docs), details: detailsOf(docs) };
}

/** The list under one filter, as stored when it is asked. It reads nothing until then. */
export type View = {
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
type Range = { readonly index: "byModified" | "byCreated" | "byStatus" | "byPriority"; readonly eq?: readonly Code[] };

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
function rangeView(issues: Issues, list: readonly Range[], reverse: boolean): View {
  const order = reverse ? list.toReversed() : list;
  const query = (r: Range) => ({ index: r.index, ...(r.eq && { eq: r.eq }), ...(reverse && { reverse: true }) }) as IssueQuery;
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
    const { next } = await issues.queryIds({ ...query(order[i]!), limit: skip - base, ...(base > 0 && { after: known.get(base) }) } as IssueQuery);
    if (next === undefined) return null;
    known.set(skip, next);
    return next;
  }

  return {
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
        const { docs, next } = await issues.query({ ...query(order[i]!), limit: n - out.length, ...(after !== undefined && { after }) } as IssueQuery);
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
        const { docs, next } = await issues.query({ index, limit: step, reverse: filter.dir === "desc", ...(after !== undefined && { after }) } as IssueQuery);
        for (const doc of docs) if (keep(doc)) matches.push(doc);
        after = next;
        done = next === undefined;
        step = Math.min(4096, step * 2);
      }
    }));

  const counted = ranges(filter, filter.status.length > 0 ? "status" : "priority");
  return {
    total: () => Promise.all(counted.map((r) => issues.count({ index: r.index, eq: r.eq } as IssueQuery))).then(sum),
    async read(offset, n) {
      await scanTo(offset + n);
      return matches.slice(offset, offset + n);
    },
  };
}

const NON_WORD = /[^\p{L}\p{M}\p{N}]+/u;

/** docstore's text words: a `match` keeps the titles that hold each of them inside one word. */
const wordsOf = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .split(NON_WORD)
    .filter((w) => w !== "");

/**
 * A title search. The text index narrows the issues to the titles holding every word of the query, a substring test
 * makes it exact, and the result is filtered and sorted in memory.
 */
function searchView(issues: Issues, filter: Filter): View {
  const words = wordsOf(filter.q);
  let found: Promise<Issue[]> | undefined;
  const rows = () =>
    (found ??= issues
      .query({ index: "byModified", ...(words.length > 0 && { match: words.join(" ") }) })
      .then(({ docs }) => docs.filter(keeps(filter)).sort(orderOf(filter))));
  return { total: () => rows().then((r) => r.length), read: async (offset, n) => (await rows()).slice(offset, offset + n) };
}

/** How the list under `filter` is read. Each case reads through an index: see the README, "Reads". */
export function viewOf({ issues }: Store, filter: Filter): View {
  const reverse = filter.dir === "desc";
  if (filter.q !== "") return searchView(issues, filter);
  if (filter.sort === "status" || filter.sort === "priority") return rangeView(issues, ranges(filter, filter.sort), reverse);
  if (filter.status.length > 0 || filter.priority.length > 0) return scanView(issues, filter);
  return rangeView(issues, [{ index: filter.sort === "created" ? "byCreated" : "byModified" }], reverse);
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

function seed(count: number, from: number, onChunk: (issues: number) => void): Promise<{ issues: Issue[]; generateMs: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./seed-worker.ts", import.meta.url), { type: "module" });
    const issues: Issue[] = [];
    worker.onerror = (e) => reject(new Error(e.message));
    worker.onmessage = (e: MessageEvent<SeedMessage>) => {
      if ("issues" in e.data) {
        for (const issue of e.data.issues) issues.push(issue);
        onChunk(issues.length);
        return;
      }
      worker.terminate();
      resolve({ issues, generateMs: e.data.generateMs });
    };
    worker.postMessage({ count, seed: from });
  });
}

/** Issues per `putMany`, which is one kv transaction. kv takes 8 MiB per transaction and counts 256 bytes per key. */
const BATCH = 2000;

/**
 * Generates `count` issues in a dedicated WebWorker and writes them. Each issue is its document plus an entry in
 * every index. `writeMs` ends when the last write is acknowledged. The ids follow from `from`, the generator's seed,
 * so two calls with different seeds write different issues.
 */
export async function writeIssues(
  { issues }: Store,
  count: number,
  from: number,
  progress: (phase: "generating" | "writing", written: number) => void,
): Promise<{ generateMs: number; writeMs: number }> {
  progress("generating", 0);
  const { issues: rows, generateMs } = await seed(count, from, (n) => progress("generating", n));
  progress("writing", 0);
  const t0 = performance.now();
  for (let at = 0; at < rows.length; at += BATCH) {
    await issues.putMany(rows.slice(at, at + BATCH));
    progress("writing", Math.min(rows.length, at + BATCH));
  }
  return { generateMs, writeMs: performance.now() - t0 };
}

const FLUSHES = "linearlite-demo:flushes";

export const forgetHost = () => sessionStorage.removeItem(FLUSHES);

/**
 * Whether this page found the database's SharedWorker running. The SharedWorker counts its flushes from the moment it
 * starts, and writing the issues takes many. A count below the one this browser tab last saw means a new
 * SharedWorker; so does a count of zero when a flush has happened and no count was seen.
 */
export async function hostOf({ db }: Store): Promise<Host> {
  try {
    const { host } = await readStats(db);
    const seen = Number(sessionStorage.getItem(FLUSHES) ?? "0");
    sessionStorage.setItem(FLUSHES, String(host.flushes));
    if (host.flushes < seen) return "restarted";
    if (host.flushes > 0) return "alive";
    return host.generation > 0 ? "restarted" : "unknown";
  } catch {
    return "unknown";
  }
}

export type Draft = Pick<Issue, "title" | "status" | "priority"> & { readonly description: string };

/** A new issue under `id`, with its description: two writes, the description first. */
export async function createIssue({ issues, details }: Store, id: string, { description, ...fields }: Draft): Promise<void> {
  const now = Date.now();
  await details.put({ id, description, comments: [] });
  await issues.put({ id, ...fields, username: "you", created: now, modified: now });
}
