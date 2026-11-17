/**
 * One client connection on the server. The server never holds a space
 * key. It checks bearer tokens against the space's ACL, enforces roles,
 * compares bases, assigns revs and stores bytes.
 *
 * Every request below runs inside `withSpace`, so a membership change and
 * a push on the same space never interleave. Every request after `auth`
 * re-reads the member's role, so a removal takes effect at once; the hub
 * also sends `denied removed` to the member's live sessions.
 *
 *   hello          records the ClientId. Nothing else is per connection
 *   auth           id = tokenId(token). No space -> denied unknown-space; no member
 *                  -> denied not-a-member; else authOk{role, incarnation, head, check}.
 *                  `denied` always carries the incarnation
 *   create         no auth. See protocol.ts: ok, ok again for the same admin and check, or exists
 *   join           no auth. Unknown or revoked invite, or a used "once" invite of
 *                  another member -> unknown-invite. The member exists -> joined again,
 *                  nothing changes. Else add {role, via}, mark a "once" invite used
 *   invite         admin. A personal space -> personal
 *   revokeInvite   admin. A missing invite is ok
 *   setRole        admin. Adds a non-member. Demoting the last admin -> last-admin
 *   remove, leave  a non-member is ok. The last admin -> last-admin. Deletes the member and
 *                  the invites it created or came through, then hub.revoke
 *   members        any member
 *   pull           any member. At most pageItems items and maxBytes, whole commits
 *   subscribe      any member. Answers with a page (possibly empty) for each catch-up step
 *                  from `after`, then a page per later commit
 *   push           writers and admins. A foreign id -> foreign-id, too many items or
 *                  bytes -> too-large, both for the whole push. Else at rev = head + 1:
 *                    record   current is tomb -> conflict(tomb); current.rev != base -> conflict(current);
 *                             else put. No current item is accepted whatever the base
 *                             (a server that lost data takes the device's state back)
 *                    tomb     current is tomb -> accepted, nothing written; else put + dropRecordData
 *                    richText current is tomb -> conflict(tomb); else put (append)
 *                    richTextState  as richText, plus dropRichText(covers)
 *                  commit only if anything was written; reply pushResult; then fan out
 *                  page{after: rev - 1, through: rev} to the other subscribers
 *   blobPut        writers. Ids carry the space tag; the owner matches the stored one; a
 *                  chunk slot is write-once (the same bytes again is ok); a tombstoned
 *                  owner -> blobAck gone
 *   blobGet        any member
 *
 * The server stores `origin` (the pushing ClientId) on rich-text items only.
 *
 * Integrity among members is the server's job: it is the only thing that
 * knows roles. A member holding the key could seal anything, so a reader's
 * writes are kept out by the role check here, not by cryptography.
 */

import { equalBytes, toBase64url } from "../bytes.js";
import type { RecordKeyId, SpaceBytes } from "../ids.js";
import { tokenId } from "../space/crypto.js";
import type { TokenId } from "../space/crypto.js";
import { decodeClientMessage, encodeServerMessage, Limits } from "../sync/protocol.js";
import type { ClientId, ClientMessage, Envelope, PushItem, Role, ServerMessage, ServerRev } from "../sync/protocol.js";
import type { ServerStore, SpaceTxn, Write } from "./store.js";

/** Raw frames out. The session encodes `ServerMessage`s itself. */
export type ServerConnection = {
  send(frame: Uint8Array): void;
  close(): void;
};

type Page = Extract<ServerMessage, { t: "page" }>;
type Live = { readonly session: ServerSession; readonly member: TokenId; subscribed: boolean };

/** Live sessions per space, for fan-out after a commit and cut-off after a removal. In memory, per server process. */
export class SubscriptionHub {
  private readonly spaces = new Map<string, Set<Live>>();

  /** Called on `authOk`. Returns the way to leave. */
  join(space: Uint8Array, member: TokenId, session: ServerSession): () => void {
    const k = toBase64url(space);
    const live: Live = { session, member, subscribed: false };
    let set = this.spaces.get(k);
    if (!set) this.spaces.set(k, (set = new Set()));
    set.add(live);
    return () => {
      set.delete(live);
      if (set.size === 0 && this.spaces.get(k) === set) this.spaces.delete(k);
    };
  }

