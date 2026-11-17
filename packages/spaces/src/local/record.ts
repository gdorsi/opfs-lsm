/**
 * The record format, one encoding for disk and wire.
 *
 * A record is a map of cells, one per field. A cell is a value (or UNSET)
 * with the stamp of the write that set it. Merging two records takes, for
 * each field, the cell with the larger stamp (`merge.ts`). A cell is
 * `valid` when this app version's validator accepts its value. Only valid
 * cells reach the slice reads parse, so reads never validate.
 *
 * RecordValue, the kv value at `73 01 <coll> <id>`:
 *
 *   [0]       flags      bit 0: readable (every required field holds a valid, set cell)
 *                        bit 1: some cell is invalid (the upgrade pass revisits these records)
 *   [1..5)    metaLen    u32 BE
 *   [5..)     meta       utf8 JSON { "c": collection name,
 *                                     "s": { field: Stamp },          every cell's stamp, set or unset
 *                                     "u"?: [field],                  valid cells that are unset
 *                                     "x"?: { field: [] | [value] } } invalid cells: [] is UNSET
 *   [..end)   fields     utf8 JSON { field: value }                  valid, set cells, plus materialized defaults
 *
 * The ServerRev a state includes lives at its own key (`73 0B`), so an
 * acknowledgement never rewrites the record.
 *
 * A read decodes only `fields`: `JSON.parse(utf8(value.subarray(5 + metaLen)))`.
 * The wire plaintext of a record is `value.subarray(1)`, the bytes from
 * metaLen on, exactly. A push encrypts it without re-encoding. A receiver
 * parses meta and fields together, so cells that are invalid for the
 * sender (in "x") can be valid for the receiver, and the other way round.
 * A field that is in the fields slice but in no cell is a default, not a
 * cell, and an unset cell stays unset when a default is added later.
 *
 * Validators must be idempotent: a validator's output is a valid input that
 * maps to itself. The store keeps outputs on a local write and keeps wire
 * values as they came on a remote apply, so a transform that does not map
 * its own output to itself makes devices disagree. Use `z.iso.datetime()`
 * or a number for dates, never `z.date()`.
 */

import { concat, fromUtf8, readU32, u32, utf8 } from "../bytes.js";
import { SpacesError } from "../errors.js";
import type { Brand, RecordId } from "../ids.js";
import type { ServerRev } from "../sync/protocol.js";
import type { CollId } from "./keys.js";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

// ---------------------------------------------------------------------------
// Stamps

/**
 * 12 bytes: wall-clock ms (48 bits) | counter (16 bits) | tab session (32
 * bits), written as 16 chars of order-preserving base64 (alphabet
 * "-0-9A-Z_a-z" in ASCII order), so string comparison is byte comparison.
 *
 * The session is random per tab instance and only breaks ties, so tabs
 * never coordinate on clocks (separate-before-serializing-shared-state).
 * Two equal stamps on different values would need the same ms, counter and
 * 32-bit session.
 */
export type Stamp = Brand<string, "Stamp">;
export type StampBytes = Brand<Uint8Array, "StampBytes">;

const ALPHABET = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
const SIX = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) SIX[ALPHABET.charCodeAt(i)] = i;
const STAMP_CHARS = 16;
/** The year 3000 in ms. A fixed bound, so every replica refuses the same stamps. */
export const MAX_STAMP_MS = 32_503_680_000_000;
const STAMP_SHAPE = /^[-0-9A-Z_a-z]{16}$/;

/** True for the text a Clock writes. */
export const isStamp = (text: unknown): text is Stamp => typeof text === "string" && STAMP_SHAPE.test(text);

/** Eight base-64 digits of `n` < 2^48, most significant first. */
function digits48(n: number): string {
  let out = "";
  for (let shift = 7; shift >= 0; shift--) out += ALPHABET[Math.floor(n / 64 ** shift) % 64]!;
  return out;
}

function formatStamp(ms: number, counter: number, session: number): Stamp {
  return (digits48(ms) + digits48(counter * 4294967296 + session)) as Stamp;
}

