import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { u32 } from "../src/bytes.js";
import { SpacesError } from "../src/errors.js";
import type { FileKeyId, RecordKeyId, SpaceBytes } from "../src/ids.js";
import type { FieldHash } from "../src/local/keys.js";
import type { Bytes32, KeyCheck, Sealed, TokenId } from "../src/space/crypto.js";
import type {
  ClientId,
  ClientMessage,
  Envelope,
  Incarnation,
  InviteUses,
  PushItem,
  RefusedReason,
  Role,
  ServerMessage,
  ServerRev,
} from "../src/sync/protocol.js";
import { decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage, Limits } from "../src/sync/protocol.js";

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });
const blob = (max = 300) => fc.uint8Array({ minLength: 0, maxLength: max });
const u32a = fc.integer({ min: 0, max: 0xffffffff });
const rev = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }).map((n) => n as ServerRev);
const field = u32a.map((n) => n as FieldHash);
const space = bytes(16).map((b) => b as SpaceBytes);
const rid = bytes(16).map((b) => b as RecordKeyId);
const fid = bytes(16).map((b) => b as FileKeyId);
const client = bytes(16).map((b) => b as ClientId);
const token = bytes(32).map((b) => b as Bytes32);
const check = bytes(8).map((b) => b as KeyCheck);
const tid = bytes(16).map((b) => b as TokenId);
const role = fc.constantFrom<Role>("admin", "writer", "reader");
const uses = fc.constantFrom<InviteUses>("once", "many");
const sealed: fc.Arbitrary<Sealed> = fc.record({ nonce: bytes(12), body: fc.uint8Array({ minLength: 16, maxLength: 200 }) });

const pushItem: fc.Arbitrary<PushItem> = fc.oneof(
  fc.record({ kind: fc.constant("record" as const), id: rid, base: rev, sealed }),
  fc.record({ kind: fc.constant("tomb" as const), id: rid, sealed }),
  fc.record({ kind: fc.constant("richText" as const), id: rid, field, sealed }),
  fc.record({ kind: fc.constant("richTextState" as const), id: rid, field, covers: rev, sealed }),
);

const envelope: fc.Arbitrary<Envelope> = fc.oneof(
  fc.record({ kind: fc.constant("record" as const), id: rid, rev, sealed }),
  fc.record({ kind: fc.constant("tomb" as const), id: rid, rev, sealed }),
  fc.record({ kind: fc.constant("richText" as const), id: rid, field, rev, sealed, origin: client }),
  fc.record({ kind: fc.constant("richTextState" as const), id: rid, field, covers: rev, rev, sealed, origin: client }),
);

const clientMessage: fc.Arbitrary<ClientMessage> = fc.oneof(
  fc.record({ t: fc.constant("hello" as const), protocol: fc.constant(1 as const), client }),
  fc.record({ t: fc.constant("auth" as const), space, token }),
  fc.record({ t: fc.constant("create" as const), space, req: u32a, token, check, personal: fc.boolean() }),
  fc.record({ t: fc.constant("join" as const), space, req: u32a, inviteToken: token, memberToken: token }),
  fc.record({ t: fc.constant("invite" as const), space, req: u32a, invite: tid, role, uses, wrappedKey: sealed }),
  fc.record({ t: fc.constant("revokeInvite" as const), space, req: u32a, invite: tid }),
  fc.record({ t: fc.constant("setRole" as const), space, req: u32a, member: tid, role }),
  fc.record({ t: fc.constant("remove" as const), space, req: u32a, member: tid }),
  fc.record({ t: fc.constant("leave" as const), space, req: u32a }),
  fc.record({ t: fc.constant("members" as const), space, req: u32a }),
  fc.record({ t: fc.constant("pull" as const), space, after: rev, maxBytes: u32a }),
  fc.record({ t: fc.constant("subscribe" as const), space, after: rev }),
  fc.record({ t: fc.constant("push" as const), space, req: u32a, items: fc.array(pushItem, { maxLength: 6 }) }),
  fc.record({ t: fc.constant("blobPut" as const), space, req: u32a, file: fid, owner: rid, chunk: u32a, chunks: u32a, body: blob(2000) }),
  fc.record({ t: fc.constant("blobGet" as const), space, req: u32a, file: fid, chunk: u32a }),
);