  subscribe(space: Uint8Array, session: ServerSession): void {
    for (const live of this.spaces.get(toBase64url(space)) ?? []) if (live.session === session) live.subscribed = true;
  }

  /** Sends `page` to every subscribed session of the space except `except`. */
  publish(space: Uint8Array, page: Page, except: ServerSession): void {
    for (const live of this.spaces.get(toBase64url(space)) ?? []) {
      if (live.subscribed && live.session !== except) live.session.send(page);
    }
  }

  /** Sends `denied removed` to every live session of `member` in `space` and drops them. */
  revoke(space: Uint8Array, member: TokenId): void {
    for (const live of [...(this.spaces.get(toBase64url(space)) ?? [])]) {
      if (equalBytes(live.member, member)) live.session.cut(space);
    }
  }
}

const isForeign = (space: SpaceBytes, id: Uint8Array): boolean => !equalBytes(id.subarray(0, 8), space.subarray(0, 8));
const sealedSize = (s: { nonce: Uint8Array; body: Uint8Array }) => s.nonce.length + s.body.length;
const canWrite = (role: Role) => role !== "reader";

export class ServerSession {
  private client: ClientId | undefined;
  private readonly spaces = new Map<string, { member: TokenId; leave: () => void }>();

  constructor(
    private readonly store: ServerStore,
    private readonly connection: ServerConnection,
    private readonly hub: SubscriptionHub,
  ) {}

  /** Decodes one frame. A frame that does not decode closes the connection. */
  receiveFrame(frame: Uint8Array): void {
    let message: ClientMessage;
    try {
      message = decodeClientMessage(frame);
    } catch {
      this.connection.close();
      return;
    }
    void this.receive(message).catch(() => this.connection.close());
  }

  /** Requests of one connection reach `withSpace` in arrival order, because nothing awaits before it. */
  receive(m: ClientMessage): Promise<void> {
    if (m.t === "hello") {
      this.client = m.client;
      return Promise.resolve();
    }
    if (!this.client) {
      this.connection.close();
      return Promise.resolve();
    }
    return this.store.withSpace(m.space, (txn) => this.handle(m, txn));
  }

  closed(): void {
    for (const s of this.spaces.values()) s.leave();
    this.spaces.clear();
  }

  send(message: ServerMessage): void {
    this.connection.send(encodeServerMessage(message));
  }

  /** The hub removed this session's member. */
  cut(space: Uint8Array): void {
    const k = toBase64url(space);
    this.spaces.get(k)?.leave();
    this.spaces.delete(k);
    this.send({ t: "denied", space: space as SpaceBytes, reason: "removed", incarnation: this.store.incarnation });
  }

  private denied(space: SpaceBytes, reason: "unknown-space" | "not-a-member" | "removed") {
    this.send({ t: "denied", space, reason, incarnation: this.store.incarnation });
  }

  /** The authenticated member's id and current role, or undefined after sending `denied`. */
  private who(space: SpaceBytes, txn: SpaceTxn): { id: TokenId; role: Role } | undefined {
    const entry = this.spaces.get(toBase64url(space));
    if (!entry) return void this.denied(space, txn.exists() ? "not-a-member" : "unknown-space");
    const member = txn.member(entry.member);
    if (!member) {
      this.cut(space);
      return undefined;
    }
    return { id: entry.member, role: member.role };
  }

