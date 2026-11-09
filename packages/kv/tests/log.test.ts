import { describe, expect, it } from "vitest";
import { checkBatch } from "../src/check.js";
import {
  KIND_RECORD,
  KIND_SEAL,
  decodeOps,
  encodeFrame,
  encodeOps,
  parseSegment,
  scanFrames,
  segmentFile,
} from "../src/log/frame.js";
import { Hlc } from "../src/log/hlc.js";
import { Merger, type MergedRecord } from "../src/log/merger.js";
import { listSegments, listTabs } from "../src/log/reader.js";
import { EngineHost, MemoryFs, createLocalIngestClient, type Db } from "../src/index.js";
import { dbInternals } from "../src/db.js";
import { openHarnessDb } from "../src/testing.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const str = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);

function put(key: string, value = key): Uint8Array {
  return encodeOps(checkBatch([{ type: "put", key: utf(key), value: utf(value) }]));
}

function rec(tab: string, stamp: number, n: number): MergedRecord {
  return { stamp, tab, n, writerId: tab, ops: decodeOps(put(`${tab}${stamp}`)) };
}

describe("log frames", () => {
  it("round-trip records, and a SEAL ends the segment", () => {
    const bytes = new Uint8Array([
      ...encodeFrame(KIND_RECORD, 10, 1, put("a")),
      ...encodeFrame(KIND_RECORD, 20, 2, put("b")),
      ...encodeFrame(KIND_SEAL, 20, 2, new Uint8Array(0)),
    ]);
    const scan = scanFrames(bytes, 0, 0);
    expect(scan.records.map((r) => [r.stamp, r.n, dec.decode(r.ops[0]!.key)])).toEqual([
      [10, 1, "a"],
      [20, 2, "b"],
    ]);
    expect(scan.sealed).toBe(true);
    expect(scan.validBytes).toBe(bytes.byteLength);
  });

  it("stop at a torn frame, a bad CRC, a gap in n, and a stamp that does not rise", () => {
    const one = encodeFrame(KIND_RECORD, 10, 1, put("a"));
    const two = encodeFrame(KIND_RECORD, 20, 2, put("b"));
    expect(scanFrames(new Uint8Array([...one, ...two.subarray(0, 5)]), 0, 0).records).toHaveLength(1);
    const corrupt = new Uint8Array([...one, ...two]);
    corrupt[corrupt.byteLength - 1]! ^= 1;
    expect(scanFrames(corrupt, 0, 0).records).toHaveLength(1);
    const gap = new Uint8Array([...one, ...encodeFrame(KIND_RECORD, 20, 3, put("c"))]);
    expect(scanFrames(gap, 0, 0).records).toHaveLength(1);
    const back = new Uint8Array([...one, ...encodeFrame(KIND_RECORD, 10, 2, put("c"))]);
    expect(scanFrames(back, 0, 0).records).toHaveLength(1);
  });

  it("accept any first n after reclaimed segments", () => {
    const frame = encodeFrame(KIND_RECORD, 50, 7, put("a"));
    expect(scanFrames(frame, 0, 0).records).toHaveLength(0);
    expect(scanFrames(frame, undefined, 40).records).toHaveLength(1);
  });

  it("pass over records under a cut, checking only their place in the chain", () => {
    const bytes = new Uint8Array([
      ...encodeFrame(KIND_RECORD, 10, 1, put("a")),
      ...encodeFrame(KIND_RECORD, 20, 2, put("b")),
      ...encodeFrame(KIND_RECORD, 30, 3, put("c")),
    ]);
    const scan = scanFrames(bytes, 0, 0, 20);
    expect(scan.records.map((r) => r.n)).toEqual([3]);
    expect([scan.n, scan.stamp, scan.validBytes]).toEqual([3, 30, bytes.byteLength]);
    // A skipped record's body is not checked; a returned one's is.
    const body = bytes.slice();
    body[30]! ^= 1;
    expect(scanFrames(body, 0, 0, 20).records.map((r) => r.n)).toEqual([3]);
    expect(scanFrames(body, 0, 0, 0).records).toEqual([]);
    // A skipped record still has to follow the chain.
    const gap = new Uint8Array([...encodeFrame(KIND_RECORD, 10, 1, put("a")), ...encodeFrame(KIND_RECORD, 20, 5, put("b"))]);
    expect(scanFrames(gap, 0, 0, 20).n).toBe(1);
  });

  it("name segments by first n and the stamp before them, in sort order", () => {
    const a = segmentFile({ firstN: 1, prevStamp: 0 });
    const b = segmentFile({ firstN: 12, prevStamp: 99 });
    expect(parseSegment(b)).toEqual({ firstN: 12, prevStamp: 99 });
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe("hlc", () => {
  it("never repeats, rises with the clock, and sorts after what it observed", () => {
    let now = 100;
    const hlc = new Hlc(() => now);
    const a = hlc.next();
    const b = hlc.next();
    expect(b).toBeGreaterThan(a);
    hlc.observe(10_000);
    expect(hlc.next()).toBeGreaterThan(10_000);
    now = 1_000_000;
    expect(hlc.next()).toBe(4_000_000);
  });
});

describe("merger", () => {
  it("hands out records once every tab that may write promised past them, in (stamp, tab) order", () => {
    const m = new Merger("me");
    m.setLive(["a", "b"]);
    expect(m.record("a", rec("a", 10, 1))).toBe("ok");
    expect(m.record("b", rec("b", 10, 1))).toBe("ok");
    // b is heard from at 10, a at 10, and this tab promises 30.
    expect(m.drain(30).map((r) => `${r.tab}${r.stamp}`)).toEqual(["a10", "b10"]);
    expect(m.stable).toBe(10);
    m.record("a", rec("a", 20, 2));
    expect(m.drain(30)).toEqual([]); // b has promised only 10
    expect(m.promise("b", 25, 1)).toBe("ok");
    expect(m.drain(30).map((r) => r.stamp)).toEqual([20]);
    expect(m.stable).toBe(20); // a's own last record is all a has promised
  });

  it("holds the watermark at a live tab it has not heard from, until it promises", () => {
    const m = new Merger("me");
    m.record("a", rec("a", 10, 1));
    m.setLive(["a", "new"]);
    expect(m.drain(100)).toEqual([]);
    m.promise("new", 50, 0);
    expect(m.drain(100).map((r) => r.stamp)).toEqual([10]);
  });

  it("reports a gap in a tab's n, and a promise of records it has not taken in", () => {
    const m = new Merger("me");
    m.record("a", rec("a", 10, 1));
    expect(m.record("a", rec("a", 30, 3))).toBe("gap");
    expect(m.promise("a", 40, 3)).toBe("gap");
    expect(m.record("a", rec("a", 20, 2))).toBe("ok");
    expect(m.record("a", rec("a", 20, 2))).toBe("dup");
  });

  it("stops waiting for a dead tab once its log was read to the end", () => {
    const m = new Merger("me");
    m.setLive(["a", "dead"]);
    m.promise("a", 100, 0);
    m.record("dead", rec("dead", 10, 1));
    expect(m.drain(100).map((r) => r.stamp)).toEqual([10]);
    expect(m.stable).toBe(10);
    m.finalize("dead");
    expect(m.drain(100)).toEqual([]);
    expect(m.stable).toBe(100);
  });

  it("drops what a generation's cut covers", () => {
    const m = new Merger("me");
    m.record("a", rec("a", 10, 1));
    m.record("a", rec("a", 20, 2));
    m.cut(15);
    m.promise("a", 30, 2);
    expect(m.drain(30).map((r) => r.stamp)).toEqual([20]);
  });
});

/** Tabs over one MemoryFs and one in-process host. */
async function tabs(count: number, maxWalBytes = 1 << 20) {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const name = `log-${Math.random().toString(36).slice(2)}`;
  const dbs: Db[] = [];
  for (let i = 0; i < count; i++) {
    dbs.push(
      await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), ingestPolicy: { maxWalBytes } }),
    );
  }
  return { fs, host, name, dbs, close: () => Promise.all(dbs.map((d) => d.close())) };
}

async function stateOf(db: Db): Promise<{ head: number; rows: string[] }> {
  return db.view(async (snap) => {
    const rows: string[] = [];
    for await (const e of snap.range()) rows.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
    return { head: snap.walHead, rows };
  });
}

describe("per-tab logs", () => {
  it("write with no lock to the tab's own log, read their own writes at once, and the other tab's after sync", async () => {
    const { fs, dbs, close } = await tabs(2);
    const [a, b] = dbs as [Db, Db];
    try {
      await a.put(utf("x"), utf("1"));
      expect(str(await a.get(utf("x")))).toBe("1");
      await b.put(utf("y"), utf("2"));
      await a.sync();
      await b.sync();
      expect(str(await a.get(utf("y")))).toBe("2");
      expect(str(await b.get(utf("x")))).toBe("1");
      const own = (await listTabs(fs)).sort();
      expect(own).toEqual([dbInternals(a)!.tab, dbInternals(b)!.tab].sort());
    } finally {
      await close();
    }
  });

  it("give every tab the same order and the same seqs", async () => {
    const { dbs, close } = await tabs(3);
    try {
      await Promise.all(
        dbs.flatMap((db, t) =>
          Array.from({ length: 20 }, (_, i) => db.put(utf(`k${i % 5}`), utf(`t${t}.${i}`))),
        ),
      );
      for (const db of dbs) await db.sync();
      const states = await Promise.all(dbs.map(stateOf));
      expect(states[0]!.head).toBe(60);
      expect(states[1]).toEqual(states[0]);
      expect(states[2]).toEqual(states[0]);
    } finally {
      await close();
    }
  });

  it("serialize updates across tabs with no lock and no lost update", async () => {
    const { dbs, close } = await tabs(3);
    const counter = utf("counter");
    try {
      let runs = 0;
      await Promise.all(
        dbs.flatMap((db) =>
          Array.from({ length: 15 }, () =>
            db.update([counter], ([cur], tx) => {
              runs += 1;
              tx.put(counter, utf(String(Number(str(cur) ?? "0") + 1)));
            }),
          ),
        ),
      );
      expect(runs).toBe(45);
      for (const db of dbs) {
        await db.sync();
        expect(str(await db.get(counter))).toBe("45");
      }
    } finally {
      await close();
    }
  });

  it("order a write after another tab's write it has seen", async () => {
    const { dbs, close } = await tabs(2);
    const [a, b] = dbs as [Db, Db];
    try {
      await a.put(utf("k"), utf("a"));
      await b.sync();
      await b.put(utf("k"), utf("b"));
      await a.sync();
      expect(str(await a.get(utf("k")))).toBe("b");
    } finally {
      await close();
    }
  });

  it("ingest every tab's records at one cut, and reclaim the segments it covers", async () => {
    const { fs, dbs, close } = await tabs(2, 256);
    const [a, b] = dbs as [Db, Db];
    try {
      for (let i = 0; i < 40; i++) await (i % 2 ? a : b).put(utf(`k${i}`), utf("x".repeat(40)));
      await a.ingest();
      await b.sync();
      const sa = await stateOf(a);
      expect(sa.rows).toHaveLength(40);
      expect(await stateOf(b)).toEqual(sa);
      // Each tab keeps at most its open segment and the one before it.
      for (const tab of await listTabs(fs)) expect((await listSegments(fs, tab)).length).toBeLessThanOrEqual(2);
    } finally {
      await close();
    }
  });

  it("let a new tab join while others write, and agree with them", async () => {
    const { fs, host, name, dbs, close } = await tabs(2);
    try {
      const writing = Promise.all(
        dbs.flatMap((db, t) => Array.from({ length: 30 }, (_, i) => db.put(utf(`k${i}`), utf(`t${t}.${i}`)))),
      );
      const late = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host) });
      dbs.push(late);
      await late.put(utf("late"), utf("1"));
      await writing;
      for (const db of dbs) await db.sync();
      const states = await Promise.all(dbs.map(stateOf));
      expect(states[0]!.head).toBe(61);
      for (const s of states) expect(s).toEqual(states[0]);
    } finally {
      await close();
    }
  });

  it("read a closed tab's log to its end and stop waiting for it", async () => {
    const { fs, host, name, dbs, close } = await tabs(2);
    const [a, b] = dbs as [Db, Db];
    try {
      for (let i = 0; i < 5; i++) await a.put(utf(`a${i}`), utf("1"));
      await a.close();
      await b.sync();
      expect(str(await b.get(utf("a4")))).toBe("1");
      // b alone now: its writes are stable at once, and a reopen sees everything.
      await b.put(utf("b"), utf("1"));
      await b.ingest();
      const again = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host) });
      dbs.push(again);
      expect((await stateOf(again)).rows).toHaveLength(6);
    } finally {
      await close();
    }
  });
});
