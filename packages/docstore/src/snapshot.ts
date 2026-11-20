import { CorruptDatabaseError, type Entry, type Range, type ViewSnapshot } from "@opfs-lsm/kv";
import { readableTarget, type BoundCollection } from "./catalog.js";
import { decodeDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { concat, decodeEntries, encodeCursor, entryId, entryIdString, idBytes, parseId, scanPlan } from "./keys.js";
import type { Cursor, EntryPage, EntryValues, IdPage, IndexEntry, JsonDoc, Page, Query, QueryInput } from "./schema.js";

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
  ): Promise<EntryPage<EntryValues<T, Ix, I>>>;
  /** How many entries `query` would walk, from `offset` and stopping at `limit` if given. */
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

const noJoin = () => undefined;

/** Every entry of `range`, read in one call: a `range` iterator spends a promise turn on each entry. */
async function collect(snap: ViewSnapshot, range: Range): Promise<Entry[]> {
  return (await snap.rangeJoin(range, noJoin)).map((hit) => hit.entry);
}

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
    const { target, range, limit } = this.plan(q, 1);
    // The entry past `limit` only says a next page exists, so its document is not read or parsed.
    let left = limit ?? Number.POSITIVE_INFINITY;
    if (target.kind === "rows") {
      const page = await this.snap.rangeValues(range, (bytes) => (left-- > 0 ? decodeDoc(bytes) : undefined));
      const next = trimPage(page, (h) => h.key, limit);
      return { docs: page.map((h) => h.value as unknown as T), ...next };
    }
    const rowOf = (h: Entry) => (left-- > 0 ? concat(target.rowPrefix, entryId(target, h.key, h.value)) : undefined);
    const hits = await this.snap.rangeJoin(range, rowOf, decodeDoc);
    const next = trimPage(hits, (h) => h.entry.key, limit);
    const docs = hits.map(({ joined }) => {
      if (!joined) throw new CorruptDatabaseError(`an index entry of "${this.coll.name}" points at a missing document`);
      return joined as unknown as T;
    });
    return { docs, ...next };
  }

  async queryIds(q: Query<T, Ix>): Promise<IdPage> {
    const { target, range, limit } = this.plan(q, 1);
    const page = await collect(this.snap, range);
    const next = trimPage(page, (h) => h.key, limit);
    return { ids: page.map((h) => entryIdString(target, h.key, h.value)), ...next };
  }

  async queryEntries<I extends (keyof Ix & string) | undefined = undefined>(
    q: Query<T, Ix> & { readonly index?: I | undefined },
  ): Promise<EntryPage<EntryValues<T, Ix, I>>> {
    const { target, range, limit } = this.plan(q, 1);
    const page = await collect(this.snap, range);
    const next = trimPage(page, (h) => h.key, limit);
    const entries = decodeEntries(target, page, (q as QueryInput).eq?.length ?? 0);
    return { entries: entries as IndexEntry<EntryValues<T, Ix, I>>[], ...next };
  }

  count(q: Query<T, Ix>): Promise<number> {
    return this.snap.count(this.plan(q, 0).range);
  }

  /** `peek` extra entries tell whether another page follows. */
  private plan(q: Query<T, Ix>, peek: number) {
    const input = q as QueryInput;
    const limit = limitOf(input.limit);
    const target = input.index === undefined ? this.coll.rows : readableTarget(this.coll, input.index);
    const offset = offsetOf(input.offset);
    const range = scanPlan(target, input);
    return { target, limit, range: { ...range, ...(limit && { limit: limit + peek }), ...(offset && { offset }) } };
  }
}