function msOf(stamp: Stamp): number {
  let n = 0;
  for (let i = 0; i < 8; i++) n = n * 64 + SIX[stamp.charCodeAt(i)]!;
  return n;
}

/** False for a stamp above `MAX_STAMP_MS`: such a cell could never be overwritten. */
export const stampInRange = (stamp: Stamp): boolean => msOf(stamp) <= MAX_STAMP_MS;

function counterOf(stamp: Stamp): number {
  return (
    (SIX[stamp.charCodeAt(8)]! << 10) | (SIX[stamp.charCodeAt(9)]! << 4) | (SIX[stamp.charCodeAt(10)]! >> 2)
  );
}

/**
 * A hybrid logical clock, one per tab, in memory only. It needs no
 * persistence:
 * - a stamp is issued inside the kv.update body that writes it, as
 *   `next(floor)` with `floor` the largest stamp among the cells it
 *   overwrites, so a local write always beats the value it replaced,
 *   whatever the wall clocks say;
 * - after a restart, even one that lost acked writes, the wall clock has
 *   moved past them.
 * Only a wall clock set back across a restart can issue a stamp below one
 * already issued, and that stamp loses to the older write on the same field.
 */
export class Clock {
  private lastMs = -1;
  private lastCounter = 0;

  /** `now` is for tests that need a wall clock they control. */
  constructor(
    readonly session: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Strictly greater than every stamp this clock issued or observed, and than `floor`. */
  next(floor?: Stamp): Stamp {
    this.observe(floor);
    const ms = Math.min(this.now(), MAX_STAMP_MS);
    if (ms > this.lastMs) {
      this.lastMs = ms;
      this.lastCounter = 0;
    } else if (this.lastCounter === 0xffff) {
      // Out of room: past the bound the ms stays put (the year 3000).
      if (this.lastMs < MAX_STAMP_MS) {
        this.lastMs++;
        this.lastCounter = 0;
      }
    } else {
      this.lastCounter++;
    }
    return formatStamp(this.lastMs, this.lastCounter, this.session);
  }

  /** Called with each remote stamp applied, so later local stamps follow it. */
  observe(stamp: Stamp | undefined): void {
    if (stamp === undefined) return;
    const ms = msOf(stamp);
    if (ms > MAX_STAMP_MS) return;
    if (ms > this.lastMs) {
      this.lastMs = ms;
      this.lastCounter = counterOf(stamp);
    } else if (ms === this.lastMs) {
      this.lastCounter = Math.max(this.lastCounter, counterOf(stamp));
    }
  }
}

export function compareStamps(a: Stamp, b: Stamp): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stampBytes(stamp: Stamp): StampBytes {
  const out = new Uint8Array(12);
  for (let i = 0, o = 0; i < STAMP_CHARS; i += 4, o += 3) {
    const n =
      (SIX[stamp.charCodeAt(i)]! << 18) |
      (SIX[stamp.charCodeAt(i + 1)]! << 12) |
      (SIX[stamp.charCodeAt(i + 2)]! << 6) |
      SIX[stamp.charCodeAt(i + 3)]!;
    out[o] = n >> 16;
    out[o + 1] = (n >> 8) & 0xff;
    out[o + 2] = n & 0xff;
  }
  return out as StampBytes;
}

// ---------------------------------------------------------------------------
// Cells and records

export const UNSET: unique symbol = Symbol("unset");
export type CellValue = Json | typeof UNSET;

export type Cell = {
  readonly stamp: Stamp;
  readonly value: CellValue;
  /** Accepted by this app version's validator for the field. Recomputed when the schema version changes (`store.ts` upgrade pass). */
  readonly valid: boolean;
};

export type RecordState = {
  /** Collection name, the same in every app version, unlike `CollId`. */
  readonly coll: string;
  readonly cells: ReadonlyMap<string, Cell>;
};

export type StoredRecord = {
  readonly readable: boolean;
  readonly state: RecordState;
};

const HEAD = 5;
const READABLE = 1;
const HAS_INVALID = 2;

function writeU64(out: Uint8Array, at: number, n: number): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(at, Math.floor(n / 4294967296));
  view.setUint32(at + 4, n >>> 0);
}

