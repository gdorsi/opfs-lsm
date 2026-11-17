import { describe, expect, it } from "vitest";
import { equalBytes } from "../src/bytes.js";
import type { FileKeyId, RecordKeyId, SpaceBytes } from "../src/ids.js";
import { createSpacesServer, MemoryServerStore } from "../src/server/index.js";
import type { Bytes32, Sealed, TokenId } from "../src/space/crypto.js";
import { inviteKeys, keyCheck, randomKey, randomToken, tokenId } from "../src/space/crypto.js";
import type { FieldHash as FieldHashLike } from "../src/local/keys.js";
import type { ClientId, ClientMessage, Envelope, Role, ServerMessage, ServerRev } from "../src/sync/protocol.js";
import { decodeServerMessage, encodeClientMessage, Limits } from "../src/sync/protocol.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const sealed = (n = 8): Sealed => ({ nonce: rnd(12), body: rnd(16 + n) });

function world() {
  const store = new MemoryServerStore();
  const server = createSpacesServer({ store });
  const conn = () => {
    const frames: ServerMessage[] = [];
    let closed = false;
    const handle = server.accept({
      send: (f) => frames.push(decodeServerMessage(f)),
      close: () => {
        closed = true;
      },
    });
    handle.receive(encodeClientMessage({ t: "hello", protocol: 1, client: rnd(16) as ClientId }));
    return {
      frames,
      get closed() {
        return closed;
      },
      handle,
      /** Sends one message and returns what came back. */
      async call(m: ClientMessage): Promise<ServerMessage[]> {
        const from = frames.length;
        handle.receive(encodeClientMessage(m));
        for (let i = 0; i < 2000 && frames.length === from; i++) await new Promise((r) => setTimeout(r, 1));
        await flush();
        return frames.slice(from);
      },
    };
  };
  return { store, conn };
}
type Conn = ReturnType<ReturnType<typeof world>["conn"]>;

const one = <T extends ServerMessage["t"]>(msgs: ServerMessage[], t: T) => {
  const m = msgs.find((x) => x.t === t);
  if (!m) throw new Error(`no ${t} in ${msgs.map((x) => x.t).join(",")}`);
  return m as Extract<ServerMessage, { t: T }>;
};
const refusal = (msgs: ServerMessage[]) => (msgs[0] as { reason?: string }).reason ?? msgs[0]?.t;

