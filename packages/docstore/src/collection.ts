import type { Entry } from "@opfs-lsm/kv";
import type { BoundCollection } from "./catalog.js";
import { followCollection, type CollectionChange } from "./changes.js";
import { decodeDocs, diffEntries, entriesOf, type EncodedDoc, type StoredDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { bytesEqual, concat, idBytes, idOf, keyString, parseId, rowKey, type DocId } from "./keys.js";
import type { EntryPageOf, IdPage, IndexInfo, JsonDoc, Page, Query } from "./schema.js";
import { SnapshotReader, type CollectionSnapshot } from "./snapshot.js";
import type { StoreCore, WritePlan } from "./store.js";

/**
 * `T` is the stored document. `In` is what a write takes, which differs from
 * `T` when the schema's validator has defaults or transforms.
 */
export interface Collection<T extends JsonDoc, Ix, In = T> {
  readonly name: string;
  /** The indexes this handle's schema declares for the collection, by name. */
  readonly indexes: ReadonlyMap<string, IndexInfo>;

  /** The stored document, or undefined. */
  get(id: string): Promise<T | undefined>;
  /** In the order of `ids`. One read: every row sees the same writes. */
  getMany(ids: readonly string[]): Promise<(T | undefined)[]>;

  /** Upsert. See `putMany`. */
  put(doc: In): Promise<void>;
  /**
   * Upsert every document in one kv transaction: all land or none do. In a
   * collection with an index, a document whose stored bytes would not change
   * writes nothing. A collection with no index reads no row and writes every
   * document. Throws DocStoreError "document" on a bad or repeated id or a
   * value an index cannot hold, "unique" if two documents would share a
   * unique value, "invalid" if the collection's validator rejects one or
   * returns a Promise, and kv's ConstraintError over kv's batch limits. With
   * a validator, each document is stored as the validator's output.
   */
  putMany(docs: readonly In[]): Promise<void>;
  /**
   * Read-modify-write one document. `fn` gets the stored form and returns
   * the next document with the same id. It may run more than once, so it
   * must be pure. Returns the stored form of the result, or undefined if
   * there was no document (then `fn` does not run).
   */
  modify(id: string, fn: (doc: T) => In): Promise<T | undefined>;
  /**
   * Read-modify-write several documents in one kv transaction, so no write
   * from this handle, another handle or another tab lands between the read
   * and the write. `fn` gets the stored forms in the order of `ids`
   * (undefined: no document) and returns one entry per id: a document to
   * store, whose id must be that slot's id, `null` to delete, or `undefined`
   * to leave as is. A slot left as is still counts as read: if its document
   * changed meanwhile, `fn` runs again. `fn` may run more than once, so it
   * must be pure. Throws DocStoreError "document" for a repeated id, a result
   * of the wrong length, or a document under another id, and writes nothing.
   * Other errors are those of `putMany`.
   */
  modifyMany(
    ids: readonly string[],
    fn: (docs: readonly (T | undefined)[]) => readonly (In | null | undefined)[],
  ): Promise<void>;

  /** True if there was a document. */
  delete(id: string): Promise<boolean>;
  /** One transaction. Returns how many of the distinct ids existed. */
  deleteMany(ids: readonly string[]): Promise<number>;
  /**
   * Remove every document with one catalog write: the collection gets a new
   * id, so every reader and writer stops seeing the old keys at once. The old
   * keys are deleted in the background. The cost does not depend on the size.
   */
  clear(): Promise<void>;

  /**
   * One page of documents in index order (`reverse`: descending). `next` is
   * set iff more entries follow; pass it as `after`. A multi index returns a
   * document once per matching element. A slot of `eq` can be a list of
   * values: the order is then that of the fields after `eq`, then the id, and
   * a document found under two of the values comes once.
   */
  query(q: Query<T, Ix>): Promise<Page<T>>;
  /** As `query`, without reading the documents. */
  queryIds(q: Query<T, Ix>): Promise<IdPage>;
  /**
   * As `queryIds`, and each entry also carries the values its index orders
   * it by. No document is read.
   */
  queryEntries<I extends (keyof Ix & string) | undefined = undefined>(
    q: Query<T, Ix> & { readonly index?: I | undefined },
  ): Promise<EntryPageOf<T, Ix, I>>;
  /** How many results `query` would return, from `offset` and stopping at `limit` if given. */
  count(q: Query<T, Ix>): Promise<number>;

  /**
   * Reads from one kv snapshot: every read in `body` sees the same state,
   * whatever is written meanwhile. `body` runs once. A write made inside
   * `body` is not visible to its snapshot.
   */
  view<R>(body: (snap: CollectionSnapshot<T, Ix>) => Promise<R>): Promise<R>;
  /**
   * Every change to this collection's documents, from this handle, other
   * handles and other tabs, in kv seq order. Index entries are not reported.
   * Returns the unsubscribe function. To read the collection and then follow
   * it without a hole, subscribe first, then `view`, and ignore events with a
   * seq at or below `snap.seq`.
   */
  changes(listener: (change: CollectionChange<T>) => void): () => void;
}

export const RETRY: unique symbol = Symbol("retry");

const NONE: readonly Entry[] = [];

/**
 * A row read before the transaction. The body retries unless the row still
 * holds `bytes`. `owned` lists the row's unique entries while some unique
 * index is building, and is empty otherwise.
 */
type Prior = {
  readonly bytes: Uint8Array | undefined;
  readonly before: readonly Entry[];
  readonly owned: readonly Entry[];
};

/**
 * While a unique index is building, two old rows may share a value and the
 * entry belongs to whichever row the backfill reached first, so a row may
 * remove a unique entry only after reading who owns it. Which keys to read
 * depends on the old row, and `update` reads only keys named up front: such
 * writes read their rows before the transaction. Once every unique index is
 * ready, a row's unique entries are its own.
 */
const buildingUnique = (coll: BoundCollection) =>
  coll.maintained.some((p) => p.target.kind === "unique" && p.state.kind === "building");

function priorOf(coll: BoundCollection, idb: Uint8Array, bytes: Uint8Array | undefined, doc: StoredDoc | undefined): Prior {
  if (!bytes) return { bytes, before: NONE, owned: NONE };
  const owned: Entry[] | undefined = buildingUnique(coll) ? [] : undefined;
  return { bytes, before: entriesOf(coll, idb, doc!, "stored", owned), owned: owned ?? NONE };
}

/**
 * One transaction that writes `docs[i]` under `ids[i]`, or deletes the row
 * when it is undefined, and returns how many of the rows existed. Without
 * `prior` the old rows are read inside the transaction.
 *
 * A unique key conflicts when its owner is another id outside the batch. A
 * batch member that owns a key and no longer claims it releases it, so every
 * delete of the batch goes out before any put.
 */
function planChanges(
  coll: BoundCollection,
  ids: readonly DocId[],
  docs: readonly (EncodedDoc | undefined)[],
  prior?: readonly Prior[],
): WritePlan<number> {
  const n = ids.length;
  const idbs = ids.map(idBytes);
  const rowKeys = idbs.map((b) => concat(coll.rows.prefix, b));
  const after: (readonly Entry[])[] = [];
  const claims = new Map<string, { readonly key: Uint8Array; readonly at: number }>();
  for (let i = 0; i < n; i++) {
    const doc = docs[i];
    if (!doc) {
      after.push(NONE);
      continue;
    }
    const unique: Entry[] = [];
    after.push(entriesOf(coll, idbs[i]!, doc.doc, "next", unique));
    for (const u of unique) {
      const k = keyString(u.key);
      const other = claims.get(k);
      if (other) throw uniqueError(ids[i]!, ids[other.at]!);
      claims.set(k, { key: u.key, at: i });
    }
  }
  const claimed = [...claims.values()];
  const owners = new Map<string, number>();
  const ownedKeys: Uint8Array[] = [];
  for (const p of prior ?? []) {
    for (const u of p.owned) {
      owners.set(keyString(u.key), n + claimed.length + ownedKeys.length);
      ownedKeys.push(u.key);
    }
  }
  let batch: Set<string> | undefined;

  return {
    keys: [...rowKeys, ...claimed.map((c) => c.key), ...ownedKeys],
    apply: (values, tx) => {
      if (prior?.some((p, i) => !bytesEqual(p.bytes, values[i]))) return RETRY;
      for (let j = 0; j < claimed.length; j++) {
        const { at } = claimed[j]!;
        const owner = values[n + j];
        if (owner === undefined || bytesEqual(owner, idbs[at]) || bytesEqual(values[at], docs[at]!.bytes)) continue;
        const ownerId = idOf(owner);
        if (!(batch ??= new Set(ids)).has(ownerId)) throw uniqueError(ids[at]!, ownerId);
      }
      const removes: Uint8Array[] = [];
      const writes: Entry[] = [];
      let existed = 0;
      const rows = values.slice(0, n);
      const kept = rows.map((old, i) => (docs[i] ? bytesEqual(old, docs[i]!.bytes) : old === undefined));
      const olds = prior ? [] : decodeDocs(rows.map((old, i) => (kept[i] ? undefined : old)));
      for (let i = 0; i < n; i++) {
        const old = olds[i];
        const doc = docs[i];
        if (rows[i]) existed++;
        if (kept[i]) continue;
        if (doc) tx.put(rowKeys[i]!, doc.bytes);
        else tx.delete(rowKeys[i]!);
        const before = prior ? prior[i]!.before : old ? entriesOf(coll, idbs[i]!, old, "stored") : NONE;
        const diff = diffEntries(before, after[i]!);
        for (const k of diff.remove) {
          const at = owners.get(keyString(k));
          if (at === undefined || bytesEqual(values[at], idbs[i])) removes.push(k);
        }
        for (const e of diff.write) writes.push(e);
      }
      for (const k of removes) tx.delete(k);
      for (const e of writes) tx.put(e.key, e.value);
      return existed;
    },
  };
}

/** With no index to diff, a put needs no old row: the catalog read in `write` is the only guard. */
function blindPut(coll: BoundCollection, docs: readonly EncodedDoc[]): WritePlan<void> {
  return {
    keys: [],
    apply: (_values, tx) => {
      for (const d of docs) tx.put(rowKey(coll.rows.prefix, d.id), d.bytes);
    },
  };
}

function uniqueError(incoming: string, owner: string): DocStoreError {
  return new DocStoreError("unique", `"${incoming}" and "${owner}" would share a unique value`, [incoming, owner]);
}

type Slot = EncodedDoc | null | undefined;

/**
 * Run `fn` on the rows `olds` and plan the writes of the slots it changed,
 * against those rows. `changed` lists the slot of each id in the plan.
 */
function planModify<T extends JsonDoc, In>(
  coll: BoundCollection,
  encode: (docs: readonly unknown[]) => EncodedDoc[],
  docIds: readonly DocId[],
  idbs: readonly Uint8Array[],
  olds: readonly (Uint8Array | undefined)[],
  fn: (docs: readonly (T | undefined)[]) => readonly (In | null | undefined)[],
): { readonly next: readonly Slot[]; readonly changed: readonly number[]; readonly plan: WritePlan<number> } {
  const docs = decodeDocs(olds);
  // Before `fn`, which may change the objects it is given.
  const priors = olds.map((bytes, i) => priorOf(coll, idbs[i]!, bytes, docs[i]));

  const out = fn(docs as unknown as (T | undefined)[]);
  if (!Array.isArray(out) || out.length !== docIds.length) {
    throw new DocStoreError("document", `fn must return one entry for each of the ${docIds.length} ids`);
  }
  const encoded = encode(out.filter((d) => d !== undefined && d !== null));
  let k = 0;
  const next = out.map((d, i): Slot => {
    if (d === undefined || d === null) return d;
    const doc = encoded[k++]!;
    if (doc.id !== docIds[i]) {
      throw new DocStoreError("document", `fn returned a document with id "${doc.id}" for "${docIds[i]}"`);
    }
    return doc;
  });

  const changed = next.flatMap((d, i) => (d === undefined ? [] : [i]));
  const plan = planChanges(
    coll,
    changed.map((i) => docIds[i]!),
    changed.map((i) => next[i] ?? undefined),
    changed.map((i) => priors[i]!),
  );
  return { next, changed, plan };
}

export class CollectionImpl<T extends JsonDoc, Ix, In> implements Collection<T, Ix, In> {
  constructor(
    private readonly store: StoreCore,
    readonly name: string,
    readonly indexes: ReadonlyMap<string, IndexInfo>,
    private readonly encode: (docs: readonly unknown[]) => EncodedDoc[],
  ) {}

  get(id: string): Promise<T | undefined> {
    return this.view((snap) => snap.get(id));
  }

  getMany(ids: readonly string[]): Promise<(T | undefined)[]> {
    return this.view((snap) => snap.getMany(ids));
  }

  put(doc: In): Promise<void> {
    return this.putMany([doc]);
  }

  async putMany(docs: readonly In[]): Promise<void> {
    const encoded = this.encode(docs);
    const ids = encoded.map((e) => e.id);
    if (new Set(ids).size !== ids.length) throw new DocStoreError("document", "putMany got one id twice");
    await this.store.write<unknown>(this.name, (coll) =>
      coll.maintained.length === 0 ? blindPut(coll, encoded) : this.planRows(coll, ids, encoded),
    );
  }

  async modify(id: string, fn: (doc: T) => In): Promise<T | undefined> {
    const [slot] = await this.transact([id], ([doc]) => [doc === undefined ? undefined : fn(doc)]);
    return slot ? (slot.doc as unknown as T) : undefined;
  }

  async modifyMany(
    ids: readonly string[],
    fn: (docs: readonly (T | undefined)[]) => readonly (In | null | undefined)[],
  ): Promise<void> {
    await this.transact(ids, fn);
  }

  /**
   * Without a unique index the transaction reads only the rows, so `fn`
   * runs inside it, on what it read. A unique index adds the owners of the
   * values `fn` returns, and kv takes its keys up front: then the rows are
   * read before the transaction, and it commits only if every row, the ones
   * `fn` left included, still holds the bytes `fn` saw. Returns what each
   * slot became.
   */
  private async transact(
    ids: readonly string[],
    fn: (docs: readonly (T | undefined)[]) => readonly (In | null | undefined)[],
  ): Promise<readonly Slot[]> {
    const docIds = ids.map(parseId);
    if (new Set(docIds).size !== docIds.length) throw new DocStoreError("document", "modifyMany got one id twice");
    const idbs = docIds.map(idBytes);
    return this.store.write(this.name, async (coll): Promise<WritePlan<readonly Slot[]>> => {
      const rowKeys = idbs.map((b) => concat(coll.rows.prefix, b));
      if (!coll.maintained.some((p) => p.target.kind === "unique")) {
        return {
          keys: rowKeys,
          apply: (olds, tx) => {
            const { next, changed, plan } = planModify(coll, this.encode, docIds, idbs, olds, fn);
            plan.apply(changed.map((i) => olds[i]), tx);
            return next;
          },
        };
      }
      const olds = await this.store.kv.getMany(rowKeys);
      const { next, plan } = planModify(coll, this.encode, docIds, idbs, olds, fn);
      const left = next.flatMap((d, i) => (d === undefined ? [i] : []));
      return {
        keys: [...plan.keys, ...left.map((i) => rowKeys[i]!)],
        apply: (values, tx) => {
          if (left.some((i, k) => !bytesEqual(olds[i], values[plan.keys.length + k]))) return RETRY;
          return plan.apply(values, tx) === RETRY ? RETRY : next;
        },
      };
    });
  }

  async delete(id: string): Promise<boolean> {
    return (await this.deleteMany([id])) > 0;
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    const distinct = [...new Set(ids.map(parseId))];
    return this.store.write(this.name, (coll) => this.planRows(coll, distinct, distinct.map(() => undefined)));
  }

  /** `planChanges`, reading the rows first only while a unique index builds. */
  private async planRows(
    coll: BoundCollection,
    ids: readonly DocId[],
    docs: readonly (EncodedDoc | undefined)[],
  ): Promise<WritePlan<number>> {
    return planChanges(coll, ids, docs, buildingUnique(coll) ? await this.priors(coll, ids) : undefined);
  }

  private async priors(coll: BoundCollection, ids: readonly DocId[]): Promise<Prior[]> {
    const idbs = ids.map(idBytes);
    const rows = await this.store.kv.getMany(idbs.map((idb) => concat(coll.rows.prefix, idb)));
    const docs = decodeDocs(rows);
    return rows.map((bytes, i) => priorOf(coll, idbs[i]!, bytes, docs[i]));
  }

  clear(): Promise<void> {
    return this.store.clear(this.name);
  }

  query(q: Query<T, Ix>): Promise<Page<T>> {
    return this.view((snap) => snap.query(q));
  }

  queryIds(q: Query<T, Ix>): Promise<IdPage> {
    return this.view((snap) => snap.queryIds(q));
  }

  queryEntries<I extends (keyof Ix & string) | undefined = undefined>(
    q: Query<T, Ix> & { readonly index?: I | undefined },
  ): Promise<EntryPageOf<T, Ix, I>> {
    return this.view((snap) => snap.queryEntries(q));
  }

  count(q: Query<T, Ix>): Promise<number> {
    return this.view((snap) => snap.count(q));
  }

  view<R>(body: (snap: CollectionSnapshot<T, Ix>) => Promise<R>): Promise<R> {
    return this.store.kv.view((snap) => {
      const coll = this.store.collectionAt(snap, this.name);
      return coll instanceof Promise
        ? coll.then((c) => body(new SnapshotReader<T, Ix>(snap, c)))
        : body(new SnapshotReader<T, Ix>(snap, coll));
    });
  }

  changes(listener: (change: CollectionChange<T>) => void): () => void {
    return followCollection(this.store.kv, this.name, listener);
  }
}
