/**
 * The kv key layout: the one place that knows it.
 *
 * Every key starts with 0x73 ('s'). docstore owns 0x64 and the yjs adapter
 * 0x79, so this package can share a kv database with either.
 *
 *   73 00 <utf8 name>                                meta: "account" (32-byte secret), "catalog" (JSON)
 *   73 01 <coll u8> <record 16>                      live record        value: RecordValue (record.ts)
 *   73 02 <record 16>                                tombstone          value: TombValue JSON, kept forever
 *   73 03 <coll u8> <index u8> <tuple…> 00 <record 16>  index entry        value: empty
 *   73 04 <kind u8> …                                outbox, one sub-prefix per kind (below)
 *   73 05 <record 16> <field u32> <origin u32> <seq u32>
 *                                                    rich-text update   value: Yjs update (plaintext)
 *   73 06 <space 16>                                 space key          value: key(32) || member token(32), never changes
 *   73 07 <space 16>                                 pull cursor        value: incarnation(16) || ServerRev u64 BE || flags u8
 *                                                    flags bit 0: a pull skipped an item of an unknown collection
 *   73 08 <space 16>                                 space meta         value: SpaceMeta JSON (space/spaces.ts)
 *   73 09 <file 16>                                  file manifest      value: FileManifestValue JSON (store.ts)
 *   73 0A <file 16> <chunk u32>                      file chunk         value: ciphertext, exactly as on the server
 *   73 0B <record 16>                                base rev           value: ServerRev u64 BE; absent means 0.
 *                                                    Its own key so an ack never rewrites the record or wakes a watch
 *
 * Outbox (`73 04`), the work the sync leader owes the server. The engine
 * follows this one prefix in `kv.changes`:
 *
 *   73 04 00 <record 16>                             record or tombstone to push; value: OutboxValue (record.ts)
 *   73 04 01 <record 16> <field u32> <origin u32> <seq u32>
 *                                                    local rich-text update to push; value: empty, the update is at 73 05 + same suffix
 *   73 04 02 <req 16>                                membership request, then its outcome; value: JSON (space/spaces.ts).
 *                                                    req = ms u64 || 8 random bytes, so a scan is creation order
 *   73 04 03 <file 16>                               file to upload; value: empty
 *   73 04 04 <file 16>                               file another tab wants downloaded; value: empty
 *
 * Why this order:
 * - A record id starts with its space tag, so `73 01 <coll> <tag>` is "the
 *   collection's records in one space": a prefix scan, no space index.
 * - A tombstone has its own prefix, so record scans never step over dead
 *   rows, and a merge reads `73 01` and `73 02` for one id in one update.
 * - A record's rich-text updates and its files sit under ids that start
 *   with the record id or the file id, so deleting them is one
 *   `deleteRange` each.
 * - kv seq appears in no key. It is not durable (kv design, "Recovery").
 *   The only cursor is the server rev, tagged with the server's incarnation.
 */

import type { KeyBounds } from "@opfs-lsm/kv";
import { concat, prefixBounds, readU32, u32, utf8 } from "../bytes.js";
import type { FileKeyId, RecordKeyId, SpaceBytes, SpaceTag } from "../ids.js";

export const ROOT = 0x73;

export const Tag = {
  meta: 0x00,
  record: 0x01,
  tomb: 0x02,
  index: 0x03,
  outbox: 0x04,
  richText: 0x05,
  spaceKey: 0x06,
  cursor: 0x07,
  spaceMeta: 0x08,
  fileManifest: 0x09,
  fileChunk: 0x0a,
  base: 0x0b,
} as const;

export const OutboxKind = {
  record: 0x00,
  richText: 0x01,
  request: 0x02,
  fileUpload: 0x03,
  fileWant: 0x04,
} as const;
export type OutboxKind = (typeof OutboxKind)[keyof typeof OutboxKind];

