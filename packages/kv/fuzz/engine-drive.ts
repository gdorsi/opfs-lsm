/**
 * Engine cases and the host that drives them, shared by the seeded tests
 * (`xorshift`), the Jazzer.js engine targets (`bytesSource`) and the engine
 * gate: entry lists, corrupt runs and blocks, pattern lists, and merge
 * sessions fed in any order, with early pumps, wrong-length feeds, and the
 * calls a host must not make. A driver returns a transcript, one line per
 * stop, which two builds of the engine must agree on.
 */
import type { EngineExports } from "../src/store/engine.js";
import { blocksOf, fixIndexCrc, fixSstCrc } from "./targets.js";

/** Where a case builder takes its choices from. */
export interface Source {
  /** 0 <= result < n, and 0 when n <= 0. */
  int(n: number): number;
  bytes(n: number, alphabet?: number): Uint8Array;
  pick<T>(xs: readonly T[]): T;
}

function source(next: () => number, bytes?: Source["bytes"]): Source {
  const int = (n: number) => (n > 0 ? next() % n : 0);
  return {
    int,
    bytes: bytes ?? ((n, alphabet = 256) => Uint8Array.from({ length: n }, () => int(alphabet))),
    pick: (xs) => xs[int(xs.length)]!,
  };
}

/** xorshift32: the same seed gives the same cases. */
export function xorshift(seed: number): Source {
  let state = seed >>> 0 || 1;
  return source(() => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  });
}

/**
 * A fuzzer's input, read front to back like libFuzzer's FuzzedDataProvider:
 * a choice takes 4 bytes, bytes are copied as they are, and once the input
 * runs out every choice is 0, so a short input makes a small case. A choice
 * of 0 is therefore always the common case: a rare event is `int(n) === 1`,
 * and a list to `pick` from starts with its usual value.
 */
export function bytesSource(data: Uint8Array): Source {
  let at = 0;
  const next = () => {
    let v = 0;
    for (let i = 0; i < 4 && at < data.byteLength; i++) v |= data[at++]! << (8 * i);
    return v >>> 0;
  };
  return source(next, (n, alphabet = 256) => {
    const out = data.slice(at, at + n);
    at += out.byteLength;
    if (alphabet < 256) for (let i = 0; i < out.byteLength; i++) out[i]! %= alphabet;
    return out.byteLength === n ? out : concat([out, new Uint8Array(n - out.byteLength)]);
  });
}

export const NEED = 1;
export const DONE = 5;
const TAG_PUT = 1;
const TAG_DEL = 2;

type Entry = { del: boolean; key: Uint8Array; value: Uint8Array; seq: bigint };

function key(r: Source): Uint8Array {
  const shape = r.int(4);
  if (shape === 0) return r.bytes(r.int(4), 3);
  if (shape === 1) return new TextEncoder().encode(`k/${String(r.int(5000)).padStart(6, "0")}`);
  if (shape === 2) return r.bytes(1 + r.int(40), 4);
  return r.bytes(r.int(300));
}

export function randomEntries(r: Source, n: number, seq0: number): Entry[] {
  return Array.from({ length: n }, (_, i) => ({
    del: r.int(5) === 1,
    key: key(r),
    value: r.bytes(r.int(40) === 1 ? 5000 + r.int(70_000) : r.int(200), r.int(2) ? 6 : 256),
    seq: r.int(50) === 1 ? 2n ** 40n + BigInt(r.int(1000)) : BigInt(seq0 + i),
  }));
}

/** Entry records (packages/kv/engine/abi.md, "Wire formats"). */
export function pack(es: readonly Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of es) {
    const head = new DataView(new ArrayBuffer(13));
    head.setUint8(0, e.del ? TAG_DEL : TAG_PUT);
    head.setBigUint64(1, e.seq, true);
    head.setUint32(9, e.key.byteLength, true);
    parts.push(new Uint8Array(head.buffer), e.key);
    if (!e.del) parts.push(u32s([e.value.byteLength]), e.value);
  }
  return concat(parts);
}

