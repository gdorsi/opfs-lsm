/**
 * The wire protocol between a device and the sync server. The server
 * package imports this same file, so the message types and the codec exist
 * once.
 *
 * Framing: one binary message per transport frame. A u8 type tag, then the
 * fields in declaration order. Integers are u32 or u64 BE, byte strings are
 * u32 length + bytes, lists are u32 count + items. There is no JSON and no
 * base64 on the wire. A ciphertext travels as raw bytes.
 *
 * What the server stores per space, and the only thing it serves:
 *   - the ACL: member ids (SHA-256 of a member token) with roles, and
 *     invites (id, role, uses, the space key wrapped under the invite)
 *   - per record, the latest sealed state, or a sealed tombstone, kept forever
 *   - per rich-text field of a live record, sealed Yjs updates, until a
 *     client replaces them with a sealed merged state
 *   - per file, sealed chunks, until the owning record is tombstoned
 *   - one counter, the space's ServerRev, bumped once per accepted commit
 *   - one random incarnation per store
 *
 * Membership. End-to-end encryption hides data from the server and nothing
 * more: the server enforces who may read, write and administer, and there is
 * no key rotation. A member is a random bearer token (`crypto.ts`
 * MemberToken), one per membership, kept by the client with the space key.
 * The server stores only its id. Every request re-reads the role.
 *   - `create` makes the space and its first admin, with the space key's
 *     KeyCheck and a `personal` flag. Unauthenticated. If the space exists
 *     and the token is already its admin with the same check, it is `ok`
 *     again (a retry), otherwise `refused exists`.
 *   - `auth` presents a member token for one space on one connection:
 *     `authOk` (with the check), or `denied`. `denied` always carries the
 *     store's incarnation, so a device can tell a replaced store from a
 *     removal. A session whose member is removed gets an unprompted
 *     `denied "removed"` and is cut off.
 *   - `invite` (admin) registers an invite id with a role and the space key
 *     wrapped under the invite's wrap key. The link carries the secret in
 *     its fragment, so the server cannot unwrap it. The server remembers
 *     who created it.
 *   - `join` (unauthenticated) presents the invite token and a new member
 *     token. A "once" invite is kept after use and answers only its user.
 *     A member that joins again with a valid invite gets `joined` again and
 *     nothing changes: a retry after a lost reply.
 *   - `setRole` (admin) also adds a non-member, which lets an admin
 *     re-register members on a server that lost the space. `remove`
 *     (admin), `revokeInvite` (admin), `leave`, `members`.
 *   - Removing or leaving deletes the member, the invites it created and
 *     the invite it joined through, so it cannot come back with a link it
 *     knows. A non-member is `ok`. The last admin cannot be removed,
 *     demoted or leave.
 *   - A personal space has one member. `invite`, `join` and `setRole` are
 *     `refused personal`.
 * A removed member keeps the space key and what it synced. The server stops
 * serving and accepting it.
 *
 * The cursor. A device stores, per space, the highest ServerRev it applied
 * (`73 07`, written in the same kv batch as the data). `pull{after}`
 * returns every live item whose rev is greater, in rev order, so a
 * superseded state is never sent: a device that was away pulls each
 * changed record once, not its history. The server's counter is durable
 * (its own store), so the cursor survives the device's restarts and
 * power losses. A device that lost a suffix also lost the matching
 * cursor suffix (same kv batch) and pulls those items again.
 *
 * The server can lose data too (restored from a backup, or a new store).
 * Each server store has a random incarnation, sent in `authOk` with the
 * space's head. A device whose cursor names another incarnation, or a rev
 * above the head, re-queues every record of the space and pulls from 0
 * (`LocalStore.requeueSpace`). State is the unit, so any device can
 * repopulate a server.
 */

import { Reader, Writer } from "../bytes.js";
import type { Brand, FileKeyId, RecordKeyId, SpaceBytes } from "../ids.js";
import type { FieldHash } from "../local/keys.js";
import type { Bytes32, KeyCheck, Sealed, TokenId } from "../space/crypto.js";
import { sealedBytes, sealedFrom } from "../space/crypto.js";

