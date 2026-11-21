import { CorruptDatabaseError, type Decode, type Entry, type Range, type ViewSnapshot } from "@opfs-lsm/kv";
import { readableTarget, type BoundCollection } from "./catalog.js";
import { decodeDoc, decodeFields } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { compareBytes, concat, decodeEntries, encodeCursor, entryId, idBytes, idOf, keyId, parseId, scanPlan, type ScanPlan, type ScanTarget } from "./keys.js";
import type { Cursor, EntryPageOf, IdPage, JsonDoc, Page, Query, QueryInput } from "./schema.js";

/** Reads of one collection from one kv snapshot. */
export interface CollectionSnapshot<T extends JsonDoc, Ix> {
  /**
   * The kv seq of the snapshot. Every `changes` event with a seq at or below
   * it is reflected in what the snapshot reads, and none with a larger seq is.
   */
  readonly seq: number;
  /** The stored document, or undefined. */
  get(id: string): Promise<T | undefined>;
  /** In the order of `ids`. */
  getMany(ids: readonly string[]): Promise<(T | undefined)[]>;
  /** See `Collection.query`. */
  query(q: Query<T, Ix>): Promise<Page<T>>;
  /** As `query`, without reading the documents. */
  queryIds(q: Query<T, Ix>): Promise<IdPage>;
  /** See `Collection.queryEntries`. */
  queryEntries<I extends (keyof Ix & string) | undefined = undefined>(
    q: Query<T, Ix> & { readonly index?: I | undefined },
  ): Promise<EntryPageOf<T, Ix, I>>;
  /** How many results `query` would return, from `offset` and stopping at `limit` if given. */
  count(q: Query<T, Ix>): Promise<number>;
}

function limitOf(limit: unknown): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1) return limit;
  throw new DocStoreError("query", "limit must be a positive integer");
}

function offsetOf(offset: unknown): number {
  if (offset === undefined) return 0;
  if (typeof offset === "number" && Number.isInteger(offset) && offset >= 0) return offset;
  throw new DocStoreError("query", "offset must be a non-negative integer");
}

/** `hits` holds one entry past the page iff another page follows: drop it and name the cursor. */
function trimPage<H>(hits: H[], keyOf: (hit: H) => Uint8Array, limit: number | undefined): { next?: Cursor } {
  if (limit === undefined || hits.length <= limit) return {};
  hits.length = limit;
  return { next: encodeCursor(keyOf(hits[limit - 1]!)) };
}

const nothing = () => undefined;

/** What `queryEntries` needs of an entry's value, decoded from the bytes where kv holds them. */
const ENTRY_VALUE: { readonly [K in ScanTarget["kind"]]: Decode<unknown> } = {
  rows: nothing,
  sorted: nothing,
  text: nothing,
  unique: idOf,
  covering: decodeFields,
};

type Merge = ScanPlan & { readonly reverse: boolean; readonly offset: number; readonly want: number | undefined };

/**
 * Hands `each` the entries of every range in the order of the bytes after
 * each range's `skip`, past `offset` and at most `want`, and returns how
 * many. Entries equal there are one document under two values: only the
 * first range's is handed over, the lowest going forward and the highest
 * going back. The iterators hold the snapshot's readers until the last one
 * is returned.
 */
async function merge(snap: ViewSnapshot, { ranges, repeats, reverse, offset, want }: Merge, each: (entry: Entry) => void): Promise<number> {
  const cap = want === undefined ? {} : { limit: offset + want };
  const iters = ranges.map(({ range }) => snap.range({ ...range, ...cap })[Symbol.asyncIterator]());
  const heads: (Entry | undefined)[] = [];
  const step = async (i: number) => {
    const r = await iters[i]!.next();
    heads[i] = r.done ? undefined : r.value;
  };
  const cmp = (a: Entry, i: number, b: Entry, j: number) => compareBytes(a.key, b.key, ranges[i]!.skip, ranges[j]!.skip);
  let taken = 0;
  try {
    await Promise.all(iters.map((_, i) => step(i)));
    for (let seen = 0; ; ) {
      let pick = -1;
      heads.forEach((h, i) => {
        if (h && (pick < 0 || (reverse ? cmp(h, i, heads[pick]!, pick) >= 0 : cmp(h, i, heads[pick]!, pick) < 0))) pick = i;
      });
      if (pick < 0) break;
      const head = heads[pick]!;
      if (seen++ >= offset) {
        each(head);
        if (++taken === want) break;
      }
      // Only a repeat makes other heads move with the pick.
      if (repeats) await Promise.all(heads.map((h, i) => h && cmp(h, i, head, pick) === 0 && step(i)));
      else await step(pick);
    }
  } finally {
    await Promise.all(iters.map((it) => it.return?.()));
  }
  return taken;
}

/** The entries of a merge, each with `value` of its bytes. */
async function mergeEntries<V>(snap: ViewSnapshot, plan: Merge, value: Decode<V>): Promise<{ key: Uint8Array; value: V }[]> {
  const out: { key: Uint8Array; value: V }[] = [];
  await merge(snap, plan, (entry) => out.push({ key: entry.key, value: value(entry.value) }));
  return out;
}

/** What a read plans: its target, the page size, and either the one range to scan or the ranges to merge. */
type Plan = Merge & { readonly target: ScanTarget; readonly limit: number | undefined; readonly range: Range | undefined };

/** What a point read needs of kv: a `Db` and a view snapshot both fit. */
type PointSource = Pick<ViewSnapshot, "getMany">;

/**
 * The point reads of one collection. `coll` must come from the catalog that
 * `source` holds. Over a live `Db`, only point reads are safe: a scan could
 * straddle a `clear`.
 */
