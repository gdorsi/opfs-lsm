/**
 * LocalStore: the only writer of every key whose lifetime is a record's or
 * a file's: records, tombstones, index entries, the record and rich-text
 * outboxes, rich-text updates, file manifests and chunks, and pull
 * cursors. A record's delete has to remove all of them in one
 * transaction, so one module must own them all. `FileStore` (chunking,
 * crypto) and `RichTextFields` (the Y.Doc lifecycle) ask it to write and
 * never write themselves. `SpaceRegistry` owns the rest: space keys, space
 * meta, membership requests.
 *
 * It knows the key layout and the merge rules. It knows nothing about
 * crypto, the wire or spaces: the sync engine hands it validated plaintext
 * and takes plaintext back. File chunks arrive sealed, and to this module
 * they are opaque bytes.
 *
 * Every mutation is ONE `kv.update` whose body is synchronous and pure
 * given the values it read:
 *   - `write`        local ops (create / update / delete)
 *   - `applyRemote`  a page of remote items, plus the cursor in the same batch
 *   - `acknowledge`  base revs and outbox clears after a push
 * Each reads the catalog key and throws SpacesError "stale-schema" if
 * another tab upgraded the schema since this tab opened. An older tab can
 * then never write without maintaining a newer index (docstore's rule,
 * without its RETRY loop: the merge runs inside the body, so nothing is
 * planned outside that could go stale).
 *
 * Shared state: two tabs, or a tab and the sync leader, writing the same
 * record are serialized by kv.update, and each body merges with what it
 * read. Nothing else is shared. Clocks are per tab (`record.ts`).
 */

import type { BatchTx, Db, Entry, KeyBounds, ViewSnapshot } from "@opfs-lsm/kv";
import { after, compareBytes, concat, EMPTY, equalBytes, fromBase64url, fromUtf8, keyString, readU64, toBase64url, u64, utf8 } from "../bytes.js";
import { SpacesError } from "../errors.js";
import type { RecordStatus } from "../db.js";
import { fileBytes, isIdText, recordBytes } from "../ids.js";
import type { FileId, FileKeyId, RecordId, RecordKeyId, SpaceBytes, SpaceTag } from "../ids.js";
import { bindField, fieldKind } from "../schema.js";
import type { AnyCollection, FieldDef, SchemaDef, Scalar, StandardSchemaV1 } from "../schema.js";
import type { Incarnation, PullCursor, ServerRev } from "../sync/protocol.js";
import {
  cursorBounds,
  baseKey,
  cursorKey,
  fieldHash,
  fileChunkBounds,
  fileChunkKey,
  fileManifestKey,
  idAtEnd,
  indexBounds,
  metaKey,
  outboxBounds,
  outboxFileKey,
  outboxRecordKey,
  outboxRichTextBounds,
  outboxRichTextKey,
  OutboxKind,
  recordBounds,
  recordKey,
  richTextBounds,
  richTextKey,
  ROOT,
  Tag,
  tombBounds,
  tombKey,
} from "./keys.js";
import type { CollId, FieldHash, IndexId } from "./keys.js";
import { diffEntries, indexEntries, isReadable, mergeRemote, newestStamp, rowFields, applyLocal, maxStamp } from "./merge.js";
import type { LocalPatch } from "./merge.js";
import {
  decodeBase,
  decodeOutbox,
  decodeRecord,
  decodeTomb,
  encodeOutbox,
  encodeRecord,
  encodeTomb,
  readFields,
  stateBytes,
  toRow,
  UNSET,
  encodeBase,
  hasInvalidCell,
  stampInRange,
} from "./record.js";
import type { Cell, Clock, Json, RecordState, Stamp, TombValue } from "./record.js";
import { tupleRange } from "./tuple.js";

/** The value at 73 09, owned here. */
export type FileManifestValue = {
  readonly size: number;
  readonly chunks: number;
  /** Chunks present locally. A download is complete when this equals `chunks`. */
  readonly have: number;
  /** Set by the first record that references the file, inside that record's write. */
  readonly owner?: RecordKeyId;
};

// ---------------------------------------------------------------------------
// Catalog: the schema as stored, so every tab maintains the same indexes.

export type FieldValidation = { readonly ok: true; readonly value: Json | undefined } | { readonly ok: false; readonly message: string };

export type BoundField = {
  readonly name: string;
  readonly kind: "value" | "ref" | "file";
  /**
   * What `validate(undefined)` gave at open: a default to fill into rows
   * that have no cell for the field, or `required` when the validator
   * refuses undefined. An optional field with no default is
   * `{ kind: "absent" }`.
   */
  readonly fallback: { readonly kind: "required" } | { readonly kind: "absent" } | { readonly kind: "default"; readonly value: Json };
  /** The field's Standard Schema validator, run synchronously. A Promise result is a failure. */
  readonly validate: (value: unknown) => FieldValidation;
};

export type BoundIndex = {
  readonly name: string;
  readonly id: IndexId;
  readonly by: readonly string[];
  /** Writers maintain `building` indexes. Queries wait until `ready`. */
  readonly state: "building" | "ready";
};

export type BoundCollection = {
  readonly name: string;
  readonly id: CollId;
  readonly fields: ReadonlyMap<string, BoundField>;
  readonly richText: ReadonlyMap<string, FieldHash>;
  readonly indexes: readonly BoundIndex[];
};

export type Catalog = {
  readonly version: number;
  readonly collections: ReadonlyMap<string, BoundCollection>;
  /** The stored JSON bytes. Every write compares them with the stored value. */
  readonly bytes: Uint8Array;
};

/** The catalog as stored at `73 00 catalog`. */
type StoredCatalog = {
  readonly format: 1;
  /** The app version that last changed the catalog. A tab with a lower one is stale. */
  version: number;
  /** The version whose upgrade pass (re-validation of every record) has finished. Below `version`: a pass is owed. */
  pass: number;
  /** Collection ids are never reused. */
  nextColl: number;
  collections: { [name: string]: StoredCollection };
};
type StoredCollection = {
  id: number;
  /** Index ids are never reused within the collection. */
  nextIndex: number;
  indexes: { [name: string]: { id: number; by: string[]; state: "building" | "ready" } };
  /** What a record's fields slice depends on: each field's kind, requiredness and default. A change owes every record a re-encode. */
  sig: string;
  /** Set by a reconcile whose `sig` changed; cleared when the upgrade pass has re-encoded the collection. */
  rewrite?: true;
};

// ---------------------------------------------------------------------------
// Inputs

export type WriteOp =
  | {
      readonly kind: "put";
      readonly coll: BoundCollection;
      readonly id: RecordKeyId;
      /** true: the record must not exist yet (new random id); false: it must exist and not be tombstoned. */
      readonly create: boolean;
      readonly patch: LocalPatch;
      /** Files referenced by the patch: their manifests are read to take ownership (first record wins) or refuse a second owner. */
      readonly files: readonly FileKeyId[];
    }
  | { readonly kind: "delete"; readonly coll: BoundCollection; readonly id: RecordKeyId };