export type Role = "admin" | "writer" | "reader";

/** Per-space commit counter assigned by the server, from 1. 0 means "nothing yet". Stored as u64 BE. Below 2^53. */
export type ServerRev = Brand<number, "ServerRev">;
/**
 * 16 random bytes per sync engine instance. The server stores it with every
 * rich-text item it accepts, so a device skips its own on pull. Records and
 * tombstones carry none: an echoed record merges to identical bytes.
 */
export type ClientId = Brand<Uint8Array, "ClientId">;
/** 16 random bytes per server store, fixed for the store's life. */
export type Incarnation = Brand<Uint8Array, "Incarnation">;
/** What a device stores per space at `73 07`: the highest rev applied, and which server store assigned it. */
export type PullCursor = { readonly incarnation: Incarnation; readonly rev: ServerRev };

/**
 * A stored item as the server serves it. Cleartext header, sealed body.
 * The header is what the server sees: kind, ids, rev, size. The body's AAD
 * binds kind, space, record and field (`crypto.ts` ItemAad).
 */
export type Envelope =
  /** Plaintext: the record's state bytes (`local/record.ts`). The server keeps one per record. */
  | { readonly kind: "record"; readonly id: RecordKeyId; readonly rev: ServerRev; readonly sealed: Sealed }
  /** Plaintext: TombValue. Cleartext so the server can drop the record's rich text and files, and refuse anything later for the id. */
  | { readonly kind: "tomb"; readonly id: RecordKeyId; readonly rev: ServerRev; readonly sealed: Sealed }
  /** Plaintext: one Yjs update (possibly several merged by the sender). */
  | {
      readonly kind: "richText";
      readonly id: RecordKeyId;
      readonly field: FieldHash;
      readonly rev: ServerRev;
      readonly sealed: Sealed;
      readonly origin: ClientId;
    }
  /** Plaintext: a Yjs update holding every update of the field up to `covers`. The server deleted those updates when it stored this. */
  | {
      readonly kind: "richTextState";
      readonly id: RecordKeyId;
      readonly field: FieldHash;
      readonly covers: ServerRev;
      readonly rev: ServerRev;
      readonly sealed: Sealed;
      readonly origin: ClientId;
    };

/**
 * What a device pushes. A record names the ServerRev its state includes
 * (`base`): the server stores it only if `base` is the record's current
 * rev, a compare-and-set, and otherwise returns the current item as a
 * conflict. A tombstone is never refused. Delete is terminal, so it needs
 * no base. Rich-text items are appended, because Yjs updates commute.
 */
export type PushItem =
  | { readonly kind: "record"; readonly id: RecordKeyId; readonly base: ServerRev; readonly sealed: Sealed }
  | { readonly kind: "tomb"; readonly id: RecordKeyId; readonly sealed: Sealed }
  | { readonly kind: "richText"; readonly id: RecordKeyId; readonly field: FieldHash; readonly sealed: Sealed }
  | {
      readonly kind: "richTextState";
      readonly id: RecordKeyId;
      readonly field: FieldHash;
      readonly covers: ServerRev;
      readonly sealed: Sealed;
    };

export type InviteUses = "once" | "many";