let n = 0;
/** A space created by its admin, who is authenticated on `conn`. */
async function setup(w: ReturnType<typeof world>, opts: { personal?: boolean } = {}) {
  const space = rnd(16) as SpaceBytes;
  const key = randomKey();
  const check = await keyCheck(key);
  const token = randomToken();
  const conn = w.conn();
  const created = await conn.call({ t: "create", space, req: ++n, token, check, personal: opts.personal ?? false });
  const authed = await conn.call({ t: "auth", space, token });
  return { space, key, check, token, id: await tokenId(token), conn, created, authed };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Invites with `role`, then joins on a fresh connection. */
async function addMember(w: ReturnType<typeof world>, s: Setup, role: Role, uses: "once" | "many" = "once") {
  const secret = rnd(16);
  const keys = await inviteKeys(secret);
  const invite = await tokenId(keys.token);
  await s.conn.call({ t: "invite", space: s.space, req: ++n, invite, role, uses, wrappedKey: sealed(32) });
  return { keys, invite, ...(await join(w, s, keys.token)) };
}
async function join(w: ReturnType<typeof world>, s: Setup, inviteToken: Bytes32) {
  const token = randomToken();
  const conn = w.conn();
  const joined = await conn.call({ t: "join", space: s.space, req: ++n, inviteToken, memberToken: token });
  const authed = await conn.call({ t: "auth", space: s.space, token });
  return { token, id: await tokenId(token), conn, joined, authed };
}

const rid = (s: Setup): RecordKeyId => new Uint8Array([...s.space.subarray(0, 8), ...rnd(8)]) as RecordKeyId;
const pushRecord = (s: Setup, conn: Conn, id: RecordKeyId, base: number) =>
  conn.call({ t: "push", space: s.space, req: ++n, items: [{ kind: "record", id, base: base as ServerRev, sealed: sealed() }] });

describe("create", () => {
  it("makes the space and its admin, and a retry by the same admin is ok", async () => {
    const w = world();
    const s = await setup(w);
    expect(s.created[0]).toMatchObject({ t: "ok" });
    expect(one(s.authed, "authOk")).toMatchObject({ role: "admin", head: 0 });
    expect(equalBytes(one(s.authed, "authOk").check, s.check)).toBe(true);
    expect(equalBytes(one(s.authed, "authOk").incarnation, w.store.incarnation)).toBe(true);
    const again = await w.conn().call({ t: "create", space: s.space, req: 1, token: s.token, check: s.check, personal: false });
    expect(again[0]).toMatchObject({ t: "ok" });
  });

  it("refuses a space that exists for anyone else or another check", async () => {
    const w = world();
    const s = await setup(w);
    const stranger = await w.conn().call({ t: "create", space: s.space, req: 1, token: randomToken(), check: s.check, personal: false });
    expect(refusal(stranger)).toBe("exists");
    const wrongCheck = await w.conn().call({ t: "create", space: s.space, req: 1, token: s.token, check: await keyCheck(randomKey()), personal: false });
    expect(refusal(wrongCheck)).toBe("exists");
  });

  it("denied carries the incarnation, for an unknown space and a stranger", async () => {
    const w = world();
    const s = await setup(w);
    const unknown = await w.conn().call({ t: "auth", space: rnd(16) as SpaceBytes, token: randomToken() });
    expect(one(unknown, "denied")).toMatchObject({ reason: "unknown-space" });
    expect(equalBytes(one(unknown, "denied").incarnation, w.store.incarnation)).toBe(true);
    const stranger = await w.conn().call({ t: "auth", space: s.space, token: randomToken() });
    expect(one(stranger, "denied")).toMatchObject({ reason: "not-a-member" });
    expect(equalBytes(one(stranger, "denied").incarnation, w.store.incarnation)).toBe(true);
  });

  it("ignores everything before hello and closes on a bad frame", async () => {
    const w = world();
    const server = createSpacesServer({ store: w.store });
    let closed = 0;
    const raw = server.accept({ send: () => undefined, close: () => closed++ });
    raw.receive(encodeClientMessage({ t: "members", space: rnd(16) as SpaceBytes, req: 1 }));
    await flush();
    raw.receive(new Uint8Array([255]));
    await flush();
    expect(closed).toBe(2);
  });
});

describe("join", () => {
  it("is a retry after a lost reply, and a used once-invite answers only its user", async () => {
    const w = world();
    const s = await setup(w);
    const m = await addMember(w, s, "writer");
    expect(one(m.joined, "joined")).toMatchObject({ role: "writer" });
    expect(equalBytes(one(m.joined, "joined").check, s.check)).toBe(true);
    const again = await w.conn().call({ t: "join", space: s.space, req: 9, inviteToken: m.keys.token, memberToken: m.token });
    expect(one(again, "joined")).toMatchObject({ role: "writer" });
    const second = await w.conn().call({ t: "join", space: s.space, req: 9, inviteToken: m.keys.token, memberToken: randomToken() });
    expect(refusal(second)).toBe("unknown-invite");
    const members = await s.conn.call({ t: "members", space: s.space, req: 1 });
    expect(one(members, "memberList").members).toHaveLength(2);
  });

  it("a many-invite admits several members with its role", async () => {
    const w = world();
    const s = await setup(w);
    const a = await addMember(w, s, "reader", "many");
    const b = await join(w, s, a.keys.token);
    expect(one(b.joined, "joined")).toMatchObject({ role: "reader" });
    expect(one(b.authed, "authOk")).toMatchObject({ role: "reader" });
    const list = one(await s.conn.call({ t: "members", space: s.space, req: 1 }), "memberList");
    expect(list.members).toHaveLength(3);
    expect(list.invites).toEqual([expect.objectContaining({ role: "reader", uses: "many" })]);
  });

  it("refuses an unknown invite and an unknown space", async () => {
    const w = world();
    const s = await setup(w);
    const bad = await w.conn().call({ t: "join", space: s.space, req: 1, inviteToken: randomToken(), memberToken: randomToken() });
    expect(refusal(bad)).toBe("unknown-invite");
    const none = await w.conn().call({ t: "join", space: rnd(16) as SpaceBytes, req: 1, inviteToken: randomToken(), memberToken: randomToken() });
    expect(refusal(none)).toBe("unknown-space");
  });

  it("only an admin invites and revokes, and a revoked invite is gone", async () => {
    const w = world();
    const s = await setup(w);
    const writer = await addMember(w, s, "writer", "many");
    const denied = await writer.conn.call({ t: "invite", space: s.space, req: 1, invite: rnd(16) as TokenId, role: "reader", uses: "once", wrappedKey: sealed(32) });
    expect(refusal(denied)).toBe("not-authorized");
    expect(refusal(await writer.conn.call({ t: "revokeInvite", space: s.space, req: 2, invite: writer.invite }))).toBe("not-authorized");
    expect((await s.conn.call({ t: "revokeInvite", space: s.space, req: 3, invite: writer.invite }))[0]).toMatchObject({ t: "ok" });
    const late = await w.conn().call({ t: "join", space: s.space, req: 4, inviteToken: writer.keys.token, memberToken: randomToken() });
    expect(refusal(late)).toBe("unknown-invite");
  });
});

describe("remove", () => {
  it("revokes the invites the member created and came through, and cuts its session off", async () => {
    const w = world();
    const s = await setup(w);
    const bob = await addMember(w, s, "admin", "many");
    // bob, an admin, makes an invite of his own
    const keys = await inviteKeys(rnd(16));
    const bobInvite = await tokenId(keys.token);
    await bob.conn.call({ t: "invite", space: s.space, req: 1, invite: bobInvite, role: "writer", uses: "many", wrappedKey: sealed(32) });
    const other = await addMember(w, s, "writer", "many");
    await bob.conn.call({ t: "subscribe", space: s.space, after: 0 as ServerRev });

    const before = bob.conn.frames.length;
    const res = await s.conn.call({ t: "remove", space: s.space, req: 2, member: bob.id });
    expect(res[0]).toMatchObject({ t: "ok" });
    expect(bob.conn.frames.slice(before)).toEqual([expect.objectContaining({ t: "denied", reason: "removed" })]);

    // bob's invite and the one he joined through are gone; an unrelated one stays
    expect(refusal(await w.conn().call({ t: "join", space: s.space, req: 3, inviteToken: keys.token, memberToken: randomToken() }))).toBe("unknown-invite");
    expect(refusal(await w.conn().call({ t: "join", space: s.space, req: 4, inviteToken: bob.keys.token, memberToken: bob.token }))).toBe("unknown-invite");
    expect(refusal(await w.conn().call({ t: "join", space: s.space, req: 5, inviteToken: other.keys.token, memberToken: randomToken() }))).toBe("joined");

    // his next requests go nowhere
    expect(one(await bob.conn.call({ t: "pull", space: s.space, after: 0 as ServerRev, maxBytes: 1000 }), "denied")).toMatchObject({ reason: "not-a-member" });
    expect(one(await pushRecord(s, bob.conn, rid(s), 0), "denied")).toMatchObject({ reason: "not-a-member" });
    expect(one(await w.conn().call({ t: "auth", space: s.space, token: bob.token }), "denied")).toMatchObject({ reason: "not-a-member" });
  });

  it("removing a non-member is ok, and only an admin removes others", async () => {
    const w = world();
    const s = await setup(w);
    const writer = await addMember(w, s, "writer");
    expect((await s.conn.call({ t: "remove", space: s.space, req: 1, member: rnd(16) as TokenId }))[0]).toMatchObject({ t: "ok" });
    expect(refusal(await writer.conn.call({ t: "remove", space: s.space, req: 2, member: s.id }))).toBe("not-authorized");
  });
});

describe("last admin", () => {
  it("cannot be removed, demoted or leave, until another admin exists", async () => {
    const w = world();
    const s = await setup(w);
    expect(refusal(await s.conn.call({ t: "remove", space: s.space, req: 1, member: s.id }))).toBe("last-admin");
    expect(refusal(await s.conn.call({ t: "leave", space: s.space, req: 2 }))).toBe("last-admin");
    expect(refusal(await s.conn.call({ t: "setRole", space: s.space, req: 3, member: s.id, role: "reader" }))).toBe("last-admin");
    const bob = await addMember(w, s, "admin");
    expect((await s.conn.call({ t: "setRole", space: s.space, req: 4, member: s.id, role: "writer" }))[0]).toMatchObject({ t: "ok" });
    expect(refusal(await bob.conn.call({ t: "leave", space: s.space, req: 5 }))).toBe("last-admin");
    expect((await s.conn.call({ t: "leave", space: s.space, req: 6 }))[0]).toMatchObject({ t: "ok" });
  });

  it("setRole adds a non-member with that role", async () => {
    const w = world();
    const s = await setup(w);
    const ghost = await tokenId(randomToken());
    expect((await s.conn.call({ t: "setRole", space: s.space, req: 1, member: ghost, role: "writer" }))[0]).toMatchObject({ t: "ok" });
    const list = one(await s.conn.call({ t: "members", space: s.space, req: 2 }), "memberList");
    expect(list.members.find((m) => equalBytes(m.id, ghost))?.role).toBe("writer");
  });
});

describe("personal space", () => {
  it("refuses invites, joins and new members", async () => {
    const w = world();
    const s = await setup(w, { personal: true });
    const keys = await inviteKeys(rnd(16));
    const invite = await tokenId(keys.token);
    expect(refusal(await s.conn.call({ t: "invite", space: s.space, req: 1, invite, role: "reader", uses: "once", wrappedKey: sealed(32) }))).toBe("personal");
    expect(refusal(await w.conn().call({ t: "join", space: s.space, req: 2, inviteToken: keys.token, memberToken: randomToken() }))).toBe("personal");
    expect(refusal(await s.conn.call({ t: "setRole", space: s.space, req: 3, member: await tokenId(randomToken()), role: "writer" }))).toBe("personal");
  });
});

describe("push", () => {
  it("a stale base returns the current item and a right base replaces it", async () => {
    const w = world();
    const s = await setup(w);
    const id = rid(s);
    const first = one(await pushRecord(s, s.conn, id, 0), "pushResult");
    expect(first).toMatchObject({ rev: 1, conflicts: [] });
    expect(first.accepted).toHaveLength(1);
    const stale = one(await pushRecord(s, s.conn, id, 0), "pushResult");
    expect(stale.accepted).toHaveLength(0);
    expect(stale.conflicts).toEqual([expect.objectContaining({ kind: "record", rev: 1 })]);
    expect(stale.rev).toBe(1);
    const next = one(await pushRecord(s, s.conn, id, 1), "pushResult");
    expect(next).toMatchObject({ rev: 2, conflicts: [] });
    const page = one(await s.conn.call({ t: "pull", space: s.space, after: 0 as ServerRev, maxBytes: 1 << 20 }), "page");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ rev: 2 });
    expect(page).toMatchObject({ through: 2, more: false });
  });

  it("a record push after a tombstone gets the tombstone, for record, richText and richTextState", async () => {
    const w = world();
    const s = await setup(w);
    const id = rid(s);
    await pushRecord(s, s.conn, id, 0);
    await s.conn.call({ t: "push", space: s.space, req: 1, items: [{ kind: "tomb", id, sealed: sealed() }] });
    const items = [
      { kind: "record" as const, id, base: 1 as ServerRev, sealed: sealed() },
      { kind: "richText" as const, id, field: 1 as never as FieldHashLike, sealed: sealed() },
      { kind: "richTextState" as const, id, field: 1 as never as FieldHashLike, covers: 1 as ServerRev, sealed: sealed() },
    ];
    const res = one(await s.conn.call({ t: "push", space: s.space, req: 2, items }), "pushResult");
    expect(res.accepted).toHaveLength(0);
    expect(res.conflicts.map((c) => c.kind)).toEqual(["tomb", "tomb", "tomb"]);
    expect(res.rev).toBe(2);
    const again = one(await s.conn.call({ t: "push", space: s.space, req: 3, items: [{ kind: "tomb", id, sealed: sealed() }] }), "pushResult");
    expect(again).toMatchObject({ rev: 2, conflicts: [] });
  });

  it("a tombstone drops the record's rich text and blobs", async () => {
    const w = world();
    const s = await setup(w);
    const id = rid(s);
    const file = new Uint8Array([...s.space.subarray(0, 8), ...rnd(8)]) as FileKeyId;
    await s.conn.call({ t: "push", space: s.space, req: 1, items: [{ kind: "record", id, base: 0 as ServerRev, sealed: sealed() }, { kind: "richText", id, field: 7 as never as FieldHashLike, sealed: sealed() }] });
    const body = rnd(40);
    expect(one(await s.conn.call({ t: "blobPut", space: s.space, req: 2, file, owner: id, chunk: 0, chunks: 1, body }), "blobAck")).toMatchObject({ gone: false });
    expect(one(await s.conn.call({ t: "blobGet", space: s.space, req: 3, file, chunk: 0 }), "blobChunk").body).toEqual(body);
    await s.conn.call({ t: "push", space: s.space, req: 4, items: [{ kind: "tomb", id, sealed: sealed() }] });
    const page = one(await s.conn.call({ t: "pull", space: s.space, after: 0 as ServerRev, maxBytes: 1 << 20 }), "page");
    expect(page.items.map((i) => i.kind)).toEqual(["tomb"]);
    expect(one(await s.conn.call({ t: "blobGet", space: s.space, req: 5, file, chunk: 0 }), "blobChunk").body).toBeNull();
    expect(one(await s.conn.call({ t: "blobPut", space: s.space, req: 6, file, owner: id, chunk: 0, chunks: 1, body }), "blobAck")).toMatchObject({ gone: true });
  });

  it("a richTextState replaces the updates it covers and keeps newer ones", async () => {
    const w = world();
    const s = await setup(w);
    const id = rid(s);
    const f = 3 as never as FieldHashLike;
    const text = (n: number) => s.conn.call({ t: "push", space: s.space, req: ++n, items: [{ kind: "richText", id, field: f, sealed: sealed(n + 1) }] });
    await text(1);
    await text(2);
    await text(3);
    await s.conn.call({ t: "push", space: s.space, req: 9, items: [{ kind: "richTextState", id, field: f, covers: 2 as ServerRev, sealed: sealed(50) }] });
    const page = one(await s.conn.call({ t: "pull", space: s.space, after: 0 as ServerRev, maxBytes: 1 << 20 }), "page");
    expect(page.items.map((i) => [i.kind, i.rev])).toEqual([["richText", 3], ["richTextState", 4]]);
  });

  it("refuses the whole push for a foreign id, a reader, and too many items or bytes", async () => {
    const w = world();
    const s = await setup(w);
    const good = rid(s);
    const foreign = rnd(16) as RecordKeyId;
    const item = (id: RecordKeyId) => ({ kind: "record" as const, id, base: 0 as ServerRev, sealed: sealed() });
    const res = await s.conn.call({ t: "push", space: s.space, req: 1, items: [item(good), item(foreign)] });
    expect(res[0]).toMatchObject({ t: "pushRejected", reason: "foreign-id" });
    const many = Array.from({ length: Limits.pushItems + 1 }, () => item(rid(s)));
    expect((await s.conn.call({ t: "push", space: s.space, req: 2, items: many }))[0]).toMatchObject({ reason: "too-large" });
    const big = [1, 2].map(() => ({ kind: "record" as const, id: rid(s), base: 0 as ServerRev, sealed: { nonce: rnd(12), body: new Uint8Array(Limits.pushBytes / 2 + 1) } }));
    expect((await s.conn.call({ t: "push", space: s.space, req: 3, items: big }))[0]).toMatchObject({ reason: "too-large" });
    const reader = await addMember(w, s, "reader");
    expect((await reader.conn.call({ t: "push", space: s.space, req: 4, items: [item(rid(s))] }))[0]).toMatchObject({ reason: "not-a-writer" });
    const page = one(await s.conn.call({ t: "pull", space: s.space, after: 0 as ServerRev, maxBytes: 1 << 20 }), "page");
    expect(page.items).toHaveLength(0);
    expect(page.through).toBe(0);
  });

  it("blobPut refuses foreign ids, another owner, and rewritten chunks", async () => {
    const w = world();
    const s = await setup(w);
    const mine = () => new Uint8Array([...s.space.subarray(0, 8), ...rnd(8)]);
    const file = mine() as FileKeyId;
    const owner = rid(s);
    const put = (over: Partial<Extract<ClientMessage, { t: "blobPut" }>>) =>
      s.conn.call({ t: "blobPut", space: s.space, req: ++n, file, owner, chunk: 0, chunks: 2, body: new Uint8Array([1, 2, 3]), ...over });
    expect((await put({ file: rnd(16) as FileKeyId }))[0]).toMatchObject({ reason: "foreign-id" });
    expect((await put({ owner: rnd(16) as RecordKeyId }))[0]).toMatchObject({ reason: "foreign-id" });
    expect((await put({}))[0]).toMatchObject({ t: "blobAck", gone: false });
    expect((await put({}))[0]).toMatchObject({ t: "blobAck", gone: false });
    expect((await put({ body: new Uint8Array([9]) }))[0]).toMatchObject({ reason: "foreign-id" });
    expect((await put({ owner: rid(s), chunk: 1 }))[0]).toMatchObject({ reason: "foreign-id" });
    expect((await put({ chunk: 2 }))[0]).toMatchObject({ reason: "too-large" });
  });
});

