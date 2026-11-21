/**
 * The database handle: typed collections over one kv `Db`, plus spaces,
 * files and sync.
 *
 * One write path. `create`, `update` and `delete` are each `transact` with
 * one op. `transact` validates every field outside kv (a validator may not
 * await, see `schema.ts`), then hands the ops to `LocalStore.write`, which
 * runs one `kv.update`. That update merges, maintains indexes, fills the
 * outbox and checks the catalog, all in its synchronous body. No crypto and
 * no network run on a local write.
 *
 * One read path. Reads go to kv only (memtable and SST pages, never
 * IndexedDB) and parse only the fields slice of each value. No crypto and
 * no validation run on a read: only valid values reach that slice.
 */

import type { Db } from "@opfs-lsm/kv";
import type { Files } from "./files.js";
import type { RecordId, SpaceId } from "./ids.js";
import type { RichTextLease } from "./richtext.js";
import type {
  AnyCollection,
  Input,
  Page,
  Patch,
  Query,
  Resolved,
  ResolveSpec,
  RichTextKeys,
  Row,
  SchemaDef,
} from "./schema.js";
import type { Space, Spaces } from "./space/spaces.js";
import type { LeaderElection } from "./sync/engine.js";
import type { Transport } from "./sync/transport.js";
import type { Brand } from "./ids.js";

/** 32 random bytes as base64url. Whoever holds it is this account on every space it joined. */
export type AccountSecret = Brand<string, "AccountSecret">;

export type OpenOptions = {
  /** The app opens and closes kv. This package owns the keys that start with byte 0x73. */
  readonly kv: Db;
  /** Where spaces sync. Absent: local only. Data, spaces and invites still work and sync once a later open passes a server. */
  readonly server?: Transport;
  /**
   * Link a new device to an existing account. Absent: the secret stored in
   * kv, or a new account on first open. A different secret than the stored
   * one throws SpacesError "account": one kv database holds one account.
   */
  readonly account?: AccountSecret;
  /** Which tab runs sync. Default: the Web Lock `opfs-lsm-spaces:<kv name>:sync`. Tests pass `alwaysLeader`. */
  readonly leader?: LeaderElection;
};

/** Where a new record or file goes. Default: the personal space. */
export type WriteOptions = { readonly space?: Space | SpaceId };

export type RecordStatus =
  | "live"
  /** Tombstoned here or anywhere this device synced from. Terminal. */
  | "deleted"
  /** Stored, but a field this app version requires holds a value it cannot validate (a newer app version wrote it). Kept and synced, not shown. */
  | "unreadable"
  | "missing";

export interface CollectionApi<Cs extends readonly AnyCollection[], C extends AnyCollection> {
  /** Validates every field, assigns a new id in the space, writes. The returned row is the validated input. */
  create(input: Input<C>, options?: WriteOptions): Promise<Row<C>>;
  /**
   * Sets the given fields, each merged on its own with a stamp that beats
   * the value it replaces. Throws SpacesError "not-found" for a missing or
   * deleted record.
   */
  update(id: RecordId<C["name"]>, patch: Patch<C>): Promise<void>;
  /** Terminal. Removes the row, its index entries, its rich-text updates and its files, here and, once synced, everywhere. Idempotent. */
  delete(id: RecordId<C["name"]>): Promise<void>;
  get<const R extends ResolveSpec<Cs, C> = {}>(
    id: RecordId<C["name"]>,
    options?: { readonly resolve?: R },
  ): Promise<Resolved<Cs, C, R> | undefined>;
  status(id: RecordId<C["name"]>): Promise<RecordStatus>;
  /** One kv snapshot per page: the index range, the rows, and every resolved ref. */
  query<const R extends ResolveSpec<Cs, C> = {}>(
    query: Query<C> & { readonly resolve?: R },
  ): Promise<Page<Resolved<Cs, C, R>>>;
  /**
   * Calls `listener` with the whole result now, then after every change to
   * this collection from this tab, another tab or a remote, coalesced to
   * one rerun per microtask. Returns unsubscribe. A kv `gap` reruns too.
   */
  watch<const R extends ResolveSpec<Cs, C> = {}>(
    query: Query<C> & { readonly resolve?: R },
    listener: (rows: Resolved<Cs, C, R>[]) => void,
  ): () => void;
  /**
   * A lease on the record's Yjs field. Loads `yjs` and the field's updates
   * on first open (dynamic import, so apps without rich text never load
   * yjs). Throws SpacesError "not-found" if the record is missing or
   * deleted: a field doc is never created for a record that is not there.
   */
  open<K extends RichTextKeys<C["shape"]>>(id: RecordId<C["name"]>, field: K): Promise<RichTextLease>;
}

/** The collections inside `transact`: same ops, synchronous, applied together. */
export interface TxCollection<C extends AnyCollection> {
  create(input: Input<C>, options?: WriteOptions): Row<C>;
  update(id: RecordId<C["name"]>, patch: Patch<C>): void;
  delete(id: RecordId<C["name"]>): void;
}

export type Tx<Cs extends readonly AnyCollection[]> = {
  readonly [C in Cs[number] as C["name"]]: TxCollection<C>;
};

export interface SyncStatus {
  /**
   * `follower`: another tab holds the sync lock. This tab still sees every
   * applied change through kv, and `pending()` and `whenIdle()` read the
   * outbox, which is in kv too. There is no second channel between tabs.
   */
  readonly state: "local-only" | "offline" | "connecting" | "syncing" | "idle" | "follower";
  /** Outbox entries not yet accepted by the server. */
  pending(): Promise<number>;
  /** Resolves when the outbox is empty and every subscribed space has pulled to the server's head. */
  whenIdle(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface Account {
  readonly personal: Space;
  /** For linking another device (QR code, passphrase). The app decides how it travels. */
  exportSecret(): Promise<AccountSecret>;
}

interface DbCore<Cs extends readonly AnyCollection[]> {
  readonly account: Account;
  readonly spaces: Spaces;
  readonly files: Files;
  readonly sync: SyncStatus;
  /**
   * Runs `build` synchronously to collect ops, validating each field as it
   * is added; then applies them all in one kv transaction. Every op lands,
   * or none does. Ops may span collections and spaces. Returns what
   * `build` returned. Remote replicas converge to the same result but may
   * briefly see part of it (see rationale, "Sync").
   */
  transact<T>(build: (tx: Tx<Cs>) => T): Promise<T>;
  /** Stops sync in this tab and releases leases. Does not close kv. */
  close(): Promise<void>;
}

/** Collection names the handle reserves, derived from its own members. */
export type ReservedName = keyof DbCore<readonly AnyCollection[]>;

export type SpacesDb<Cs extends readonly AnyCollection[]> = {
  readonly [C in Cs[number] as C["name"]]: CollectionApi<Cs, C>;
} & DbCore<Cs>;

/**
 * Opens the database over `kv`:
 *   1. loads or creates the account (meta key `account`);
 *   2. `LocalStore.open`: reconciles the catalog with `schema` (one kv
 *      update) and rebuilds any new or redefined index before returning;
 *   3. `SpaceRegistry.open`: reads every space key and meta (two range
 *      scans) and derives the personal space from the account secret; a new
 *      account queues the personal space's `create` request;
 *   4. with a server, starts the sync engine, which runs only in the tab
 *      that wins the leader election.
 * Cold open costs kv's open, a few point reads and two small range scans,
 * plus one HKDF for the personal space. No record is read.
 */
export declare function openSpaces<const Cs extends readonly AnyCollection[]>(
  schema: SchemaDef<Cs>,
  options: OpenOptions,
): Promise<SpacesDb<Cs>>;
