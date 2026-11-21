/**
 * What the zero-knowledge server persists, per space. Storage is pluggable:
 * an in-memory store for tests, and later SQLite or a Durable Object per
 * space. Every method of a `SpaceTxn` runs inside `withSpace`, which gives
 * one space's requests exclusive access, so a push's compare-and-set and
 * its commit are one step. Spaces never touch each other.
 *
 * Contract. `commit` and every other write are durable before their promise
 * resolves. Any restore or repair of a store that could lose acknowledged
 * writes must draw a new incarnation, so devices notice and push again.
 *
 * Per space:
 *   acl       member id -> role and the invite it joined through; invite id
 *             -> role, uses, wrapped space key, who created it, who used it.
 *             Ids are SHA-256 prefixes of bearer tokens, so the store never
 *             holds a token or a key it could use. Also the space key's
 *             check value and the personal flag, both set at `create`.
 *   head      the last ServerRev
 *   items     one live item per slot, where a slot is a record (record or
 *             tomb) or a (record, field, rev) rich-text update or state.
 *             Each item carries the rev of the commit that wrote it, and an
 *             index by rev serves `pull`. Replacing a record's state drops
 *             its old rev from that index, so pulls never send superseded
 *             states.
 *   blobs     (file) -> owner record, chunk count, sealed chunks
 *
 * Sizes, per live record: one sealed state (its plaintext size + 28 bytes
 * of nonce and tag) + about 40 bytes of header. A tombstone is about 70
 * bytes and kept forever. Rich text: the sealed updates since the last
 * compaction. Nothing else, and no history.
 */

import { toBase64url } from "../bytes.js";
import type { FileKeyId, RecordKeyId, SpaceBytes } from "../ids.js";
import type { FieldHash } from "../local/keys.js";
import type { KeyCheck, Sealed, TokenId } from "../space/crypto.js";
import type { Envelope, Incarnation, InviteUses, Role, ServerRev } from "../sync/protocol.js";

export type StoredMember = { readonly role: Role; /** The invite it joined through. */ readonly via?: TokenId };

export type StoredInvite = {
  readonly role: Role;
  readonly uses: InviteUses;
  readonly wrappedKey: Sealed;
  readonly createdBy: TokenId;
  /** Set when a "once" invite is used. The invite then answers only this member. */
  readonly usedBy?: TokenId;
};

export type Write =
  | { readonly kind: "put"; readonly item: Envelope }
  /** Tombstone side effects: every rich-text item and blob of the record. */
  | { readonly kind: "dropRecordData"; readonly id: RecordKeyId }
  /** Compaction: the field's rich-text items with rev <= covers. */
  | { readonly kind: "dropRichText"; readonly id: RecordKeyId; readonly field: FieldHash; readonly covers: ServerRev };

export type PullPage = { readonly items: Envelope[]; readonly through: ServerRev; readonly more: boolean };

export interface SpaceTxn {
  /** False until `create`. Every other method requires an existing space. */
  exists(): boolean;
  create(admin: TokenId, check: KeyCheck, personal: boolean): Promise<void>;
  check(): KeyCheck;
  personal(): boolean;
  member(id: TokenId): StoredMember | undefined;
  members(): readonly ({ readonly id: TokenId } & StoredMember)[];
  /** `undefined` removes the member. */
  setMember(id: TokenId, member: StoredMember | undefined): Promise<void>;
  invite(id: TokenId): StoredInvite | undefined;
  invites(): readonly ({ readonly id: TokenId } & StoredInvite)[];
  /** `undefined` deletes the invite. */
  setInvite(id: TokenId, invite: StoredInvite | undefined): Promise<void>;

  head(): ServerRev;
  /** The live record or tomb item for `id`. */
  current(id: RecordKeyId): Promise<Envelope | undefined>;
  /** All writes of one push, at rev = head + 1, atomically. Bumps head. */
  commit(rev: ServerRev, writes: readonly Write[]): Promise<void>;
  /**
   * Live items with rev in (after, through], in rev order, whole commits
   * only. At least one commit, then more while the item count stays within
   * `maxItems` and the sealed bytes within `maxBytes`. When nothing is left,
   * `through` is the head and `more` is false.
   */
  pull(after: ServerRev, maxBytes: number, maxItems: number): Promise<PullPage>;

  blob(file: FileKeyId): Promise<{ readonly owner: RecordKeyId; readonly chunks: number } | undefined>;
  blobChunk(file: FileKeyId, chunk: number): Promise<Uint8Array | undefined>;
  blobPut(file: FileKeyId, owner: RecordKeyId, chunks: number, chunk: number, body: Uint8Array): Promise<void>;
}

export interface ServerStore {
  /** Random per store, fixed for its life. A device that sees another one re-pushes its state (`sync/protocol.ts`). */
  readonly incarnation: Incarnation;
  withSpace<T>(space: SpaceBytes, fn: (txn: SpaceTxn) => Promise<T>): Promise<T>;
}

const key = toBase64url;