  private async handle(m: Exclude<ClientMessage, { t: "hello" }>, txn: SpaceTxn): Promise<void> {
    const { space } = m;
    switch (m.t) {
      case "auth": {
        if (!txn.exists()) return this.denied(space, "unknown-space");
        const id = await tokenId(m.token);
        const member = txn.member(id);
        if (!member) return this.denied(space, "not-a-member");
        const k = toBase64url(space);
        this.spaces.get(k)?.leave();
        this.spaces.set(k, { member: id, leave: this.hub.join(space, id, this) });
        return this.send({ t: "authOk", space, role: member.role, incarnation: this.store.incarnation, head: txn.head(), check: txn.check() });
      }
      case "create": {
        const id = await tokenId(m.token);
        if (!txn.exists()) {
          await txn.create(id, m.check, m.personal);
          return this.send({ t: "ok", space, req: m.req });
        }
        const retry = txn.member(id)?.role === "admin" && equalBytes(txn.check(), m.check);
        return this.send(retry ? { t: "ok", space, req: m.req } : { t: "refused", space, req: m.req, reason: "exists" });
      }
      case "join": {
        const refuse = (reason: "unknown-space" | "unknown-invite" | "personal") => this.send({ t: "refused", space, req: m.req, reason });
        if (!txn.exists()) return refuse("unknown-space");
        if (txn.personal()) return refuse("personal");
        const inviteId = await tokenId(m.inviteToken);
        const invite = txn.invite(inviteId);
        const memberId = await tokenId(m.memberToken);
        if (!invite || (invite.usedBy && !equalBytes(invite.usedBy, memberId))) return refuse("unknown-invite");
        const existing = txn.member(memberId);
        if (!existing) {
          await txn.setMember(memberId, { role: invite.role, via: inviteId });
          if (invite.uses === "once") await txn.setInvite(inviteId, { ...invite, usedBy: memberId });
        }
        return this.send({ t: "joined", space, req: m.req, role: existing?.role ?? invite.role, wrappedKey: invite.wrappedKey, check: txn.check() });
      }
      case "pull":
      case "subscribe": {
        const me = this.who(space, txn);
        if (!me) return;
        if (m.t === "subscribe") this.hub.subscribe(space, this);
        const maxBytes = m.t === "pull" ? Math.min(m.maxBytes, Limits.pageBytes) : Limits.pageBytes;
        let after = m.after;
        do {
          const page = await txn.pull(after, maxBytes, Limits.pageItems);
          this.send({ t: "page", space, after, through: page.through, items: page.items, more: page.more });
          after = page.through;
          if (!page.more) break;
        } while (m.t === "subscribe");
        return;
      }
      case "push":
        return this.push(m, txn);
      case "blobPut":
        return this.blobPut(m, txn);
      case "blobGet": {
        if (!this.who(space, txn)) return;
        const body = await txn.blobChunk(m.file, m.chunk);
        return this.send({ t: "blobChunk", space, req: m.req, body: body ?? null });
      }
      default:
        return this.admin(m, txn);
    }
  }

  private async admin(
    m: Extract<ClientMessage, { t: "invite" | "revokeInvite" | "setRole" | "remove" | "leave" | "members" }>,
    txn: SpaceTxn,
  ): Promise<void> {
    const { space, req } = m;
    const me = this.who(space, txn);
    if (!me) return;
    const ok = () => this.send({ t: "ok", space, req });
    const refuse = (reason: "not-authorized" | "last-admin" | "personal") => this.send({ t: "refused", space, req, reason });
    const admins = txn.members().filter((x) => x.role === "admin");
    const lastAdmin = (id: TokenId) => admins.length === 1 && equalBytes(admins[0]!.id, id);

    if (m.t === "members") {
      return this.send({
        t: "memberList",
        space,
        req,
        members: txn.members().map((x) => ({ id: x.id, role: x.role })),
        invites: txn.invites().map((x) => ({ id: x.id, role: x.role, uses: x.uses })),
      });
    }

    if (m.t === "leave" || m.t === "remove") {
      const target = m.t === "leave" ? me.id : m.member;
      if (m.t === "remove" && me.role !== "admin" && !equalBytes(target, me.id)) return refuse("not-authorized");
      const stored = txn.member(target);
      if (stored) {
        if (stored.role === "admin" && lastAdmin(target)) return refuse("last-admin");
        await txn.setMember(target, undefined);
        for (const inv of txn.invites()) {
          if (equalBytes(inv.createdBy, target) || (stored.via && equalBytes(inv.id, stored.via))) await txn.setInvite(inv.id, undefined);
        }
      }
      ok();
      if (stored) this.hub.revoke(space, target);
      return;
    }

    if (me.role !== "admin") return refuse("not-authorized");
    switch (m.t) {
      case "invite": {
        if (txn.personal()) return refuse("personal");
        const old = txn.invite(m.invite);
        await txn.setInvite(m.invite, {
          role: m.role,
          uses: m.uses,
          wrappedKey: m.wrappedKey,
          createdBy: me.id,
          ...(old?.usedBy && { usedBy: old.usedBy }),
        });
        return ok();
      }
      case "revokeInvite":
        await txn.setInvite(m.invite, undefined);
        return ok();
      case "setRole": {
        if (txn.personal()) return refuse("personal");
        const stored = txn.member(m.member);
        if (stored?.role === "admin" && m.role !== "admin" && lastAdmin(m.member)) return refuse("last-admin");
        await txn.setMember(m.member, { ...stored, role: m.role });
        return ok();
      }
    }
  }

