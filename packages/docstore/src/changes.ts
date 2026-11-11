import { ClosedError, CorruptDatabaseError, type ChangeEvent, type ChangeOp, type Db } from "@opfs-lsm/kv";
import { parseCatalog } from "./catalog.js";
import { decodeDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { CATALOG_KEY, bytesEqual, hasPrefix, rowPrefix, type CollectionId } from "./keys.js";
import type { JsonDoc } from "./schema.js";

/** `doc` is parsed on first access, so a listener that only needs `id` pays no JSON.parse. `deleted` tells a delete from a put without parsing. */
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
  | { readonly kind: "closed" };

const fromUtf8 = new TextDecoder();

function docChange<T extends JsonDoc>(id: string, bytes: Uint8Array | undefined): DocChange<T> {
  let parsed: T | undefined;
  return {
    id,
    deleted: bytes === undefined,
    get doc() {
      return bytes && (parsed ??= decodeDoc(bytes) as unknown as T);
    },
  };
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
    for (const op of ops) {
      if (prefix && hasPrefix(op.key, prefix)) {
        changes.push(docChange<T>(fromUtf8.decode(op.key.subarray(prefix.length)), op.type === "put" ? op.value : undefined));
      } else if (bytesEqual(op.key, CATALOG_KEY)) {
        const next = op.type === "put" ? collectionIdIn(op.value, name) : undefined;
        if (next === id) continue;
        if (changes.length > 0) emit({ kind: "append", seq, changes });
        changes = [];
        follow(next);
        emit({ kind: "gap" });
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
        emit({ kind: "closed" });
        live = false;
        return;
    }
  };

  /** Hold events, learn the id and seq from one snapshot, then replay what the snapshot does not reflect. */
  const resync = () => {
    held = [];
    kv.view(async (snap) => ({ seq: snap.seq, id: collectionIdIn(await snap.get(CATALOG_KEY), name) }))
      .then((base) => {
        through = base.seq;
        follow(base.id);
      })
      .catch((err: unknown) => {
        if (!(err instanceof ClosedError)) console.error("docstore changes() could not read the catalog", err);
        follow(undefined);
      })
      .then(() => {
        const replay = held!;
        held = undefined;
        for (const event of replay) deliver(event);
      });
  };

  /** A replayed gap starts another resync, and the events after it wait for that one. */
  const deliver = (event: ChangeEvent) => {
    if (held) held.push(event);
    else if (live) apply(event);
  };

  const off = kv.changes(deliver);
  resync();
  return () => {
    live = false;
    off();
  };
}