/** A collection's u8 id from the catalog. Allocated once and never reused, so a dropped collection's keys never alias a new one. */
export type CollId = number & { readonly __coll: true };
/** An index's u8 id within its collection, allocated like `CollId`. */
export type IndexId = number & { readonly __index: true };
/** FNV-1a 32 of the rich-text field's name: stable across app versions (a declaration index is not). */
export type FieldHash = number & { readonly __field: true };

const key = (...parts: (number | Uint8Array)[]): Uint8Array =>
  concat(...parts.map((p) => (typeof p === "number" ? Uint8Array.of(p) : p)));

const under = (...parts: (number | Uint8Array)[]): KeyBounds => prefixBounds(key(...parts));

const RECORD_ID = 16;

export function metaKey(name: "account" | "catalog"): Uint8Array {
  return key(ROOT, Tag.meta, utf8(name));
}
export function recordKey(coll: CollId, id: RecordKeyId): Uint8Array {
  return key(ROOT, Tag.record, coll, id);
}
/** The collection's records, all of them or one space's. */
export function recordBounds(coll: CollId, space?: SpaceTag): KeyBounds {
  return space === undefined ? under(ROOT, Tag.record, coll) : under(ROOT, Tag.record, coll, space);
}
export function tombKey(id: RecordKeyId): Uint8Array {
  return key(ROOT, Tag.tomb, id);
}
/** `tuple` is the docstore tuple encoding of the index values (`tuple.ts`). The 00 between it and the id keeps a 0xFF id byte from reading as an escape. */
export function indexKey(coll: CollId, index: IndexId, tuple: Uint8Array, id: RecordKeyId): Uint8Array {
  return key(ROOT, Tag.index, coll, index, tuple, Uint8Array.of(0), id);
}
export function indexBounds(coll: CollId, index: IndexId): KeyBounds {
  return under(ROOT, Tag.index, coll, index);
}
export function outboxRecordKey(id: RecordKeyId): Uint8Array {
  return key(ROOT, Tag.outbox, OutboxKind.record, id);
}
/** One outbox kind, or all of them. `space` narrows a kind whose keys continue with a record id. */
export function outboxBounds(kind?: OutboxKind, space?: SpaceTag): KeyBounds {
  if (kind === undefined) return under(ROOT, Tag.outbox);
  return space === undefined ? under(ROOT, Tag.outbox, kind) : under(ROOT, Tag.outbox, kind, space);
}
/** `origin`: the writing lease's random session, or 0 for updates pulled from the server (then `seq` is the rev mod 2^32). */
export function richTextKey(id: RecordKeyId, field: FieldHash, origin: number, seq: number): Uint8Array {
  return key(ROOT, Tag.richText, id, u32(field), u32(origin), u32(seq));
}
/** One field's updates, or with `field` absent every rich-text update of the record. */
export function richTextBounds(id: RecordKeyId, field?: FieldHash): KeyBounds {
  return field === undefined ? under(ROOT, Tag.richText, id) : under(ROOT, Tag.richText, id, u32(field));
}
export function outboxRichTextKey(id: RecordKeyId, field: FieldHash, origin: number, seq: number): Uint8Array {
  return key(ROOT, Tag.outbox, OutboxKind.richText, id, u32(field), u32(origin), u32(seq));
}
/** Every unpushed rich-text update, of one record, or of one field of it. */
export function outboxRichTextBounds(id?: RecordKeyId, field?: FieldHash): KeyBounds {
  if (id === undefined) return under(ROOT, Tag.outbox, OutboxKind.richText);
  return field === undefined
    ? under(ROOT, Tag.outbox, OutboxKind.richText, id)
    : under(ROOT, Tag.outbox, OutboxKind.richText, id, u32(field));
}
export function spaceKeyKey(space: SpaceBytes): Uint8Array {
  return key(ROOT, Tag.spaceKey, space);
}
/** Every space key, for `SpaceRegistry.open`. */
export function spaceKeyBounds(): KeyBounds {
  return under(ROOT, Tag.spaceKey);
}
export function cursorKey(space: SpaceBytes): Uint8Array {
  return key(ROOT, Tag.cursor, space);
}
/** Every pull cursor. */
export function cursorBounds(): KeyBounds {
  return under(ROOT, Tag.cursor);
}
export function spaceMetaKey(space: SpaceBytes): Uint8Array {
  return key(ROOT, Tag.spaceMeta, space);
}
export function spaceMetaBounds(): KeyBounds {
  return under(ROOT, Tag.spaceMeta);
}
/** `req` is 16 bytes: ms u64 then 8 random bytes. Local only: the leader maps it to a per-connection u32 `req` on the wire. */
export function outboxRequestKey(req: Uint8Array): Uint8Array {
  return key(ROOT, Tag.outbox, OutboxKind.request, req);
}
/** The ServerRev a record's state includes, or absent for 0. */
export function baseKey(id: RecordKeyId): Uint8Array {
  return key(ROOT, Tag.base, id);
}
/** Base revs of one space's records. */
export function baseBounds(space: SpaceTag): KeyBounds {
  return under(ROOT, Tag.base, space);
}
export function fileManifestKey(id: FileKeyId): Uint8Array {
  return key(ROOT, Tag.fileManifest, id);
}
export function fileChunkKey(id: FileKeyId, chunk: number): Uint8Array {
  return key(ROOT, Tag.fileChunk, id, u32(chunk));
}
export function fileChunkBounds(id: FileKeyId): KeyBounds {
  return under(ROOT, Tag.fileChunk, id);
}
export function outboxFileKey(kind: typeof OutboxKind.fileUpload | typeof OutboxKind.fileWant, id: FileKeyId): Uint8Array {
  return key(ROOT, Tag.outbox, kind, id);
}
/** Tombstones of one space: tomb keys start with the record id, which starts with the space tag. */
export function tombBounds(space: SpaceTag): KeyBounds {
  return under(ROOT, Tag.tomb, space);
}