/** `req` is a u32 the client picks, echoed in the reply. */
export type ClientMessage =
  | { readonly t: "hello"; readonly protocol: 1; readonly client: ClientId }
  /** One per space per connection. */
  | { readonly t: "auth"; readonly space: SpaceBytes; readonly token: Bytes32 }
  /** Unauthenticated. The space must not exist. The caller becomes its admin. */
  | { readonly t: "create";
      readonly space: SpaceBytes;
      readonly req: number;
      readonly token: Bytes32;
      readonly check: KeyCheck;
      readonly personal: boolean;
    }
  /** Unauthenticated. `memberToken` becomes a member with the invite's role. */
  | { readonly t: "join"; readonly space: SpaceBytes; readonly req: number; readonly inviteToken: Bytes32; readonly memberToken: Bytes32 }
  | {
      readonly t: "invite";
      readonly space: SpaceBytes;
      readonly req: number;
      readonly invite: TokenId;
      readonly role: Role;
      readonly uses: InviteUses;
      readonly wrappedKey: Sealed;
    }
  | { readonly t: "revokeInvite"; readonly space: SpaceBytes; readonly req: number; readonly invite: TokenId }
  | { readonly t: "setRole"; readonly space: SpaceBytes; readonly req: number; readonly member: TokenId; readonly role: Role }
  | { readonly t: "remove"; readonly space: SpaceBytes; readonly req: number; readonly member: TokenId }
  | { readonly t: "leave"; readonly space: SpaceBytes; readonly req: number }
  | { readonly t: "members"; readonly space: SpaceBytes; readonly req: number }
  | { readonly t: "pull"; readonly space: SpaceBytes; readonly after: ServerRev; readonly maxBytes: number }
  /** After the first pull reaches the head: the server sends a `page` for each later commit. */
  | { readonly t: "subscribe"; readonly space: SpaceBytes; readonly after: ServerRev }
  | { readonly t: "push"; readonly space: SpaceBytes; readonly req: number; readonly items: readonly PushItem[] }
  | {
      readonly t: "blobPut";
      readonly space: SpaceBytes;
      readonly req: number;
      readonly file: FileKeyId;
      readonly owner: RecordKeyId;
      readonly chunk: number;
      readonly chunks: number;
      readonly body: Uint8Array;
    }
  | { readonly t: "blobGet"; readonly space: SpaceBytes; readonly req: number; readonly file: FileKeyId; readonly chunk: number };

/** `foreign-id` also answers a `blobPut` whose file or owner id lacks the space tag, names another owner, or rewrites a chunk with other bytes. */
export type PushRejectedReason = "not-a-writer" | "too-large" | "foreign-id";

export type RefusedReason =
  | "exists"
  | "unknown-space"
  | "unknown-invite"
  | "not-authorized"
  | "last-admin"
  | "personal"
  | "already-member";

export type ServerMessage =
  | {
      readonly t: "authOk";
      readonly space: SpaceBytes;
      readonly role: Role;
      readonly incarnation: Incarnation;
      readonly head: ServerRev;
      readonly check: KeyCheck;
    }
  /** Also sent unprompted when a live session's member is removed. */
  | {
      readonly t: "denied";
      readonly space: SpaceBytes;
      readonly reason: "unknown-space" | "not-a-member" | "removed";
      readonly incarnation: Incarnation;
    }
  | { readonly t: "ok"; readonly space: SpaceBytes; readonly req: number }
  | { readonly t: "refused"; readonly space: SpaceBytes; readonly req: number; readonly reason: RefusedReason }
  | {
      readonly t: "joined";
      readonly space: SpaceBytes;
      readonly req: number;
      readonly role: Role;
      readonly wrappedKey: Sealed;
      readonly check: KeyCheck;
    }
  | {
      readonly t: "memberList";
      readonly space: SpaceBytes;
      readonly req: number;
      readonly members: readonly { readonly id: TokenId; readonly role: Role }[];
      readonly invites: readonly { readonly id: TokenId; readonly role: Role; readonly uses: InviteUses }[];
    }
  /**
   * Items with rev in (after, through], in rev order. `more`: the page hit
   * `maxBytes`. A page never splits one commit.
   */
  | {
      readonly t: "page";
      readonly space: SpaceBytes;
      readonly after: ServerRev;
      readonly through: ServerRev;
      readonly items: readonly Envelope[];
      readonly more: boolean;
    }
  /**
   * The accepted items were committed at `rev`. An item the server did
   * not take comes back in `conflicts` as the server's current item for
   * that record: a newer state for a stale base, or the tombstone for any
   * item that targets a deleted record. The device applies conflicts like
   * a page without a cursor, so a tombstone conflict deletes the record
   * locally and clears its outbox. One path, nothing to forget.
   */
  | {
      readonly t: "pushResult";
      readonly space: SpaceBytes;
      readonly req: number;
      readonly rev: ServerRev;
      readonly accepted: readonly RecordKeyId[];
      readonly conflicts: readonly Envelope[];
    }
  | { readonly t: "pushRejected"; readonly space: SpaceBytes; readonly req: number; readonly reason: PushRejectedReason }
  | { readonly t: "blobAck"; readonly space: SpaceBytes; readonly req: number; readonly gone: boolean }
  | { readonly t: "blobChunk"; readonly space: SpaceBytes; readonly req: number; readonly body: Uint8Array | null };

