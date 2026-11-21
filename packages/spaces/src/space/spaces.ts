/**
 * Spaces: the unit of sharing, encryption and sync.
 *
 * A space has one AES-256-GCM key for its whole life (`73 06 <space>`).
 * There are no epochs and no rotation. End-to-end encryption hides data
 * from the server, and the server enforces membership and roles. A removed
 * member keeps the key and stops being served.
 *
 * A key reaches a device in exactly two ways, both started by a person:
 *   - an invite link, whose fragment carries the invite secret. The server
 *     holds only the space key wrapped under a key derived from that secret;
 *   - the account's personal space, where every joined space is a `$spaces`
 *     record `{ space, key }`, so the account's other devices get it.
 * No client ever wraps the key for a member the server names, so a server
 * that adds itself to its own ACL still gets no key.
 *
 * Member tokens are random, one per membership, stored with the key at
 * `73 06` and in the `$spaces` record, so every device of an account is the
 * same member. A new membership (a re-join after removal, another server)
 * gets a new token. Only the personal space's token is derived from the
 * account secret, since it bootstraps everything else. Member ids
 * (`tokenId(token)`) are unlinkable across spaces. Names are app data: a
 * profile record keyed by member id (`keyedRecordId`).
 *
 * Key durability: a space's `$spaces` record must be acked by the server
 * before the space's `create` request goes out and before any of its
 * records is pushed. No ciphertext reaches the server under a key that
 * lives only on one device.
 *
 * The personal space has no other members. `invite`, `setRole`, `remove`
 * and `leave` throw on it, and its `create` carries `personal`, so the
 * server refuses invites and joins on it too: inviting someone to it would
 * hand out every space key.
 *
 * A space's tag (the first 8 bytes of its id) must be unique on the device.
 * `create` draws again on a clash. `join` refuses a link whose tag clashes
 * with a different local space.
 *
 * Membership changes are server requests. Any tab can make one: it writes
 * the request to the outbox (`73 04 02 <req>`), the sync leader sends it,
 * and the leader writes the outcome back to the same key, which the calling
 * tab watches through kv.changes. kv is the only channel between tabs.
 * `create` is the one change that works offline: the space is usable at once
 * and the leader registers it on the next connection.
 *
 * Local state per space (all owned here):
 *   73 06 <space 16>      space key (32) || member token (32)
 *   73 08 <space 16>      SpaceMeta JSON
 *   73 04 02 <req 16>     a pending request, then its outcome
 * The pull cursor (`73 07`) belongs to LocalStore.
 */

import type { Db } from "@opfs-lsm/kv";
import type { FileRef } from "../files.js";
import type { Brand, FileId, MemberId, RecordId, SpaceId, SpaceTag } from "../ids.js";
import type { LocalStore } from "../local/store.js";
import type { Role } from "../sync/protocol.js";
import type { AeadKey, Bytes32, Sealed } from "./crypto.js";

/** `<app url>#join=<space id>.<base64url invite secret>`. The secret travels in the fragment, so the server never sees it. */
export type InviteLink = Brand<string, "InviteLink">;

export type Member = { readonly id: MemberId; readonly role: Role; readonly me: boolean };
export type Invite = { readonly id: string; readonly role: Role; readonly uses: "once" | "many" };

/**
 * This account's standing in a space.
 * `pending`: created offline, not registered yet; the creator is admin.
 * `removed`: the server said this account is no longer a member. Local data stays readable; nothing syncs.
 */
export type Standing = Role | "pending" | "removed";

/** The value at 73 08. */
export type SpaceMeta = {
  readonly standing: Standing;
  /** base64url MemberId, so `Space.me` needs no crypto. */
  readonly me: string;
  /** base64url KeyCheck: compared with authOk and joined before the first push and after an unwrap. */
  readonly check: string;
  /**
   * Admins only: the member list as the server last sent it. The leader
   * fetches it after every membership change it made succeeds. Used to
   * re-register the space on a server that lost it.
   */
  readonly members?: readonly { readonly id: string; readonly role: Role }[];
};

/** The value of a `$spaces` record in the personal space (keyed by space id). Never tombstoned: leaving sets `left`, so a re-join can write it again. */
export type SpacesEntry = { readonly space: string; readonly key: string; readonly token: string; readonly left?: true };

export interface Space {
  readonly id: SpaceId;
  readonly personal: boolean;
  /** This account's member id in this space. */
  readonly me: MemberId;
  standing(): Standing;
  /** Needs the server. Rejects with SpacesError "offline" when none answers. */
  members(): Promise<{ readonly members: readonly Member[]; readonly invites: readonly Invite[] }>;
  /** Admins only. Needs the server: the link works once the server stored the wrapped key. */
  invite(role: Role, options?: { readonly uses?: "once" | "many"; readonly baseUrl?: string }): Promise<InviteLink>;
  revokeInvite(link: InviteLink | Invite["id"]): Promise<void>;
  setRole(member: MemberId, role: Role): Promise<void>;
  /** The server stops serving the member at once. They keep the key and what they already synced. */
  remove(member: MemberId): Promise<void>;
  leave(): Promise<void>;
  watch(listener: () => void): () => void;
}