/** FNV-1a 32 of a rich-text field's name. */
export function fieldHash(name: string): FieldHash {
  let h = 0x811c9dc5;
  for (const byte of utf8(name)) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0) as FieldHash;
}

/** The id that ends a key: record and tombstone keys, index entries and outbox record entries. */
export const idAtEnd = (key: Uint8Array): RecordKeyId => key.subarray(key.length - RECORD_ID) as RecordKeyId;

/** Decoders for keys seen in `kv.changes` events. */
export function parseKey(key: Uint8Array):
  | { readonly tag: typeof Tag.record; readonly coll: CollId; readonly id: RecordKeyId }
  | { readonly tag: typeof Tag.richText; readonly id: RecordKeyId; readonly field: FieldHash; readonly origin: number }
  | { readonly tag: typeof Tag.outbox; readonly kind: OutboxKind }
  | { readonly tag: typeof Tag.fileManifest; readonly file: FileKeyId }
  | { readonly tag: "other" } {
  if (key[0] === ROOT) {
    switch (key[1]) {
      case Tag.record:
        if (key.length === 3 + RECORD_ID) {
          return { tag: Tag.record, coll: key[2] as CollId, id: key.subarray(3) as RecordKeyId };
        }
        break;
      case Tag.richText:
        if (key.length === 2 + RECORD_ID + 12) {
          return {
            tag: Tag.richText,
            id: key.subarray(2, 2 + RECORD_ID) as RecordKeyId,
            field: readU32(key, 2 + RECORD_ID) as FieldHash,
            origin: readU32(key, 6 + RECORD_ID),
          };
        }
        break;
      case Tag.outbox:
        if (key.length > 2) return { tag: Tag.outbox, kind: key[2] as OutboxKind };
        break;
      case Tag.fileManifest:
        if (key.length === 2 + RECORD_ID) return { tag: Tag.fileManifest, file: key.subarray(2) as FileKeyId };
        break;
    }
  }
  return { tag: "other" };
}