// ---- codec ----

const ROLE = ["admin", "writer", "reader"] as const;
const USES = ["once", "many"] as const;
const DENIED = ["unknown-space", "not-a-member", "removed"] as const;
const REFUSED = ["exists", "unknown-space", "unknown-invite", "not-authorized", "last-admin", "personal", "already-member"] as const;
const PUSH_REJECTED = ["not-a-writer", "too-large", "foreign-id"] as const;

/** The 1-based tag of `value` in `table`. */
function enumTag<T extends string>(table: readonly T[], value: T): number {
  const i = table.indexOf(value);
  if (i < 0) throw new RangeError(`unknown value ${value}`);
  return i + 1;
}
function fromTag<T>(r: Reader, table: readonly T[]): T {
  return table[r.u8() - 1] ?? r.fail("unknown enum value");
}

const putSealed = (w: Writer, s: Sealed) => w.bytes(sealedBytes(s));
const getSealed = (r: Reader): Sealed => sealedFrom(r.bytesField());
const getSpace = (r: Reader) => r.fixed(16) as SpaceBytes;
const getRecord = (r: Reader) => r.fixed(16) as RecordKeyId;
const getTokenId = (r: Reader) => r.fixed(16) as TokenId;
const getToken = (r: Reader) => r.fixed(32) as Bytes32;
const getCheck = (r: Reader) => r.fixed(8) as KeyCheck;

function flag(r: Reader): boolean {
  const b = r.u8();
  if (b > 1) r.fail("bad flag");
  return b === 1;
}

function putPush(w: Writer, it: PushItem): void {
  switch (it.kind) {
    case "record":
      w.u8(1).fixed(it.id, 16).u64(it.base);
      break;
    case "tomb":
      w.u8(2).fixed(it.id, 16);
      break;
    case "richText":
      w.u8(3).fixed(it.id, 16).u32(it.field);
      break;
    case "richTextState":
      w.u8(4).fixed(it.id, 16).u32(it.field).u64(it.covers);
      break;
  }
  putSealed(w, it.sealed);
}

function getPush(r: Reader): PushItem {
  const kind = r.u8();
  const id = getRecord(r);
  switch (kind) {
    case 1: {
      const base = r.u64() as ServerRev;
      return { kind: "record", id, base, sealed: getSealed(r) };
    }
    case 2:
      return { kind: "tomb", id, sealed: getSealed(r) };
    case 3: {
      const field = r.u32() as FieldHash;
      return { kind: "richText", id, field, sealed: getSealed(r) };
    }
    case 4: {
      const field = r.u32() as FieldHash;
      const covers = r.u64() as ServerRev;
      return { kind: "richTextState", id, field, covers, sealed: getSealed(r) };
    }
    default:
      return r.fail("unknown push item");
  }
}

function putEnvelope(w: Writer, e: Envelope): void {
  switch (e.kind) {
    case "record":
      w.u8(1).fixed(e.id, 16);
      break;
    case "tomb":
      w.u8(2).fixed(e.id, 16);
      break;
    case "richText":
      w.u8(3).fixed(e.id, 16).u32(e.field);
      break;
    case "richTextState":
      w.u8(4).fixed(e.id, 16).u32(e.field).u64(e.covers);
      break;
  }
  w.u64(e.rev);
  putSealed(w, e.sealed);
  if (e.kind === "richText" || e.kind === "richTextState") w.fixed(e.origin, 16);
}

