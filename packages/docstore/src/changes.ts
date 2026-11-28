import { ClosedError, CorruptDatabaseError, type ChangeEvent, type ChangeOp } from "@opfs-lsm/kv";
import { declaredPlan, parseCatalog, type BoundCollection, type IndexPlan } from "./catalog.js";
import { decodeDocs, indexEntries, type StoredDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import {
  CATALOG_KEY,
  bytesEqual,
  compareBytes,
  decodeEntries,
  hasPrefix,
  idBytes,
  idOf,
  keyId,
  keyString,
  rowPrefix,
  touches,
  type CollectionId,
} from "./keys.js";
import type { EntryOf, IndexEntry, JsonDoc, KeyOnlyIndex } from "./schema.js";
import type { StoreCore } from "./store.js";

/** The documents of an event are parsed together on the first access to any `doc`, so a listener that only needs `id` pays no JSON.parse. `deleted` tells a delete from a put without parsing. */
export type DocChange<T extends JsonDoc, Ix = any> = {
  readonly id: string;
  readonly deleted: boolean;
  /** The stored form after the change. Undefined for a delete. */
  readonly doc: T | undefined;
  /**
   * The entries the document had in `index` before the change, in index
   * order, as `queryEntries` gives them: none when it did not exist or was
   * not in the index. They come from the index entries the write removed and
   * added, and from `doc` for an index the write left alone, so nothing is
   * read. `index` is a sorted or multi index that is not unique and includes
   * no field: a write can replace the value of any other entry in place, and
   * the key of a unique entry does not name its document. Throws
   * DocStoreError "query" for any other index, and "schema" or
   * "index-failed" when the catalog of the change holds the index otherwise
   * than this handle declares it, as a query does, but not while it builds.
   */
  before<I extends KeyOnlyIndex<Ix>>(index: I): EntryOf<T, Ix, I>[];
  /**
   * The entries this change added to `index` and removed from it, each in
   * index order, as `queryEntries` gives them: an update that leaves the
   * index alone has none. They are the index entries the write recorded, so
   * nothing is read and no document is decoded. The same indexes and errors as
   * `before`. When one record writes a document twice, the last change of
   * that document carries the entries of both writes, and the earlier ones
   * none.
   */
  written<I extends KeyOnlyIndex<Ix>>(index: I): { readonly added: EntryOf<T, Ix, I>[]; readonly removed: EntryOf<T, Ix, I>[] };
};

export type CollectionChange<T extends JsonDoc, Ix = any> =
  | { readonly kind: "append"; readonly seq: number; readonly changes: readonly DocChange<T, Ix>[] }
  /** What the listener holds may be stale: read again. Sent for kv's `gap`, when the collection was cleared or dropped, and for any range delete over its documents. */
  | { readonly kind: "gap" }
  /** The last event. `reason` is kv's: "close" for the kv handle's `close()`, "destroyed" when its database was removed. */
  | { readonly kind: "closed"; readonly reason: "close" | "destroyed" };

/** One index's ops in a run, by document id. */
type EntryOps = Map<string, { readonly removed: Uint8Array[]; readonly added: Uint8Array[] }>;

/**
 * The ops of one kv record that one catalog describes: the rows, parsed
 * together on the first access to any document, since a listener reads every
 * document of an event or none, and the collection's index entries, grouped
 * by index on the first `before` that asks for one.
 */
class Run {
  readonly puts: Uint8Array[] = [];
  /** The record's other puts and dels: `group` keeps an index's by its prefix. */
  readonly entries: Exclude<ChangeOp, { readonly type: "deleteRange" }>[] = [];
  private docs: (StoredDoc | undefined)[] | undefined;
  private coll: BoundCollection | undefined;
  private readonly byIndex = new Map<string, EntryOps>();
  private changes = 0;
  /** The number of the last change of each document. */
  private readonly lastOf = new Map<string, number>();

  constructor(private readonly bound: () => BoundCollection) {}

  /** The number of the next change, which becomes the last of its document. */
  claim(id: string): number {
    this.lastOf.set(id, this.changes);
    return this.changes++;
  }

  doc(slot: number): StoredDoc {
    return (this.docs ??= decodeDocs(this.puts))[slot]!;
  }

  /** The document's entries in `index` before the change: what the write removed, and what it holds now that the write did not add. */
  before(index: string, id: string, slot: number | undefined): IndexEntry[] {
    const plan = this.plan(index);
    let ops = this.byIndex.get(index);
    if (!ops) this.byIndex.set(index, (ops = this.group(plan)));
    const mine = ops.get(id);
    const keys = mine ? mine.removed.slice() : [];
    if (slot !== undefined) {
      const now = indexEntries(plan, idBytes(id), this.doc(slot));
      const added = new Set(mine?.added.map(keyString));
      if (Array.isArray(now)) for (const e of now) if (!added.has(keyString(e.key))) keys.push(e.key);
    }
    keys.sort(compareBytes);
    return decodeEntries(plan.target, keys.map((key) => ({ key, value: undefined })), 0);
  }

  /** The entries the write added to and removed from `index`, when `n` is the last change of the document. */
  written(index: string, id: string, n: number): { added: IndexEntry[]; removed: IndexEntry[] } {
    const plan = this.plan(index);
    let ops = this.byIndex.get(index);
    if (!ops) this.byIndex.set(index, (ops = this.group(plan)));
    const mine = this.lastOf.get(id) === n ? ops.get(id) : undefined;
    const decode = (keys: Uint8Array[] = []) => decodeEntries(plan.target, keys.toSorted(compareBytes).map((key) => ({ key, value: undefined })), 0);
    return { added: decode(mine?.added), removed: decode(mine?.removed) };
  }

  private plan(index: string): IndexPlan {
    // A building index is written like a ready one, so before reads it too.
    const plan = declaredPlan((this.coll ??= this.bound()), index);
    const t = plan.target;
    if (t.kind === "text" || t.unique || t.include) {
      throw new DocStoreError("query", `before cannot read "${index}"`);
    }
    return plan;
  }

  private group(plan: IndexPlan): EntryOps {
    const out: EntryOps = new Map();
    for (const op of this.entries) {
      if (!hasPrefix(op.key, plan.target.prefix)) continue;
      const id = keyId(plan.target, op.key);
      let mine = out.get(id);
      if (!mine) out.set(id, (mine = { removed: [], added: [] }));
      (op.type === "del" ? mine.removed : mine.added).push(op.key);
    }
    return out;
  }
}

class Change<T extends JsonDoc> implements DocChange<T, any> {
  readonly deleted: boolean;
  declare readonly doc: T | undefined;
  readonly #slot: number | undefined;
  readonly #run: Run;
  readonly #n: number;

  /** `slot` is the change's place in the run's rows. `doc` is an own getter, so a copy of the change, such as `postMessage` makes, keeps it. */
  constructor(
    readonly id: string,
    slot: number | undefined,
    run: Run,
  ) {
    this.deleted = slot === undefined;
    this.#slot = slot;
    this.#run = run;
    this.#n = run.claim(id);
    Object.defineProperty(this, "doc", {
      enumerable: true,
      get: () => (slot === undefined ? undefined : (run.doc(slot) as unknown as T)),
    });
  }

  before(index: string): any[] {
    return this.#run.before(index, this.id, this.#slot);
  }

  written(index: string): { added: any[]; removed: any[] } {
    return this.#run.written(index, this.id, this.#n);
  }
}

/** The id of collection `name` in catalog `bytes`, or undefined when the catalog lacks it or this library cannot read it. */
function collectionIdIn(bytes: Uint8Array | undefined, name: string): CollectionId | undefined {
  if (!bytes) return undefined;
  try {
    return parseCatalog(bytes).collections[name]?.id as CollectionId | undefined;
  } catch (err) {
    if (err instanceof DocStoreError || err instanceof CorruptDatabaseError) return undefined;
    throw err;
  }
}

/**
 * Turn kv's change feed into the changes of collection `name`.
 *
 * Which keys are the collection's depends on its id in the catalog. The feed
 * reads the id from a snapshot whose seq it knows, holds the events that
 * arrive meanwhile, and drops those the snapshot already reflects. It
 * follows the id from then on, since the catalog write that changes it is an
 * event too, and reads it again after a kv `gap`, which may have skipped such
 * a write.
 */
export function followCollection<T extends JsonDoc, Ix>(
  store: StoreCore,
  name: string,
  listener: (change: CollectionChange<T, Ix>) => void,
): () => void {
  const kv = store.kv;
  let live = true;
  let held: ChangeEvent[] | undefined;
  let id: CollectionId | undefined;
  let prefix: Uint8Array | undefined;
  /** The catalog that gives `id`, for the index entries of the changes. */
  let catalog: Uint8Array | undefined;
  /** Events at or below this seq are reflected in what the feed already knows. */
  let through = 0;
  /** The last catalog read failed, so events may have been missed. */
  let stale = false;

  const emit = (change: CollectionChange<T, Ix>) => {
    if (!live) return;
    try {
      listener(change);
    } catch (err) {
      console.error("docstore changes() listener threw", err);
    }
  };

  const follow = (next: CollectionId | undefined, bytes: Uint8Array | undefined) => {
    id = next;
    prefix = next === undefined ? undefined : rowPrefix(next);
    catalog = bytes;
  };

  const newRun = () => {
    const bytes = catalog;
    return new Run(() => store.collectionIn(bytes, name));
  };

  const append = (seq: number, ops: readonly ChangeOp[]) => {
    let changes: DocChange<T, Ix>[] = [];
    let run = newRun();
    /** Send the changes so far, then a gap. */
    const gap = () => {
      if (changes.length > 0) emit({ kind: "append", seq, changes });
      changes = [];
      run = newRun();
      emit({ kind: "gap" });
    };
    for (const op of ops) {
      switch (op.type) {
        case "put":
        case "del":
          if (prefix && hasPrefix(op.key, prefix)) {
            const slot = op.type === "put" ? run.puts.push(op.value) - 1 : undefined;
            changes.push(new Change<T>(idOf(op.key, prefix.length), slot, run));
          } else if (bytesEqual(op.key, CATALOG_KEY)) {
            // Copied: the bytes are a view of a memtable chunk.
            const bytes = op.type === "put" ? op.value.slice() : undefined;
            const next = collectionIdIn(bytes, name);
            if (next === id) {
              catalog = bytes;
              run = newRun();
              continue;
            }
            follow(next, bytes);
            gap();
          } else if (prefix) {
            run.entries.push(op);
          }
          break;
        case "deleteRange": {
          const overCatalog = touches(op, CATALOG_KEY);
          // A clear, or another layer's delete. The op says which rows are gone only by their seqs, which the feed does not keep.
          if (overCatalog || (prefix && touches(op, prefix))) gap();
          // Where the collection is now, the next catalog read says.
          if (overCatalog) return resync();
          break;
        }
      }
    }
    if (changes.length > 0) emit({ kind: "append", seq, changes });
  };

  const apply = (event: ChangeEvent) => {
    switch (event.kind) {
      case "append":
        if (event.seq <= through) return;
        through = event.seq;
        return append(event.seq, event.ops);
      case "gap":
        if (event.through <= through) return;
        emit({ kind: "gap" });
        return resync();
      case "closed":
        emit({ kind: "closed", reason: event.reason });
        live = false;
        return;
    }
  };

  /**
   * Hold events, learn the id and seq from one snapshot, then replay what the
   * snapshot does not reflect. A read that fails leaves the feed stale: the
   * events it held are lost, so the next event reads again, and the listener
   * gets a gap once a read succeeds.
   */
  const resync = (first: ChangeEvent[] = []) => {
    held = first;
    kv.view(async (snap) => ({ seq: snap.seq, catalog: await snap.get(CATALOG_KEY) }))
      .then(
        (base) => {
          through = base.seq;
          follow(collectionIdIn(base.catalog, name), base.catalog);
          if (stale) emit({ kind: "gap" });
          stale = false;
          return held!;
        },
        (err: unknown) => {
          follow(undefined, undefined);
          if (err instanceof ClosedError) return held!;
          console.error("docstore changes() could not read the catalog", err);
          stale = true;
          return held!.filter((event) => event.kind === "closed");
        },
      )
      .then((replay) => {
        held = undefined;
        for (const event of replay) deliver(event);
      });
  };

  /** A replayed gap starts another resync, and the events after it wait for that one. */
  const deliver = (event: ChangeEvent) => {
    if (!live) return;
    if (held) held.push(event);
    else if (stale && event.kind !== "closed") resync([event]);
    else apply(event);
  };

  const off = kv.changes(deliver);
  resync();
  return () => {
    live = false;
    off();
  };
}
