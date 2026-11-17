/**
 * Rich-text fields: a Y.Doc per (record, field), loaded on demand. This
 * module is the only one that imports `yjs`, and `db.ts` loads it with a
 * dynamic import, so an app without a `richText()` field never pays for
 * yjs.
 *
 * Storage follows `@opfs-lsm/yjs` KvPersistence: one key per update at
 *   73 05 <record> <field hash> <origin u32> <seq u32>
 * written by `LocalStore` on this module's behalf.
 * The origin is this lease's random session, or 0 for updates the sync
 * leader pulled (seq = rev mod 2^32). Load is one view and one range scan,
 * applied in one Y.transact.
 *
 * Live updates come from kv.changes. A put under the doc's prefix whose
 * origin is not this lease's session is applied with origin REMOTE. That
 * covers another tab's edit and an update the leader pulled from the
 * server. Each update is stored once per device, not once per tab, which
 * fixes the N-fold storage of `broadcastSync`.
 *
 * Local edits: every `doc.on("update")` not from LOAD or REMOTE becomes
 * `LocalStore.appendRichText`, one tombstone-checked kv.update. That is one
 * IndexedDB transaction per Yjs transaction, a few hundred per second, far
 * above typing speed. This module never writes kv itself. LocalStore owns
 * the keys, because a record's delete removes them in its own transaction.
 *
 * Trim: when the doc has 500 stored updates and none of them is still in
 * the outbox (all pushed), and 1 s has passed with no edit, one batch does
 * deleteRange(doc prefix, { through: snap.seq }) and puts the merged state,
 * as KvPersistence does. The engine may then push that state as a
 * `richTextState` covering the pull cursor, so the server drops what it
 * covers. Any client can compact, and two compactions at once are just two
 * states that the next one merges.
 *
 * Deletion: the record's tombstone (local or pulled) deletes the doc's
 * keys in the same batch. Every lease on it sees the deleteRange in
 * kv.changes, detaches its update handler synchronously before any await,
 * sets `deleted`, and calls the listeners. `open` refuses a missing or
 * tombstoned record, so a doc is never seeded for an id the record no
 * longer lists.
 *
 * Encryption: the engine seals updates like records (`ItemKind.richText`,
 * the field hash in the AAD). Locally they are plaintext, so the trim
 * merges in JS with no crypto.
 */

import type * as Y from "yjs";
import type { Db } from "@opfs-lsm/kv";
import type { RecordKeyId } from "./ids.js";
import type { FieldHash } from "./local/keys.js";
import type { LocalStore } from "./local/store.js";

export interface RichTextLease {
  readonly doc: Y.Doc;
  /** True once the record was deleted. The doc no longer saves or syncs. */
  readonly deleted: boolean;
  onDeleted(listener: () => void): () => void;
  /** Drops this lease. The doc stays loaded 5 s for a quick reopen, then is destroyed. */
  release(): void;
}

/**
 * One loaded doc per (record, field) per tab, shared by refcount. React
 * StrictMode's double mount, or navigating away and back, reuses the
 * loaded doc.
 */
export declare class RichTextFields {
  /** `kv` only for `kv.changes`. Reads and writes go through `store`. */
  constructor(kv: Db, store: LocalStore);
  open(record: RecordKeyId, field: FieldHash): Promise<RichTextLease>;
  closeAll(): Promise<void>;
}

/** For the engine's push: `Y.mergeUpdates` over a field's pending updates. Lives here so only this module imports yjs. */
export declare function mergeUpdates(updates: readonly Uint8Array[]): Uint8Array;