const serverMessage: fc.Arbitrary<ServerMessage> = fc.oneof(
  fc.record({ t: fc.constant("authOk" as const), space, role, incarnation: bytes(16).map((b) => b as Incarnation), head: rev, check }),
  fc.record({
    t: fc.constant("denied" as const),
    space,
    reason: fc.constantFrom("unknown-space", "not-a-member", "removed" as const),
    incarnation: bytes(16).map((b) => b as Incarnation),
  }),
  fc.record({ t: fc.constant("ok" as const), space, req: u32a }),
  fc.record({
    t: fc.constant("refused" as const),
    space,
    req: u32a,
    reason: fc.constantFrom<RefusedReason>(
      "exists",
      "unknown-space",
      "unknown-invite",
      "not-authorized",
      "last-admin",
      "personal",
      "already-member",
    ),
  }),
  fc.record({ t: fc.constant("joined" as const), space, req: u32a, role, wrappedKey: sealed, check }),
  fc.record({
    t: fc.constant("memberList" as const),
    space,
    req: u32a,
    members: fc.array(fc.record({ id: tid, role }), { maxLength: 5 }),
    invites: fc.array(fc.record({ id: tid, role, uses }), { maxLength: 5 }),
  }),
  fc.record({ t: fc.constant("page" as const), space, after: rev, through: rev, items: fc.array(envelope, { maxLength: 5 }), more: fc.boolean() }),
  fc.record({
    t: fc.constant("pushResult" as const),
    space,
    req: u32a,
    rev,
    accepted: fc.array(rid, { maxLength: 5 }),
    conflicts: fc.array(envelope, { maxLength: 4 }),
  }),
  fc.record({ t: fc.constant("pushRejected" as const), space, req: u32a, reason: fc.constantFrom("not-a-writer", "too-large", "foreign-id" as const) }),
  fc.record({ t: fc.constant("blobAck" as const), space, req: u32a, gone: fc.boolean() }),
  fc.record({ t: fc.constant("blobChunk" as const), space, req: u32a, body: fc.option(blob(500), { nil: null }) }),
);

/** Strips undefined and normalises Uint8Array views so toEqual compares content. */
const norm = <T,>(m: T): T => JSON.parse(JSON.stringify(m, (_k, v) => (v instanceof Uint8Array ? { b: Array.from(v) } : v)));

const isProtocolError = (e: unknown) => (e as { code?: string }).code === "protocol";
const decodesOrProtocolError = (decode: (b: Uint8Array) => unknown, input: Uint8Array) => {
  try {
    decode(input);
    return true;
  } catch (e) {
    return isProtocolError(e);
  }
};

describe("client messages", () => {
  it("round trip", () => {
    fc.assert(
      fc.property(clientMessage, (m) => {
        expect(norm(decodeClientMessage(encodeClientMessage(m)))).toEqual(norm(m));
      }),
      { numRuns: 300 },
    );
  });

  it("every strict prefix is refused", () => {
    fc.assert(
      fc.property(clientMessage, (m) => {
        const b = encodeClientMessage(m);
        for (let n = 0; n < b.length; n++) expect(() => decodeClientMessage(b.subarray(0, n))).toThrow(SpacesError);
      }),
      { numRuns: 60 },
    );
  });

  it("refuses trailing bytes, unknown tags and other protocol versions", () => {
    const hello = encodeClientMessage({ t: "hello", protocol: 1, client: new Uint8Array(16) as ClientId });
    expect(() => decodeClientMessage(new Uint8Array([...hello, 0]))).toThrow(SpacesError);
    expect(() => decodeClientMessage(new Uint8Array([0]))).toThrow(SpacesError);
    expect(() => decodeClientMessage(new Uint8Array([200]))).toThrow(SpacesError);
    expect(() => decodeClientMessage(new Uint8Array([1, 2, ...new Uint8Array(16)]))).toThrow(SpacesError);
    expect(() => decodeClientMessage(new Uint8Array(0))).toThrow(SpacesError);
  });
});