function getEnvelope(r: Reader): Envelope {
  const kind = r.u8();
  const id = getRecord(r);
  let field = 0 as FieldHash;
  let covers = 0 as ServerRev;
  if (kind === 3 || kind === 4) field = r.u32() as FieldHash;
  if (kind === 4) covers = r.u64() as ServerRev;
  if (kind < 1 || kind > 4) r.fail("unknown envelope kind");
  const rev = r.u64() as ServerRev;
  const sealed = getSealed(r);
  if (kind === 1) return { kind: "record", id, rev, sealed };
  if (kind === 2) return { kind: "tomb", id, rev, sealed };
  const origin = r.fixed(16) as ClientId;
  switch (kind) {
    case 3:
      return { kind: "richText", id, field, rev, sealed, origin };
    default:
      return { kind: "richTextState", id, field, covers, rev, sealed, origin };
  }
}

/** Smallest encoded Envelope and PushItem, for the reader's list-length check. */
const ENVELOPE_MIN = 1 + 16 + 8 + 4 + 28;
const PUSH_MIN = 1 + 16 + 4 + 28;

export function encodeClientMessage(m: ClientMessage): Uint8Array {
  const w = new Writer(m.t === "blobPut" ? m.body.length + 128 : 256);
  switch (m.t) {
    case "hello":
      w.u8(1).u8(m.protocol).fixed(m.client, 16);
      break;
    case "auth":
      w.u8(2).fixed(m.space, 16).fixed(m.token, 32);
      break;
    case "create":
      w.u8(3).fixed(m.space, 16).u32(m.req).fixed(m.token, 32).fixed(m.check, 8).u8(m.personal ? 1 : 0);
      break;
    case "join":
      w.u8(4).fixed(m.space, 16).u32(m.req).fixed(m.inviteToken, 32).fixed(m.memberToken, 32);
      break;
    case "invite":
      w.u8(5).fixed(m.space, 16).u32(m.req).fixed(m.invite, 16).u8(enumTag(ROLE, m.role)).u8(enumTag(USES, m.uses));
      putSealed(w, m.wrappedKey);
      break;
    case "revokeInvite":
      w.u8(6).fixed(m.space, 16).u32(m.req).fixed(m.invite, 16);
      break;
    case "setRole":
      w.u8(7).fixed(m.space, 16).u32(m.req).fixed(m.member, 16).u8(enumTag(ROLE, m.role));
      break;
    case "remove":
      w.u8(8).fixed(m.space, 16).u32(m.req).fixed(m.member, 16);
      break;
    case "leave":
      w.u8(9).fixed(m.space, 16).u32(m.req);
      break;
    case "members":
      w.u8(10).fixed(m.space, 16).u32(m.req);
      break;
    case "pull":
      w.u8(11).fixed(m.space, 16).u64(m.after).u32(m.maxBytes);
      break;
    case "subscribe":
      w.u8(12).fixed(m.space, 16).u64(m.after);
      break;
    case "push":
      w.u8(13).fixed(m.space, 16).u32(m.req).u32(m.items.length);
      for (const it of m.items) putPush(w, it);
      break;
    case "blobPut":
      w.u8(14).fixed(m.space, 16).u32(m.req).fixed(m.file, 16).fixed(m.owner, 16).u32(m.chunk).u32(m.chunks).bytes(m.body);
      break;
    case "blobGet":
      w.u8(15).fixed(m.space, 16).u32(m.req).fixed(m.file, 16).u32(m.chunk);
      break;
  }
  return w.finish();
}

/** Throws SpacesError "protocol" on malformed input: the caller drops the connection. */
export function decodeClientMessage(bytes: Uint8Array): ClientMessage {
  const r = new Reader(bytes);
  const m = readClient(r);
  r.end();
  return m;
}

