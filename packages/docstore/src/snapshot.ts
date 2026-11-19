import { CorruptDatabaseError, type Entry, type Range, type ViewSnapshot } from "@opfs-lsm/kv";
import { readableTarget, type BoundCollection } from "./catalog.js";
import { decodeDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { concat, decodeEntries, encodeCursor, entryId, entryIdString, idBytes, idOf, parseId, scanPlan } from "./keys.js";
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
  /** How many entries `query` would walk, stopping at `limit` if given. */
  count(q: Query<T, Ix>): Promise<number>;
}

function limitOf(limit: unknown): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1) return limit;
  throw new DocStoreError("query", "limit must be a positive integer");
}

function withLimit(range: Range, limit: number | undefined): Range {
  return limit === undefined ? range : { ...range, limit };
}

/** `hits` holds one entry past the page iff another page follows: drop it and name the cursor. */
function trimPage<H>(hits: H[], keyOf: (hit: H) => Uint8Array, limit: number | undefined): { next?: Cursor } {
  if (limit === undefined || hits.length <= limit) return {};
  hits.length = limit;
  return { next: encodeCursor(keyOf(hits[limit - 1]!)) };
}

async function collect(entries: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const e of entries) out.push(e);
  return out;
}

/** What a point read needs of kv: a `Db` and a view snapshot both fit. */
type PointSource = Pick<ViewSnapshot, "get">;

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
    const bytes = await this.snap.get(concat(this.coll.rows.prefix, idBytes(parseId(id))));
    return bytes && (decodeDoc(bytes) as unknown as T);
  }

  async getMany(ids: readonly string[]): Promise<(T | undefined)[]> {
    const keys = ids.map((id) => concat(this.coll.rows.prefix, idBytes(parseId(id))));
    const rows = await Promise.all(keys.map((k) => this.snap.get(k)));
    return rows.map((bytes) => bytes && (decodeDoc(bytes) as unknown as T));
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
    if (target.kind === "rows") {
      const page = await collect(this.snap.range(range));
      const next = trimPage(page, (h) => h.key, limit);
      return { docs: page.map((h) => decodeDoc(h.value) as unknown as T), ...next };
    }
    const hits = await this.snap.rangeJoin(range, (h) => concat(target.rowPrefix, entryId(target, h.key, h.value)));
    const next = trimPage(hits, (h) => h.entry.key, limit);
    const docs = hits.map(({ joined }) => {
      if (!joined) throw new CorruptDatabaseError(`an index entry of "${this.coll.name}" points at a missing document`);
      return decodeDoc(joined) as unknown as T;
    });
    return { docs, ...next };
  }

  async queryIds(q: Query<T, Ix>): Promise<IdPage> {
    const { target, range, limit } = this.plan(q, 1);
    const page = await collect(this.snap.range(range));
    const next = trimPage(page, (h) => h.key, limit);
    return { ids: page.map((h) => entryIdString(target, h.key, h.value)), ...next };
  }

  async queryEntries<I extends (keyof Ix & string) | undefined = undefined>(
    q: Query<T, Ix> & { readonly index?: I | undefined },
  ): Promise<EntryPage<EntryValues<T, Ix, I>>> {
    const { target, range, limit } = this.plan(q, 1);
    const page = await collect(this.snap.range(range));
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
    return { target, limit, range: withLimit(scanPlan(target, input), limit && limit + peek) };
  }
}