describe("server messages", () => {
  it("round trip", () => {
    fc.assert(
      fc.property(serverMessage, (m) => {
        expect(norm(decodeServerMessage(encodeServerMessage(m)))).toEqual(norm(m));
      }),
      { numRuns: 300 },
    );
  });

  it("every strict prefix is refused", () => {
    fc.assert(
      fc.property(serverMessage, (m) => {
        const b = encodeServerMessage(m);
        for (let n = 0; n < b.length; n++) expect(() => decodeServerMessage(b.subarray(0, n))).toThrow(SpacesError);
      }),
      { numRuns: 60 },
    );
  });

  it("refuses an unknown enum value and a bad flag", () => {
    const denied = encodeServerMessage({ t: "denied", space: new Uint8Array(16) as SpaceBytes, reason: "unknown-space", incarnation: new Uint8Array(16) as Incarnation });
    const bad = denied.slice();
    bad[17] = 9;
    expect(() => decodeServerMessage(bad)).toThrow(SpacesError);
    const ack = encodeServerMessage({ t: "blobAck", space: new Uint8Array(16) as SpaceBytes, req: 1, gone: true });
    const badFlag = ack.slice();
    badFlag[badFlag.length - 1] = 2;
    expect(() => decodeServerMessage(badFlag)).toThrow(SpacesError);
  });

  it("refuses a list count the input cannot hold, without allocating for it", () => {
    const space = new Uint8Array(16);
    const head = [7, ...space, ...new Uint8Array(16)];
    const bomb = new Uint8Array([...head, ...u32(0xffffffff)]);
    expect(() => decodeServerMessage(bomb)).toThrow(SpacesError);
    expect(() => decodeClientMessage(new Uint8Array([13, ...space, 0, 0, 0, 1, ...u32(0xffffffff)]))).toThrow(SpacesError);
  });

  it("refuses an integer above 2^53", () => {
    const pull = encodeClientMessage({ t: "pull", space: new Uint8Array(16) as SpaceBytes, after: 0 as ServerRev, maxBytes: 1 });
    const big = pull.slice();
    big[17] = 0xff;
    expect(() => decodeClientMessage(big)).toThrow(SpacesError);
  });
});

describe("hostile input", () => {
  it("random bytes either decode or fail with a protocol error, never anything else", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (b) => {
        expect(decodesOrProtocolError(decodeClientMessage, b)).toBe(true);
        expect(decodesOrProtocolError(decodeServerMessage, b)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("flipping a byte of a valid message never escapes as another error", () => {
    fc.assert(
      fc.property(serverMessage, fc.nat(), fc.integer({ min: 1, max: 255 }), (m, at, x) => {
        const b = encodeServerMessage(m);
        const c = b.slice();
        c[at % c.length]! ^= x;
        expect(decodesOrProtocolError(decodeServerMessage, c)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("limits", () => {
  it("keeps a legal single item pushable and a page smaller than a push", () => {
    expect(Limits.richTextStateBytes).toBeLessThan(Limits.pushBytes);
    expect(Limits.pageBytes).toBeLessThan(Limits.pushBytes);
    expect(Limits.pageItems).toBeGreaterThan(Limits.pushItems);
    expect(Limits.chunkBytes).toBe(1024 * 1024);
    expect(Limits.recordBytes).toBeLessThan(Limits.pushBytes);
  });
});
