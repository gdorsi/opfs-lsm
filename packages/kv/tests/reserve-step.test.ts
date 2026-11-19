import { describe, expect, it } from "vitest";
import {
  fillReserve,
  inspectReserve,
  removeReserve,
  RESERVE_PATH,
  step,
  type Reserve,
  type ReserveEffect,
  type ReserveEvent,
} from "../src/host/reserve.js";
import { asSeq } from "../src/seq.js";
import { MemoryFs } from "../src/testing.js";
import { BudgetFs } from "./sim/byte-budget.js";

const KiB = 1024;
const T = 64 * KiB;
const seq = asSeq;

const UNKNOWN: Reserve = { kind: "unknown" };
const held = (bytes: number): Reserve => ({ kind: "held", bytes });
const offered = (head: number): Reserve => ({ kind: "released", ask: { kind: "offered", head: seq(head) } });
const after = (s: number): Reserve => ({ kind: "released", ask: { kind: "after", seq: seq(s) } });

const settle = (through: number, target = T, head = through): ReserveEvent => ({
  kind: "settle",
  through: seq(through),
  head: seq(head),
  target,
});
const found = (bytes: number, target = T): ReserveEvent => ({ kind: "found", bytes, head: seq(9), target });
const refused: ReserveEvent = { kind: "refused", head: seq(9) };
const fillRefused: ReserveEvent = { kind: "fill-refused", head: seq(9) };
const filled: ReserveEvent = { kind: "filled", bytes: T };
const done = (head: number): ReserveEvent => ({ kind: "done", head: seq(head) });

const NONE: ReserveEffect = { kind: "none" };
const fill = (head: number, target = T): ReserveEffect => ({ kind: "fill", head: seq(head), target });

type Row = readonly [what: string, state: Reserve, event: ReserveEvent, next: Reserve, effect: ReserveEffect];

const rows: readonly Row[] = [
  ["unknown, a settle: look at the file", UNKNOWN, settle(5), UNKNOWN, { kind: "inspect", head: seq(5), target: T }],
  ["unknown, the file has the target size", UNKNOWN, found(T), held(T), NONE],
  ["unknown, no file and none wanted", UNKNOWN, found(0, 0), held(0), NONE],
  ["unknown, a file left and none wanted: remove it", UNKNOWN, found(T, 0), held(0), { kind: "remove" }],
  ["unknown, no file: fill", UNKNOWN, found(0), held(0), fill(9)],
  ["unknown, a smaller file: rewrite", UNKNOWN, found(T / 2), held(T / 2), fill(9)],
  ["unknown, a larger file: rewrite", UNKNOWN, found(2 * T), held(2 * T), fill(9)],
  ["unknown, a refused write: release what an earlier session left", UNKNOWN, refused, offered(9), { kind: "release" }],

  ["held at the target, a settle", held(T), settle(5), held(T), NONE],
  ["held under the target, a settle: rewrite larger", held(T / 2), settle(5), held(T / 2), fill(5)],
  ["held over the target, a settle", held(2 * T), settle(5), held(2 * T), NONE],
  ["held, the fill landed", held(0), filled, held(T), NONE],
  ["held, a refused rewrite keeps the smaller file", held(T / 2), fillRefused, held(T / 2), NONE],
  ["no file, and it does not fit: offer", held(0), fillRefused, offered(9), { kind: "offer" }],
  ["held, a refused write: release", held(T), refused, offered(9), { kind: "release" }],
  ["no file, a refused write: offer, with nothing to release", held(0), refused, offered(9), { kind: "offer" }],
  ["held, a tab opens: look again at the next settle", held(T), { kind: "watch" }, UNKNOWN, NONE],

  ["offered, a settle: no fill and no second offer", offered(4), settle(100), offered(4), NONE],
  ["offered, a pull: post the offer again", offered(4), { kind: "pull" }, offered(4), { kind: "offer" }],
  ["offered, answered with writes: flush now", offered(4), done(6), after(6), { kind: "flush" }],
  ["offered, answered with no write: wait for the next flush", offered(4), done(4), after(4), NONE],
  ["offered, a refused write", offered(4), refused, offered(4), NONE],
  ["offered, a tab opens", offered(4), { kind: "watch" }, offered(4), NONE],

  ["answered, a settle before a flush holds the answer", after(6), settle(5), after(6), NONE],
  ["answered, a settle that holds the answer: fill", after(6), settle(6, T, 8), after(6), fill(8)],
  ["answered, the fill landed", after(6), filled, held(T), NONE],
  ["answered, the fill does not fit: offer again", after(6), fillRefused, offered(9), { kind: "offer" }],
  ["answered, a refused write", after(6), refused, after(6), NONE],
  ["answered, a second done", after(6), done(8), after(6), NONE],
  ["answered, a pull", after(6), { kind: "pull" }, after(6), NONE],

  ["unknown, the last tab closes", UNKNOWN, { kind: "last-unwatch" }, UNKNOWN, NONE],
  ["held, the last tab closes: the file stays", held(T), { kind: "last-unwatch" }, UNKNOWN, NONE],
  ["offered, the last tab closes", offered(4), { kind: "last-unwatch" }, UNKNOWN, NONE],
  ["answered, the last tab closes", after(6), { kind: "last-unwatch" }, UNKNOWN, NONE],
  ["unknown, a fill that outlived its watch", UNKNOWN, filled, UNKNOWN, NONE],
  ["unknown, a refused fill that outlived its watch", UNKNOWN, fillRefused, UNKNOWN, NONE],
];

