import type { DbName } from "../check.js";
import { asGeneration, asSeq, type Generation, type Seq } from "../seq.js";
import { openDatabase, reqToPromise, txDone } from "./wal.js";

/** One IndexedDB database per origin. It outlives the databases `destroyDb` removed. */
const DESTROYED_DB = "opfs-lsm-destroyed";
/** Database name -> `DestroyedFloor`. */
const DESTROYED_STORE = "destroyed";

/**
 * What a database `destroyDb` removed leaves, the only thing it leaves:
 * every seq it named, in the WAL or in a manifest, is below `head`, and
 * every manifest number it used is at most `top`.
 *
 * - It is written at durability "strict" before `destroyDb` removes a file
 *   or deletes the WAL database. That order, and no order between two
 *   IndexedDB databases, keeps a power loss from undoing the removal.
 * - While `opfs-lsm-wal/<name>` exists, its `meta` is what counts and the
 *   row is ignored. Recovery rule 0 reads it only for a WAL database that
 *   records no generation, and forgets it once that database starts past it.
 * - It never moves down.
 */
export type DestroyedFloor = { readonly head: Seq; readonly top: Generation };

function floorOf(raw: unknown): DestroyedFloor | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { head, top } = raw as { head?: unknown; top?: unknown };
  if (typeof head !== "number" || typeof top !== "number") return undefined;
  return { head: asSeq(head), top: asGeneration(top) };
}

function createRegistry(db: IDBDatabase): void {
  db.createObjectStore(DESTROYED_STORE);
}

/** The row for `name`, or undefined. Creates nothing, not even `opfs-lsm-destroyed`. */
export async function readDestroyed(name: DbName): Promise<DestroyedFloor | undefined> {
  const db = await openDatabase(DESTROYED_DB, {});
  if (!db) return undefined;
  try {
    const tx = db.transaction(DESTROYED_STORE, "readonly");
    return floorOf(await reqToPromise(tx.objectStore(DESTROYED_STORE).get(name)));
  } finally {
    db.close();
  }
}

/**
 * Write the row for `name` at durability "strict": it resolves once the row
 * is on disk. A row already there keeps the higher of each figure.
 */
export async function recordDestroyed(name: DbName, floor: DestroyedFloor): Promise<void> {
  const db = (await openDatabase(DESTROYED_DB, { create: createRegistry }))!;
  try {
    const tx = db.transaction(DESTROYED_STORE, "readwrite", { durability: "strict" });
    const done = txDone(tx);
    const store = tx.objectStore(DESTROYED_STORE);
    const old = floorOf(await reqToPromise(store.get(name)));
    store.put({ head: Math.max(old?.head ?? 0, floor.head), top: Math.max(old?.top ?? 0, floor.top) }, name);
    await done;
  } finally {
    db.close();
  }
}

/**
 * Delete the row for `name` if it still reads `floor`. Called only once a
 * strict commit recorded its figures in the new WAL database, so a power
 * loss that loses this delete leaves a row that is ignored.
 */
export async function forgetDestroyed(name: DbName, floor: DestroyedFloor): Promise<void> {
  const db = await openDatabase(DESTROYED_DB, {});
  if (!db) return;
  try {
    const tx = db.transaction(DESTROYED_STORE, "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore(DESTROYED_STORE);
    const now = floorOf(await reqToPromise(store.get(name)));
    if (now && now.head === floor.head && now.top === floor.top) store.delete(name);
    await done;
  } finally {
    db.close();
  }
}
