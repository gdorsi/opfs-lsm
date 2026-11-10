/**
 * Dump a LevelDB write-ahead log (such as Chrome's OPFS `Paths` database,
 * `<profile>/Default/File System/000/t/Paths/NNNNNN.log`) record by record,
 * and flag every physical record whose checksum or framing is bad.
 *
 *   node packages/kv/scripts/leveldb-log.ts <file.log> [--batches] [--match <regex>]
 */
import fs from "node:fs";

const BLOCK = 32768;
const HEADER = 7;
const TYPES = ["ZERO", "FULL", "FIRST", "MIDDLE", "LAST"] as const;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32c(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function unmask(m: number): number {
  const r = (m - 0xa282ead8) >>> 0;
  return ((r >>> 17) | (r << 15)) >>> 0;
}

/**
 * A physical record as LevelDB's log::Reader sees it. A bad record makes
 * the reader drop the rest of its 32 KiB block (`dropped` bytes), and the
 * records that follow in that block are never read: they are not listed.
 * A record cut off by the end of the file is a silent end of log.
 */
export type Physical = {
  offset: number;
  block: number;
  type: string;
  length: number;
  ok: boolean;
  why?: string;
  dropped?: number;
  data: Uint8Array;
};

export function physicalRecords(buf: Uint8Array): Physical[] {
  const out: Physical[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let block = 0; block * BLOCK < buf.length; block++) {
    const end = Math.min(buf.length, (block + 1) * BLOCK);
    const atEof = end === buf.length;
    let p = block * BLOCK;
    const bad = (type: string, length: number, why: string) => {
      out.push({
        offset: p,
        block,
        type,
        length,
        ok: false,
        why,
        dropped: end - p,
        data: new Uint8Array(),
      });
    };
    while (p < end) {
      if (p + HEADER > end) {
        if (atEof && buf.subarray(p, end).some((b) => b !== 0)) bad("PARTIAL", end - p, "header cut off at end of file");
        break;
      }
      const masked = view.getUint32(p, true);
      const length = view.getUint16(p + 4, true);
      const type = buf[p + 6]!;
      const name = TYPES[type] ?? `T${type}`;
      if (p + HEADER + length > end) {
        bad(name, length, atEof ? "record cut off at end of file" : "bad record length");
        break;
      }
      if (type === 0 && length === 0) {
        if (buf.subarray(p, end).some((b) => b !== 0)) bad("ZERO", 0, "zero header before data");
        break;
      }
      const ok = type >= 1 && type <= 4 && crc32c(buf.subarray(p + 6, p + HEADER + length)) === unmask(masked);
      if (!ok) {
        bad(name, length, "checksum mismatch");
        break;
      }
      out.push({
        offset: p,
        block,
        type: name,
        length,
        ok,
        data: buf.subarray(p + HEADER, p + HEADER + length),
      });
      p += HEADER + length;
    }
  }
  return out;
}

function varint(buf: Uint8Array, at: number): [number, number] {
  let v = 0;
  let shift = 0;
  for (;;) {
    const b = buf[at++]!;
    v += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [v, at];
    shift += 7;
  }
}

export type Op = { put: boolean; key: Uint8Array; value?: Uint8Array };
export type Batch = { offset: number; seq: bigint; ops: Op[] };

export function batches(phys: Physical[]): Batch[] {
  const out: Batch[] = [];
  let parts: Uint8Array[] = [];
  let start = 0;
  for (const r of phys) {
    if (!r.ok) {
      parts = [];
      continue;
    }
    if (r.type === "FULL" || r.type === "FIRST") {
      parts = [r.data];
      start = r.offset;
    } else parts.push(r.data);
    if (r.type !== "FULL" && r.type !== "LAST") continue;
    const rec = Buffer.concat(parts);
    parts = [];
    const seq = rec.readBigUInt64LE(0);
    const count = rec.readUInt32LE(8);
    const ops: Op[] = [];
    let at = 12;
    for (let i = 0; i < count; i++) {
      const tag = rec[at++]!;
      let len: number;
      [len, at] = varint(rec, at);
      const key = rec.subarray(at, (at += len));
      if (tag === 1) {
        [len, at] = varint(rec, at);
        ops.push({ put: true, key, value: rec.subarray(at, (at += len)) });
      } else ops.push({ put: false, key });
    }
    out.push({ offset: start, seq, ops });
  }
  return out;
}

const printable = (b: Uint8Array) =>
  Buffer.from(b)
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, ".");

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: leveldb-log <file.log> [--batches] [--match <regex>]");
    process.exit(2);
  }
  const showBatches = process.argv.includes("--batches");
  const mi = process.argv.indexOf("--match");
  const match = mi > 0 ? new RegExp(process.argv[mi + 1]!) : null;
  const buf = new Uint8Array(fs.readFileSync(file));
  const phys = physicalRecords(buf);
  const bad = phys.filter((r) => !r.ok);
  console.log(`${file}: ${buf.length} bytes, ${Math.ceil(buf.length / BLOCK)} blocks, ${phys.length} physical records, ${bad.length} bad`);
  for (const r of bad) {
    const dropped = Buffer.from(buf.subarray(r.offset, r.offset + r.dropped!)).toString("latin1");
    const names = [...new Set(dropped.match(/[\w.-]{6,}/g) ?? [])];
    console.log(
      `  bad @${r.offset} block ${r.block} +${r.offset - r.block * BLOCK} ${r.type} len ${r.length} (${r.why}); drops ${r.dropped} bytes to the block end`,
    );
    if (names.length) console.log(`    names in the dropped bytes: ${names.slice(0, 40).join(" ")}${names.length > 40 ? ` ... (${names.length})` : ""}`);
  }
  if (showBatches || match) {
    for (const b of batches(phys)) {
      const lines = b.ops.map((o) => `${o.put ? "PUT" : "DEL"} ${printable(o.key)}${o.value ? ` = ${printable(o.value)}` : ""}`);
      if (match && !lines.some((l) => match.test(l))) continue;
      console.log(`@${b.offset} block ${Math.floor(b.offset / BLOCK)} seq ${b.seq}`);
      for (const l of lines) console.log(`  ${l}`);
    }
  }
}
