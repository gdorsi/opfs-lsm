import { prefixBound, type Db } from "@opfs-lsm/kv";
import * as Y from "yjs";

/**
 * Yjs persistence on @opfs-lsm/kv, the counterpart of y-indexeddb's
 * `IndexeddbPersistence`. Many documents share one kv `db`; the caller owns
 * the db and closes it.
 *
 * Every local update is one `put`. Yjs updates commute, so the keys only have
 * to be unique, not ordered: `<doc prefix><session u32><seq u32>`, where the
 * session is random per persistence instance. Loading reads the doc's prefix
 * in one range scan and applies every update in one transaction. Once the doc
 * has `trimSize` stored updates or more and no update for `trimDelayMs`, they
 * are replaced with one merged state in one batch, the way y-indexeddb trims
 * at 500. A load replays every stored update, so a long session left unmerged
 * makes the next load slow.
 */
export class KvPersistence {
  readonly whenSynced: Promise<this>;
  synced = false;
  /** Updates found by the last load (before any trim). */
  loadedUpdates = 0;
  /** How long the doc must go without an update, once it has `trimSize` stored updates, before they are merged while it is open. */
  trimDelayMs = 1000;

  private readonly prefix: Uint8Array;
  private readonly session = (Math.random() * 0x1_0000_0000) >>> 0;
  private seq = 0;
  /** Stored updates of this doc as this instance counts them: its own writes since the last merge, plus what it loaded. */
  private stored = 0;
  private trimTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private failure: { readonly error: unknown } | undefined;
  private destroying: Promise<void> | undefined;

  constructor(
    private readonly db: Db,
    readonly name: string,
    readonly doc: Y.Doc,
    private readonly trimSize = DEFAULT_TRIM_SIZE,
  ) {
    this.prefix = docPrefix(name);
    doc.on("update", this.storeUpdate);
    doc.on("destroy", this.docDestroyed);
    // Content the doc held before this persistence was attached fires no update event.
    if (doc.store.clients.size > 0) this.track(db.put(this.nextKey(), Y.encodeStateAsUpdate(doc)));
    this.whenSynced = this.load();
  }

  /**
   * Resolves once every update written so far has been acked by the WAL. When
   * a write failed, the stored doc misses that update, so flush writes the
   * whole doc state once more and rejects if that write fails too.
   */
  async flush(): Promise<void> {
    await this.settle();
    if (this.failure) {
      this.failure = undefined;
      this.track(this.db.put(this.nextKey(), Y.encodeStateAsUpdate(this.doc)));
    }
    // Settle again even with no failure: a concurrent flush may have just started the repair.
    await this.settle();
    this.throwIfFailed();
  }

  /** Every call, and `doc.destroy()`, share one teardown, so each caller sees its failure. */
  readonly destroy = (): Promise<void> => (this.destroying ??= this.teardown());

  private async teardown(): Promise<void> {
    clearTimeout(this.trimTimer);
    this.doc.off("update", this.storeUpdate);
    this.doc.off("destroy", this.docDestroyed);
    await this.flush();
  }

  /** Yjs drops the promise a listener returns, so a failure is left for a `destroy()` that waits. */
  private readonly docDestroyed = (): void => {
    this.destroy().catch(() => {});
  };

  /**
   * Destroys this persistence, then removes every stored update of this doc
   * in one range delete. Other docs in the db are untouched. Later updates of
   * the doc are not stored.
   */
  async clearData(): Promise<void> {
    // The final flush only stores updates this delete removes, so its failure does not stop the delete.
    await this.destroy().catch(() => {});
    await this.db.batch((tx) => tx.deleteRange(prefixBound(this.prefix)));
  }

  private readonly storeUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || this.destroying) return;
    this.track(this.db.put(this.nextKey(), update));
    if (++this.stored >= this.trimSize) {
      clearTimeout(this.trimTimer);
      this.trimTimer = setTimeout(() => this.track(this.trim()), this.trimDelayMs);
    }
  };

  private async load(): Promise<this> {
    const { updates, through } = await this.readStored();
    this.loadedUpdates = updates.length;
    this.stored = updates.length;
    if (!this.destroying) {
      this.apply(updates);
      // The doc already holds every loaded update, so this merge needs no second read.
      const count = updates.length;
      if (count >= this.trimSize) this.trimTimer = setTimeout(() => this.track(this.replace(count, through)), this.trimDelayMs);
      this.synced = true;
    }
    return this;
  }

  /**
   * Merges the doc's stored updates into one while it is open. Every stored
   * update is applied first, other tabs' included, so the one state holds
   * everything in the keys it replaces.
   */
  private async trim(): Promise<void> {
    this.trimTimer = undefined;
    // The range delete stops at the read's seq. An own update still in flight
    // would stay stored, keyed before the merged state, and a later load would
    // replay it without the updates it builds on: Yjs then holds it as pending,
    // which costs quadratic time in the number of such updates.
    await Promise.all(this.pending);
    if (this.destroying) return;
    const { updates, through } = await this.readStored();
    if (this.destroying) return;
    this.apply(updates);
    await this.replace(updates.length, through);
  }

  /** The doc's stored updates, and the seq of the log they were read at. */
  private readStored(): Promise<{ updates: Uint8Array[]; through: number }> {
    return this.db.view(async (snap) => {
      const updates: Uint8Array[] = [];
      for await (const entry of snap.range(prefixBound(this.prefix))) updates.push(entry.value);
      return { updates, through: snap.seq };
    });
  }

  private apply(updates: readonly Uint8Array[]): void {
    Y.transact(
      this.doc,
      () => {
        for (const update of updates) Y.applyUpdate(this.doc, update);
      },
      this,
      false,
    );
  }

  /**
   * Replaces the `count` updates read at seq `through` with one update holding
   * the whole doc, in one batch. The range delete stops at `through`, so an
   * update stored after the read, by this tab or another, stays.
   */
  private async replace(count: number, through: number): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.doc);
    const key = this.nextKey();
    this.stored = Math.max(1, this.stored - count + 1);
    await this.db.batch((tx) => {
      tx.deleteRange(prefixBound(this.prefix), { through });
      tx.put(key, state);
    });
  }

  private track(write: Promise<unknown>): void {
    const done = write.then(
      () => {},
      (error: unknown) => {
        this.failure ??= { error };
      },
    ).finally(() => this.pending.delete(done));
    this.pending.add(done);
  }

  private async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure.error;
  }

  private nextKey(): Uint8Array {
    const key = new Uint8Array(this.prefix.byteLength + 8);
    key.set(this.prefix);
    const view = new DataView(key.buffer);
    view.setUint32(this.prefix.byteLength, this.session);
    view.setUint32(this.prefix.byteLength + 4, this.seq++);
    return key;
  }
}

const DEFAULT_TRIM_SIZE = 500;

const textEncoder = new TextEncoder();

/** `y` + u16 name length + UTF-8 name. The length keeps "a" from prefixing "a/b". */
function docPrefix(name: string): Uint8Array {
  const bytes = textEncoder.encode(name);
  if (bytes.byteLength > 0xffff) throw new Error("document name longer than 65535 bytes");
  const out = new Uint8Array(3 + bytes.byteLength);
  out[0] = 0x79;
  out[1] = bytes.byteLength >> 8;
  out[2] = bytes.byteLength & 0xff;
  out.set(bytes, 3);
  return out;
}