function readClient(r: Reader): ClientMessage {
  switch (r.u8()) {
    case 1: {
      if (r.u8() !== 1) r.fail("unsupported protocol version");
      return { t: "hello", protocol: 1, client: r.fixed(16) as ClientId };
    }
    case 2:
      return { t: "auth", space: getSpace(r), token: getToken(r) };
    case 3: {
      const space = getSpace(r);
      const req = r.u32();
      const token = getToken(r);
      const check = getCheck(r);
      return { t: "create", space, req, token, check, personal: flag(r) };
    }
    case 4:
      return { t: "join", space: getSpace(r), req: r.u32(), inviteToken: getToken(r), memberToken: getToken(r) };
    case 5: {
      const space = getSpace(r);
      const req = r.u32();
      const invite = getTokenId(r);
      const role = fromTag(r, ROLE);
      const uses = fromTag(r, USES);
      return { t: "invite", space, req, invite, role, uses, wrappedKey: getSealed(r) };
    }
    case 6:
      return { t: "revokeInvite", space: getSpace(r), req: r.u32(), invite: getTokenId(r) };
    case 7:
      return { t: "setRole", space: getSpace(r), req: r.u32(), member: getTokenId(r), role: fromTag(r, ROLE) };
    case 8:
      return { t: "remove", space: getSpace(r), req: r.u32(), member: getTokenId(r) };
    case 9:
      return { t: "leave", space: getSpace(r), req: r.u32() };
    case 10:
      return { t: "members", space: getSpace(r), req: r.u32() };
    case 11:
      return { t: "pull", space: getSpace(r), after: r.u64() as ServerRev, maxBytes: r.u32() };
    case 12:
      return { t: "subscribe", space: getSpace(r), after: r.u64() as ServerRev };
    case 13: {
      const space = getSpace(r);
      const req = r.u32();
      return { t: "push", space, req, items: r.list(PUSH_MIN, () => getPush(r)) };
    }
    case 14: {
      const space = getSpace(r);
      const req = r.u32();
      const file = r.fixed(16) as FileKeyId;
      const owner = getRecord(r);
      const chunk = r.u32();
      const chunks = r.u32();
      return { t: "blobPut", space, req, file, owner, chunk, chunks, body: r.bytesField() };
    }
    case 15:
      return { t: "blobGet", space: getSpace(r), req: r.u32(), file: r.fixed(16) as FileKeyId, chunk: r.u32() };
    default:
      return r.fail("unknown client message");
  }
}