  private async push(m: Extract<ClientMessage, { t: "push" }>, txn: SpaceTxn): Promise<void> {
    const { space, req } = m;
    const me = this.who(space, txn);
    if (!me) return;
    const reject = (reason: "not-a-writer" | "too-large" | "foreign-id") => this.send({ t: "pushRejected", space, req, reason });
    if (!canWrite(me.role)) return reject("not-a-writer");
    if (m.items.some((it) => isForeign(space, it.id))) return reject("foreign-id");
    if (m.items.length > Limits.pushItems || m.items.reduce((n, it) => n + sealedSize(it.sealed), 0) > Limits.pushBytes) {
      return reject("too-large");
    }

    const head = txn.head();
    const rev = (head + 1) as ServerRev;
    const origin = this.client!;
    const pending = new Map<string, Envelope>();
    const puts: Envelope[] = [];
    const writes: Write[] = [];
    const accepted: RecordKeyId[] = [];
    const conflicts: Envelope[] = [];
    const currentOf = async (id: RecordKeyId) => pending.get(toBase64url(id)) ?? (await txn.current(id));
    const put = (item: Envelope) => {
      puts.push(item);
      writes.push({ kind: "put", item });
      if (item.kind === "record" || item.kind === "tomb") pending.set(toBase64url(item.id), item);
    };

    for (const it of m.items as readonly PushItem[]) {
      const cur = await currentOf(it.id);
      if (it.kind === "tomb") {
        if (cur?.kind !== "tomb") {
          put({ kind: "tomb", id: it.id, rev, sealed: it.sealed });
          writes.push({ kind: "dropRecordData", id: it.id });
        }
      } else if (cur?.kind === "tomb" || (it.kind === "record" && cur && cur.rev !== it.base)) {
        conflicts.push(cur!);
        continue;
      } else if (it.kind === "record") put({ kind: "record", id: it.id, rev, sealed: it.sealed });
      else if (it.kind === "richText") put({ kind: "richText", id: it.id, field: it.field, rev, sealed: it.sealed, origin });
      else {
        put({ kind: "richTextState", id: it.id, field: it.field, covers: it.covers, rev, sealed: it.sealed, origin });
        writes.push({ kind: "dropRichText", id: it.id, field: it.field, covers: Math.min(it.covers, head) as ServerRev });
      }
      accepted.push(it.id);
    }

    if (puts.length > 0) await txn.commit(rev, writes);
    this.send({ t: "pushResult", space, req, rev: puts.length > 0 ? rev : (head as ServerRev), accepted, conflicts });
    if (puts.length > 0) {
      this.hub.publish(space, { t: "page", space, after: head as ServerRev, through: rev, items: puts, more: false }, this);
    }
  }

  private async blobPut(m: Extract<ClientMessage, { t: "blobPut" }>, txn: SpaceTxn): Promise<void> {
    const { space, req } = m;
    const me = this.who(space, txn);
    if (!me) return;
    const reject = (reason: "not-a-writer" | "too-large" | "foreign-id") => this.send({ t: "pushRejected", space, req, reason });
    if (!canWrite(me.role)) return reject("not-a-writer");
    if (isForeign(space, m.file) || isForeign(space, m.owner)) return reject("foreign-id");
    const maxChunks = Math.ceil(Limits.fileBytes / Limits.chunkBytes);
    if (m.chunks === 0 || m.chunks > maxChunks || m.chunk >= m.chunks || m.body.length > Limits.chunkBytes + 16) return reject("too-large");
    if ((await txn.current(m.owner))?.kind === "tomb") return this.send({ t: "blobAck", space, req, gone: true });
    const stored = await txn.blob(m.file);
    if (stored && (!equalBytes(stored.owner, m.owner) || stored.chunks !== m.chunks)) return reject("foreign-id");
    const prior = await txn.blobChunk(m.file, m.chunk);
    if (prior && !equalBytes(prior, m.body)) return reject("foreign-id");
    if (!prior) await txn.blobPut(m.file, m.owner, m.chunks, m.chunk, m.body);
    return this.send({ t: "blobAck", space, req, gone: false });
  }
}