export class PointReader<T extends JsonDoc> {
  constructor(
    protected readonly snap: PointSource,
    protected readonly coll: BoundCollection,
  ) {}

  async get(id: string): Promise<T | undefined> {
    return (await this.getMany([id]))[0];
  }

  /** One kv read for every row, parsed from the stored bytes with no copy between. */
  async getMany(ids: readonly string[]): Promise<(T | undefined)[]> {
    const keys = ids.map((id) => concat(this.coll.rows.prefix, idBytes(parseId(id))));
    return (await this.snap.getMany(keys, decodeDoc)) as unknown as (T | undefined)[];
  }
}

/**
 * The one implementation of every read. The prefixes and readable indexes
 * match the data for good: no later `clear` or schema change reaches them.
 */
export class SnapshotReader<T extends JsonDoc, Ix> extends PointReader<T> implements CollectionSnapshot<T, Ix> {
  readonly seq: number;

  constructor(
    protected override readonly snap: ViewSnapshot,
    coll: BoundCollection,
  ) {
    super(snap, coll);
    this.seq = snap.seq;
  }

  async query(q: Query<T, Ix>): Promise<Page<T>> {
    const plan = this.plan(q, 1);
    const { target, limit, range } = plan;
    // The entry past `limit` only says a next page exists, so its document is not read or parsed.
    let left = limit ?? Number.POSITIVE_INFINITY;
    if (target.kind === "rows") {
      const page = await this.snap.rangeValues(range!, (bytes) => (left-- > 0 ? decodeDoc(bytes) : undefined));
      const next = trimPage(page, (h) => h.key, limit);
      return { docs: page.map((h) => h.value as unknown as T), ...next };
    }
    const rowKey = (h: Entry) => concat(target.rowPrefix, entryId(target, h.key, h.value));
    if (!range) {
      const page = await mergeEntries(this.snap, plan, (bytes) => bytes);
      const next = trimPage(page, (h) => h.key, limit);
      const docs = await this.snap.getMany(page.map(rowKey), decodeDoc);
      return { docs: docs.map((doc) => this.present(doc)), ...next };
    }
    const hits = await this.snap.rangeJoin(range, (h) => (left-- > 0 ? rowKey(h) : undefined), decodeDoc);
    const next = trimPage(hits, (h) => h.entry.key, limit);
    return { docs: hits.map(({ joined }) => this.present(joined)), ...next };
  }

  private present(doc: unknown): T {
    if (!doc) throw new CorruptDatabaseError(`an index entry of "${this.coll.name}" points at a missing document`);
    return doc as T;
  }

  async queryIds(q: Query<T, Ix>): Promise<IdPage> {
    const plan = this.plan(q, 1);
    const { target, limit } = plan;
    const unique = target.kind === "unique";
    const page = await this.scan(plan, unique ? idOf : nothing);
    const next = trimPage(page, (h) => h.key, limit);
    return { ids: page.map((h) => (unique ? (h.value as string) : keyId(target, h.key))), ...next };
  }

  async queryEntries<I extends (keyof Ix & string) | undefined = undefined>(
    q: Query<T, Ix> & { readonly index?: I | undefined },
  ): Promise<EntryPageOf<T, Ix, I>> {
    const plan = this.plan(q, 1);
    const { target, limit, range } = plan;
    // As in `query`, the entry past `limit` is not decoded.
    let left = limit ?? Number.POSITIVE_INFINITY;
    const decode = ENTRY_VALUE[target.kind];
    const page = await this.scan(plan, (bytes) => (left-- > 0 ? decode(bytes) : undefined));
    const next = trimPage(page, (h) => h.key, limit);
    // One range shares its `eq` values. A merge holds entries of several combinations, each decoded whole.
    const entries = decodeEntries(target, page, range ? ((q as QueryInput).eq?.length ?? 0) : 0);
    return { entries, ...next } as EntryPageOf<T, Ix, I>;
  }

  async count(q: Query<T, Ix>): Promise<number> {
    const plan = this.plan(q, 0);
    const { range, limit, offset } = plan;
    if (range) return this.snap.count(range);
    if (plan.repeats) return merge(this.snap, plan, () => {});
    // Each range counts at most what the page can hold, and the ranges share no document.
    const cap = limit === undefined ? {} : { limit: offset + limit };
    const counts = await Promise.all(plan.ranges.map((r) => this.snap.count({ ...r.range, ...cap })));
    const left = Math.max(0, counts.reduce((a, b) => a + b, 0) - offset);
    return limit === undefined ? left : Math.min(left, limit);
  }

  /** The entries of the query, each with `value` of its bytes. */
  private scan<V>(plan: Plan, value: Decode<V>): Promise<{ key: Uint8Array; value: V }[]> {
    return plan.range ? this.snap.rangeValues(plan.range, value) : mergeEntries(this.snap, plan, value);
  }

  /** `peek` extra entries tell whether another page follows. `range` is the query's one range, when it has one. */
  private plan(q: Query<T, Ix>, peek: number) {
    const input = q as QueryInput;
    const limit = limitOf(input.limit);
    const target = input.index === undefined ? this.coll.rows : readableTarget(this.coll, input.index);
    const offset = offsetOf(input.offset);
    const { ranges, repeats } = scanPlan(target, input);
    const want = limit && limit + peek;
    const range: Range | undefined = ranges.length === 1 ? { ...ranges[0]!.range, ...(want && { limit: want }), ...(offset && { offset }) } : undefined;
    return { target, limit, offset, want, ranges, repeats, reverse: input.reverse === true, range };
  }
}

