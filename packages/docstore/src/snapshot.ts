import { CorruptDatabaseError, type Entry, type Range, type ViewSnapshot } from "@opfs-lsm/kv";
import { readableTarget, type BoundCollection } from "./catalog.js";
import { decodeDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { concat, encodeCursor, entryId, idBytes, idOf, parseId, scanPlan } from "./keys.js";
import type { Cursor, IdPage, JsonDoc, Page, Query, QueryInput } from "./schema.js";

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
function trimPage(hits: Entry[], limit: number | undefined): { next?: Cursor } {
  if (limit === undefined || hits.length <= limit) return {};
  hits.length = limit;
  return { next: encodeCursor(hits[limit - 1]!.key) };
}

async function collect(entries: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const e of entries) out.push(e);
  return out;
}

/** What a reader needs of kv: a `Db` and a view snapshot both fit. */
type Source = Pick<ViewSnapshot, "get" | "range">;

/**
 * The one implementation of every read. `coll` must come from the catalog
 * that `source` holds. Over a snapshot, the prefixes and readable indexes
 * then match the data for good: no later `clear` or schema change reaches
 * them. Over a live `Db`, only point reads are safe, since a scan could
 * straddle a `clear`.
 */
export class CollectionReader<T extends JsonDoc, Ix> {
  constructor(
    private readonly snap: Source,
    private readonly coll: BoundCollection,
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

  async query(q: Query<T, Ix>): Promise<Page<T>> {
    const { target, range, limit } = this.plan(q, 1);
    const page = await collect(this.snap.range(range));
    const next = trimPage(page, limit);
    if (target.kind === "rows") return { docs: page.map((h) => decodeDoc(h.value) as unknown as T), ...next };
    const rows = await Promise.all(
      page.map((h) => this.snap.get(concat(target.rowPrefix, entryId(target, h.key, h.value)))),
    );
    const docs = rows.map((bytes) => {
      if (!bytes) throw new CorruptDatabaseError(`an index entry of "${this.coll.name}" points at a missing document`);
      return decodeDoc(bytes) as unknown as T;
    });
    return { docs, ...next };
  }

  async queryIds(q: Query<T, Ix>): Promise<IdPage> {
    const { target, range, limit } = this.plan(q, 1);
    const page = await collect(this.snap.range(range));
    const next = trimPage(page, limit);
    return { ids: page.map((h) => idOf(entryId(target, h.key, h.value))), ...next };
  }

  async count(q: Query<T, Ix>): Promise<number> {
    const { range } = this.plan(q, 0);
    let n = 0;
    for await (const _ of this.snap.range(range)) n++;
    return n;
  }

  /** `peek` extra entries tell whether another page follows. */
  private plan(q: Query<T, Ix>, peek: number) {
    const input = q as QueryInput;
    const limit = limitOf(input.limit);
    const target = input.index === undefined ? this.coll.rows : readableTarget(this.coll, input.index);
    return { target, limit, range: withLimit(scanPlan(target, input), limit && limit + peek) };
  }
}

export class SnapshotReader<T extends JsonDoc, Ix> extends CollectionReader<T, Ix> implements CollectionSnapshot<T, Ix> {
  readonly seq: number;

  constructor(snap: ViewSnapshot, coll: BoundCollection) {
    super(snap, coll);
    this.seq = snap.seq;
  }
}
