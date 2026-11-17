import { describe, expect, it } from "vitest";
import { equalBytes, utf8 } from "../src/bytes.js";
import { SpacesError } from "../src/errors.js";
import type { SpaceBytes } from "../src/ids.js";
import {
  hkdf,
  importAead,
  inviteKeys,
  itemAad,
  ItemKind,
  keyCheck,
  randomToken,
  open,
  openChunk,
  personalSpace,
  randomKey,
  seal,
  sealChunk,
  sealedBytes,
  sealedFrom,
  sha256,
  tokenId,
  unwrapSpaceKey,
  wrapSpaceKey,
} from "../src/space/crypto.js";

const space = new Uint8Array(16).fill(7) as SpaceBytes;
const other = new Uint8Array(16).fill(8) as SpaceBytes;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rejects = async (p: Promise<unknown>, code: string) =>
  expect(await p.then(() => undefined, (e: { code?: string }) => e.code)).toBe(code);

describe("seal / open", () => {
  it("round trips and binds the AAD", async () => {
    const key = await importAead(randomKey());
    const aad = itemAad(ItemKind.record, space, new Uint8Array(16).fill(1), 9);
    const sealed = await seal(key, utf8("hello"), aad);
    expect(await open(key, sealed, aad)).toEqual(utf8("hello"));

    for (let i = 0; i < aad.length; i++) {
      const bad = aad.slice();
      bad[i]! ^= 1;
      await rejects(open(key, sealed, bad), "decrypt");
    }
    for (const i of [0, sealed.body.length - 1]) {
      const body = sealed.body.slice();
      body[i]! ^= 1;
      await rejects(open(key, { nonce: sealed.nonce, body }, aad), "decrypt");
    }
    const nonce = sealed.nonce.slice();
    nonce[0]! ^= 1;
    await rejects(open(key, { nonce, body: sealed.body }, aad), "decrypt");
    await rejects(open(await importAead(randomKey()), sealed, aad), "decrypt");
  });

  it("uses a fresh nonce per seal and a stable byte form", async () => {
    const key = await importAead(randomKey());
    const a = await seal(key, new Uint8Array(0), new Uint8Array(0));
    const b = await seal(key, new Uint8Array(0), new Uint8Array(0));
    expect(equalBytes(a.nonce, b.nonce)).toBe(false);
    expect(a.body.length).toBe(16);
    const back = sealedFrom(sealedBytes(a));
    expect(await open(key, back, new Uint8Array(0))).toEqual(new Uint8Array(0));
    expect(() => sealedFrom(new Uint8Array(27))).toThrow(SpacesError);
  });

  it("itemAad has no epoch and differs in every slot", () => {
    const base = itemAad(ItemKind.record, space, new Uint8Array(16), 0);
    expect(base.length).toBe(8 + 1 + 16 + 16 + 4);
    const variants = [
      itemAad(ItemKind.tomb, space, new Uint8Array(16), 0),
      itemAad(ItemKind.record, other, new Uint8Array(16), 0),
      itemAad(ItemKind.record, space, new Uint8Array(16).fill(1), 0),
      itemAad(ItemKind.record, space, new Uint8Array(16), 1),
    ];
    for (const v of variants) expect(equalBytes(v, base)).toBe(false);
  });
});

