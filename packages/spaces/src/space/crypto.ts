/**
 * Every cryptographic format, on WebCrypto only. No dependency, so no bundle
 * cost. WebCrypto is async, which is why nothing here may run inside a
 * kv.update body, and why nothing does: local data is plaintext at rest and
 * crypto runs only at the wire.
 *
 * End-to-end encryption hides data from the server and nothing more. The
 * server enforces membership and roles. So there are no signatures, no key
 * pairs and no rotation: one AES-256-GCM key per space, and bearer tokens
 * for membership.
 *
 * Primitives: AES-256-GCM, HKDF-SHA-256, SHA-256. The server runs the same
 * module on Node's WebCrypto. All integers are big-endian.
 *
 *   Sealed        nonce(12) || ciphertext+tag
 *                 AES-256-GCM, random nonce. Keys are per space or per file,
 *                 so random nonces stay far from the 2^32 bound.
 *
 *   ItemAad       "spaces/1" || kind(u8) || space(16) || record(16) || field(u32)
 *                 Binds a ciphertext to its slot: the server cannot move a
 *                 body to another record, space, field or kind.
 *
 *   MemberToken   32 random bytes, one per membership, stored with the space key on
 *                 the client. A bearer secret: the server stores only its
 *                 TokenId, and a leaked token is replaced by leaving and
 *                 joining again. The personal space has the one derived
 *                 token: HKDF(account secret, salt = personal space id,
 *                 info "spaces/member-token"), so a new device recomputes it.
 *
 *   TokenId       SHA-256(token)[0..16]. The server's id for a member or an invite.
 *
 *   Invite        secret(16) in the link fragment, so the server never sees it.
 *                 token = HKDF(secret, info "spaces/invite-token")
 *                 wrap  = HKDF(secret, info "spaces/invite-wrap")
 *                 Independent, so the token the server sees reveals nothing
 *                 about the key that wraps the space key.
 *
 *   WrappedKey    Sealed under the invite's wrap key, aad "spaces/wrap" || space, of the space key.
 *
 *   KeyCheck      HKDF(space key, info "spaces/key-check", 8 bytes). Public. The server
 *                 stores it at `create` and returns it in `authOk` and
 *                 `joined`, so a client that holds the wrong key finds out
 *                 before its first push.
 *
 *   Personal      id  = SHA-256("spaces/personal-id" || account secret)[0..16]
 *                 key = HKDF(account secret, info "spaces/personal-key")
 *                 token as above. A new device of the account recomputes all three.
 *
 *   FileChunk     AES-GCM(file key, nonce 0^4 || chunk(u64), aad file(16) || chunk(u32) || last(u8))(bytes)
 *                 One random key per file, so the counter nonce is safe;
 *                 `last` makes truncation detectable.
 */

import { concat, u32, u64, utf8 } from "../bytes.js";
import { SpacesError } from "../errors.js";
import type { Brand, SpaceBytes } from "../ids.js";

export type Bytes32 = Brand<Uint8Array, "Bytes32">;
export type Hash = Brand<Uint8Array, "Hash">; // 32 bytes
/** SHA-256(token)[0..16]. */
export type TokenId = Brand<Uint8Array, "TokenId">;
/** 8 bytes, a public check value of a space key. */
export type KeyCheck = Brand<Uint8Array, "KeyCheck">;

/** An imported AES-GCM key. Imported once per space and held for the session: that is the CryptoKey, not a cache of data. */
export type AeadKey = Brand<CryptoKey, "AeadKey">;

export type Sealed = { readonly nonce: Uint8Array; readonly body: Uint8Array };

export const ItemKind = { record: 1, tomb: 2, richText: 3, richTextState: 4 } as const;
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind];

const subtle = crypto.subtle;
/** WebCrypto takes `ArrayBuffer`-backed views only. Every Uint8Array here is one. */
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

const NONCE = 12;
const TAG = 16;
const NO_SALT = new Uint8Array(0);

export function randomKey(): Bytes32 {
  return crypto.getRandomValues(new Uint8Array(32)) as Bytes32;
}

export async function importAead(raw: Bytes32): Promise<AeadKey> {
  return (await subtle.importKey("raw", buf(raw), "AES-GCM", false, ["encrypt", "decrypt"])) as AeadKey;
}

export async function seal(key: AeadKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Sealed> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const body = await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: buf(aad) }, key, buf(plaintext));
  return { nonce, body: new Uint8Array(body) };
}