export interface Spaces {
  readonly personal: Space;
  /** A new space with this account as its only admin. Works offline. */
  create(): Promise<Space>;
  /**
   * Needs the server. Rejects with SpacesError "invite" if the link is
   * unknown, used up by someone else, or revoked. Retrying a join that
   * already succeeded returns the space. When `link` is the page's own URL,
   * strips the fragment with `history.replaceState`.
   */
  join(link: InviteLink | string): Promise<Space>;
  get(id: SpaceId): Space | undefined;
  /** The space a record or file belongs to, from the tag in its id. */
  of(id: RecordId | FileId | FileRef): Space | undefined;
  list(): readonly Space[];
}

/**
 * What the outbox stores for a membership change. Everything the leader
 * needs is in it, so the change completes even if the calling tab closed.
 * `join` carries the wrap key (local disk is trusted like the account
 * secret), so the leader unwraps and stores the space key itself.
 */
export type SpaceRequest =
  | { readonly kind: "create"; readonly space: SpaceId }
  /** `token` is drawn when the request is made, so a retry presents the same member. */
  | { readonly kind: "join"; readonly space: SpaceId; readonly inviteToken: Bytes32; readonly wrapKey: Bytes32; readonly token: Bytes32 }
  | {
      readonly kind: "invite";
      readonly space: SpaceId;
      readonly invite: Uint8Array;
      readonly role: Role;
      readonly uses: "once" | "many";
      readonly wrappedKey: Sealed;
    }
  | { readonly kind: "revokeInvite"; readonly space: SpaceId; readonly invite: Uint8Array }
  | { readonly kind: "setRole"; readonly space: SpaceId; readonly member: Uint8Array; readonly role: Role }
  | { readonly kind: "remove"; readonly space: SpaceId; readonly member: Uint8Array }
  | { readonly kind: "leave"; readonly space: SpaceId }
  | { readonly kind: "members"; readonly space: SpaceId };

export type RequestOutcome =
  | { readonly ok: true; readonly members?: { readonly members: readonly Member[]; readonly invites: readonly Invite[] } }
  | { readonly ok: false; readonly reason: string };

/**
 * The registry the engine and the collections use. It owns `73 06`, `73 08`
 * and `73 04 02`, and the `$spaces` collection of the personal space (catalog
 * id 0, reserved).
 */
export declare class SpaceRegistry implements Spaces {
  private constructor();

  /**
   * Reads every space key and meta (one range each), derives the personal
   * space from the account secret, and follows `$spaces` records so a space
   * joined on another device of the account appears here with its key.
   * No crypto beyond importing keys on first use.
   */
  static open(kv: Db, store: LocalStore, accountSecret: Bytes32): Promise<SpaceRegistry>;

  readonly personal: Space;
  create(): Promise<Space>;
  join(link: InviteLink | string): Promise<Space>;
  get(id: SpaceId): Space | undefined;
  of(id: RecordId | FileId | FileRef): Space | undefined;
  list(): readonly Space[];

  // ---- for the collections ------------------------------------------------

  /** Throws SpacesError "read-only" for a space where this account is a reader or removed. Writes check it before the kv transaction. */
  assertWritable(space: SpaceId): void;

  // ---- for the sync engine ------------------------------------------------

  spaceOfTag(tag: SpaceTag): SpaceId | undefined;
  /** The space's imported AEAD key. */
  spaceKey(space: SpaceId): Promise<AeadKey | undefined>;
  /** The bearer token this account presents for `space`. */
  memberToken(space: SpaceId): Promise<Bytes32>;
  /**
   * What the server said in authOk or denied. One kv put; other tabs see
   * it through kv.changes. The engine never sets `removed` from a `denied`
   * whose incarnation differs from the space's cursor: that server lost
   * the space, it did not remove anyone.
   */
  setStanding(space: SpaceId, standing: Standing): Promise<void>;
  /** The key check stored for `space`. */
  keyCheck(space: SpaceId): Uint8Array | undefined;
  /** Admins: caches a memberList reply in SpaceMeta. */
  cacheMembers(space: SpaceId, members: readonly { readonly id: Uint8Array; readonly role: Role }[]): Promise<void>;
  /**
   * True once the space's `$spaces` record has no outbox entry, i.e. the
   * server holds the key's only backup. The engine waits for it before the
   * space's `create` and before pushing any of its records.
   */
  keyBackedUp(space: SpaceId): Promise<boolean>;
  /** Pending requests in the order they were made. */
  pendingRequests(limit: number): Promise<readonly { readonly key: Uint8Array; readonly request: SpaceRequest }[]>;
  /**
   * The server answered the request at `key`. Writes the outcome to the
   * same key for the calling tab, and for `join` and `create` stores the
   * space key, the standing and the `$spaces` record in the same kv batch.
   * The calling tab deletes the entry once it has read the outcome, and
   * `open` sweeps settled entries left by tabs that closed.
   */
  settle(
    key: Uint8Array,
    outcome: RequestOutcome,
    joined?: { readonly role: Role; readonly wrappedKey: Sealed; readonly check: Uint8Array },
  ): Promise<void>;
}
