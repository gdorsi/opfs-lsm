/**
 * The sync engine. One per device: it runs in the tab that wins the leader
 * election (a Web Lock), over one connection. The other tabs share kv, so
 * they see everything it applies through `kv.changes`, and it sees their
 * writes through the same feed (the outbox prefix `73 04`). kv is the bus
 * between tabs. There is no second channel and nothing to reconcile.
 *
 * The engine is the crypto and validation boundary. It turns envelopes into
 * validated `RemoteItem`s for `LocalStore.applyRemote`, and pending records
 * into sealed `PushItem`s. Everything past it is plaintext and typed
 * (boundary-discipline).
 *
 * Requests: after `hello`, and whenever kv.changes shows a new `73 04 02`
 *   entry, the engine sends each pending membership request in order
 *   (`spaces.pendingRequests`). `create` and `join` go before `auth`, since
 *   they make the membership `auth` needs. A `create` waits until
 *   `spaces.keyBackedUp(space)`. Each reply is written back with
 *   `spaces.settle`, which for `join` unwraps and stores the space key.
 *   After an admin's change succeeds, the engine sends `members` and
 *   caches the list (`spaces.cacheMembers`).
 *
 * Per space, `auth{space, spaces.memberToken(space)}`, then:
 *
 *   check     authOk.check must equal spaces.keyCheck(space), else stop the space
 *             and report: this device holds the wrong key, and pushing would
 *             overwrite good states with bytes nobody can open.
 *   standing  authOk.role -> spaces.setStanding. `denied` carries the server's
 *             incarnation. Same incarnation as the cursor (or no cursor):
 *             not-a-member / removed -> setStanding("removed"), stop the space's
 *             sync; local data stays. `unknown-space` is normal while this
 *             device's `create` is pending.
 *             Another incarnation: the server lost the space, nobody was removed.
 *             An admin re-sends `create` (same token, same check) and then
 *             `setRole` for each cached member, then auths again. Anyone else
 *             keeps its standing and waits ("waiting" in status).
 *   heal      authOk carries the server's incarnation and head. A stored cursor of
 *             another incarnation, or above the head, means the server lost data:
 *             store.requeueSpace(space), then pull from 0.
 *   pull      loop pull(after = cursor, maxBytes = Limits.pageBytes)
 *             -> openPage -> store.applyRemote(page) until !more; then subscribe(after)
 *   live      each server `page` with page.after === cursor -> openPage -> applyRemote.
 *             A page that does not start at the cursor -> pull again from the cursor.
 *   push      woken by kv.changes on 73 04 (debounced 20 ms) and after connect:
 *               1. membership requests (above)
 *               2. files: blobPut every chunk of each attached file
 *                  (store.pendingFiles("upload")), then store.acknowledgeUpload. A record
 *                  never reaches the server before its files. Wanted files
 *                  (store.pendingFiles("want")) are fetched with blobGet into
 *                  store.putFileChunks.
 *               3. records, once spaces.keyBackedUp(space):
 *                  store.pendingRecords(space, Limits.pushItems) -> seal each state
 *                  (Promise.all over WebCrypto) -> push
 *                  -> pushResult: store.acknowledge(accepted at rev), which also moves
 *                     the cursor to rev when it stood at rev - 1;
 *                     conflicts -> open each, never skip -> store.applyRemote (no cursor).
 *                     A newer state merges and stays in the outbox as localAhead, so it
 *                     goes out in the next round with the new base. A tombstone deletes
 *                     the record and clears its outbox. A record conflict that does not
 *                     open raises the base to its rev, so this state overwrites it. A
 *                     tombstone conflict that does not open is parked for the session
 *                     and reported: applying it would let a server delete records.
 *                     Repeat while anything is pending and not parked.
 *                  -> pushRejected not-a-writer: stop pushing this space, report in status.
 *                     too-large: halve the round and retry.
 *               4. rich text: store.pendingRichText -> richtext.mergeUpdates per field
 *                  (dynamic import, only if the schema has a richText field) -> seal ->
 *                  push -> store.acknowledgeRichText(exactly the merged entries).
 *
 * openPage, per envelope (LocalStore.applyRemote also drops any item whose id
 * does not carry the page's space tag, so a writer of one space cannot reach
 * records of another):
 *   richText / richTextState with origin === my ClientId -> skip (my own update;
 *     storing it again would duplicate the row). Records and tombstones carry no
 *     origin: my own state coming back merges to the same cells and raises the base.
 *   key = spaces.spaceKey(space)   (one key per space, imported once)
 *   plaintext = open(key, sealed, itemAad(...))  bad tag -> skip and report
 *   record -> decodeWireState -> validate each cell with the field's validator
 *             (unknown collection -> skip; the rebuild after an upgrade re-pulls it)
 *   tomb   -> decodeTomb
 *   richText / richTextState -> bytes as they are
 *   clock.observe(every stamp seen)
 *
 * Costs per remote record: 1 AES-GCM open, 1 JSON.parse of meta + fields,
 * one validator call per cell, and its share of one kv.update per page. No
 * signature, key lookup by epoch or permission replay.
 *
 * Idempotent everywhere: a page applied twice merges to the same bytes and
 * writes nothing; a push repeated after a lost ack comes back as a
 * conflict holding our own state, merges to no change, and clears.
 *
 * `stale-schema` from the store (another tab upgraded the schema) stops the
 * engine and releases the leader lock, so the upgraded tab takes over, and
 * `status` reports it so the app can prompt a reload.
 */