function readU64At(bytes: Uint8Array, at: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
}

/** The value at `73 0B`. */
export function encodeBase(rev: ServerRev): Uint8Array {
  const out = new Uint8Array(8);
  writeU64(out, 0, rev);
  return out;
}
/** Absent means 0: never pulled or pushed. */
export const decodeBase = (bytes: Uint8Array | undefined): ServerRev => (bytes === undefined ? 0 : readU64At(bytes, 0)) as ServerRev;

/**
 * `fields` is the fields slice to store: `rowFields(coll, state)`, which
 * adds the schema's defaults. Without it the slice holds the valid, set
 * cells only.
 */
export function encodeRecord(record: StoredRecord, fields?: { readonly [field: string]: Json }): Uint8Array {
  const stamps: { [field: string]: string } = {};
  const invalid: { [field: string]: Json[] } = {};
  const unset: string[] = [];
  let anyInvalid = false;
  const own: { [field: string]: Json } = {};
  for (const [name, cell] of record.state.cells) {
    stamps[name] = cell.stamp;
    if (!cell.valid) {
      invalid[name] = cell.value === UNSET ? [] : [cell.value];
      anyInvalid = true;
    } else if (cell.value !== UNSET) own[name] = cell.value;
    else unset.push(name);
  }
  const meta = utf8(
    JSON.stringify({
      c: record.state.coll,
      s: stamps,
      ...(unset.length > 0 ? { u: unset } : {}),
      ...(anyInvalid ? { x: invalid } : {}),
    }),
  );
  const body = utf8(JSON.stringify(fields ?? own));
  const out = new Uint8Array(HEAD + meta.length + body.length);
  out[0] = (record.readable ? READABLE : 0) | (anyInvalid ? HAS_INVALID : 0);
  out.set(u32(meta.length), 1);
  out.set(meta, HEAD);
  out.set(body, HEAD + meta.length);
  return out;
}

type Meta = {
  readonly c: string;
  readonly s: { readonly [field: string]: Stamp };
  readonly u?: readonly string[];
  readonly x?: { readonly [field: string]: readonly Json[] };
};
type Fields = { readonly [field: string]: Json };

/** One kind of cell a state holds, from the three parts of the format. */
function cellsOf(meta: Meta, fields: Fields): Map<string, { stamp: Stamp; value: CellValue; valid: boolean }> {
  const cells = new Map<string, { stamp: Stamp; value: CellValue; valid: boolean }>();
  const unset = new Set(meta.u);
  for (const name of Object.keys(meta.s)) {
    const stamp = meta.s[name]!;
    const x = meta.x?.[name];
    if (x !== undefined) cells.set(name, { stamp, value: x.length === 0 ? UNSET : x[0]!, valid: false });
    else cells.set(name, { stamp, value: !unset.has(name) && name in fields ? fields[name]! : UNSET, valid: true });
  }
  return cells;
}

/** Whole value, for merges. */
export function decodeRecord(value: Uint8Array): StoredRecord {
  const metaLen = readU32(value, 1);
  const meta = JSON.parse(fromUtf8(value.subarray(HEAD, HEAD + metaLen))) as Meta;
  const fields = JSON.parse(fromUtf8(value.subarray(HEAD + metaLen))) as Fields;
  return {
    readable: (value[0]! & READABLE) !== 0,
    state: { coll: meta.c, cells: cellsOf(meta, fields) },
  };
}

/** The read path: the fields slice of a readable record as the row's data, or undefined when the record is not readable. */
export function readFields(value: Uint8Array): { [field: string]: Json } | undefined {
  if ((value[0]! & READABLE) === 0) return undefined;
  return JSON.parse(fromUtf8(value.subarray(HEAD + readU32(value, 1)))) as { [field: string]: Json };
}

/** The wire plaintext: a view of `value` from byte 1, no copy. */
export function stateBytes(value: Uint8Array): Uint8Array {
  return value.subarray(1);
}

/** Some cell of the stored record is invalid for the app version that stored it. */
export const hasInvalidCell = (value: Uint8Array): boolean => (value[0]! & HAS_INVALID) !== 0;

