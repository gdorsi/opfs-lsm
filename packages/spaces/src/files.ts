/**
 * Files: immutable, chunked, encrypted blobs, referenced from record fields.
 *
 *   put    The file is read in 1 MiB slices. Each slice is sealed with a
 *          fresh per-file key (`crypto.ts` FileChunk) and stored at 73 0A
 *          through `LocalStore.putFileChunks`,
 *          in kv batches of at most 6 chunks (well under 8 MiB). The manifest
 *          (73 09) is written last, in the same batch as the last chunks.
 *          A crash leaves chunks without a manifest, which `open` sweeps.
 *          Returns a FileRef. Nothing is uploaded yet, and nothing touches
 *          the network.
 *   attach Writing a record whose file field holds the ref sets the
 *          manifest's owner to that record, in the same kv.update
 *          (`LocalStore.write`), and queues the upload (73 04 03). A
 *          second record that takes the same ref throws SpacesError
 *          "file-attached". A blob dies with exactly one record, so the
 *          server can free it without reading anything.
 *   upload The sync leader sends each chunk as stored (local bytes are the
 *          ciphertext, so nothing is re-encrypted) with the owner's record
 *          id in clear, before it pushes the record. Peers never see a ref
 *          whose bytes are not on the server.
 *   read   Local chunks are opened and returned as one Blob. Missing chunks:
 *          the tab writes a want entry (73 04 04) and waits on kv.changes.
 *          The leader fetches them over its connection, stores them, and
 *          completes the manifest. So a non-leader tab needs no connection
 *          of its own.
 *   delete With the owning record: one deleteRange over the chunks, here
 *          and on the server when the tombstone arrives there.
 *
 * Why chunks in kv and not a separate OPFS file: a manifest committed in
 * the same kv batch as the last chunk is the only crash-safe ordering
 * without a second store. The cost is LSM write amplification on large
 * files, so `Limits.fileBytes` is 64 MiB until kv grows a blob store (see
 * rationale, "kv gaps").
 *
 * Each file has its own key, carried in the record (`FileRef.key`), so the
 * key travels sealed under the space key with the record. The server sees
 * chunk counts and sizes, never names, types or bytes.
 */

import type { Db } from "@opfs-lsm/kv";
import type { Brand, FileId, SpaceId } from "./ids.js";
import type { LocalStore } from "./local/store.js";
import type { Space, SpaceRegistry } from "./space/spaces.js";

/**
 * The value of a `file()` field. Made only by `files.put`: the validator of
 * `file()` checks the shape and that `id` belongs to the record's space.
 * `key` is the base64url file key. It is inside the record, so it travels
 * encrypted.
 */
export type FileRef = Brand<
  {
    readonly id: FileId;
    readonly name: string;
    readonly type: string;
    readonly size: number;
    readonly key: string;
  },
  "FileRef"
>;

export interface Files {
  /** Encrypts into kv. Throws SpacesError "too-large" above `Limits.fileBytes`. */
  put(file: Blob, options?: { readonly space?: Space | SpaceId; readonly name?: string }): Promise<FileRef>;
  /** Local bytes, or fetched through the sync leader. Rejects with SpacesError "offline" when the chunks are not local and no server answers, and "deleted" when the owner record is gone. */
  read(ref: FileRef): Promise<Blob>;
  /** As `read`, chunk by chunk, so a large file can start playing before it is all here. */
  stream(ref: FileRef): ReadableStream<Uint8Array>;
  status(ref: FileRef): Promise<"local" | "partial" | "remote" | "deleted">;
}

/**
 * Chunking, sealing and Blob assembly. Every kv write goes through
 * `LocalStore` (`putFileChunks`, `wantFile`), which owns the file keys
 * because a record's delete must remove its files in the same transaction.
 * The engine moves bytes with `LocalStore.pendingFiles`, `readFileChunks`
 * and `putFileChunks` directly: chunks are sealed already, so it needs
 * nothing from this class.
 */
export declare class FileStore implements Files {
  constructor(kv: Db, store: LocalStore, spaces: SpaceRegistry);
  put(file: Blob, options?: { readonly space?: Space | SpaceId; readonly name?: string }): Promise<FileRef>;
  read(ref: FileRef): Promise<Blob>;
  stream(ref: FileRef): ReadableStream<Uint8Array>;
  status(ref: FileRef): Promise<"local" | "partial" | "remote" | "deleted">;
}
