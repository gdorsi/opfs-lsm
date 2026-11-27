import type { Entry } from "@opfs-lsm/kv";
import type { BoundCollection } from "./catalog.js";
import { followCollection, type CollectionChange } from "./changes.js";
import { decodeDocs, diffEntries, entriesOf, NONE, uniqueConflict, type Claim, type EncodedDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { bytesEqual, concat, idBytes, idOf, indexIdOf, keyString, parseId, rowKey, type DocId } from "./keys.js";
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
   * Remove every document and index entry with one kv range delete, in the
   * batch that writes the catalog, so every reader and writer stops seeing
   * them at once. The cost does not depend on the size.
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
   * handles and other tabs, in kv seq order. A change gives the document
   * after it, and with `before` its entries in an index before it. Returns
   * the unsubscribe function. To read the collection and then follow it
   * without a hole, subscribe first, then `view`, and ignore events with a
   * seq at or below `snap.seq`.
   */
  changes(listener: (change: CollectionChange<T, Ix>) => void): () => void;
}

/** What a write makes of one row: a document to store, null for no row, undefined to leave the row as it is. */
type Slot = EncodedDoc | null | undefined;

type Change = {
  readonly next: readonly Slot[];
  /** The entries of each stored row, from a write that parsed the rows itself. */
  readonly before?: readonly (readonly Entry[])[];
};

type ChangeRows = (rows: readonly (Uint8Array | undefined)[], idbs: readonly Uint8Array[]) => Change;

/** What each row became, and how many of the rows existed. */
type Written = { readonly next: readonly Slot[]; readonly existed: number };

/**
 * The one transaction that writes rows. It reads the rows `ids`, takes from
 * `change` what each becomes, and writes the rows whose bytes differ with
 * the index entries that differ. `change` is the slots themselves when they
 * do not depend on the rows. With `blind` it reads no row: documents put
 * into a collection with no index have nothing to diff.
 *
 * A unique key belongs to the row its value names. A row takes a key that
 * is free, or that a row of this write lets go of, so every delete goes out
 * before any put. Given slots name their unique keys before the body runs,
 * so the plan asks for the owners with the rows. Slots that `change` makes
 * from the rows name them only in the body, which reads the owners with
 * `tx.read`. While a unique index builds, two old rows may share a value,
 * and the entry belongs to whichever row the backfill reached first: a row
 * then removes a unique entry only after reading, with `tx.read` too, that
 * it owns it. Once the index is ready, a row's unique entries are its own.
 */
