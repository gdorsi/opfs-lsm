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
 * in one range scan and applies every update in one transaction. When a load
 * finds `trimSize` updates or more, it replaces them with one merged state in
 * one batch, the way y-indexeddb trims at 500.
 */
export class KvPersistence {
  readonly whenSynced: Promise<this>;
  synced = false;
  /** Updates found by the last load (before any trim). */
  loadedUpdates = 0;

  private readonly prefix: Uint8Array;
  private readonly session = (Math.random() * 0x1_0000_0000) >>> 0;
  private seq = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private destroyed = false;

  constructor(
    private readonly db: Db,
    readonly name: string,
    readonly doc: Y.Doc,
    private readonly trimSize = DEFAULT_TRIM_SIZE,
  ) {
    this.prefix = docPrefix(name);
    doc.on("update", this.storeUpdate);
    doc.on("destroy", this.destroy);
    this.whenSynced = this.load();
  }

  /** Resolves once every update written so far has been acked by the WAL. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  readonly destroy = async (): Promise<void> => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.off("update", this.storeUpdate);
    this.doc.off("destroy", this.destroy);
    await this.flush();
  };

  /**
   * Destroys this persistence, then removes every stored update of this doc
   * in one range delete. Other docs in the db are untouched. Later updates of
   * the doc are not stored.
   */
  async clearData(): Promise<void> {
    await this.destroy();
    await this.db.batch((tx) => tx.deleteRange(prefixBound(this.prefix)));
  }

  private readonly storeUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || this.destroyed) return;
    this.track(this.db.put(this.nextKey(), update));
  };

  private async load(): Promise<this> {
    const keys: Uint8Array[] = [];
    const updates: Uint8Array[] = [];
    for await (const entry of this.db.range(prefixBound(this.prefix))) {
      keys.push(entry.key);
      updates.push(entry.value);
    }
    this.loadedUpdates = updates.length;
    if (!this.destroyed) {
      Y.transact(
        this.doc,
        () => {
          for (const update of updates) Y.applyUpdate(this.doc, update);
        },
        this,
        false,
      );
      if (keys.length >= this.trimSize) {
        const state = Y.encodeStateAsUpdate(this.doc);
        const key = this.nextKey();
        this.track(
          this.db.batch((tx) => {
            for (const old of keys) tx.delete(old);
            tx.put(key, state);
          }),
        );
      }
      this.synced = true;
    }
    return this;
  }

  private track(write: Promise<unknown>): void {
    const done = write.finally(() => this.pending.delete(done));
    this.pending.add(done);
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