describe("derivations", () => {
  it("hkdf is deterministic, length-controlled, and separated by salt and info", async () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = Uint8Array.from({ length: 13 }, (_, i) => i);
    const out = await hkdf(ikm, salt, "a");
    expect(out.length).toBe(32);
    expect(await hkdf(ikm, salt, "a")).toEqual(out);
    expect(equalBytes(out, await hkdf(ikm, salt, "b"))).toBe(false);
    expect(equalBytes(out, await hkdf(ikm, new Uint8Array(13), "a"))).toBe(false);
    expect(equalBytes(out, await hkdf(new Uint8Array(22).fill(0x0c), salt, "a"))).toBe(false);
    expect((await hkdf(ikm, salt, "a", 42)).length).toBe(42);
    expect(await hkdf(ikm, salt, "a", 16)).toEqual(out.slice(0, 16));
  });

  it("member tokens are random, one per membership", () => {
    const a = randomToken();
    expect(a.length).toBe(32);
    expect(equalBytes(a, randomToken())).toBe(false);
  });

  it("the key check is 8 bytes, deterministic, and differs per key", async () => {
    const k = randomKey();
    const c = await keyCheck(k);
    expect(c.length).toBe(8);
    expect(await keyCheck(k)).toEqual(c);
    expect(equalBytes(await keyCheck(randomKey()), c)).toBe(false);
    expect(equalBytes(c, k.slice(0, 8))).toBe(false);
  });

  it("token ids are the first 16 bytes of SHA-256", async () => {
    const t = randomKey();
    const id = await tokenId(t);
    expect(id.length).toBe(16);
    expect(id).toEqual((await sha256(t)).slice(0, 16));
    expect(equalBytes(id, await tokenId(randomKey()))).toBe(false);
  });

  it("sha256 matches a known vector", async () => {
    expect(hex(await sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("invite token and wrap key are deterministic and independent", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const a = await inviteKeys(secret);
    const b = await inviteKeys(secret);
    expect(a).toEqual(b);
    expect(equalBytes(a.token, a.wrapKey)).toBe(false);
    const c = await inviteKeys(crypto.getRandomValues(new Uint8Array(16)));
    expect(equalBytes(a.token, c.token)).toBe(false);
    expect(equalBytes(a.wrapKey, c.wrapKey)).toBe(false);
  });

  it("the personal space is a pure function of the account secret", async () => {
    const secret = randomKey();
    const a = await personalSpace(secret);
    const b = await personalSpace(secret);
    expect(a).toEqual(b);
    expect(a.id.length).toBe(16);
    expect(a.key.length).toBe(32);
    const c = await personalSpace(randomKey());
    expect(equalBytes(a.id, c.id)).toBe(false);
    expect(equalBytes(a.key, c.key)).toBe(false);
    expect(equalBytes(a.key, a.id)).toBe(false);
    expect(a.token.length).toBe(32);
    expect(equalBytes(a.token, a.key)).toBe(false);
    expect(equalBytes(a.token, c.token)).toBe(false);
    expect(await hkdf(secret, a.id, "spaces/member-token")).toEqual(a.token);
  });
});

describe("space key wrap", () => {
  it("round trips, and fails for another wrap key, another space or a flipped byte", async () => {
    const { wrapKey } = await inviteKeys(crypto.getRandomValues(new Uint8Array(16)));
    const key = randomKey();
    const wrapped = await wrapSpaceKey(wrapKey, key, space);
    expect(await unwrapSpaceKey(wrapKey, wrapped, space)).toEqual(key);
    const stranger = await inviteKeys(crypto.getRandomValues(new Uint8Array(16)));
    await rejects(unwrapSpaceKey(stranger.wrapKey, wrapped, space), "decrypt");
    await rejects(unwrapSpaceKey(stranger.token, wrapped, space), "decrypt");
    await rejects(unwrapSpaceKey(wrapKey, wrapped, other), "decrypt");
    const body = wrapped.body.slice();
    body[3]! ^= 1;
    await rejects(unwrapSpaceKey(wrapKey, { nonce: wrapped.nonce, body }, space), "decrypt");
  });

  it("a wrapped key is not an item", async () => {
    const { wrapKey } = await inviteKeys(crypto.getRandomValues(new Uint8Array(16)));
    const wrapped = await wrapSpaceKey(wrapKey, randomKey(), space);
    const aad = itemAad(ItemKind.record, space, new Uint8Array(16), 0);
    await expect(open(await importAead(wrapKey), wrapped, aad)).rejects.toMatchObject({ code: "decrypt" });
  });
});

describe("file chunks", () => {
  it("opens with the right index and last flag only", async () => {
    const key = await importAead(randomKey());
    const file = new Uint8Array(16).fill(9);
    const sealed = await sealChunk(key, file, 4, false, utf8("chunk"));
    expect(await openChunk(key, file, 4, false, sealed)).toEqual(utf8("chunk"));
    await rejects(openChunk(key, file, 5, false, sealed), "decrypt");
    await rejects(openChunk(key, file, 4, true, sealed), "decrypt");
    await rejects(openChunk(key, new Uint8Array(16), 4, false, sealed), "decrypt");
    const flipped = sealed.slice();
    flipped[0]! ^= 1;
    await rejects(openChunk(key, file, 4, false, flipped), "decrypt");
  });

  it("is deterministic per (key, file, index), which the counter nonce makes safe", async () => {
    const key = await importAead(randomKey());
    const file = new Uint8Array(16);
    const a = await sealChunk(key, file, 0, true, utf8("x"));
    expect(await sealChunk(key, file, 0, true, utf8("x"))).toEqual(a);
    expect(equalBytes(await sealChunk(key, file, 1, true, utf8("x")), a)).toBe(false);
  });
});
