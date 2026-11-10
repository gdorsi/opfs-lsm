import { describe, expect, it } from "vitest";
import type { CheckedKey, CheckedOp, CheckedValue } from "../src/check.js";
import type { Range } from "../src/db.js";
import type { LogId, QueueCursor } from "../src/host/queues.js";
import { OwnQueue } from "../src/log/overlay.js";
import { settle } from "../src/store/cursor.js";
import type { MemRows } from "../src/store/memtable.js";
import { pointGet, RunLevel } from "../src/store/merge.js";
import { encodeRun, type SstEntry } from "../src/store/sst.js";
import { boundsOf, scanLayers } from "../src/view.js";
import { collect, readerOfBytes } from "./runs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const A = "a" as LogId;
const B = "b" as LogId;

const k = (s: string) => enc.encode(s) as CheckedKey;
const put = (key: string, value: string): CheckedOp => ({ type: "put", key: k(key), value: enc.encode(value) as CheckedValue });
const del = (key: string): CheckedOp => ({ type: "del", key: k(key) });
const open = (log: LogId, n: number): QueueCursor => ({ log, state: "open", n });
const final = (log: LogId, n: number): QueueCursor => ({ log, state: "final", n });
const damaged = (log: LogId, n: number): QueueCursor => ({ log, state: "damaged", n, reason: "hole" });

/** The installed runs: k1..k4 with run values, and a tombstone at k5. */
const levels = [
  new RunLevel([
    readerOfBytes(
      encodeRun([
        ...["k1", "k2", "k3", "k4"].map((key): SstEntry => ({ kind: "put", key: k(key), value: enc.encode(`run-${key}`) })),
        { kind: "del", key: k("k5") },
      ]).body,
    ),
  ]),
];

/** What a page reads: the overlay's row, else the runs. */
async function read(rows: MemRows, key: string): Promise<string | undefined> {
  const value = await settle(() => pointGet(rows.get(k(key)), levels, k(key)));
  return value && dec.decode(value);
}

async function scan(rows: MemRows, range: Range = {}): Promise<string[]> {
  const bounds = boundsOf(range);
  const entries = await collect(scanLayers(rows.range(bounds), levels, bounds, range));
  return entries.map((e) => `${dec.decode(e.key)}=${dec.decode(e.value)}`);
}

describe("OwnQueue reads", () => {
  it("answers with the newest write of a key, a delete included", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("x", "2"), put("y", "1")]);
    own.add(A, 3, [del("y")]);
    expect(await read(own, "x")).toBe("2");
    expect(own.get(k("y"))?.kind).toBe("del");
    expect(await read(own, "y")).toBeUndefined();
  });

  it("puts every record of a newer log after every record of an older one", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "a1")]);
    own.add(A, 2, [put("x", "a2"), put("y", "a2")]);
    own.add(B, 1, [put("x", "b1")]);
    expect(await read(own, "x")).toBe("b1");
    expect(await read(own, "y")).toBe("a2");
  });

  it("falls through to the runs for a key it does not hold", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("k2", "own")]);
    expect(own.get(k("k1"))).toBeUndefined();
    expect(await read(own, "k1")).toBe("run-k1");
    expect(await read(own, "k2")).toBe("own");
  });

  it("hides a run value under a delete, and shows a put over a run tombstone", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [del("k3"), put("k5", "own")]);
    expect(await read(own, "k3")).toBeUndefined();
    expect(await read(own, "k5")).toBe("own");
    expect(await read(own, "k4")).toBe("run-k4");
  });

  it("scans the overlay over the runs, with bounds, forward and reverse", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("k2", "own2"), del("k3"), put("k35", "own35")]);
    own.add(B, 1, [put("k1", "own1"), put("k6", "own6")]);
    expect(await scan(own)).toEqual(["k1=own1", "k2=own2", "k35=own35", "k4=run-k4", "k6=own6"]);
    expect(await scan(own, { reverse: true })).toEqual(["k6=own6", "k4=run-k4", "k35=own35", "k2=own2", "k1=own1"]);
    const inside = { start: k("k2"), endExclusive: k("k4") };
    expect(await scan(own, inside)).toEqual(["k2=own2", "k35=own35"]);
    expect(await scan(own, { ...inside, reverse: true })).toEqual(["k35=own35", "k2=own2"]);
    expect(await scan(own, { start: k("k35"), reverse: true, limit: 2 })).toEqual(["k6=own6", "k4=run-k4"]);
  });
});