type MemberRow = { id: TokenId; member: StoredMember };
type BlobRow = { owner: RecordKeyId; chunks: number; bodies: Map<number, Uint8Array> };
type SpaceState = {
  check: KeyCheck;
  personal: boolean;
  head: number;
  members: Map<string, MemberRow>;
  invites: Map<string, { id: TokenId; invite: StoredInvite }>;
  /** slot -> item. Slots: `r:<id>` for a record or tomb, `t:<id>:<field>:<rev>` for rich text. */
  items: Map<string, Envelope>;
  /** rev -> slots written by that commit and still live. */
  byRev: Map<number, Set<string>>;
  blobs: Map<string, BlobRow>;
};

const slotOf = (item: Envelope): string =>
  item.kind === "record" || item.kind === "tomb" ? `r:${key(item.id)}` : `t:${key(item.id)}:${item.field}:${item.rev}`;

const sizeOf = (item: Envelope): number => item.sealed.body.length + 28;

/** Maps, plus one promise chain per space as the lock. For tests and the v0 slice. */
export class MemoryServerStore implements ServerStore {
  readonly incarnation = crypto.getRandomValues(new Uint8Array(16)) as Incarnation;
  private readonly spaces = new Map<string, SpaceState>();
  private readonly locks = new Map<string, Promise<unknown>>();

  withSpace<T>(space: SpaceBytes, fn: (txn: SpaceTxn) => Promise<T>): Promise<T> {
    const k = key(space);
    const run = (this.locks.get(k) ?? Promise.resolve()).then(() => fn(this.txn(k)));
    const tail = run.catch(() => undefined);
    this.locks.set(k, tail);
    void tail.then(() => {
      if (this.locks.get(k) === tail) this.locks.delete(k);
    });
    return run;
  }

  private txn(k: string): SpaceTxn {
    const spaces = this.spaces;
    const st = (): SpaceState => spaces.get(k)!;
    const drop = (s: SpaceState, slot: string) => {
      const item = s.items.get(slot);
      if (!item) return;
      s.items.delete(slot);
      const set = s.byRev.get(item.rev);
      set?.delete(slot);
      if (set?.size === 0) s.byRev.delete(item.rev);
    };
    return {
      exists: () => spaces.has(k),
      async create(admin, check, personal) {
        spaces.set(k, {
          check,
          personal,
          head: 0,
          members: new Map([[key(admin), { id: admin, member: { role: "admin" } }]]),
          invites: new Map(),
          items: new Map(),
          byRev: new Map(),
          blobs: new Map(),
        });
      },
      check: () => st().check,
      personal: () => st().personal,
      member: (id) => st().members.get(key(id))?.member,
      members: () => [...st().members.values()].map((r) => ({ id: r.id, ...r.member })),
      async setMember(id, member) {
        if (member) st().members.set(key(id), { id, member });
        else st().members.delete(key(id));
      },
      invite: (id) => st().invites.get(key(id))?.invite,
      invites: () => [...st().invites.values()].map((r) => ({ id: r.id, ...r.invite })),
      async setInvite(id, invite) {
        if (invite) st().invites.set(key(id), { id, invite });
        else st().invites.delete(key(id));
      },
      head: () => st().head as ServerRev,
      async current(id) {
        return st().items.get(`r:${key(id)}`);
      },
      async commit(rev, writes) {
        const s = st();
        for (const w of writes) {
          if (w.kind === "put") {
            const slot = slotOf(w.item);
            drop(s, slot);
            s.items.set(slot, w.item);
            let set = s.byRev.get(w.item.rev);
            if (!set) s.byRev.set(w.item.rev, (set = new Set()));
            set.add(slot);
          } else if (w.kind === "dropRecordData") {
            const prefix = `t:${key(w.id)}:`;
            for (const slot of [...s.items.keys()]) if (slot.startsWith(prefix)) drop(s, slot);
            for (const [file, blob] of s.blobs) if (key(blob.owner) === key(w.id)) s.blobs.delete(file);
          } else {
            for (const [slot, item] of [...s.items]) {
              if ((item.kind === "richText" || item.kind === "richTextState") && key(item.id) === key(w.id) && item.field === w.field && item.rev <= w.covers) drop(s, slot);
            }
          }
        }
        s.head = rev;
      },
      async pull(after, maxBytes, maxItems) {
        const s = st();
        const items: Envelope[] = [];
        let bytes = 0;
        let through: number = after;
        for (let rev = after + 1; rev <= s.head; rev++) {
          const slots = s.byRev.get(rev);
          if (!slots) continue;
          const commit = [...slots].map((slot) => s.items.get(slot)!);
          const size = commit.reduce((n, i) => n + sizeOf(i), 0);
          if (items.length > 0 && (items.length + commit.length > maxItems || bytes + size > maxBytes)) {
            return { items, through: through as ServerRev, more: true };
          }
          items.push(...commit);
          bytes += size;
          through = rev;
        }
        return { items, through: Math.max(through, s.head) as ServerRev, more: false };
      },
      async blob(file) {
        const b = st().blobs.get(key(file));
        return b && { owner: b.owner, chunks: b.chunks };
      },
      async blobChunk(file, chunk) {
        return st().blobs.get(key(file))?.bodies.get(chunk);
      },
      async blobPut(file, owner, chunks, chunk, body) {
        const blobs = st().blobs;
        let b = blobs.get(key(file));
        if (!b) blobs.set(key(file), (b = { owner, chunks, bodies: new Map() }));
        b.bodies.set(chunk, body);
      },
    };
  }
}