export function encodeServerMessage(m: ServerMessage): Uint8Array {
  const w = new Writer(m.t === "blobChunk" && m.body ? m.body.length + 64 : 256);
  switch (m.t) {
    case "authOk":
      w.u8(1).fixed(m.space, 16).u8(enumTag(ROLE, m.role)).fixed(m.incarnation, 16).u64(m.head).fixed(m.check, 8);
      break;
    case "denied":
      w.u8(2).fixed(m.space, 16).u8(enumTag(DENIED, m.reason)).fixed(m.incarnation, 16);
      break;
    case "ok":
      w.u8(3).fixed(m.space, 16).u32(m.req);
      break;
    case "refused":
      w.u8(4).fixed(m.space, 16).u32(m.req).u8(enumTag(REFUSED, m.reason));
      break;
    case "joined":
      w.u8(5).fixed(m.space, 16).u32(m.req).u8(enumTag(ROLE, m.role));
      putSealed(w, m.wrappedKey);
      w.fixed(m.check, 8);
      break;
    case "memberList":
      w.u8(6).fixed(m.space, 16).u32(m.req).u32(m.members.length);
      for (const x of m.members) w.fixed(x.id, 16).u8(enumTag(ROLE, x.role));
      w.u32(m.invites.length);
      for (const x of m.invites) w.fixed(x.id, 16).u8(enumTag(ROLE, x.role)).u8(enumTag(USES, x.uses));
      break;
    case "page":
      w.u8(7).fixed(m.space, 16).u64(m.after).u64(m.through).u32(m.items.length);
      for (const e of m.items) putEnvelope(w, e);
      w.u8(m.more ? 1 : 0);
      break;
    case "pushResult":
      w.u8(8).fixed(m.space, 16).u32(m.req).u64(m.rev).u32(m.accepted.length);
      for (const id of m.accepted) w.fixed(id, 16);
      w.u32(m.conflicts.length);
      for (const e of m.conflicts) putEnvelope(w, e);
      break;
    case "pushRejected":
      w.u8(9).fixed(m.space, 16).u32(m.req).u8(enumTag(PUSH_REJECTED, m.reason));
      break;
    case "blobAck":
      w.u8(10).fixed(m.space, 16).u32(m.req).u8(m.gone ? 1 : 0);
      break;
    case "blobChunk":
      w.u8(11).fixed(m.space, 16).u32(m.req);
      if (m.body) w.u8(1).bytes(m.body);
      else w.u8(0);
      break;
  }
  return w.finish();
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage {
  const r = new Reader(bytes);
  const m = readServer(r);
  r.end();
  return m;
}

function readServer(r: Reader): ServerMessage {
  switch (r.u8()) {
    case 1: {
      const space = getSpace(r);
      const role = fromTag(r, ROLE);
      const incarnation = r.fixed(16) as Incarnation;
      const head = r.u64() as ServerRev;
      return { t: "authOk", space, role, incarnation, head, check: getCheck(r) };
    }
    case 2:
      {
      const space = getSpace(r);
      const reason = fromTag(r, DENIED);
      return { t: "denied", space, reason, incarnation: r.fixed(16) as Incarnation };
    }
    case 3:
      return { t: "ok", space: getSpace(r), req: r.u32() };
    case 4:
      return { t: "refused", space: getSpace(r), req: r.u32(), reason: fromTag(r, REFUSED) };
    case 5: {
      const space = getSpace(r);
      const req = r.u32();
      const role = fromTag(r, ROLE);
      const wrappedKey = getSealed(r);
      return { t: "joined", space, req, role, wrappedKey, check: getCheck(r) };
    }
    case 6: {
      const space = getSpace(r);
      const req = r.u32();
      const members = r.list(17, () => ({ id: getTokenId(r), role: fromTag(r, ROLE) }));
      const invites = r.list(18, () => ({ id: getTokenId(r), role: fromTag(r, ROLE), uses: fromTag(r, USES) }));
      return { t: "memberList", space, req, members, invites };
    }
    case 7: {
      const space = getSpace(r);
      const after = r.u64() as ServerRev;
      const through = r.u64() as ServerRev;
      const items = r.list(ENVELOPE_MIN, () => getEnvelope(r));
      return { t: "page", space, after, through, items, more: flag(r) };
    }
    case 8: {
      const space = getSpace(r);
      const req = r.u32();
      const rev = r.u64() as ServerRev;
      const accepted = r.list(16, () => getRecord(r));
      return { t: "pushResult", space, req, rev, accepted, conflicts: r.list(ENVELOPE_MIN, () => getEnvelope(r)) };
    }
    case 9:
      return { t: "pushRejected", space: getSpace(r), req: r.u32(), reason: fromTag(r, PUSH_REJECTED) };
    case 10:
      return { t: "blobAck", space: getSpace(r), req: r.u32(), gone: flag(r) };
    case 11: {
      const space = getSpace(r);
      const req = r.u32();
      return { t: "blobChunk", space, req, body: flag(r) ? r.bytesField() : null };
    }
    default:
      return r.fail("unknown server message");
  }
}

/**
 * Limits both sides enforce. A commit is at most `pushItems` items, and a
 * page is at most `pageItems` items or one whole commit, so an applied
 * page stays under kv's 8 MiB batch even when each item fans out into
 * several kv ops. A page never splits a commit. `pageBytes` is a target:
 * a page always holds at least one commit.
 */
export const Limits = {
  /** Plaintext of one record state. Larger text belongs in a rich-text field. */
  recordBytes: 256 * 1024,
  pushItems: 256,
  pageItems: 1024,
  pageBytes: 2 * 1024 * 1024,
  /** Sealed bytes of one push. Above the largest single item, so any legal item fits alone. */
  pushBytes: 5 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  /** One rich-text merged state. Above it the field refuses edits (kv blob store, see "kv gaps"). */
  richTextStateBytes: 4 * 1024 * 1024,
} as const;