/** One remote item, decrypted and validated by the sync engine. */
export type RemoteItem =
  | { readonly kind: "record"; readonly id: RecordKeyId; readonly rev: ServerRev; readonly state: RecordState }
  | { readonly kind: "tomb"; readonly id: RecordKeyId; readonly rev: ServerRev; readonly tomb: TombValue }
  | {
      readonly kind: "richText";
      readonly id: RecordKeyId;
      readonly field: FieldHash;
      readonly rev: ServerRev;
      readonly update: Uint8Array;
    };

export type RemotePage =
  | {
      readonly source: "server";
      readonly space: SpaceBytes;
      readonly items: readonly RemoteItem[];
      /** The server rev this page reaches, under the server incarnation it came from. Absent for push conflicts, which do not move the cursor. */
      readonly through: PullCursor | undefined;
      /** The engine skipped an item of a collection this app version does not declare. Sets the cursor's flag bit 0, in the same batch. */
      readonly skippedUnknown: boolean;
    }
  /**
   * From a peer (deferred). The server may lack what a peer sends, so a
   * merge that changed the record queues it for push. Items from a server
   * page clear the queue instead when nothing local is newer.
   */
  | { readonly source: "peer"; readonly space: SpaceBytes; readonly items: readonly RemoteItem[] };

/** What `pendingRecords` yields, for the engine to encrypt and push. */
export type PendingRecord =
  | {
      readonly kind: "record";
      readonly id: RecordKeyId;
      readonly base: ServerRev;
      readonly stamp: Stamp;
      /** `stateBytes(value)`: the wire plaintext, no copy. */
      readonly plaintext: Uint8Array;
      readonly files: readonly FileKeyId[];
    }
  | { readonly kind: "tomb"; readonly id: RecordKeyId; readonly stamp: Stamp; readonly tomb: TombValue };

/** One pushed item the server accepted: `coll` is "tomb" for a tombstone. The commit rev is passed to `acknowledge` once. */
export type PushAck = { readonly id: RecordKeyId; readonly coll: CollId | "tomb"; readonly stamp: Stamp };

/** What `applyRemote` did with a page. */
export type ApplyResult = {
  /** Items refused because their id does not start with the page's space tag. */
  readonly dropped: number;
};

/** A typed query, lowered to one key range (docstore's `scanPlan`). */
export type QueryPlan = {
  readonly coll: BoundCollection;
  /** An index range, or the record prefix (all records, or one space's). */
  readonly source: { readonly kind: "index"; readonly index: BoundIndex } | { readonly kind: "records" };
  readonly range: KeyBounds;
  readonly reverse: boolean;
  readonly limit: number | undefined;
  readonly filter: ((row: { readonly id: string }) => boolean) | undefined;
  readonly resolve: ResolvePlan | undefined;
};

/** Ref field -> target collection, and what to resolve inside it. */
export type ResolvePlan = ReadonlyMap<string, { readonly target: BoundCollection; readonly nested: ResolvePlan | undefined }>;

/** `nextKey` is set when more entries follow the last row: the key `encodeCursor` turns into an `after` value. */
export type QueryResult = { readonly rows: { readonly id: string }[]; readonly nextKey: Uint8Array | undefined };

/** The opaque `after` value for a key `query` returned. */
export const encodeCursor = (key: Uint8Array): string => toBase64url(key);

// ---------------------------------------------------------------------------
// Helpers

const CATALOG = metaKey("catalog");
const RECORD_CHUNK = 500;
const CHUNK_BYTES = 4 * 1024 * 1024;
const FORMAT = 1;
const MAX_ID = 255;

type RowObject = { id: string } & { [field: string]: unknown };

const idText = (id: RecordKeyId): string => toBase64url(id);

function parseStored(bytes: Uint8Array): StoredCatalog {
  const c = JSON.parse(fromUtf8(bytes)) as StoredCatalog;
  if (c.format !== FORMAT) throw new SpacesError("schema", `the stored catalog has format ${String(c.format)}; this library reads format ${FORMAT}`);
  return c;
}

/** What one declared collection contributes to the catalog, from the schema alone. */
type Declared = {
  readonly name: string;
  readonly fields: ReadonlyMap<string, BoundField>;
  readonly richText: ReadonlyMap<string, FieldHash>;
  readonly indexes: readonly (readonly [string, readonly string[]])[];
};

function declare(schema: SchemaDef): Declared[] {
  return schema.collections.map((c: AnyCollection) => {
    const fields = new Map<string, BoundField>();
    const richText = new Map<string, FieldHash>();
    for (const [name, def] of Object.entries(c.shape) as [string, FieldDef][]) {
      const kind = fieldKind(def);
      if (kind === "richText") richText.set(name, fieldHash(name));
      else fields.set(name, bindField(name, def as StandardSchemaV1, kind));
    }
    const indexes = Object.entries((c.indexes ?? {}) as { [index: string]: readonly string[] });
    return { name: c.name, fields, richText, indexes };
  });
}

function bind(stored: StoredCatalog, declared: readonly Declared[], bytes: Uint8Array): Catalog {
  const collections = new Map<string, BoundCollection>();
  for (const d of declared) {
    const sc = stored.collections[d.name]!;
    collections.set(d.name, {
      name: d.name,
      id: sc.id as CollId,
      fields: d.fields,
      richText: d.richText,
      indexes: Object.entries(sc.indexes).map(([name, ix]) => ({ name, id: ix.id as IndexId, by: ix.by, state: ix.state })),
    });
  }
  return { version: stored.version, collections, bytes };
}

const sameBy = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((f, i) => f === b[i]);

const shapeSig = (d: Declared): string => JSON.stringify([...d.fields].map(([name, f]) => [name, f.kind, f.fallback]));

/**
 * The catalog for a higher version. An index declared again with the same
 * fields keeps its id, its state and its entries; a new or redefined one
 * gets a fresh id and state `building`; one no longer declared is dropped
 * with one `deleteRange`. A collection whose field signature changed is
 * marked for a re-encode of all its records.
 */
function reconcile(prev: StoredCatalog | undefined, declared: readonly Declared[], version: number, tx: BatchTx): StoredCatalog {
  const next: StoredCatalog = { format: FORMAT, version, pass: prev?.pass ?? version, nextColl: prev?.nextColl ?? 1, collections: {} };
  const kept = new Set<string>();
  for (const d of declared) {
    const before = prev?.collections[d.name];
    let id = before?.id;
    if (id === undefined) id = next.nextColl++;
    let nextIndex = before?.nextIndex ?? 1;
    const indexes: StoredCollection["indexes"] = {};
    for (const [name, by] of d.indexes) {
      const old = before?.indexes[name];
      if (old !== undefined && sameBy(old.by, by)) {
        indexes[name] = old;
        kept.add(`${id}/${old.id}`);
      } else indexes[name] = { id: nextIndex++, by: [...by], state: "building" };
    }
    if (id > MAX_ID || nextIndex > MAX_ID + 1) throw new SpacesError("schema", "the catalog ran out of collection or index ids");
    const sig = shapeSig(d);
    next.collections[d.name] = { id, nextIndex, indexes, sig, ...(before !== undefined && before.sig !== sig ? { rewrite: true as const } : {}) };
  }
  if (prev !== undefined) {
    for (const c of Object.values(prev.collections)) {
      for (const ix of Object.values(c.indexes)) {
        if (!kept.has(`${c.id}/${ix.id}`)) tx.deleteRange(indexBounds(c.id as CollId, ix.id as IndexId));
      }
    }
  }
  return next;
}

