import { ClosedError, CorruptDatabaseError, type ChangeEvent, type ChangeOp, type Db } from "@opfs-lsm/kv";
import { parseCatalog } from "./catalog.js";
import { decodeDocs, type StoredDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { CATALOG_KEY, bytesEqual, hasPrefix, idOf, rowPrefix, touches, type CollectionId } from "./keys.js";
import type { JsonDoc } from "./schema.js";

/** The documents of an event are parsed together on the first access to any `doc`, so a listener that only needs `id` pays no JSON.parse. `deleted` tells a delete from a put without parsing. */
export type DocChange<T extends JsonDoc> = {
  readonly id: string;
  readonly deleted: boolean;
  /** The stored form after the change. Undefined for a delete. */
  readonly doc: T | undefined;
};

export type CollectionChange<T extends JsonDoc> =
  | { readonly kind: "append"; readonly seq: number; readonly changes: readonly DocChange<T>[] }
  /** What the listener holds may be stale: read again. Sent for kv's `gap`, and when the collection was cleared or dropped (its catalog id changed). */
  | { readonly kind: "gap" }
  /** The last event. `reason` is kv's: "close" for the kv handle's `close()`, "destroyed" when its database was removed. */
  | { readonly kind: "closed"; readonly reason: "close" | "destroyed" };

/** `slot` is the change's place in `docs`, the documents of its kv record. */
function docChange<T extends JsonDoc>(id: string, slot: number | undefined, docs: (slot: number) => StoredDoc): DocChange<T> {
  return {
    id,
    deleted: slot === undefined,
    get doc() {
      return slot === undefined ? undefined : (docs(slot) as unknown as T);
    },
  };
}

/**
 * The documents of `puts`, all parsed on the first access to any. A listener
 * reads every document of an event or none, so one batch is the cheapest.
 */
function lazyDocs(puts: readonly Uint8Array[]): (slot: number) => StoredDoc {
  let docs: (StoredDoc | undefined)[] | undefined;
  return (slot) => (docs ??= decodeDocs(puts))[slot]!;
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
export function followCollection<T extends JsonDoc>(
  kv: Db,
  name: string,
  listener: (change: CollectionChange<T>) => void,
): () => void {
  let live = true;
  let held: ChangeEvent[] | undefined;
  let id: CollectionId | undefined;
  let prefix: Uint8Array | undefined;
  /** Events at or below this seq are reflected in what the feed already knows. */
  let through = 0;
  /** The last catalog read failed, so events may have been missed. */
  let stale = false;

  const emit = (change: CollectionChange<T>) => {
    if (!live) return;
    try {
      listener(change);
    } catch (err) {
      console.error("docstore changes() listener threw", err);
    }
  };

  const follow = (next: CollectionId | undefined) => {
    id = next;
    prefix = next === undefined ? undefined : rowPrefix(next);
  };

  const append = (seq: number, ops: readonly ChangeOp[]) => {
    let changes: DocChange<T>[] = [];
    let puts: Uint8Array[] = [];
    let docs = lazyDocs(puts);
    for (const op of ops) {
      switch (op.type) {
        case "put":
        case "del":
          if (prefix && hasPrefix(op.key, prefix)) {
            const slot = op.type === "put" ? puts.push(op.value) - 1 : undefined;
            changes.push(docChange<T>(idOf(op.key, prefix.length), slot, docs));
          } else if (bytesEqual(op.key, CATALOG_KEY)) {
            const next = op.type === "put" ? collectionIdIn(op.value, name) : undefined;
            if (next === id) continue;
            if (changes.length > 0) emit({ kind: "append", seq, changes });
            changes = [];
            puts = [];
            docs = lazyDocs(puts);
            follow(next);
            emit({ kind: "gap" });
          }
          break;
        case "deleteRange":
          // The op says which rows are gone only by their seqs, which the feed does not keep.
          if (!touches(op, CATALOG_KEY) && !(prefix && touches(op, prefix))) break;
          if (changes.length > 0) emit({ kind: "append", seq, changes });
          emit({ kind: "gap" });
          return resync();
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
    kv.view(async (snap) => ({ seq: snap.seq, id: collectionIdIn(await snap.get(CATALOG_KEY), name) }))
      .then(
        (base) => {
          through = base.seq;
          follow(base.id);
          if (stale) emit({ kind: "gap" });
          stale = false;
          return held!;
        },
        (err: unknown) => {
          follow(undefined);
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