describe("pull", () => {
  it("never splits a commit and always returns at least one", async () => {
    const w = world();
    const s = await setup(w);
    const mkItems = (k: number) => Array.from({ length: k }, () => ({ kind: "record" as const, id: rid(s), base: 0 as ServerRev, sealed: sealed(1000) }));
    await s.conn.call({ t: "push", space: s.space, req: 1, items: mkItems(3) });
    await s.conn.call({ t: "push", space: s.space, req: 2, items: mkItems(2) });
    const tiny = one(await s.conn.call({ t: "pull", space: s.space, after: 0 as ServerRev, maxBytes: 1 }), "page");
    expect(tiny.items).toHaveLength(3);
    expect(tiny).toMatchObject({ through: 1, more: true });
    const rest = one(await s.conn.call({ t: "pull", space: s.space, after: tiny.through, maxBytes: 1 }), "page");
    expect(rest.items).toHaveLength(2);
    expect(rest).toMatchObject({ through: 2, more: false });
    const both = one(await s.conn.call({ t: "pull", space: s.space, after: 0 as ServerRev, maxBytes: 1 << 20 }), "page");
    expect(both.items).toHaveLength(5);
  });

  it("caps a page at pageItems and keeps paging", async () => {
    const w = world();
    const s = await setup(w);
    const commits = Math.ceil((Limits.pageItems + 50) / Limits.pushItems);
    let total = 0;
    for (let c = 0; c < commits; c++) {
      const items = Array.from({ length: Limits.pushItems }, () => ({ kind: "record" as const, id: rid(s), base: 0 as ServerRev, sealed: sealed(1) }));
      total += items.length;
      await s.conn.call({ t: "push", space: s.space, req: ++n, items });
    }
    const first = one(await s.conn.call({ t: "pull", space: s.space, after: 0 as ServerRev, maxBytes: 1 << 30 }), "page");
    expect(first.items.length).toBeLessThanOrEqual(Limits.pageItems);
    expect(first.more).toBe(true);
    const second = one(await s.conn.call({ t: "pull", space: s.space, after: first.through, maxBytes: 1 << 30 }), "page");
    expect(first.items.length + second.items.length).toBe(total);
    expect(second.more).toBe(false);
  });
});