export function u32s(values: readonly number[]): Uint8Array {
  const out = new DataView(new ArrayBuffer(4 * values.length));
  values.forEach((v, i) => out.setUint32(4 * i, v >>> 0, true));
  return new Uint8Array(out.buffer);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** A corrupt copy: a bit flip, a cut, overwritten bytes, appended bytes, or a u32 inflated. */
function corrupt(r: Source, b: Uint8Array): Uint8Array {
  const out = b.slice();
  const kind = r.int(5);
  if (kind === 0 && out.length) out[r.int(out.length)]! ^= 1 << r.int(8);
  if (kind === 1) return out.subarray(0, r.int(out.length + 1));
  if (kind === 2 && out.length) for (let i = 0; i < 1 + r.int(8); i++) out[r.int(out.length)] = r.int(256);
  if (kind === 3) return concat([out, r.bytes(1 + r.int(8))]);
  if (kind === 4 && out.length >= 4) new DataView(out.buffer).setUint32(r.int(out.length - 3), r.pick([0xffffffff, 0x7fffffff, 0x10000, 0x41]), true);
  return out;
}

/** Where a buffer keeps a length: `width` bytes at `at`, as a u32 or a varint. */
export type LengthField = { readonly at: number; readonly width: number; readonly varint: boolean };

/** Lengths a check written `o + len > end` wraps on, for any `o` past 16. */
export const HUGE = [0xffffffff, 0xfffffff0, 0x80000000];

function varint(v: number): Uint8Array {
  const out: number[] = [];
  for (; v >= 0x80; v >>>= 7) out.push((v & 0x7f) | 0x80);
  out.push(v);
  return Uint8Array.from(out);
}

function readVarint(b: Uint8Array, at: number): { value: number; width: number } | undefined {
  let value = 0;
  for (let i = 0; i < 5 && at + i < b.byteLength; i++) {
    value += (b[at + i]! & 0x7f) * 2 ** (7 * i);
    if (b[at + i]! < 0x80) return { value, width: i + 1 };
  }
  return undefined;
}

/** `b` with the length at `field` set to `value`. */
export function inflated(b: Uint8Array, field: LengthField, value: number): Uint8Array {
  return concat([b.subarray(0, field.at), field.varint ? varint(value) : u32s([value]), b.subarray(field.at + field.width)]);
}

function inflate(r: Source, b: Uint8Array, fields: readonly LengthField[]): Uint8Array {
  return fields.length ? inflated(b, r.pick(fields), r.pick(HUGE)) : b.slice();
}

/** The key and value lengths of an entry list `pack` wrote. */
export function entryFields(b: Uint8Array): LengthField[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fields: LengthField[] = [];
  for (let o = 0; o + 13 <= b.byteLength; ) {
    const put = b[o] === TAG_PUT;
    fields.push({ at: o + 9, width: 4, varint: false });
    o += 13 + view.getUint32(o + 9, true);
    if (!put || o + 4 > b.byteLength) continue;
    fields.push({ at: o, width: 4, varint: false });
    o += 4 + view.getUint32(o, true);
  }
  return fields;
}

/** The lengths of a pattern list. */
export function patternFields(b: Uint8Array): LengthField[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fields: LengthField[] = [];
  for (let o = 0; o + 4 <= b.byteLength; o += 4 + view.getUint32(o, true)) fields.push({ at: o, width: 4, varint: false });
  return fields;
}

/** The prefix, key suffix and value lengths of a data block (`tests/oracle/sst-ref.ts`, `encodeBlock`). */
export function blockFields(b: Uint8Array): LengthField[] {
  const fields: LengthField[] = [];
  if (b.byteLength < 4) return fields;
  const count = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
  let o = 4;
  const skipLength = () => {
    const v = readVarint(b, o);
    if (!v) return false;
    fields.push({ at: o, width: v.width, varint: true });
    o += v.width + v.value;
    return true;
  };
  if (!skipLength()) return fields;
  for (let i = 0; i < count && o + 9 < b.byteLength; i++) {
    const put = b[o] === TAG_PUT;
    o += 9;
    if (!skipLength() || (put && !skipLength())) break;
  }
  return fields;
}

/** The block count of a run's index (packages/kv/engine/abi.md, "Wire formats"), then each block's separator length and byte length. */
export function indexFields(index: Uint8Array): LengthField[] {
  const fields: LengthField[] = [];
  if (index.byteLength < 4) return fields;
  fields.push({ at: 0, width: 4, varint: false });
  const blocks = new DataView(index.buffer, index.byteOffset, index.byteLength).getUint32(0, true);
  let o = 4;
  for (let i = 0; i < 2 * blocks; i++) {
    const v = readVarint(index, o);
    if (!v) break;
    fields.push({ at: o, width: v.width, varint: true });
    o += v.width;
  }
  return fields;
}

/** What an index `indexFields` reads through holds: each block's separator length and byte length, and the separators. */
export function unpackIndex(index: Uint8Array): { lengths: [sep: number, block: number][]; seps: Uint8Array } {
  const fields = indexFields(index).slice(1);
  const value = (f: LengthField) => readVarint(index, f.at)!.value;
  const lengths = Array.from({ length: fields.length >> 1 }, (_, b): [number, number] => [value(fields[2 * b]!), value(fields[2 * b + 1]!)]);
  const last = fields[fields.length - 1];
  return { lengths, seps: index.slice(last ? last.at + last.width : 4, index.byteLength - 4) };
}

/** An index of blocks with these lengths over `seps`, under a CRC that matches. */
export function packIndex(lengths: readonly (readonly [sep: number, block: number])[], seps: Uint8Array): Uint8Array {
  const index = concat([u32s([lengths.length]), ...lengths.flatMap(([sep, block]) => [varint(sep), varint(block)]), seps, new Uint8Array(4)]);
  fixIndexCrc(index);
  return index;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function result(ex: EngineExports): string {
  const ptr = ex.result_ptr() >>> 0;
  return hex(new Uint8Array(ex.memory.buffer, ptr, ex.result_len()));
}

/** Write `input` to the input region and run `op` on it: the status and the result bytes. */
function call(ex: EngineExports, input: Uint8Array, op: (ptr: number) => number): string {
  const ptr = ex.input_ptr(input.byteLength) >>> 0;
  new Uint8Array(ex.memory.buffer, ptr, input.byteLength).set(input);
  const status = op(ptr);
  return `${status}:${result(ex)}`;
}

/** A run's file, and the index its encoder reported for it: what a host opens a merge with. */
export type Run = { readonly bytes: Uint8Array; readonly index: Uint8Array };

/** The run `encoder` writes for `es`. */
export function encoded(encoder: EngineExports, es: readonly Entry[]): Run {
  const input = pack(es);
  const out = call(encoder, input, (ptr) => encoder.encode_sst(ptr, input.byteLength));
  const record = Buffer.from(out.slice(out.indexOf(":") + 1), "hex");
  const keys = 16 + record.readUInt32LE(4);
  return {
    bytes: new Uint8Array(record.subarray(16, keys)),
    index: new Uint8Array(record.subarray(keys + record.readUInt32LE(8) + record.readUInt32LE(12))),
  };
}

/** One line per stop. A trap ends the transcript with `TRAP <message>`. */
export type Transcript = readonly string[];

function transcript(run: (log: string[]) => void): Transcript {
  const log: string[] = [];
  try {
    run(log);
  } catch (err) {
    if (!(err instanceof WebAssembly.RuntimeError)) throw err;
    log.push(`TRAP ${err.message}`);
  }
  return log;
}

export type EncodeCase = { readonly input: Uint8Array };

/** An entry list as is, corrupt, with a bad tag, or with a length near 2^32. */
export function encodeCase(r: Source): EncodeCase {
  const input = pack(randomEntries(r, r.pick([0, 1, 2, 5, 30, 200, 2000]), 1 + r.int(100)));
  const kind = r.int(4);
  if (kind === 1) return { input: corrupt(r, input) };
  if (kind === 2 && input.byteLength) input[0] = r.pick([0, 3, 255]);
  if (kind === 3) return { input: inflate(r, input, entryFields(input)) };
  return { input };
}

export function driveEncode(ex: EngineExports, c: EncodeCase): Transcript {
  return transcript((log) => log.push(call(ex, c.input, (ptr) => ex.encode_sst(ptr, c.input.byteLength))));
}

export type ScanCase = { readonly block: Uint8Array; readonly patterns: Uint8Array };

function patterns(r: Source): Uint8Array {
  return concat(Array.from({ length: r.int(3) }, () => r.bytes(r.int(3), r.int(2) ? 6 : 256)).flatMap((p) => [u32s([p.byteLength]), p]));
}

/** A data block of a run `encoder` writes, and a pattern list, either of them corrupt or with a length near 2^32, or neither. */
export function scanCase(r: Source, encoder: EngineExports): ScanCase {
  const blocks = blocksOf(encoded(encoder, randomEntries(r, r.pick([1, 5, 30, 200]), 1)).bytes);
  const block = blocks[r.int(blocks.length)] ?? new Uint8Array(0);
  const pats = patterns(r);
  const kind = r.int(5);
  if (kind === 1) return { block: corrupt(r, block), patterns: pats };
  if (kind === 2) return { block, patterns: corrupt(r, pats) };
  if (kind === 3) return { block: inflate(r, block, blockFields(block)), patterns: pats };
  if (kind === 4) return { block, patterns: inflate(r, pats, patternFields(pats)) };
  return { block, patterns: pats };
}

export function driveScan(ex: EngineExports, c: ScanCase): Transcript {
  const { block, patterns: pats } = c;
  return transcript((log) =>
    log.push(call(ex, concat([block, pats]), (ptr) => ex.scan_block_contains(ptr, block.byteLength, ptr + block.byteLength, pats.byteLength))),
  );
}

export type MergeCase = {
  readonly sources: readonly (readonly Run[])[];
  readonly marks: Uint8Array;
  /** The marks block was corrupted: the host encodes it, so a session may trap. */
  readonly badMarks: boolean;
  readonly drop: number;
  readonly target: number;
  readonly chunk: number;
  readonly tail: number;
  readonly yieldBytes: number;
  /** Seeds the host's feed order, wrong lengths and early pumps. */
  readonly host: number;
};

/** A marks block: u32 count, then per mark start, optional end, u64 through and u64 at. */
function marksBlock(r: Source): Uint8Array {
  const marks = Array.from({ length: r.int(3) }, () => {
    const start = key(r);
    const end = r.int(2) ? concat([start, Uint8Array.of(0xff)]) : undefined;
    const seqs = new DataView(new ArrayBuffer(16));
    seqs.setBigUint64(0, BigInt(1 + r.int(800)), true);
    seqs.setBigUint64(8, BigInt(5000 + r.int(10)), true);
    return concat([u32s([start.byteLength]), start, Uint8Array.of(end ? 1 : 0), ...(end ? [u32s([end.byteLength]), end] : []), new Uint8Array(seqs.buffer)]);
  });
  return concat([u32s([marks.length]), ...marks]);
}

/** Up to five sources of runs `encoder` writes, now and then one out of key order, corrupt, or with a corrupt index or an index length near 2^32, with or without CRCs that match. */
export function mergeCase(r: Source, encoder: EngineExports): MergeCase {
  let seq = 1;
  const sources = Array.from({ length: r.int(6) }, () => {
    const all = randomEntries(r, r.int(400), seq).sort((a, b) => Buffer.compare(a.key, b.key));
    seq += 1000;
    const per = Math.ceil(all.length / (1 + r.int(3))) || 1;
    const runs: Run[] = [];
    for (let at = 0; at < Math.max(all.length, 1); at += per) {
      const slice = all.slice(at, at + per);
      if (r.int(30) === 1) slice.reverse();
      runs.push(encoded(encoder, slice));
    }
    if (runs.length && r.int(8) === 1) {
      const i = r.int(runs.length);
      const { bytes, index } = runs[i]!;
      const kind = r.int(3);
      const bad = kind === 0 ? { bytes: corrupt(r, bytes), index } : { bytes, index: kind === 1 ? corrupt(r, index) : inflate(r, index, indexFields(index)) };
      // Past the CRCs, the footer, the index and the blocks are what refuse it.
      if (r.int(2)) {
        fixSstCrc(bad.bytes);
        fixIndexCrc(bad.index);
      }
      runs[i] = bad;
    }
    return runs;
  });
  const marks = marksBlock(r);
  const badMarks = marks.byteLength > 4 && r.int(10) === 1;
  return {
    sources,
    marks: badMarks ? concat([marks.subarray(0, 4), corrupt(r, marks.subarray(4))]) : marks,
    badMarks,
    drop: r.int(2),
    target: r.pick([1 << 22, 0, 64, 1024, 16384, Number.MAX_SAFE_INTEGER, 1e20, -5, Number.NaN]),
    chunk: r.pick([4096, 0, 16, 256, 65536]),
    tail: r.pick([4096, 0, 16, 256, 65536]),
    yieldBytes: r.pick([1 << 20, 0, 1, 1000]),
    host: 1 + r.int(2 ** 30),
  };
}

/**
 * Every stop of a session over `c`, driven the way a host may: demands fed
 * in any order, now and then a feed of the wrong length or a pump before the
 * last feed, and the calls a host must not make while a session is open or
 * after it is closed. The session is closed even after a trap.
 */
export function driveMerge(ex: EngineExports, c: MergeCase): Transcript {
  const r = xorshift(c.host);
  const list = concat([u32s([c.sources.length]), ...c.sources.map(sourceRecord), c.marks]);
  const open = (ptr: number) => ex.merge_open(ptr, list.byteLength, c.drop, c.target, c.chunk, c.tail, c.yieldBytes);
  return transcript((log) => {
    log.push(call(ex, list, open));
    if (!log[0]!.startsWith("0:")) {
      log.push(`pump ${ex.merge_pump()}`);
      return;
    }
    log.push(call(ex, list, open));
    try {
      pump(ex, c, r, log);
    } catch (err) {
      // A trap leaves the session open in the instance.
      ex.merge_close();
      throw err;
    }
    log.push(`close ${ex.merge_close()} ${ex.merge_close()} pump ${ex.merge_pump()} feed ${ex.merge_feed(0, 0)}`);
  });
}

/** A source of a source list (packages/kv/engine/abi.md, "Wire formats"). */
export function sourceRecord(runs: readonly Run[]): Uint8Array {
  return concat([u32s([runs.length]), ...runs.flatMap((run) => [u32s([run.bytes.byteLength, run.index.byteLength]), run.index])]);
}

function pump(ex: EngineExports, c: MergeCase, r: Source, log: string[]): void {
  for (let stops = 0; stops < 100_000; stops++) {
    const status = ex.merge_pump();
    log.push(`${status}:${result(ex)}`);
    if (status < 0 || status === DONE) {
      log.push(`again ${ex.merge_pump()}`);
      break;
    }
    if (status !== NEED) continue;
    const view = new DataView(ex.memory.buffer, ex.result_ptr() >>> 0, ex.result_len());
    const demands = Array.from({ length: view.byteLength / 16 }, (_, i) => [0, 4, 8, 12].map((o) => view.getUint32(16 * i + o, true)) as [number, number, number, number]);
    for (let i = demands.length - 1; i > 0; i--) {
      const j = r.int(i + 1);
      [demands[i], demands[j]] = [demands[j]!, demands[i]!];
    }
    demands.forEach(([source, run, offset, len], i) => {
      if (r.int(8) === 0) log.push(`wrong length ${ex.merge_feed(source, len + 1) !== 0}`);
      if (i === demands.length - 1 && r.int(6) === 0) log.push(`early ${ex.merge_pump()}`);
      const at = ex.merge_feed(source, len) >>> 0;
      log.push(`feed ${at !== 0}`);
      if (at) new Uint8Array(ex.memory.buffer, at, len).set(c.sources[source]![run]!.bytes.subarray(offset, offset + len));
    });
  }
}