import type { Db } from "@opfs-lsm/kv";
import type { SyncStatus } from "../db.js";
import type { SpaceId } from "../ids.js";
import type { Clock, RecordState, WireState } from "../local/record.js";
import type { BoundCollection, LocalStore, RemotePage } from "../local/store.js";
import type { SpaceRegistry } from "../space/spaces.js";
import type { ClientId, Envelope, PushItem, ServerMessage } from "./protocol.js";
import type { Transport } from "./transport.js";

/** Runs `task` while this tab is the leader. `task`'s signal aborts when leadership ends. Returns a stop function. */
export interface LeaderElection {
  run(task: (signal: AbortSignal) => Promise<void>): () => void;
}

/** `navigator.locks.request(name, ...)`: the tab holding the lock leads. When it closes, the next waiting tab leads. */
export declare function webLocksLeader(name: string): LeaderElection;
/** For tests: this handle always leads. */
export declare const alwaysLeader: LeaderElection;

export type EngineDeps = {
  readonly kv: Db;
  readonly store: LocalStore;
  readonly spaces: SpaceRegistry;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly leader: LeaderElection;
};

/** What the engine tracks per space for one connection. In memory only: everything durable is in kv. */
type SpaceSession =
  | { readonly phase: "auth" }
  | { readonly phase: "pull"; readonly cursor: number }
  | { readonly phase: "live"; readonly cursor: number; readonly pushing: boolean }
  | { readonly phase: "denied"; readonly reason: string }
  /** The server lost the space and this device is not an admin: wait for an admin to re-register it. */
  | { readonly phase: "waiting" }
  /** Removed from the space, or a reader: local data stays and pull continues if allowed, but nothing is pushed. */
  | { readonly phase: "read-only"; readonly cursor: number };

export declare class SyncEngine {
  constructor(deps: EngineDeps);
  readonly client: ClientId;
  readonly status: SyncStatus;

  /** Joins the leader election. Connects when leading, and stops when not. */
  start(): void;
  stop(): Promise<void>;

  private sessions: Map<SpaceId, SpaceSession>;
  private onFrame(message: ServerMessage): void;
  private sendRequests(): Promise<void>;
  private pullAll(space: SpaceId): Promise<void>;
  private pushRound(space: SpaceId): Promise<void>;
  private openPage(space: SpaceId, envelopes: readonly Envelope[], through: number | undefined): Promise<RemotePage>;
  private sealPending(space: SpaceId): Promise<PushItem[]>;
}

/**
 * The field validators of the record's collection, applied to a wire state:
 * what turns `WireState` into `RecordState`. Pure and synchronous. A cell
 * the validator refuses is kept with `valid: false`, so it round-trips to
 * the newer app version that wrote it. An unknown collection yields
 * undefined, and the engine skips the item.
 */
export declare function validateWireState(
  collections: ReadonlyMap<string, BoundCollection>,
  wire: WireState,
): RecordState | undefined;
