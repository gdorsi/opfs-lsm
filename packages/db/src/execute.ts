/*
 * One run of one query against one docstore snapshot. No state survives a
 * run.
 */
import type { QueryIR } from "./builder.js";
import type { Table } from "./database.js";
import { compareRows, type OrderKey, type Predicate } from "./expr.js";
import type { DocQuery, Plan } from "./plan.js";
import type { JsonDoc } from "./schema.js";

/** A query ready to run: what its description gives once, on first use. */
export type Compiled = {
  readonly ir: QueryIR;
  readonly table: Table;
  readonly plan: Plan;
  readonly order: OrderKey;
  /** The whole `where`, which an exact plan makes true for every row it reads. */
  readonly where: Predicate;
};

/** What a run found: the stored documents of the result in order, or the count of a count query. */
export type Found = {
  /** The snapshot's seq. A change at or below it is in this result. */
  readonly seq: number;
  readonly docs: readonly JsonDoc[];
  readonly count: number | undefined;
};

/** What a run reads of a docstore snapshot. */
type Snapshot = {
  readonly seq: number;
  getMany(ids: readonly string[]): Promise<(JsonDoc | undefined)[]>;
  query(q: object): Promise<{ readonly docs: JsonDoc[]; readonly next?: string }>;
  count(q: object): Promise<number>;
};

/** A filtered read in order takes pages of this size, doubling up to LAST_PAGE while few rows pass. */
const FIRST_PAGE = 32;
const LAST_PAGE = 4096;

export async function execute(snap: Snapshot, { ir, plan, order, where }: Compiled): Promise<Found> {
  const { offset, limit } = ir;
  const count = ir.shape === "count";
  const end = limit === undefined ? undefined : offset + limit;
  const found = (docs: readonly JsonDoc[], n?: number): Found => ({
    seq: snap.seq,
    docs,
    count: n === undefined ? undefined : Math.min(Math.max(n - offset, 0), limit ?? n),
  });
  let docs: JsonDoc[] = [];
  let sorted = false;
  if (plan.kind === "ids") docs = (await snap.getMany(plan.ids)).filter((d) => d !== undefined && where(d)) as JsonDoc[];
  if (plan.kind === "ranges") {
    const { ranges, exact, ordered } = plan;
    if (exact && count) return found([], await entries(snap, ranges, end));
    if (exact && ordered) return found(await window(snap, ranges, offset, limit));
    docs = await matches(snap, ranges, exact ? undefined : where, ordered ? end : undefined);
    sorted = ordered;
  }
  if (count) return found([], docs.length);
  if (!sorted) docs.sort((a, b) => compareRows(a, b, order));
  return found(docs.slice(offset, end));
}

/** How many entries the ranges hold, counted up to `end`. No document is read. */
async function entries(snap: Snapshot, ranges: readonly DocQuery[], end: number | undefined): Promise<number> {
  let n = 0;
  for (const range of ranges) {
    n += await snap.count(end === undefined ? range : { ...range, limit: end - n });
    if (n === end) break;
  }
  return n;
}

/** The documents at `offset` and after in the ranges read one after the other, up to `limit`. The entries before `offset` are passed over without their documents. */
async function window(snap: Snapshot, ranges: readonly DocQuery[], offset: number, limit: number | undefined): Promise<JsonDoc[]> {
  let out: JsonDoc[] = [];
  let skip = offset;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]!;
    // The last range passes over its entries in the read itself. An earlier one may lie whole before `offset`.
    if (skip > 0 && i < ranges.length - 1) {
      const n = await snap.count({ ...range, limit: skip + 1 });
      if (n <= skip) {
        skip -= n;
        continue;
      }
    }
    const { docs } = await snap.query({ ...range, ...(skip > 0 && { offset: skip }), ...(limit !== undefined && { limit: limit - out.length }) });
    skip = 0;
    out = out.length === 0 ? docs : out.concat(docs);
    if (out.length === limit) break;
  }
  return out;
}

/** The documents of the ranges, read one after the other, that pass `where`. With `stopAt`, only the first that many. */
async function matches(snap: Snapshot, ranges: readonly DocQuery[], where: Predicate | undefined, stopAt: number | undefined): Promise<JsonDoc[]> {
  const out: JsonDoc[] = [];
  for (const range of ranges) {
    let after: string | undefined;
    let size = stopAt === undefined ? undefined : Math.min(Math.max(stopAt, FIRST_PAGE), LAST_PAGE);
    do {
      const page = await snap.query({ ...range, ...(size !== undefined && { limit: size }), ...(after !== undefined && { after }) });
      for (const doc of page.docs) {
        if (where && !where(doc)) continue;
        if (out.push(doc) === stopAt) return out;
      }
      after = page.next;
      size = size && Math.min(size * 2, LAST_PAGE);
    } while (after !== undefined);
  }
  return out;
}