describe("the reserve's transition table", () => {
  it.each(rows)("%s", (_, state, event, next, effect) => {
    expect(step(state, event)).toEqual({ next, effect });
  });

  it("returns the same state object when nothing changes, so the host can skip the lock", () => {
    const pairs: readonly (readonly [Reserve, ReserveEvent])[] = [
      [UNKNOWN, { kind: "pull" }],
      [held(T), settle(5)],
      [offered(4), settle(5)],
      [after(6), refused],
    ];
    for (const [state, event] of pairs) expect(step(state, event).next).toBe(state);
  });
});

describe("the reserve file", () => {
  const sizeOf = async (fs: MemoryFs) => (await fs.read(RESERVE_PATH, 0, Infinity))?.byteLength;

  it("fills to the byte, in written chunks, and reads back its size", async () => {
    const fs = new MemoryFs();
    expect(await inspectReserve(fs)).toBe(0);
    const target = 2 * 1024 * KiB + 123;
    expect(await fillReserve(fs, target)).toBe("ok");
    expect(await sizeOf(fs)).toBe(target);
    expect(await inspectReserve(fs)).toBe(target);
  });

  it("removes the swap file of a fill a crash cut off, at a look and at a fill", async () => {
    const fs = new MemoryFs();
    const leave = async () => {
      const w = await fs.create(`${RESERVE_PATH}.crswap`);
      await w.write(new Uint8Array(10));
      await w.finish();
    };
    await leave();
    await inspectReserve(fs);
    expect(fs.publishedPaths()).toEqual([]);
    await leave();
    await fillReserve(fs, T);
    expect(fs.publishedPaths()).toEqual([RESERVE_PATH]);
    await leave();
    await removeReserve(fs);
    expect(fs.publishedPaths()).toEqual([]);
  });

  it("answers quota when the fill does not fit, and leaves the file as it was", async () => {
    const mem = new MemoryFs();
    const fs = new BudgetFs(mem, T);
    expect(await fillReserve(fs, T / 2)).toBe("ok");
    expect(await fillReserve(fs, T)).toBe("quota");
    expect(await sizeOf(mem)).toBe(T / 2);
    expect(fs.used).toBe(T / 2);
    await removeReserve(fs);
    expect(fs.used).toBe(0);
    expect(await fillReserve(fs, T)).toBe("ok");
  });
});