function planRows(
  coll: BoundCollection,
  ids: readonly DocId[],
  change: readonly Slot[] | ChangeRows,
  blind = false,
): WritePlan<Written> {
  const indexed = coll.maintained.length > 0;
  // A blind write derives no entry, so it needs no id apart from its row key.
  const idbs = blind ? [] : ids.map(idBytes);
  const rowKeys = blind ? ids.map((id) => rowKey(coll.rows.prefix, id)) : idbs.map((b) => concat(coll.rows.prefix, b));
  const uniques = coll.maintained.filter((p) => p.target.unique);
  /** The unique index `key` is an entry of, if it is one. */
  const uniqueOf = (key: Uint8Array) => uniques.find((p) => p.id === indexIdOf(key));
  let changeOf: ChangeRows;
  /** The entries of slots that are given: derived once, however often the body runs. */
  let after: (readonly Entry[])[] | undefined;
  /** Where the owner of each unique entry of `after` comes in the values, after the rows. */
  const asked = new Map<Entry, number>();
  if (typeof change === "function") changeOf = change;
  else {
    const given = { next: change };
    changeOf = () => given;
    if (indexed) after = change.map((d, i) => (d ? entriesOf(coll, idbs[i]!, d.doc, "next") : NONE));
    for (const entries of after ?? []) {
      for (const e of entries) if (uniqueOf(e.key)) asked.set(e, rowKeys.length + asked.size);
    }
  }

  return {
    keys: blind ? [] : asked.size > 0 ? [...rowKeys, ...Array.from(asked.keys(), (e) => e.key)] : rowKeys,
    apply: (rows, tx) => {
      const { next, before } = changeOf(rows, idbs);
      const changed: number[] = [];
      let existed = 0;
      for (let i = 0; i < next.length; i++) {
        const doc = next[i];
        const old = rows[i];
        if (old) existed++;
        if (doc !== undefined && !(doc ? bytesEqual(old, doc.bytes) : old === undefined)) changed.push(i);
      }

      const removes: Uint8Array[] = [];
      const writes: Entry[] = [];
      if (indexed) {
        const claims: Claim[] = [];
        /** The stored value of each claim's key. */
        const owners: (Uint8Array | undefined)[] = [];
        /** Unique entries of a building index, removed only if their row owns them. */
        const kept: Claim[] = [];
        const olds = before ? undefined : decodeDocs(changed.map((i) => rows[i]));
        for (let c = 0; c < changed.length; c++) {
          const i = changed[c]!;
          const id = idbs[i]!;
          const doc = next[i];
          const old = olds?.[c];
          const was = before ? before[i]! : old ? entriesOf(coll, id, old, "stored") : NONE;
          const now = !doc ? NONE : after ? after[i]! : entriesOf(coll, id, doc.doc, "next");
          const diff = diffEntries(was, now);
          for (const key of diff.remove) {
            if (uniqueOf(key)?.state.kind === "building") kept.push({ key, id });
            else removes.push(key);
          }
          for (const e of diff.write) {
            writes.push(e);
            if (!uniqueOf(e.key)) continue;
            claims.push({ key: e.key, id });
            if (after) owners.push(rows[asked.get(e)!]);
          }
        }
        // What only the stored rows decide is read here.
        const late = after ? kept : [...claims, ...kept];
        if (late.length > 0) {
          const read = tx.read(late.map((c) => c.key));
          const from = read.length - kept.length;
          for (let j = 0; j < from; j++) owners.push(read[j]);
          kept.forEach((k, j) => {
            if (bytesEqual(read[from + j], k.id)) removes.push(k.key);
          });
        }
        if (claims.length > 0) {
          // Only a key another row holds asks, so the usual write builds no set.
          let released: Set<string> | undefined;
          const clash = uniqueConflict(claims, owners, (key) => (released ??= new Set(removes.map(keyString))).has(keyString(key)));
          if (clash) throw uniqueError(idOf(clash[0]), idOf(clash[1]));
        }
      }

      for (const i of changed) {
        const doc = next[i];
        if (doc) tx.put(rowKeys[i]!, doc.bytes);
        else tx.delete(rowKeys[i]!);
      }
      for (const k of removes) tx.delete(k);
      for (const e of writes) tx.put(e.key, e.value);
      return { next, existed };
    },
  };
}

function uniqueError(incoming: string, owner: string): DocStoreError {
  return new DocStoreError("unique", `"${incoming}" and "${owner}" would share a unique value`, [incoming, owner]);
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
    await this.store.write(this.name, (coll) => planRows(coll, ids, encoded, coll.maintained.length === 0));
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

  /** `fn` runs inside the transaction, on the rows it read. Returns what each slot became. */
  private async transact(
    ids: readonly string[],
    fn: (docs: readonly (T | undefined)[]) => readonly (In | null | undefined)[],
  ): Promise<readonly Slot[]> {
    const docIds = ids.map(parseId);
    if (new Set(docIds).size !== docIds.length) throw new DocStoreError("document", "modifyMany got one id twice");
    const written = await this.store.write(this.name, (coll) =>
      planRows(coll, docIds, (rows, idbs) => {
        const docs = decodeDocs(rows);
        // Before `fn`, which may change the objects it is given.
        const before = docs.map((doc, i) => (doc ? entriesOf(coll, idbs[i]!, doc, "stored") : NONE));
        const out = fn(docs as unknown as (T | undefined)[]);
        if (!Array.isArray(out) || out.length !== docIds.length) {
          throw new DocStoreError("document", `fn must return one entry for each of the ${docIds.length} ids`);
        }
        const encoded = this.encode(out.filter((d) => d !== undefined && d !== null));
        let k = 0;
        const next = out.map((d, i): Slot => {
          if (d === undefined || d === null) return d;
          const doc = encoded[k++]!;
          if (doc.id !== docIds[i]) {
            throw new DocStoreError("document", `fn returned a document with id "${doc.id}" for "${docIds[i]}"`);
          }
          return doc;
        });
        return { next, before };
      }),
    );
    return written.next;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.deleteMany([id])) > 0;
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    const distinct = [...new Set(ids.map(parseId))];
    const gone = distinct.map(() => null);
    return (await this.store.write(this.name, (coll) => planRows(coll, distinct, gone))).existed;
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

  changes(listener: (change: CollectionChange<T, Ix>) => void): () => void {
    return followCollection(this.store, this.name, listener);
  }
}