/**
 * A record state as it arrives from the wire, before validation: every
 * cell from the sender's "s", "x" and fields, with no `valid` yet.
 * `sync/engine.ts` validates it with the schema's field validators and
 * turns it into a `RecordState`.
 */
export type WireState = {
  readonly coll: string;
  readonly cells: ReadonlyMap<string, { readonly stamp: Stamp; readonly value: CellValue }>;
};

const isObject = (v: unknown): v is { [key: string]: unknown } => typeof v === "object" && v !== null && !Array.isArray(v);

export function decodeWireState(plaintext: Uint8Array): WireState {
  try {
    const metaLen = readU32(plaintext, 0);
    const meta: unknown = JSON.parse(fromUtf8(plaintext.subarray(4, 4 + metaLen)));
    const fields: unknown = JSON.parse(fromUtf8(plaintext.subarray(4 + metaLen)));
    if (!isObject(meta) || typeof meta["c"] !== "string" || !isObject(meta["s"]) || !isObject(fields)) throw new Error("shape");
    const x = meta["x"];
    if (x !== undefined && !isObject(x)) throw new Error("shape");
    const u = meta["u"];
    if (u !== undefined && !Array.isArray(u)) throw new Error("shape");
    const unset = new Set<unknown>(u);
    for (const stamp of Object.values(meta["s"])) if (!isStamp(stamp)) throw new Error("stamp");
    const cells = new Map<string, { stamp: Stamp; value: CellValue }>();
    for (const [name, stamp] of Object.entries(meta["s"] as { [f: string]: Stamp })) {
      const invalid = x?.[name];
      if (Array.isArray(invalid)) cells.set(name, { stamp, value: invalid.length === 0 ? UNSET : (invalid[0] as Json) });
      else cells.set(name, { stamp, value: !unset.has(name) && name in fields ? (fields[name] as Json) : UNSET });
    }
    return { coll: meta["c"], cells };
  } catch {
    throw new SpacesError("protocol", "a record state is malformed");
  }
}

// ---------------------------------------------------------------------------
// Tombstones and outbox entries

/** The value at `73 02 <id>`, and the plaintext of a tombstone on the wire. Kept forever. */
export type TombValue = { readonly coll: string; readonly deletedAt: Stamp };
export function encodeTomb(tomb: TombValue): Uint8Array {
  return utf8(JSON.stringify({ c: tomb.coll, d: tomb.deletedAt }));
}
export function decodeTomb(bytes: Uint8Array): TombValue {
  try {
    const v: unknown = JSON.parse(fromUtf8(bytes));
    if (!isObject(v) || typeof v["c"] !== "string" || !isStamp(v["d"])) throw new Error("shape");
    return { coll: v["c"], deletedAt: v["d"] };
  } catch {
    throw new SpacesError("protocol", "a tombstone is malformed");
  }
}

/**
 * The value at `73 04 00 <id>`: what to push for the record, and the stamp
 * of its latest local change. A push clears the entry only if the stamp is
 * still the one it pushed, so a change made during the push stays queued.
 * The stamp also tells push which record key to read: `coll` for a live
 * record, the tombstone key when `tomb`.
 */
export type OutboxValue = { readonly tomb: boolean; readonly coll: CollId; readonly stamp: Stamp };
/** tomb u8 | coll u8 | stamp, 16 ASCII chars. */
export function encodeOutbox(value: OutboxValue): Uint8Array {
  return concat(Uint8Array.of(value.tomb ? 1 : 0, value.coll), utf8(value.stamp));
}
export function decodeOutbox(bytes: Uint8Array): OutboxValue {
  return { tomb: bytes[0] === 1, coll: bytes[1] as CollId, stamp: fromUtf8(bytes.subarray(2)) as Stamp };
}

/**
 * The row object handed to the app: the fields slice plus the id. It takes
 * the freshly parsed `fields` object over, so nothing is copied.
 */
export function toRow(id: RecordId, fields: { [field: string]: Json }): { readonly id: RecordId } {
  return Object.assign(fields, { id });
}