describe("subscribe", () => {
  it("fans a commit out to the other subscriber only, with the pusher's origin on rich text", async () => {
    const w = world();
    const s = await setup(w);
    const bob = await addMember(w, s, "writer");
    await s.conn.call({ t: "subscribe", space: s.space, after: 0 as ServerRev });
    await bob.conn.call({ t: "subscribe", space: s.space, after: 0 as ServerRev });

    const id = rid(s);
    const aliceFrom = s.conn.frames.length;
    const bobFrom = bob.conn.frames.length;
    const res = await s.conn.call({
      t: "push",
      space: s.space,
      req: 1,
      items: [
        { kind: "record", id, base: 0 as ServerRev, sealed: sealed() },
        { kind: "richText", id, field: 1 as never as FieldHashLike, sealed: sealed() },
      ],
    });
    expect(res.map((m) => m.t)).toEqual(["pushResult"]);
    expect(s.conn.frames.slice(aliceFrom).map((m) => m.t)).toEqual(["pushResult"]);
    const pages = bob.conn.frames.slice(bobFrom);
    expect(pages).toHaveLength(1);
    const page = one(pages, "page");
    expect(page).toMatchObject({ after: 0, through: 1, more: false });
    expect(page.items.map((i) => i.kind)).toEqual(["record", "richText"]);
    const rich = page.items[1] as Extract<Envelope, { kind: "richText" }>;
    expect(rich.origin).toHaveLength(16);
    expect("origin" in page.items[0]!).toBe(false);
  });

  it("catches up from `after` before live pages, and a closed session gets none", async () => {
    const w = world();
    const s = await setup(w);
    await pushRecord(s, s.conn, rid(s), 0);
    const bob = await addMember(w, s, "reader");
    const caught = await bob.conn.call({ t: "subscribe", space: s.space, after: 0 as ServerRev });
    expect(one(caught, "page").items).toHaveLength(1);
    bob.conn.handle.closed();
    const from = bob.conn.frames.length;
    await pushRecord(s, s.conn, rid(s), 0);
    expect(bob.conn.frames.length).toBe(from);
  });
});
