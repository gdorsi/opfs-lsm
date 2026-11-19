import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Miss, type LayerCursor, type LayerEntry } from "../src/store/cursor.js";
import { NO_MARKS } from "../src/store/marks.js";
import { liveStep } from "../src/store/read.js";
import { asSeq } from "../src/seq.js";

const KEYS = 12;
const key = (i: number) => Uint8Array.of(0x6b, i);

type Cell = "put" | "del" | undefined;

/** One source's entries in scan order: `cells[i]` is what it holds for key i. */
function entriesOf(cells: readonly Cell[], source: number, reverse: boolean): LayerEntry[] {
  const out: LayerEntry[] = [];
  for (const [i, kind] of cells.entries()) {
    if (kind === "put") out.push({ key: key(i), kind, value: Uint8Array.of(source, i), seq: asSeq(1) });
    else if (kind === "del") out.push({ key: key(i), kind, seq: asSeq(1) });
  }
  return reverse ? out.reverse() : out;
}

/**
 * A cursor over `entries` that misses the first time it is asked for each
 * position in `cold`. `unseen` is true from a `next` until the `peek` after it.
 */
function coldCursor(entries: readonly LayerEntry[], cold: ReadonlySet<number>) {
  let at = 0;
  const loaded = new Set<number>();
  const state = { unseen: true, misses: 0 };
  const cursor: LayerCursor = {
    peek() {
      state.unseen = false;
      if (cold.has(at) && !loaded.has(at)) {
        const position = at;
        state.misses++;
        return new Miss(Promise.resolve().then(() => (loaded.add(position), [])));
      }
      return entries[at];
    },
    next() {
      at++;
      state.unseen = true;
    },
  };
  return { cursor, state };
}

const sourcesArb = fc.array(
  fc.record({
    cells: fc.array(fc.constantFrom<Cell>("put", "del", undefined, undefined), { minLength: KEYS, maxLength: KEYS }),
    cold: fc.array(fc.nat(KEYS), { maxLength: 4 }),
  }),
  { maxLength: 5 },
);

describe("a merge of cursors", () => {
  it("yields each key once from its newest source, in scan order, whatever misses on the way", async () => {
    let missed = 0;
    await fc.assert(
      fc.asyncProperty(sourcesArb, fc.boolean(), async (sources, reverse) => {
        const cursors = sources.map((s, i) => coldCursor(entriesOf(s.cells, i, reverse), new Set(s.cold)));
        const step = liveStep(cursors.map((c) => c.cursor), NO_MARKS, reverse);
        const got: string[] = [];
        for (;;) {
          const e = step();
          if (e instanceof Miss) {
            // Every source the last step moved was asked before the miss came back, so their reads start together.
            expect(cursors.filter((c) => c.state.unseen)).toEqual([]);
            await e.ready;
            continue;
          }
          if (!e) break;
          got.push(`${e.key[1]}:${[...e.value!]}`);
        }
        const want: string[] = [];
        for (let i = 0; i < KEYS; i++) {
          const newest = sources.findIndex((s) => s.cells[i] !== undefined);
          if (newest >= 0 && sources[newest]!.cells[i] === "put") want.push(`${i}:${[newest, i]}`);
        }
        expect(got).toEqual(reverse ? want.reverse() : want);
        expect(step()).toBeUndefined();
        missed += cursors.reduce((n, c) => n + c.state.misses, 0);
      }),
      { numRuns: 500 },
    );
    expect(missed).toBeGreaterThan(200);
  });

  it("asks every source before its first miss comes back", () => {
    const sources = [0, 1, 2].map((i) => coldCursor(entriesOf(["put", "put"], i, false), new Set([0])));
    const step = liveStep(sources.map((s) => s.cursor), NO_MARKS);
    expect(step()).toBeInstanceOf(Miss);
    expect(sources.map((s) => s.state.misses)).toEqual([1, 1, 1]);
  });

  it("asks the sources that held one key together, after the step that passed it", async () => {
    // Every source holds key 0, and its position after that key is cold.
    const sources = [0, 1, 2].map((i) => coldCursor(entriesOf(["put", "put"], i, false), new Set([1])));
    const step = liveStep(sources.map((s) => s.cursor), NO_MARKS);
    expect([...(step() as LayerEntry).value!]).toEqual([0, 0]);
    expect(sources.map((s) => s.state.misses)).toEqual([0, 0, 0]);
    const miss = step();
    expect(miss).toBeInstanceOf(Miss);
    expect(sources.map((s) => s.state.misses)).toEqual([1, 1, 1]);
    await (miss as Miss).ready;
    expect([...(step() as LayerEntry).value!]).toEqual([0, 1]);
    expect(sources.map((s) => s.state.misses)).toEqual([1, 1, 1]);
  });
});
