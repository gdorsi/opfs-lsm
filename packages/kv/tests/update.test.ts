import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClosedError, ConstraintError, prefixBound, type Db, type Range, type UpdateTx, type ViewSnapshot } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests, ingest, MemoryFs } from "../src/testing.js";
import { CheckedBatch, checkDbName } from "../src/check.js";
import { TabWal } from "../src/idb/wal.js";
import { watchWalGroups } from "./wal-groups.js";

const NAME = "update";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);
const maxWalBytes = 1 << 30;

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetMemoryFsForTests(NAME);
});

const open = (writerId: string, fs: MemoryFs) => openHarnessDb({ name: NAME, writerId, fs, forceMemory: true, maxWalBytes });

function putOps(key: string, value: string) {
  const batch = new CheckedBatch();
  batch.add({ type: "put", key: utf(key), value: utf(value) });
  return batch.ops;
}

/** A write of another connection that posts nothing, so an open handle hears of it only from the WAL. */
async function unheard(key: string, value: string): Promise<void> {
  const silent = await TabWal.open(checkDbName(NAME));
  await silent.appendAfter(0, () => ({ ops: putOps(key, value), result: undefined }));
  silent.close();
}

/** Add one to the counter `n`, and count the runs of the body. */
function counter() {
  const count = { runs: 0 };
  const bump = (db: Db) =>
    db.update([utf("n")], ([cur], tx) => {
      count.runs += 1;
      const next = Number(text(cur) ?? "0") + 1;
      tx.put(utf("n"), utf(String(next)));
      return next;
    });
  return { count, bump };
}

const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** The keys under `saw/`, where a body records the value it read. */
async function saw(db: Db): Promise<(string | undefined)[]> {
  const keys: (string | undefined)[] = [];
  for await (const e of db.range(prefixBound(utf("saw/")))) keys.push(text(e.key));
  return keys;
}

const recordRead = (db: Db) => db.update([utf("n")], ([cur], tx) => tx.put(utf(`saw/${text(cur)}`), utf("x")));