/** At the same version the declarations must be the ones stored. */
function checkSameDeclarations(stored: StoredCatalog, declared: readonly Declared[]): void {
  for (const d of declared) {
    const sc = stored.collections[d.name];
    const names = sc === undefined ? [] : Object.keys(sc.indexes);
    const same =
      sc !== undefined &&
      names.length === d.indexes.length &&
      d.indexes.every(([name, by]) => sc.indexes[name] !== undefined && sameBy(sc.indexes[name]!.by, by));
    if (!same) throw new SpacesError("schema", `"${d.name}" changed without a version bump`);
  }
}

function writeManifest(m: FileManifestValue): Uint8Array {
  return utf8(JSON.stringify({ s: m.size, c: m.chunks, h: m.have, ...(m.owner === undefined ? {} : { o: toBase64url(m.owner) }) }));
}
function readManifest(bytes: Uint8Array | undefined): FileManifestValue | undefined {
  if (bytes === undefined) return undefined;
  const m = JSON.parse(fromUtf8(bytes)) as { s: number; c: number; h: number; o?: string };
  return { size: m.s, chunks: m.c, have: m.h, ...(m.o === undefined ? {} : { owner: fromBase64url(m.o)! as RecordKeyId }) };
}

/** incarnation(16) || rev u64 BE || flags u8. Flag bit 0: a pull skipped an item of an unknown collection. */
const SKIPPED = 1;
function encodeCursorValue(c: PullCursor, flags: number): Uint8Array {
  return concat(c.incarnation, u64(c.rev), Uint8Array.of(flags));
}
function decodeCursorValue(bytes: Uint8Array): PullCursor & { readonly flags: number } {
  return { incarnation: bytes.slice(0, 16) as Incarnation, rev: readU64(bytes, 16) as ServerRev, flags: bytes[24] ?? 0 };
}

/** The files a record's cells reference. */
function fileIdsOf(coll: BoundCollection, state: RecordState): FileKeyId[] {
  const out: FileKeyId[] = [];
  for (const field of coll.fields.values()) {
    if (field.kind !== "file") continue;
    const cell = state.cells.get(field.name);
    if (cell === undefined || !cell.valid || cell.value === UNSET) continue;
    const id = (cell.value as { id?: unknown } | null)?.id;
    if (isIdText(id)) out.push(fileBytes(id as FileId));
  }
  return out;
}

/** Values read once from kv, then shared by every op of one body, so two ops on one record see each other. */
class Overlay<V> {
  private readonly seen = new Map<string, V | undefined>();
  get(id: RecordKeyId, initial: () => V | undefined): V | undefined {
    const k = keyString(id);
    if (!this.seen.has(k)) this.seen.set(k, initial());
    return this.seen.get(k);
  }
  set(id: RecordKeyId, value: V | undefined): void {
    this.seen.set(keyString(id), value);
  }
}

/** Everything a record's delete removes, besides its tombstone and outbox entry. */
function dropRecord(tx: BatchTx, coll: BoundCollection | undefined, id: RecordKeyId, cur: RecordState | undefined): void {
  tx.delete(baseKey(id));
  if (coll === undefined) return;
  tx.delete(recordKey(coll.id, id));
  if (cur !== undefined) {
    for (const entry of indexEntries(coll, id, cur)) tx.delete(entry);
    for (const file of fileIdsOf(coll, cur)) {
      tx.deleteRange(fileChunkBounds(file));
      tx.delete(fileManifestKey(file));
      tx.delete(outboxFileKey(OutboxKind.fileUpload, file));
      tx.delete(outboxFileKey(OutboxKind.fileWant, file));
    }
  }
  if (coll.richText.size > 0) {
    tx.deleteRange(richTextBounds(id));
    tx.deleteRange(outboxRichTextBounds(id));
  }
}

function boundsOf(range: KeyBounds): KeyBounds {
  return range.endExclusive === undefined ? { start: range.start! } : { start: range.start!, endExclusive: range.endExclusive };
}

// ---------------------------------------------------------------------------

export class LocalStore {
  private cat!: Catalog;
  private stored!: StoredCatalog;
  private byId = new Map<number, BoundCollection>();

  private constructor(
    private readonly kv: Db,
    private readonly clock: Clock,
    private readonly declared: readonly Declared[],
  ) {}

  /**
   * One `kv.update([catalogKey])`: store the schema if the stored catalog
   * is absent or older; throw SpacesError "stale-schema" if it is newer
   * (an older tab must reload). New and redefined indexes get fresh ids and
   * state `building`; unchanged ones keep their entries; removed ones are
   * dropped with one `deleteRange` each. When the schema gains a
   * collection, the same update deletes the pull cursors whose flag says a
   * pull skipped an unknown collection, so the next pull fetches what the
   * old version skipped. Then `rebuild` runs before open resolves.
   */
  static async open(kv: Db, schema: SchemaDef, clock: Clock): Promise<LocalStore> {
    const declared = declare(schema);
    const store = new LocalStore(kv, clock, declared);
    // Cursors are read ahead and read again inside the update, so the delete is atomic with the catalog.
    const flagged = await store.cursorsSkippingUnknown();
    const out = await kv.update([CATALOG, ...flagged], ([value, ...cursors], tx) => {
      const prev = value === undefined ? undefined : parseStored(value);
      if (prev !== undefined && prev.version > schema.version) {
        throw new SpacesError("stale-schema", `the stored schema is version ${prev.version}; this tab has ${schema.version}`);
      }
      if (prev !== undefined && prev.version === schema.version) {
        checkSameDeclarations(prev, declared);
        return { stored: prev, bytes: value! };
      }
      const next = reconcile(prev, declared, schema.version, tx);
      if (prev !== undefined && declared.some((d) => prev.collections[d.name] === undefined)) {
        cursors.forEach((c, i) => {
          if (c !== undefined && (decodeCursorValue(c).flags & SKIPPED) !== 0) tx.delete(flagged[i]!);
        });
      }
      const bytes = utf8(JSON.stringify(next));
      tx.put(CATALOG, bytes);
      return { stored: next, bytes };
    });
    store.adopt(out.stored, out.bytes);
    await store.rebuild();
    return store;
  }