/** Throws SpacesError "decrypt" on a bad tag. The engine drops such an item and reports it, without stopping the page. */
export async function open(key: AeadKey, sealed: Sealed, aad: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: buf(sealed.nonce), additionalData: buf(aad) }, key, buf(sealed.body)),
    );
  } catch {
    throw new SpacesError("decrypt", "authentication failed");
  }
}

/** The wire and disk form of a Sealed: nonce || body. */
export const sealedBytes = (s: Sealed): Uint8Array => concat(s.nonce, s.body);
/** Throws SpacesError "protocol" if there is no room for a nonce and a tag. */
export function sealedFrom(bytes: Uint8Array): Sealed {
  if (bytes.length < NONCE + TAG) throw new SpacesError("protocol", "sealed value too short");
  return { nonce: bytes.slice(0, NONCE), body: bytes.slice(NONCE) };
}

const ITEM_PREFIX = utf8("spaces/1");
export function itemAad(kind: ItemKind, space: SpaceBytes, record: Uint8Array, field: number): Uint8Array {
  return concat(ITEM_PREFIX, Uint8Array.of(kind), space, record, u32(field));
}

export async function sha256(bytes: Uint8Array): Promise<Hash> {
  return new Uint8Array(await subtle.digest("SHA-256", buf(bytes))) as Hash;
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const base = await subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(utf8(info)) }, base, length * 8),
  );
}

export const randomToken = (): Bytes32 => randomKey();

export async function keyCheck(spaceKey: Bytes32): Promise<KeyCheck> {
  return (await hkdf(spaceKey, NO_SALT, "spaces/key-check", 8)) as KeyCheck;
}

export async function tokenId(token: Uint8Array): Promise<TokenId> {
  return (await sha256(token)).slice(0, 16) as TokenId;
}

/** `token` goes to the server, `wrapKey` stays in the link. */
export async function inviteKeys(inviteSecret: Uint8Array): Promise<{ token: Bytes32; wrapKey: Bytes32 }> {
  const [token, wrapKey] = await Promise.all([
    hkdf(inviteSecret, NO_SALT, "spaces/invite-token"),
    hkdf(inviteSecret, NO_SALT, "spaces/invite-wrap"),
  ]);
  return { token: token as Bytes32, wrapKey: wrapKey as Bytes32 };
}

const wrapAad = (space: SpaceBytes) => concat(utf8("spaces/wrap"), space);

export async function wrapSpaceKey(wrapKey: Bytes32, spaceKey: Bytes32, space: SpaceBytes): Promise<Sealed> {
  return seal(await importAead(wrapKey), spaceKey, wrapAad(space));
}

/** Throws SpacesError "decrypt" on a wrong wrap key or space. */
export async function unwrapSpaceKey(wrapKey: Bytes32, wrapped: Sealed, space: SpaceBytes): Promise<Bytes32> {
  const key = (await open(await importAead(wrapKey), wrapped, wrapAad(space))) as Bytes32;
  if (key.length !== 32) throw new SpacesError("decrypt", "space key has the wrong size");
  return key;
}

export async function personalSpace(accountSecret: Bytes32): Promise<{ id: SpaceBytes; key: Bytes32; token: Bytes32 }> {
  const [hash, key] = await Promise.all([
    sha256(concat(utf8("spaces/personal-id"), accountSecret)),
    hkdf(accountSecret, NO_SALT, "spaces/personal-key"),
  ]);
  const id = hash.slice(0, 16) as SpaceBytes;
  return { id, key: key as Bytes32, token: (await hkdf(accountSecret, id, "spaces/member-token")) as Bytes32 };
}

const chunkNonce = (chunk: number) => concat(new Uint8Array(4), u64(chunk));
const chunkAad = (file: Uint8Array, chunk: number, last: boolean) => concat(file, u32(chunk), Uint8Array.of(last ? 1 : 0));

export async function sealChunk(fileKey: AeadKey, file: Uint8Array, chunk: number, last: boolean, bytes: Uint8Array): Promise<Uint8Array> {
  const body = await subtle.encrypt(
    { name: "AES-GCM", iv: buf(chunkNonce(chunk)), additionalData: buf(chunkAad(file, chunk, last)) },
    fileKey,
    buf(bytes),
  );
  return new Uint8Array(body);
}

export async function openChunk(fileKey: AeadKey, file: Uint8Array, chunk: number, last: boolean, sealed: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await subtle.decrypt(
        { name: "AES-GCM", iv: buf(chunkNonce(chunk)), additionalData: buf(chunkAad(file, chunk, last)) },
        fileKey,
        buf(sealed),
      ),
    );
  } catch {
    throw new SpacesError("decrypt", "file chunk failed authentication");
  }
}