describe("update", () => {
  it("concurrent increments from two tabs lose none", async () => {
    const fs = new MemoryFs();
    const a = await open("a", fs);
    const b = await open("b", fs);
    const { bump } = counter();
    const results = await Promise.all(upTo(20).map((i) => bump(i % 2 ? a : b)));
    expect(results.sort((x, y) => x - y)).toEqual(upTo(20));
    await a.sync();
    expect(text(await a.get(utf("n")))).toBe("20");
    await a.close();
    await b.close();
  });

  it("runs the body once when no other write lands, and commits like a put: one group of one record", async () => {
    const db = await open("a", new MemoryFs());
    await db.put(utf("n"), utf("1"));
    const groups = watchWalGroups();
    const { count, bump } = counter();
    expect(await bump(db)).toBe(2);
    expect(count.runs).toBe(1);
    expect(groups).toEqual([1]);
    expect(text(await db.get(utf("n")))).toBe("2");
    await db.close();
  });

  it("runs the body exactly twice when another handle's write landed first, and only its last run counts", async () => {
    const fs = new MemoryFs();
    const db = await open("a", fs);
    await db.put(utf("n"), utf("1"));
    await unheard("n", "5");
    const { count, bump } = counter();
    expect(await bump(db)).toBe(6);
    expect(count.runs).toBe(2);
    expect(text(await db.get(utf("n")))).toBe("6");
    const other = await open("b", fs);
    expect(text(await other.get(utf("n")))).toBe("6");
    await db.close();
    await other.close();
  });

  it("writes nothing from the run another write beat: in its handle, in another, and after a flush", async () => {
    const fs = new MemoryFs();
    const db = await open("a", fs);
    await db.put(utf("n"), utf("1"));
    await unheard("n", "5");
    await recordRead(db);
    expect(await saw(db)).toEqual(["saw/5"]);
    const other = await open("b", fs);
    expect(await saw(other)).toEqual(["saw/5"]);
    await ingest(db);
    const flushed = await open("c", fs);
    expect(await saw(flushed)).toEqual(["saw/5"]);
    for (const handle of [db, other, flushed]) await handle.close();
  });

  it("writes nothing from that run when its handle hears of the other write before its own row lands", async () => {
    const db = await open("a", new MemoryFs());
    await db.put(utf("n"), utf("1"));
    await unheard("n", "5");
    // The sync reads the WAL first. The body runs before its answer arrives, and the row lands after it.
    const sync = db.sync();
    await Promise.all([sync, recordRead(db)]);
    expect(await saw(db)).toEqual(["saw/5"]);
    await db.close();
  });

  it("reads a put of the same key issued in the same turn", async () => {
    const db = await open("a", new MemoryFs());
    const groups = watchWalGroups();
    const put = db.put(utf("n"), utf("7"));
    const { count, bump } = counter();
    const next = bump(db);
    await put;
    expect(await next).toBe(8);
    expect(count.runs).toBe(1);
    expect(groups, "the update adds no row that would lose to the put").toEqual([1]);
    expect(text(await db.get(utf("n")))).toBe("8");
    await db.close();
  });

  it("gives each update issued in one turn on one key its own result, in call order", async () => {
    const db = await open("a", new MemoryFs());
    const groups = watchWalGroups();
    const { count, bump } = counter();
    expect(await Promise.all(upTo(8).map(() => bump(db)))).toEqual(upTo(8));
    expect(count.runs).toBe(8);
    expect(groups, "each commits like a put").toEqual(upTo(8).map(() => 1));
    expect(text(await db.get(utf("n")))).toBe("8");
    await db.close();
  });

  it("runs the next update after one whose body threw", async () => {
    const db = await open("a", new MemoryFs());
    const { bump } = counter();
    const failed = db.update([utf("n")], () => {
      throw new Error("boom");
    });
    const next = bump(db);
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe(1);
    await db.close();
  });

  it("returns what a body that writes nothing read at the committed head", async () => {
    const db = await open("a", new MemoryFs());
    await db.put(utf("n"), utf("1"));
    await unheard("n", "5");
    expect(await db.update([utf("n")], ([cur]) => text(cur))).toBe("5");
    await db.close();
  });

  it("throws only what a body throws at the committed head", async () => {
    const db = await open("a", new MemoryFs());
    await db.put(utf("n"), utf("1"));
    await unheard("n", "5");
    const read = db.update([utf("n")], ([cur]) => {
      if (text(cur) !== "5") throw new Error(`read ${text(cur)}`);
      return text(cur);
    });
    expect(await read).toBe("5");
    await db.close();
  });

  it("writes no more rows that lose while another handle keeps writing, and commits like a put again once it stops", async () => {
    const db = await open("a", new MemoryFs());
    await db.put(utf("n"), utf("1"));
    const lost: number[] = [];
    const stop = db.changes((e) => {
      if (e.kind === "append" && e.ops.length === 0) lost.push(e.seq);
    });
    const { count, bump } = counter();

    await unheard("other", "0");
    expect(await bump(db)).toBe(2);
    expect(count.runs, "the update the other write beat runs again").toBe(2);
    expect(lost).toHaveLength(1);

    for (const i of upTo(3)) {
      await unheard("other", String(i));
      expect(await bump(db)).toBe(2 + i);
    }
    expect(count.runs, "each update after it runs once").toBe(5);
    expect(lost, "and writes no row that would lose").toHaveLength(1);

    // The other handle stopped. One update finds that out, and the next commits like a put.
    await bump(db);
    const groups = watchWalGroups();
    expect(await bump(db)).toBe(7);
    expect(count.runs).toBe(7);
    expect(groups).toEqual([1]);

    // So a write of the other handle beats it once more.
    await unheard("other", "9");
    expect(await bump(db)).toBe(8);
    expect(count.runs).toBe(9);
    expect(lost).toHaveLength(2);
    stop();
    await db.close();
  });

  it("rejects with ClosedError and writes nothing when the handle closes before the body runs again", async () => {
    const fs = new MemoryFs();
    const db = await open("w", fs);
    await unheard("n", "1");
    let runs = 0;
    const update = db.update([utf("n")], ([cur], tx) => {
      runs += 1;
      if (runs === 1) queueMicrotask(() => void db.close());
      tx.put(utf("copy"), cur ?? utf("none"));
    });
    await expect(update).rejects.toBeInstanceOf(ClosedError);
    const reopened = await open("r", fs);
    expect(await reopened.get(utf("copy"))).toBeUndefined();
    await reopened.close();
  });

  it("reads an ingested key in a tab that has not loaded the SST yet", async () => {
    const fs = new MemoryFs();
    const writer = await openHarnessDb({ name: NAME, writerId: "w", fs, forceMemory: true, maxWalBytes });
    await writer.put(utf("k"), utf("1"));
    await ingest(writer);
    const reader = await openHarnessDb({ name: NAME, writerId: "r", fs, forceMemory: true, maxWalBytes });
    const seen = await reader.update([utf("k"), utf("absent")], (values) =>
      values.map(text),
    );
    expect(seen).toEqual(["1", undefined]);
    await writer.close();
    await reader.close();
  });

  it("sees a write that was never broadcast", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, maxWalBytes });
    await db.put(utf("n"), utf("1"));
    const silent = await TabWal.open(checkDbName(NAME));
    await silent.appendAfter(0, () => ({
      ops: putOps("n", "5"),
      result: undefined,
    }));
    silent.close();
    await db.update([utf("n")], ([cur], tx) => {
      tx.put(utf("n"), utf(String(Number(text(cur)) + 1)));
    });
    expect(text(await db.get(utf("n")))).toBe("6");
    await db.close();
  });

  it("writes nothing when the body throws", async () => {
    const db = await openHarnessDb({ name: NAME, writerId: "w", fs: new MemoryFs(), forceMemory: true, maxWalBytes });
    await expect(
      db.update([utf("k")], (_values, tx) => {
        tx.put(utf("k"), utf("x"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.get(utf("k"))).toBeUndefined();
    await db.close();
  });
});

describe("update with tx.read", () => {
  /** `at` names the key that holds a number. Adds one to that number. */
  const bumpAt = (db: Db, count?: { runs: number }) =>
    db.update([utf("at")], ([at], tx) => {
      if (count) count.runs += 1;
      const [n] = tx.read([at!]);
      const next = Number(text(n) ?? "0") + 1;
      tx.put(at!, utf(String(next)));
      return `${text(at)}=${next}`;
    });

  /** `at` and the number it names in two runs, so a handle that loaded the one still has the other to load. */
  async function twoRuns(fs: MemoryFs): Promise<void> {
    const writer = await open("w", fs);
    await writer.batch((tx) => {
      tx.put(utf("n/1"), utf("7"));
      tx.put(utf("n/2"), utf("100"));
    });
    await ingest(writer);
    await writer.put(utf("at"), utf("n/1"));
    await ingest(writer);
    await writer.close();
  }

  it("reads a key the body learns from its values, and commits like a put when the value is in memory", async () => {
    const db = await open("a", new MemoryFs());
    await db.batch((tx) => {
      tx.put(utf("at"), utf("n/1"));
      tx.put(utf("n/1"), utf("7"));
    });
    const groups = watchWalGroups();
    const count = { runs: 0 };
    expect(await bumpAt(db, count)).toBe("n/1=8");
    expect(count.runs).toBe(1);
    expect(groups).toEqual([1]);
    expect(text(await db.get(utf("n/1")))).toBe("8");
    await db.close();
  });

  it("gives the values in the order of the keys, undefined for a missing one, and nothing for no key", async () => {
    const db = await open("a", new MemoryFs());
    await db.batch((tx) => {
      tx.put(utf("a"), utf("1"));
      tx.put(utf("c"), utf("3"));
    });
    const seen = await db.update([], (values, tx) => [values, tx.read([]), tx.read([utf("c"), utf("b"), utf("a")]).map(text)]);
    expect(seen).toEqual([[], [], ["3", undefined, "1"]]);
    await db.close();
  });

  it("runs the body again once a value it asked for is loaded, and still commits like a put", async () => {
    const fs = new MemoryFs();
    await twoRuns(fs);
    // A cache that keeps nothing: the update holds what it loaded until its body has run.
    const db = await openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, maxWalBytes, cacheBytes: 1 });
    const groups = watchWalGroups();
    const count = { runs: 0 };
    expect(await bumpAt(db, count)).toBe("n/1=8");
    expect(count.runs, "the first run ended at tx.read").toBe(2);
    expect(groups).toEqual([1]);
    expect(text(await db.get(utf("n/1")))).toBe("8");
    await db.close();
  });

  it("writes nothing from a run that ended at tx.read, even when the body caught what it threw", async () => {
    const fs = new MemoryFs();
    await twoRuns(fs);
    const db = await open("a", fs);
    let caught = 0;
    const out = await db.update([utf("at")], ([at], tx) => {
      try {
        const [n] = tx.read([at!]);
        tx.put(utf("copy"), n!);
        return "read";
      } catch {
        caught += 1;
        tx.put(utf("caught"), utf("x"));
        return "caught";
      }
    });
    expect([out, caught]).toEqual(["read", 1]);
    expect(await db.get(utf("caught"))).toBeUndefined();
    expect(text(await db.get(utf("copy")))).toBe("7");
    await db.close();
  });

  it("reads at the committed head when another handle's write landed first", async () => {
    const db = await open("a", new MemoryFs());
    await db.batch((tx) => {
      tx.put(utf("at"), utf("n/1"));
      tx.put(utf("n/1"), utf("7"));
      tx.put(utf("n/2"), utf("100"));
    });
    await unheard("at", "n/2");
    const count = { runs: 0 };
    expect(await bumpAt(db, count)).toBe("n/2=101");
    expect(count.runs).toBe(2);
    expect((await db.getMany([utf("n/1"), utf("n/2")])).map(text)).toEqual(["7", "101"]);
    await db.close();
  });

  it("ends a run at tx.read inside the transaction too, which then appends nothing and runs again", async () => {
    const fs = new MemoryFs();
    await twoRuns(fs);
    const db = await open("a", fs);
    // A row of this handle loses to another handle's write, so its next update runs in a transaction. Neither reads a run.
    await db.put(utf("m"), utf("0"));
    await unheard("other", "0");
    await db.update([utf("m")], ([m], tx) => tx.put(utf("m"), utf(`${text(m)}1`)));
    const groups = watchWalGroups();
    const count = { runs: 0 };
    expect(await bumpAt(db, count)).toBe("n/1=8");
    expect(count.runs).toBe(2);
    expect(groups, "the transaction adds its record itself, in no group").toEqual([]);
    expect(text(await db.get(utf("n/1")))).toBe("8");
    await db.close();
  });

  it("concurrent updates from two tabs that read through tx.read lose none", async () => {
    const fs = new MemoryFs();
    const a = await open("a", fs);
    const b = await open("b", fs);
    await a.put(utf("at"), utf("n/1"));
    await b.sync();
    const results = await Promise.all(upTo(20).map((i) => bumpAt(i % 2 ? a : b)));
    expect(results.sort()).toEqual(upTo(20).map((i) => `n/1=${i}`).sort());
    await a.sync();
    expect(text(await a.get(utf("n/1")))).toBe("20");
    await a.close();
    await b.close();
  });

  it("throws ConstraintError once the body returned", async () => {
    const db = await open("a", new MemoryFs());
    let kept: UpdateTx | undefined;
    await db.update([], (_values, tx) => {
      kept = tx;
    });
    expect(() => kept!.read([utf("k")])).toThrow(ConstraintError);
    await db.close();
  });
});

