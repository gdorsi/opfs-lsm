import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { mergeCursors, runLevels } from "../src/store/merge.js";
import { encodeSst, SstReader, type SstEntry } from "../src/store/sst.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const key = (i: number) => enc.encode(`k${String(i).padStart(4, "0")}`);

function run(keys: number[], tag: string): SstReader {
  const entries: SstEntry[] = keys.map((i) =>
    i % 5 === 0
      ? { kind: "del", key: key(i), seq: 1 }
      : { kind: "put", key: key(i), value: enc.encode(`${tag}${i}`), seq: 1 },
  );
  return new SstReader(encodeSst(entries, 64));
}

/** Newest first: two overlapping L0 runs, then L1 and L2 cut into disjoint runs with gaps. */
function layout() {
  const l2 = [[0, 30], [40, 70], [75, 120]].map(([a, b]) => run(range(a!, b!, 1), "l2:"));
  const l1 = [[10, 50], [60, 90]].map(([a, b]) => run(range(a!, b!, 3), "l1:"));
  const l0 = [run(range(5, 100, 7), "l0a:"), run(range(0, 110, 11), "l0b:")];
  const paths = [
    "l0/2-2.sst",
    "l0/1-1.sst",
    ...l1.map((_, i) => `l1/c1.${i}-0.sst`),
    ...l2.map((_, i) => `l2/c1.${i}-0.sst`),
  ];
  return { paths, readers: [...l0, ...l1, ...l2] };
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i += step) out.push(i);
  return out;
}

function scan(cursors: Parameters<typeof mergeCursors>[0], limit?: number): string[] {
  return [...mergeCursors(cursors, limit)].map((e) => `${dec.decode(e.key)}=${dec.decode(e.value)}`);
}

describe("runLevels", () => {
  it("scans the same rows as one cursor per run, for every bound", () => {
    const { paths, readers } = layout();
    const levels = runLevels(paths, readers);
    expect(levels).toHaveLength(4);
    const bounds = [undefined, ...range(-1, 125, 4).flatMap((a) =>
      range(a, 130, 9).map((b) => ({ start: key(a < 0 ? 0 : a), endExclusive: key(b) })),
    ), ...range(0, 125, 6).map((a) => ({ start: key(a) }))];
    for (const b of bounds) {
      for (const limit of [undefined, 1, 7]) {
        const want = scan(readers.map((r) => r.cursor(b)), limit);
        const got = scan(levels.map((l) => l.cursor(b)), limit);
        expect(got).toEqual(want);
      }
    }
  });

  it("keeps runs in key order inside a level", () => {
    const { paths, readers } = layout();
    const rows = scan(runLevels(paths, readers).map((l) => l.cursor()));
    const keys = rows.map((r) => enc.encode(r.split("=")[0]!));
    for (let i = 1; i < keys.length; i++) expect(compareBytes(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
  });
});