describe("OwnQueue install", () => {
  it("drops records up to the cursor and keeps the rest", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.add(A, 3, [put("z", "3")]);
    own.install([open(A, 2)]);
    expect(own.get(k("x"))).toBeUndefined();
    expect(own.get(k("y"))).toBeUndefined();
    expect(await read(own, "z")).toBe("3");
    expect(own.above(A, 0).map((r) => r.n)).toEqual([3]);
  });

  it("reads the later value of a key after the earlier record that wrote it is dropped", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("k1", "first")]);
    own.add(A, 2, [put("other", "x")]);
    own.add(A, 3, [put("k1", "third")]);
    own.install([open(A, 2)]);
    expect(await read(own, "k1")).toBe("third");
  });

  it("returns a key whose only records are dropped to the runs", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("k1", "own"), del("k2")]);
    own.add(A, 2, [put("k1", "own again")]);
    own.install([open(A, 2)]);
    expect(own.get(k("k1"))).toBeUndefined();
    expect(own.get(k("k2"))).toBeUndefined();
    expect(await read(own, "k1")).toBe("run-k1");
    expect(await read(own, "k2")).toBe("run-k2");
    expect(own.range()).toEqual([]);
  });

  it("drops everything of a final log, past its n too", () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.add(A, 3, [put("z", "3")]);
    own.add(B, 1, [put("w", "1")]);
    own.install([final(A, 1)]);
    expect(own.range().map((r) => dec.decode(r.key))).toEqual(["w"]);
    expect(own.above(A, 0)).toEqual([]);
  });

  it("keeps the records past a damaged cursor, and above returns them in order", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.add(A, 3, [put("x", "3"), del("y")]);
    own.add(A, 4, [put("z", "4")]);
    own.install([damaged(A, 2)]);
    expect(await read(own, "x")).toBe("3");
    expect(await read(own, "z")).toBe("4");
    const rest = own.above(A, 2);
    expect(rest.map((r) => r.n)).toEqual([3, 4]);
    expect(rest[0]!.ops).toEqual([put("x", "3"), del("y")]);
    expect(own.above(A, 3).map((r) => r.n)).toEqual([4]);
  });

  it("reads an older log's kept write of a key after the newer log's write of it is dropped", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("z", "a1")]);
    own.add(A, 2, [put("x", "a2")]);
    own.add(B, 1, [put("x", "b1")]);
    own.add(B, 2, [put("w", "b2")]);
    own.install([damaged(A, 1), open(B, 1)]);
    expect(await read(own, "x")).toBe("a2");
    expect(own.get(k("z"))).toBeUndefined();
    expect(await read(own, "w")).toBe("b2");
  });

  it("drops what retire names and nothing of another log", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "a")]);
    own.add(B, 1, [put("y", "b")]);
    own.install([damaged(A, 0)]);
    own.retire(A);
    expect(own.get(k("x"))).toBeUndefined();
    expect(await read(own, "y")).toBe("b");
    expect(own.above(A, 0)).toEqual([]);
    own.retire("never-added" as LogId);
    expect(await read(own, "y")).toBe("b");
  });

  it("ignores cursors of logs it never held and cursors that move back", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.install([open("other" as LogId, 9), final("gone" as LogId, 3)]);
    expect(own.range()).toHaveLength(2);
    own.install([open(A, 1)]);
    own.install([open(A, 0)]);
    expect(own.get(k("x"))).toBeUndefined();
    expect(await read(own, "y")).toBe("2");
    own.install([]);
    expect(await read(own, "y")).toBe("2");
  });
});

describe("OwnQueue add", () => {
  it("ignores a record the installed manifest already covers", () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.install([open(A, 2)]);
    own.add(A, 2, [put("late", "2")]);
    expect(own.get(k("late"))).toBeUndefined();
    expect(own.bytes).toBe(0);
    own.add(A, 3, [put("z", "3")]);
    expect(own.get(k("z"))).toBeDefined();
  });

  it("ignores a record of a retired or final log", () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.install([final(A, 1)]);
    own.add(A, 2, [put("y", "2")]);
    expect(own.range()).toEqual([]);
  });

  it("refuses a gap, a restart, and a record for a log a newer one replaced", () => {
    const own = new OwnQueue();
    expect(() => own.add(A, 2, [put("x", "1")])).toThrow(RangeError);
    own.add(A, 1, [put("x", "1")]);
    expect(() => own.add(A, 3, [put("x", "3")])).toThrow(RangeError);
    own.add(B, 1, [put("y", "1")]);
    expect(() => own.add(A, 2, [put("x", "2")])).toThrow(RangeError);
    expect(own.range()).toHaveLength(2);
  });

  it("counts the key and value bytes it holds", () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("key", "value"), del("gone")]);
    own.add(A, 2, [put("k", "v")]);
    own.add(B, 1, [put("b", "bb")]);
    expect(own.bytes).toBe(3 + 5 + 4 + 2 + 3);
    own.install([open(A, 1)]);
    expect(own.bytes).toBe(2 + 3);
    own.retire(B);
    expect(own.bytes).toBe(2);
    own.install([final(A, 2)]);
    expect(own.bytes).toBe(0);
  });
});

describe("OwnQueue pin", () => {
  it("keeps answering as it did when pinned through add, install and retire", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1"), put("k2", "own")]);
    own.add(A, 2, [del("k3")]);
    const pinned = own.pin();
    const before = await scan(pinned);
    expect(before).toEqual(["k1=run-k1", "k2=own", "k4=run-k4", "x=1"]);

    own.add(A, 3, [put("x", "3"), put("new", "n")]);
    own.install([open(A, 2)]);
    own.add(B, 1, [put("y", "1")]);
    own.retire(B);

    expect(await scan(pinned)).toEqual(before);
    expect(await read(pinned, "x")).toBe("1");
    expect(await read(pinned, "new")).toBeUndefined();
    expect(await read(pinned, "k3")).toBeUndefined();
    expect(await scan(own)).toEqual(["k1=run-k1", "k2=run-k2", "k3=run-k3", "k4=run-k4", "new=n", "x=3"]);
  });

  it("holds a large overlay across an install that rebuilds it", async () => {
    const own = new OwnQueue();
    const name = (i: number) => `n${String(i).padStart(5, "0")}`;
    for (let n = 1; n <= 30; n++) {
      own.add(A, n, Array.from({ length: 100 }, (_, i) => put(name((n - 1) * 100 + i), `a${n}`)));
    }
    const pinned = own.pin();
    const want = pinned.range().map((r) => dec.decode(r.key));
    expect(want).toHaveLength(3000);

    own.install([open(A, 20)]);
    own.add(A, 31, [put(name(0), "again"), put(name(5000), "tail")]);
    own.retire(A);

    expect(pinned.range().map((r) => dec.decode(r.key))).toEqual(want);
    expect(dec.decode(pinned.get(k(name(0)))!.value!)).toBe("a1");
    expect(own.range()).toEqual([]);
  });
});