  /** Keys of the pull cursors whose flag bit 0 is set. */
  private async cursorsSkippingUnknown(): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for await (const e of this.kv.range(cursorBounds())) if ((decodeCursorValue(e.value).flags & SKIPPED) !== 0) out.push(e.key);
    return out;
  }

  private adopt(stored: StoredCatalog, bytes: Uint8Array): void {
    this.stored = stored;
    this.cat = bind(stored, this.declared, bytes);
    this.byId = new Map([...this.cat.collections.values()].map((c) => [c.id, c]));
  }

  get catalog(): Catalog {
    return this.cat;
  }

  /** Inside every body: another tab's higher version means this tab's index maintenance is out of date. */
  private checkCatalog(value: Uint8Array | undefined): void {
    if (value !== undefined && equalBytes(value, this.cat.bytes)) return;
    const version = value === undefined ? undefined : parseStored(value).version;
    if (version !== this.cat.version) {
      throw new SpacesError("stale-schema", `the stored schema is version ${String(version)}; this tab has ${this.cat.version}`);
    }
  }

  /**
   * Local ops, one kv.update. Reads: catalog, each op's record key and
   * tombstone key, and the manifests of referenced files. The tombstone is
   * read because `keyedRecordId` re-derives ids on purpose: a create of a
   * keyed id that was deleted must fail, not write a live row beside the
   * tombstone. Body, per op:
   *
   *   put:     tomb present           -> throw SpacesError "deleted"
   *            cur = decodeRecord(rec)
   *            create && cur          -> throw (id collision, 2^-64)
   *            !create && !cur        -> throw SpacesError "not-found"
   *            stamp = clock.next(maxStamp(cur, patch.keys()))
   *            next  = applyLocal(cur, coll.name, patch, stamp)
   *            files: manifest.owner ??= id; owner !== id -> throw "file-attached"
   *            put rec(base unchanged), diff index entries,
   *            put outbox 73 04 00 <id> = { tomb: false, coll, stamp }
   *   delete:  no rec -> nothing (idempotent)
   *            put tomb { coll, deletedAt: clock.next() }; delete rec and its entries;
   *            deleteRange richText(id) and outboxRichText(id);
   *            for each file cell: deleteRange chunks, delete manifest and upload entry;
   *            put outbox 73 04 00 <id> = { tomb: true, coll, stamp }
   *
   * A throw aborts the kv transaction: every op lands or none does.
   */
  async write(ops: readonly WriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    const keys: Uint8Array[] = [CATALOG];
    const at: { rec: number; files: number[] }[] = [];
    for (const op of ops) {
      const rec = keys.length;
      keys.push(recordKey(op.coll.id, op.id), tombKey(op.id));
      const files: number[] = [];
      if (op.kind === "put") {
        for (const file of op.files) {
          files.push(keys.length);
          keys.push(fileManifestKey(file));
        }
      }
      at.push({ rec, files });
    }
    await this.kv.update(keys, (vals, tx) => {
      this.checkCatalog(vals[0]);
      const recs = new Overlay<Uint8Array>();
      const tombs = new Overlay<boolean>();
      const manifests = new Map<string, FileManifestValue | undefined>();
      ops.forEach((op, n) => {
        const pos = at[n]!;
        const { coll, id } = op;
        const dead = tombs.get(id, () => vals[pos.rec + 1] !== undefined)!;
        const raw = recs.get(id, () => vals[pos.rec]);
        if (op.kind === "put") {
          if (dead) throw new SpacesError("deleted", `record ${idText(id)} was deleted`);
          const cur = raw === undefined ? undefined : decodeRecord(raw);
          if (op.create && cur !== undefined) throw new SpacesError("validation", `record ${idText(id)} already exists`);
          if (!op.create && cur === undefined) throw new SpacesError("not-found", `record ${idText(id)} does not exist`);
          const stamp = this.clock.next(maxStamp(cur?.state, op.patch.keys()));
          const state = applyLocal(cur?.state, coll.name, op.patch, stamp);
          op.files.forEach((file, i) => {
            const k = keyString(file);
            const manifest = manifests.has(k) ? manifests.get(k) : readManifest(vals[pos.files[i]!]);
            if (manifest === undefined) throw new SpacesError("not-found", "the file is not stored on this device");
            if (manifest.owner !== undefined && !equalBytes(manifest.owner, id)) {
              throw new SpacesError("file-attached", "the file already belongs to another record");
            }
            if (manifest.owner === undefined) {
              const owned = { ...manifest, owner: id };
              tx.put(fileManifestKey(file), writeManifest(owned));
              tx.put(outboxFileKey(OutboxKind.fileUpload, file), EMPTY);
              manifests.set(k, owned);
            } else manifests.set(k, manifest);
          });
          const value = encodeRecord({ readable: isReadable(coll, state), state }, rowFields(coll, state));
          tx.put(recordKey(coll.id, id), value);
          recs.set(id, value);
          const d = diffEntries(indexEntries(coll, id, cur?.state), indexEntries(coll, id, state));
          for (const entry of d.put) tx.put(entry, EMPTY);
          for (const entry of d.del) tx.delete(entry);
          tx.put(outboxRecordKey(id), encodeOutbox({ tomb: false, coll: coll.id, stamp }));
        } else {
          if (raw === undefined) return;
          const cur = decodeRecord(raw);
          const deletedAt = this.clock.next();
          tx.put(tombKey(id), encodeTomb({ coll: coll.name, deletedAt }));
          dropRecord(tx, coll, id, cur.state);
          tx.put(outboxRecordKey(id), encodeOutbox({ tomb: true, coll: coll.id, stamp: deletedAt }));
          recs.set(id, undefined);
          tombs.set(id, true);
        }
      });
    });
  }

  /**
   * A page of remote items, one kv.update, with the cursor in the same
   * batch, so the cursor never claims data that was not applied (and after
   * a power loss both fall back together, see rationale "Sync").
   *
   *   record:   tomb present -> drop
   *             out = mergeRemote(cur, item.state)
   *             out.changed -> put rec(base = max(base, rev)), diff entries
   *             else base < rev -> put rec with only the base raised
   *             server page: out.localAhead ? keep outbox entry : delete it
   *             peer page:   out.changed ? put outbox entry : leave it
   *   tomb:     as local delete, without the outbox entry (the server has it)
   *   richText: tomb present -> drop; else put 73 05 <id> <field> <0> <rev mod 2^32>
   *   cursor:   put 73 07 <space> = { incarnation, through }
   *
   * Items of a collection this app version does not declare never reach
   * this method (the engine skips them). The cursor still moves past them,
   * and `open` resets every cursor when the schema version changes, so
   * the upgraded app pulls them again.
   *
   * The engine pages so one batch stays far below kv's 8 MiB.
   *
   * Every item's id must start with the page's space tag; others are
   * dropped and counted in the result. Cells stamped above `MAX_STAMP_MS`
   * are dropped too: they could never be overwritten.
   */
  async applyRemote(page: RemotePage): Promise<ApplyResult> {
    const server = page.source === "server";
    // An id starts with its space's tag: an item from another space is refused, whoever sent it.
    const tag = page.space.subarray(0, 8);
    const items = page.items.filter((item) => equalBytes(item.id.subarray(0, 8), tag));
    const dropped = page.items.length - items.length;
    const keys: Uint8Array[] = [CATALOG];
    const cursor = page.source === "server" && page.through !== undefined ? cursorKey(page.space) : undefined;
    if (cursor !== undefined) keys.push(cursor);
    type Plan = { coll: BoundCollection | undefined; rec: number; tomb: number; out: number; rt: number; base: number };
    const plan: (Plan | undefined)[] = items.map((item) => {
      const coll =
        item.kind === "record" ? this.cat.collections.get(item.state.coll) : item.kind === "tomb" ? this.cat.collections.get(item.tomb.coll) : undefined;
      if (item.kind === "record" && coll === undefined) return undefined;
      const p: Plan = { coll, rec: -1, tomb: keys.length, out: -1, rt: -1, base: -1 };
      keys.push(tombKey(item.id));
      if (item.kind === "richText") {
        p.rt = keys.length;
        keys.push(richTextKey(item.id, item.field, 0, item.rev));
      } else {
        if (coll !== undefined) {
          p.rec = keys.length;
          keys.push(recordKey(coll.id, item.id));
        }
        p.out = keys.length;
        keys.push(outboxRecordKey(item.id));
        if (item.kind === "record") {
          p.base = keys.length;
          keys.push(baseKey(item.id));
        }
      }
      return p;
    });
    if (items.length === 0 && cursor === undefined) return { dropped };
    await this.kv.update(keys, (vals, tx) => {
      this.checkCatalog(vals[0]);
      const recs = new Overlay<Uint8Array>();
      const tombs = new Overlay<boolean>();
      const outs = new Overlay<Uint8Array>();
      const bases = new Overlay<ServerRev>();
      items.forEach((item, n) => {
        const p = plan[n];
        if (p === undefined) return;
        const { id } = item;
        const dead = tombs.get(id, () => vals[p.tomb] !== undefined)!;
        if (item.kind === "richText") {
          if (!dead && vals[p.rt] === undefined) tx.put(richTextKey(id, item.field, 0, item.rev), item.update);
          return;
        }
        const raw = p.rec < 0 ? undefined : recs.get(id, () => vals[p.rec]);
        const outbox = outs.get(id, () => vals[p.out]);
        if (item.kind === "tomb") {
          if (dead) return;
          this.clock.observe(item.tomb.deletedAt);
          tx.put(tombKey(id), encodeTomb(item.tomb));
          dropRecord(tx, p.coll, id, raw === undefined ? undefined : decodeRecord(raw).state);
          if (outbox !== undefined) tx.delete(outboxRecordKey(id));
          tombs.set(id, true);
          recs.set(id, undefined);
          outs.set(id, undefined);
          bases.set(id, 0 as ServerRev);
          return;
        }
        if (dead) return;
        const coll = p.coll!;
        const state = inRange(item.state);
        for (const cell of state.cells.values()) this.clock.observe(cell.stamp);
        const cur = raw === undefined ? undefined : decodeRecord(raw);
        const out = mergeRemote(cur?.state, state);
        if (out.changed) {
          const value = encodeRecord({ readable: isReadable(coll, out.next), state: out.next }, rowFields(coll, out.next));
          tx.put(recordKey(coll.id, id), value);
          recs.set(id, value);
          const d = diffEntries(indexEntries(coll, id, cur?.state), indexEntries(coll, id, out.next));
          for (const entry of d.put) tx.put(entry, EMPTY);
          for (const entry of d.del) tx.delete(entry);
        }
        // The base has its own key, so raising it alone wakes no watcher.
        const base = bases.get(id, () => decodeBase(vals[p.base]))!;
        if (base < item.rev && (out.changed || raw !== undefined)) {
          tx.put(baseKey(id), encodeBase(item.rev));
          bases.set(id, item.rev);
        }
        if (server) {
          if (!out.localAhead && outbox !== undefined) {
            tx.delete(outboxRecordKey(id));
            outs.set(id, undefined);
          }
        } else if (out.changed) {
          const stamp = newestStamp(out.next);
          if (stamp !== undefined) tx.put(outboxRecordKey(id), encodeOutbox({ tomb: false, coll: coll.id, stamp }));
        }
      });
      if (cursor !== undefined && page.source === "server" && page.through !== undefined) {
        const stored = vals[1] === undefined ? undefined : decodeCursorValue(vals[1]);
        const sameServer = stored !== undefined && equalBytes(stored.incarnation, page.through.incarnation);
        const rev = sameServer && stored.rev >= page.through.rev ? stored.rev : page.through.rev;
        const flags = (sameServer ? stored.flags : 0) | (page.skippedUnknown ? SKIPPED : 0);
        if (!sameServer || rev !== stored.rev || flags !== stored.flags) {
          tx.put(cursor, encodeCursorValue({ incarnation: page.through.incarnation, rev: rev as ServerRev }, flags));
        }
      }
    });
    return { dropped };
  }

  /**
   * Records waiting for the server, in outbox order, with the record or
   * tombstone and the base rev read in one view.
   */
  async pendingRecords(space: SpaceTag, limit: number): Promise<PendingRecord[]> {
    return this.kv.view(async (snap) => {
      const entries: Entry[] = [];
      for await (const e of snap.range({ ...outboxBounds(OutboxKind.record, space), limit })) entries.push(e);
      const rows = await Promise.all(
        entries.map((entry) => {
          const o = decodeOutbox(entry.value);
          const id = idAtEnd(entry.key);
          return Promise.all([snap.get(o.tomb ? tombKey(id) : recordKey(o.coll, id)), o.tomb ? undefined : snap.get(baseKey(id))]);
        }),
      );
      const out: PendingRecord[] = [];
      entries.forEach((entry, i) => {
        const [joined, base] = rows[i]!;
        if (joined === undefined) return;
        const o = decodeOutbox(entry.value);
        const id = idAtEnd(entry.key).slice() as RecordKeyId;
        if (o.tomb) {
          out.push({ kind: "tomb", id, stamp: o.stamp, tomb: decodeTomb(joined) });
          return;
        }
        const coll = this.byId.get(o.coll);
        const hasFiles = coll !== undefined && [...coll.fields.values()].some((f) => f.kind === "file");
        out.push({
          kind: "record",
          id,
          base: decodeBase(base),
          stamp: o.stamp,
          plaintext: stateBytes(joined),
          files: hasFiles ? fileIdsOf(coll, decodeRecord(joined).state) : [],
        });
      });
      return out;
    });
  }

  /**
   * After the server accepted a push as commit `rev` of `space`: raise each
   * record's base to `rev`, and delete its outbox entry if the entry's stamp
   * is still the pushed one. Only the base key and the outbox entry are
   * written, never the record. If the stored cursor is at `rev - 1` it moves
   * to `rev` in the same batch (same incarnation), so the device does not
   * pull its own commit back; a missing or older cursor is left alone. One
   * kv.update. Running it twice changes nothing.
   */
  async acknowledge(space: SpaceBytes, rev: ServerRev, acks: readonly PushAck[]): Promise<void> {
    const keys: Uint8Array[] = [CATALOG, cursorKey(space)];
    for (const ack of acks) {
      keys.push(outboxRecordKey(ack.id));
      if (ack.coll !== "tomb") keys.push(baseKey(ack.id), tombKey(ack.id));
    }
    await this.kv.update(keys, (vals, tx) => {
      this.checkCatalog(vals[0]);
      let i = 2;
      for (const ack of acks) {
        const outbox = vals[i++];
        if (outbox !== undefined && decodeOutbox(outbox).stamp === ack.stamp) tx.delete(outboxRecordKey(ack.id));
        if (ack.coll === "tomb") continue;
        const base = decodeBase(vals[i++]);
        const dead = vals[i++] !== undefined;
        if (!dead && base < rev) tx.put(baseKey(ack.id), encodeBase(rev));
      }
      const stored = vals[1] === undefined ? undefined : decodeCursorValue(vals[1]);
      if (stored !== undefined && stored.rev === rev - 1) {
        tx.put(cursorKey(space), encodeCursorValue({ incarnation: stored.incarnation, rev }, stored.flags));
      }
    });
  }

  async readCursor(space: SpaceBytes): Promise<PullCursor | undefined> {
    const value = await this.kv.get(cursorKey(space));
    if (value === undefined) return undefined;
    const { incarnation, rev } = decodeCursorValue(value);
    return { incarnation, rev };
  }

  /**
   * The server lost data this device holds: it reports another incarnation,
   * or a head below the cursor (restored from a backup). In chunks of 500
   * records, each one kv.update: delete the record's base key and put an
   * outbox entry for every live record and tombstone of the space. The state
   * is the unit, so pushing it all again is correct and idempotent.
   *
   * The cursor `{ incarnation, rev 0 }` is written in the last update only.
   * A crash before it leaves the old cursor, whose incarnation or rev still
   * disagrees with the server, so the engine detects the same loss again and
   * runs this again; chunks already done are idempotent. A crash after it
   * leaves a finished requeue: every record was queued before the cursor
   * moved.
   */
  async requeueSpace(space: SpaceBytes, incarnation: Incarnation): Promise<void> {
    const tag = space.subarray(0, 8) as SpaceTag;
    for (const coll of this.cat.collections.values()) {
      await this.eachChunk(recordBounds(coll.id, tag), async (keys) => {
        await this.kv.update([CATALOG, ...keys], (vals, tx) => {
          this.checkCatalog(vals[0]);
          keys.forEach((key, i) => {
            const value = vals[i + 1];
            if (value === undefined) return;
            const id = idAtEnd(key);
            tx.delete(baseKey(id));
            const stamp = newestStamp(decodeRecord(value).state);
            if (stamp !== undefined) tx.put(outboxRecordKey(id), encodeOutbox({ tomb: false, coll: coll.id, stamp }));
          });
        });
      });
    }
    await this.eachChunk(tombBounds(tag), async (_keys, entries) => {
      await this.kv.update([CATALOG], ([catalog], tx) => {
        this.checkCatalog(catalog);
        for (const e of entries) {
          const tomb = decodeTomb(e.value);
          const coll = this.cat.collections.get(tomb.coll);
          if (coll !== undefined) {
            tx.put(outboxRecordKey(idAtEnd(e.key)), encodeOutbox({ tomb: true, coll: coll.id, stamp: tomb.deletedAt }));
          }
        }
      });
    });
    await this.kv.update([CATALOG], ([catalog], tx) => {
      this.checkCatalog(catalog);
      tx.put(cursorKey(space), encodeCursorValue({ incarnation, rev: 0 as ServerRev }, 0));
    });
  }

  /**
   * Scans `bounds` in chunks of 500 entries or 4 MiB, one view each, and
   * hands the keys and entries that pass `keep` to `step`.
   */
  private async eachChunk(
    bounds: KeyBounds,
    step: (keys: Uint8Array[], entries: Entry[]) => Promise<void>,
    keep?: (entry: Entry) => boolean,
  ): Promise<void> {
    let start = bounds.start!;
    for (;;) {
      const entries: Entry[] = [];
      let last: Uint8Array | undefined;
      await this.kv.view(async (snap) => {
        let bytes = 0;
        const range = bounds.endExclusive === undefined ? { start } : { start, endExclusive: bounds.endExclusive };
        for await (const entry of snap.range({ ...range, limit: RECORD_CHUNK })) {
          last = entry.key;
          if (keep === undefined || keep(entry)) entries.push(entry);
          bytes += entry.key.length + entry.value.length;
          if (bytes >= CHUNK_BYTES) break;
        }
      });
      if (last === undefined) return;
      if (entries.length > 0) {
        await step(
          entries.map((e) => e.key),
          entries,
        );
      }
      start = after(last);
    }
  }

  // ---- rich text (for RichTextFields and the engine) ----------------------

  /**
   * One local Yjs update:
   *   kv.update([tombKey(id)], ([tomb], tx) => {
   *     if (tomb) throw SpacesError "not-found";
   *     tx.put(richTextKey(id, field, origin, seq), update);
   *     tx.put(outboxRichTextKey(id, field, origin, seq), EMPTY);
   *   })
   * The tombstone check is inside the transaction, so no write lands after
   * a delete, whatever order the awaits run in.
   */
  async appendRichText(id: RecordKeyId, field: FieldHash, origin: number, seq: number, update: Uint8Array): Promise<void> {
    await this.kv.update([tombKey(id)], ([tomb], tx) => {
      if (tomb !== undefined) throw new SpacesError("not-found", `record ${idText(id)} was deleted`);
      tx.put(richTextKey(id, field, origin, seq), update);
      tx.put(outboxRichTextKey(id, field, origin, seq), EMPTY);
    });
  }

  /** One view + one range: every stored update of the field, and the snapshot seq for a later trim. */
  async loadRichText(
    id: RecordKeyId,
    field: FieldHash,
  ): Promise<{ readonly updates: Uint8Array[]; readonly through: number; readonly unpushed: number }> {
    return this.kv.view(async (snap) => {
      const updates: Uint8Array[] = [];
      for await (const e of snap.range(richTextBounds(id, field))) updates.push(e.value);
      return { updates, through: snap.seq, unpushed: await snap.count(outboxRichTextBounds(id, field)) };
    });
  }

  /**
   * deleteRange(field prefix, { through }) + put(state), in one batch, only if the field's outbox is empty and
   * the record is not deleted. Returns false and writes nothing otherwise.
   * Updates written after `through` survive the range delete, so an update
   * that lands between the check and the batch is kept.
   */
  async trimRichText(id: RecordKeyId, field: FieldHash, through: number, origin: number, seq: number, state: Uint8Array): Promise<boolean> {
    if ((await this.kv.count(outboxRichTextBounds(id, field))) > 0) return false;
    return this.kv.update([tombKey(id)], ([tomb], tx) => {
      if (tomb !== undefined) return false;
      tx.deleteRange(richTextBounds(id, field), { through });
      tx.put(richTextKey(id, field, origin, seq), state);
      return true;
    });
  }

  /** The engine's push input: per (record, field), the unpushed updates and their outbox keys. */
  async pendingRichText(
    space: SpaceTag,
    limit: number,
  ): Promise<{ readonly id: RecordKeyId; readonly field: FieldHash; readonly updates: Uint8Array[]; readonly outboxKeys: Uint8Array[] }[]> {
    const rows = await this.kv.rangeJoin({ ...outboxBounds(OutboxKind.richText, space), limit }, (entry) =>
      concat(Uint8Array.of(ROOT, Tag.richText), entry.key.subarray(3)),
    );
    const groups = new Map<string, { id: RecordKeyId; field: FieldHash; updates: Uint8Array[]; outboxKeys: Uint8Array[] }>();
    for (const { entry, joined } of rows) {
      const at = entry.key;
      const group = keyString(at.subarray(3, 3 + 16 + 4));
      let g = groups.get(group);
      if (g === undefined) {
        const field = new DataView(at.buffer, at.byteOffset, at.byteLength).getUint32(3 + 16) as FieldHash;
        g = { id: at.slice(3, 3 + 16) as RecordKeyId, field, updates: [], outboxKeys: [] };
        groups.set(group, g);
      }
      if (joined !== undefined) g.updates.push(joined);
      g.outboxKeys.push(at);
    }
    return [...groups.values()];
  }

  /** After the server appended them: delete exactly these outbox entries. */
  async acknowledgeRichText(outboxKeys: readonly Uint8Array[]): Promise<void> {
    await this.kv.batch((tx) => {
      for (const key of outboxKeys) tx.delete(key);
    });
  }

  // ---- files (for FileStore and the engine) --------------------------------

  /** Sealed chunks, at most 6 per call (one kv batch, below 8 MiB). `manifest` goes in the batch with the last chunks. */
  async putFileChunks(file: FileKeyId, from: number, chunks: readonly Uint8Array[], manifest: FileManifestValue | undefined): Promise<void> {
    await this.kv.update([fileManifestKey(file)], ([stored], tx) => {
      chunks.forEach((chunk, i) => tx.put(fileChunkKey(file, from + i), chunk));
      if (manifest === undefined) return;
      const owner = manifest.owner ?? readManifest(stored)?.owner;
      tx.put(fileManifestKey(file), writeManifest({ ...manifest, ...(owner === undefined ? {} : { owner }) }));
      if (manifest.have === manifest.chunks) tx.delete(outboxFileKey(OutboxKind.fileWant, file));
    });
  }

  async readFileChunks(file: FileKeyId, from: number, count: number): Promise<(Uint8Array | undefined)[]> {
    return this.kv.view((snap) => Promise.all(Array.from({ length: count }, (_, i) => snap.get(fileChunkKey(file, from + i)))));
  }

  async readManifest(file: FileKeyId): Promise<FileManifestValue | undefined> {
    return readManifest(await this.kv.get(fileManifestKey(file)));
  }

  /** A tab wants a remote file: put 73 04 04 <file>. Deleted by `putFileChunks` once the download completes. */
  async wantFile(file: FileKeyId): Promise<void> {
    await this.kv.put(outboxFileKey(OutboxKind.fileWant, file), EMPTY);
  }

  /** Attached files whose upload is queued (73 04 03), and the files some tab wants (73 04 04). */
  async pendingFiles(kind: "upload" | "want", limit: number): Promise<FileKeyId[]> {
    const out: FileKeyId[] = [];
    const bounds = outboxBounds(kind === "upload" ? OutboxKind.fileUpload : OutboxKind.fileWant);
    for await (const e of this.kv.range({ ...bounds, limit })) out.push(e.key.slice(3) as FileKeyId);
    return out;
  }

  async acknowledgeUpload(file: FileKeyId): Promise<void> {
    await this.kv.delete(outboxFileKey(OutboxKind.fileUpload, file));
  }

  // ---- reads ----------------------------------------------------------------

  /** One kv get, the fields slice parsed. No validation, no crypto. With `resolve`, one view instead, and its refs loaded from the same snapshot. */
  async get(coll: BoundCollection, id: RecordKeyId, resolve?: ResolvePlan): Promise<{ readonly id: string } | undefined> {
    const key = recordKey(coll.id, id);
    if (resolve === undefined) {
      const value = await this.kv.get(key);
      const fields = value === undefined ? undefined : readFields(value);
      return fields === undefined ? undefined : toRow(idText(id) as RecordId, fields);
    }
    return this.kv.view(async (snap) => {
      const value = await snap.get(key);
      const fields = value === undefined ? undefined : readFields(value);
      if (fields === undefined) return undefined;
      const row = toRow(idText(id) as RecordId, fields) as RowObject;
      await this.resolveRows(snap, [row], resolve);
      return row;
    });
  }

  async status(coll: BoundCollection, id: RecordKeyId): Promise<RecordStatus> {
    return this.kv.view(async (snap) => {
      const [rec, tomb] = await Promise.all([snap.get(recordKey(coll.id, id)), snap.get(tombKey(id))]);
      if (tomb !== undefined) return "deleted";
      if (rec === undefined) return "missing";
      return (rec[0]! & 1) === 1 ? "live" : "unreadable";
    });
  }

  /**
   * One kv view: the range over index entries (each joined to its row with
   * a batch of `snap.get`s) or over `73 01` records, the filter, then each
   * resolve level as one batch of `snap.get`s.
   */
  async query(plan: QueryPlan): Promise<QueryResult> {
    const { coll, source, range, reverse, limit, filter, resolve } = plan;
    if (limit === 0) return { rows: [], nextKey: undefined };
    const want = limit === undefined ? Infinity : limit + 1;
    const chunk = limit === undefined ? 128 : Math.min(limit + 1, 128);
    return this.kv.view(async (snap) => {
      const rows: RowObject[] = [];
      const keys: Uint8Array[] = [];
      let pending: Entry[] = [];
      const flush = async (): Promise<boolean> => {
        const batch = pending;
        pending = [];
        const values =
          source.kind === "index"
            ? await Promise.all(batch.map((e) => snap.get(recordKey(coll.id, idAtEnd(e.key)))))
            : batch.map((e) => e.value);
        for (let i = 0; i < batch.length; i++) {
          const value = values[i];
          const fields = value === undefined ? undefined : readFields(value);
          if (fields === undefined) continue;
          const key = batch[i]!.key;
          const row = toRow(idText(idAtEnd(key)) as RecordId, fields) as RowObject;
          if (filter !== undefined && !filter(row)) continue;
          rows.push(row);
          keys.push(key);
          if (rows.length >= want) return true;
        }
        return false;
      };
      let full = false;
      for await (const entry of snap.range({ ...boundsOf(range), ...(reverse ? { reverse } : {}) })) {
        pending.push(entry);
        if (pending.length >= chunk && (full = await flush())) break;
      }
      if (!full && pending.length > 0) full = await flush();
      const more = full && limit !== undefined;
      if (more) {
        rows.length = limit;
        keys.length = limit;
      }
      if (resolve !== undefined) await this.resolveRows(snap, rows, resolve);
      return { rows, nextKey: more ? keys[limit - 1] : undefined };
    });
  }

  /** One level of refs: the targets of every row are read as one batch, then their own refs, level by level. */
  private async resolveRows(snap: ViewSnapshot, rows: readonly RowObject[], plan: ResolvePlan): Promise<void> {
    await Promise.all(
      [...plan].map(async ([field, { target, nested }]) => {
        const wanted = new Set<string>();
        for (const row of rows) {
          const v = row[field];
          if (isIdText(v)) wanted.add(v);
        }
        const loaded = new Map<string, RowObject | undefined>();
        await Promise.all(
          [...wanted].map(async (text) => {
            const value = await snap.get(recordKey(target.id, recordBytes(text as RecordId)));
            const fields = value === undefined ? undefined : readFields(value);
            loaded.set(text, fields === undefined ? undefined : (toRow(text as RecordId, fields) as RowObject));
          }),
        );
        if (nested !== undefined) {
          await this.resolveRows(snap, [...loaded.values()].filter((r): r is RowObject => r !== undefined), nested);
        }
        for (const row of rows) {
          const v = row[field];
          row[field] = isIdText(v) ? loaded.get(v) : undefined;
        }
      }),
    );
  }

  /** Lowers a typed query to a plan (pure; tuple-encodes `eq` and the bound). */
  plan(coll: BoundCollection, q: QueryInput): QueryPlan {
    if (q.limit !== undefined && (!Number.isSafeInteger(q.limit) || q.limit < 0)) {
      throw new SpacesError("validation", "limit must be a non-negative integer");
    }
    let source: QueryPlan["source"];
    let bounds: KeyBounds;
    if (q.index !== undefined) {
      const index = coll.indexes.find((i) => i.name === q.index);
      if (index === undefined) throw new SpacesError("validation", `${coll.name} has no index "${q.index}"`);
      if (index.state !== "ready") throw new SpacesError("schema", `index "${index.name}" is still building`);
      if (q.space !== undefined) throw new SpacesError("validation", "an index query does not take a space");
      source = { kind: "index", index };
      bounds = tupleRange(indexBounds(coll.id, index.id).start!, index.by.length, q);
    } else {
      if (q.eq !== undefined || q.gt !== undefined || q.gte !== undefined || q.lt !== undefined || q.lte !== undefined || q.startsWith !== undefined) {
        throw new SpacesError("validation", "a bound needs an index");
      }
      source = { kind: "records" };
      bounds = recordBounds(coll.id, q.space);
    }
    const reverse = q.reverse === true;
    if (q.after !== undefined) {
      const key = fromBase64url(q.after);
      const inside =
        key !== undefined &&
        compareBytes(key, bounds.start!) >= 0 &&
        (bounds.endExclusive === undefined || compareBytes(key, bounds.endExclusive) < 0);
      if (key === undefined || !inside) throw new SpacesError("validation", "the cursor is not from this query");
      bounds = reverse ? { start: bounds.start!, endExclusive: key } : boundsFrom(after(key), bounds.endExclusive);
    }
    return { coll, source, range: bounds, reverse, limit: q.limit, filter: undefined, resolve: undefined };
  }

  /**
   * Calls `onChange` (coalesced per microtask) after any kv change event
   * with a put or delete under `73 01 <coll.id>`, or a `gap`. Listens to
   * kv.changes, so it sees this tab, other tabs and remote applies alike.
   */
  watch(coll: BoundCollection, onChange: () => void): () => void {
    let queued = false;
    let live = true;
    const fire = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (live) onChange();
      });
    };
    const mine = recordBounds(coll.id);
    const stop = this.kv.changes((event) => {
      if (event.kind === "gap") return fire();
      if (event.kind !== "append") return;
      for (const op of event.ops) {
        if (op.type === "deleteRange") {
          if ((op.endExclusive === undefined || compareBytes(op.endExclusive, mine.start!) > 0) && compareBytes(op.start, mine.endExclusive!) < 0) return fire();
        } else if (op.key[0] === ROOT && op.key[1] === Tag.record && op.key[2] === coll.id) return fire();
      }
    });
    return () => {
      live = false;
      stop();
    };
  }

  /**
   * Fills `building` indexes in chunks of 500 records or 4 MiB, each one
   * kv.update that re-derives entries from the records it read, then marks
   * the indexes ready in the catalog. Idempotent, and restartable from
   * scratch after a crash. Indexes that were kept across a version bump
   * keep their entries and cost nothing here.
   *
   * When the stored version has no finished upgrade pass, it also visits
   * the records that hold an invalid cell (flag in the record value) and
   * re-validates their cells with the current validators, refreshing the
   * readable flag and the entries of every index. A collection whose field
   * signature changed (a field added with a default or as required, or a
   * default changed) is re-encoded in full instead, to materialize defaults
   * into the fields slice. A value an older app version could not read
   * becomes visible after the upgrade, and reads never fill defaults.
   */
  private async rebuild(): Promise<void> {
    const pass = this.stored.pass < this.stored.version;
    const owed = [...this.cat.collections.values()].some((c) => c.indexes.some((i) => i.state === "building"));
    if (!pass && !owed) return;
    for (const coll of this.cat.collections.values()) {
      const building = coll.indexes.filter((i) => i.state === "building");
      const full = pass && this.stored.collections[coll.name]!.rewrite === true;
      const fill: BoundCollection = { ...coll, indexes: building };
      const ready: BoundCollection = { ...coll, indexes: coll.indexes.filter((i) => i.state === "ready") };
      const wanted = (e: Entry) => full || building.length > 0 || (pass && hasInvalidCell(e.value));
      await this.eachChunk(
        recordBounds(coll.id),
        async (keys) => {
          await this.kv.update([CATALOG, ...keys], (vals, tx) => {
            this.checkCatalog(vals[0]);
            keys.forEach((key, i) => {
              const value = vals[i + 1];
              if (value === undefined) return;
              const id = idAtEnd(key);
              const cur = decodeRecord(value);
              let state = cur.state;
              if (full || (pass && hasInvalidCell(value))) {
                state = this.revalidate(coll, state);
                const next = encodeRecord({ readable: isReadable(coll, state), state }, rowFields(coll, state));
                if (!equalBytes(next, value)) tx.put(key, next);
                const d = diffEntries(indexEntries(ready, id, cur.state), indexEntries(ready, id, state));
                for (const entry of d.put) tx.put(entry, EMPTY);
                for (const entry of d.del) tx.delete(entry);
              }
              for (const entry of indexEntries(fill, id, state)) tx.put(entry, EMPTY);
            });
          });
        },
        wanted,
      );
    }
    const done = await this.kv.update([CATALOG], ([value], tx) => {
      if (value === undefined) throw new SpacesError("stale-schema", "the catalog is gone");
      const stored = parseStored(value);
      if (stored.version !== this.stored.version) {
        throw new SpacesError("stale-schema", `the stored schema is version ${stored.version}; this tab has ${this.stored.version}`);
      }
      stored.pass = stored.version;
      for (const c of Object.values(stored.collections)) {
        delete c.rewrite;
        for (const ix of Object.values(c.indexes)) ix.state = "ready";
      }
      const bytes = utf8(JSON.stringify(stored));
      if (!equalBytes(bytes, value)) tx.put(CATALOG, bytes);
      return { stored, bytes };
    });
    this.adopt(done.stored, done.bytes);
  }

  /** Every cell checked again by the current validators. A field this version does not declare is kept, hidden. */
  private revalidate(coll: BoundCollection, state: RecordState): RecordState {
    const cells = new Map<string, Cell>();
    for (const [name, cell] of state.cells) {
      const valid = cell.value === UNSET ? true : (coll.fields.get(name)?.validate(cell.value).ok ?? false);
      cells.set(name, valid === cell.valid ? cell : { ...cell, valid });
    }
    return { coll: state.coll, cells };
  }
}

/** The state without the cells whose stamp is beyond the fixed bound. */
function inRange(state: RecordState): RecordState {
  let cells: Map<string, Cell> | undefined;
  for (const [name, cell] of state.cells) {
    if (!stampInRange(cell.stamp)) {
      cells ??= new Map(state.cells);
      cells.delete(name);
    }
  }
  return cells === undefined ? state : { coll: state.coll, cells };
}

const boundsFrom = (start: Uint8Array, endExclusive: Uint8Array | undefined): KeyBounds =>
  endExclusive === undefined ? { start } : { start, endExclusive };

/** The untyped query `db.ts` passes down after the types did their job. */
export type QueryInput = {
  readonly index?: string | undefined;
  readonly space?: SpaceTag | undefined;
  readonly eq?: readonly Scalar[] | undefined;
  readonly gt?: Scalar | undefined;
  readonly gte?: Scalar | undefined;
  readonly lt?: Scalar | undefined;
  readonly lte?: Scalar | undefined;
  readonly startsWith?: string | undefined;
  readonly limit?: number | undefined;
  readonly after?: string | undefined;
  readonly reverse?: boolean | undefined;
};