describe("rangeJoin", () => {
  it("joins each entry to its target across the log and an SST", async () => {
    const fs = new MemoryFs();
    const writer = await openHarnessDb({ name: NAME, writerId: "w", fs, forceMemory: true, maxWalBytes });
    await writer.batch((tx) => {
      tx.put(utf("doc/1"), utf("one"));
      tx.put(utf("idx/1"), utf("doc/1"));
    });
    await ingest(writer);
    await writer.batch((tx) => {
      tx.put(utf("doc/2"), utf("two"));
      tx.put(utf("idx/2"), utf("doc/2"));
      tx.put(utf("idx/3"), utf("doc/missing"));
    });
    const reader = await openHarnessDb({ name: NAME, writerId: "r", fs, forceMemory: true, maxWalBytes });
    const hits = await reader.view((snap) => snap.rangeJoin(prefixBound(utf("idx/")), (e) => e.value));
    expect(hits.map((h) => [text(h.entry.key), text(h.joined)])).toEqual([
      ["idx/1", "one"],
      ["idx/2", "two"],
      ["idx/3", undefined],
    ]);
    await writer.close();
    await reader.close();
  });

  it("does not see a write that lands during the view", async () => {
    const db = await openHarnessDb({ name: NAME, writerId: "w", fs: new MemoryFs(), forceMemory: true, maxWalBytes });
    await db.batch((tx) => {
      tx.put(utf("doc/1"), utf("one"));
      tx.put(utf("idx/1"), utf("doc/1"));
    });
    const hits = await db.view(async (snap) => {
      await db.batch((tx) => {
        tx.put(utf("doc/1"), utf("changed"));
        tx.put(utf("idx/2"), utf("doc/1"));
      });
      return snap.rangeJoin(prefixBound(utf("idx/")), (e) => e.value);
    });
    expect(hits.map((h) => [text(h.entry.key), text(h.joined)])).toEqual([["idx/1", "one"]]);
    await db.close();
  });

  it("asks keyOf once per entry and joins keys that repeat", async () => {
    const db = await openHarnessDb({ name: NAME, writerId: "w", fs: new MemoryFs(), forceMemory: true, maxWalBytes });
    await db.batch((tx) => {
      tx.put(utf("doc/1"), utf("one"));
      for (const i of [1, 2, 3]) tx.put(utf(`idx/${i}`), utf(i === 2 ? "doc/none" : "doc/1"));
    });
    await ingest(db);
    let asked = 0;
    const hits = await db.view((snap) =>
      snap.rangeJoin(prefixBound(utf("idx/")), (e) => {
        asked++;
        return text(e.value) === "doc/none" ? undefined : e.value;
      }),
    );
    expect(asked).toBe(3);
    expect(hits.map((h) => text(h.joined))).toEqual(["one", undefined, "one"]);
    await db.close();
  });

  it("joins the entries of a reverse range, last first", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, writerId: "w", fs, forceMemory: true, maxWalBytes });
    await db.batch((tx) => {
      for (const i of [1, 2, 3, 4]) {
        tx.put(utf(`doc/${i}`), utf(`doc ${i}`));
        tx.put(utf(`idx/${i}`), utf(`doc/${i}`));
      }
    });
    await ingest(db);
    await db.batch((tx) => {
      tx.put(utf("doc/5"), utf("doc 5"));
      tx.put(utf("idx/5"), utf("doc/5"));
      tx.delete(utf("idx/2"));
      tx.put(utf("doc/3"), utf("doc 3, newer"));
    });
    const shown = (hits: Awaited<ReturnType<ViewSnapshot["rangeJoin"]>>) =>
      hits.map((h) => `${text(h.entry.key)}>${text(h.joined)}`);
    const join = (range: Range) => db.view((snap) => snap.rangeJoin(range, (e) => e.value));
    const forward = shown(await join(prefixBound(utf("idx/"))));
    expect(forward).toHaveLength(4);
    for (const limit of [undefined, 1, 3]) {
      const range = { ...prefixBound(utf("idx/")), reverse: true, ...(limit !== undefined ? { limit } : {}) };
      expect(shown(await join(range))).toEqual([...forward].reverse().slice(0, limit));
    }
    await db.close();
  });
});
