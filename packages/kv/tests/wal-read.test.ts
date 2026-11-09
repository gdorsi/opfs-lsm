import { describe, expect, it } from "vitest";
import { checkKey, checkValue, type CheckedOp } from "../src/check.js";
import { CommitError } from "../src/errors.js";
import { KIND_RECORD, decodeOps, encodeFrame, encodeOps, segmentPath } from "../src/log/frame.js";
import { TAB_START, readTab } from "../src/log/reader.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";

/**
 * Reading a tab's log back. Frame-level rules (torn tail, CRC, gaps in `n`)
 * are in log.test.ts; these cover the record bodies and resuming a read.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const TAB = "00000000000000bb";

function put(i: number): CheckedOp[] {
  return [{ type: "put", key: checkKey(enc.encode(`k${i}`)), value: checkValue(enc.encode(`v${i}`)) }];
}

async function appendTo(fs: MemoryFs, frames: Uint8Array[]): Promise<void> {
  const path = segmentPath(TAB, { firstN: 1, prevStamp: 0 });
  const old = (await fs.read(path, 0, Number.POSITIVE_INFINITY)) ?? new Uint8Array();
  const w = await fs.create(path);
  await w.write(new Uint8Array([...old, ...frames.flatMap((f) => [...f])]));
  await w.finish();
}

const summary = (records: readonly { n: number; ops: readonly CheckedOp[] }[]) =>
  records.map((r) => `${r.n}:${r.ops.map((op) => dec.decode(op.key)).join(",")}`);

describe("log read", () => {
  it("resumes after the last record it read, and returns only what came after", async () => {
    const fs = new MemoryFs();
    await appendTo(fs, Array.from({ length: 4 }, (_, i) => encodeFrame(KIND_RECORD, 10 * (i + 1), i + 1, encodeOps(put(i + 1)))));
    const first = await readTab(fs, TAB, TAB_START);
    expect(summary(first.records)).toEqual(["1:k1", "2:k2", "3:k3", "4:k4"]);
    expect(first.pos).toMatchObject({ n: 4, stamp: 40, sealed: false });

    expect((await readTab(fs, TAB, first.pos)).records).toEqual([]);
    await appendTo(fs, [5, 6].map((n) => encodeFrame(KIND_RECORD, 10 * n, n, encodeOps(put(n)))));
    const next = await readTab(fs, TAB, first.pos);
    expect(summary(next.records)).toEqual(["5:k5", "6:k6"]);
    expect(next.empty).toBe(false);
  });

  it("reports a tab with no log as empty", async () => {
    const read = await readTab(new MemoryFs(), TAB, TAB_START);
    expect(read).toMatchObject({ records: [], empty: true });
  });

  it("round-trips a batch of puts, an empty value and a delete as bytes", () => {
    const big = new Uint8Array(70_000).map((_, i) => i & 0xff);
    const ops = decodeOps(
      encodeOps([
        { type: "put", key: checkKey(enc.encode("a")), value: checkValue(big) },
        { type: "put", key: checkKey(enc.encode("empty")), value: checkValue(new Uint8Array()) },
        { type: "del", key: checkKey(enc.encode("gone")) },
        { type: "put", key: checkKey(enc.encode("z")), value: checkValue(enc.encode("last")) },
      ]),
    );
    expect(ops.map((op) => `${op.type}:${dec.decode(op.key)}`)).toEqual([
      "put:a",
      "put:empty",
      "del:gone",
      "put:z",
    ]);
    const value = (i: number) => (ops[i] as Extract<CheckedOp, { type: "put" }>).value;
    expect(value(0)).toEqual(big);
    expect(value(1).byteLength).toBe(0);
    expect(dec.decode(value(3))).toBe("last");
  });

  it("rejects a truncated record body", () => {
    // A put whose key claims 10 bytes and has 2.
    const body = new Uint8Array([0, 10, 0, 0, 0, 1, 2]);
    expect(() => decodeOps(body)).toThrow(CommitError);
    expect(() => decodeOps(body)).toThrow("corrupt log record: truncated");
    // A put whose value length is cut off.
    const cut = encodeOps(put(1)).subarray(0, 8);
    expect(() => decodeOps(cut)).toThrow("corrupt log record: truncated");
  });

  it("rejects an unknown op type", () => {
    const body = encodeOps(put(1)).slice();
    body[0] = 7;
    expect(() => decodeOps(body)).toThrow("corrupt log op 7");
  });
});
