import { describe, expect, it } from "vitest";
import { actions, clone, crashes, diskKey, initial, read, type Bounds, type ReadAs, type State } from "../formal/ingest-plan/model.js";
import type { CheckedKey, CheckedValue } from "../src/check.js";
import type { LogId, QueueScan } from "../src/host/queues.js";
import { encodeOps } from "../src/idb/wal.js";
import { scanLog, type ListedSegment } from "../src/log/queue-scan.js";
import { encodeHeader, encodeRecords, encodeSeal, frameSeed } from "../src/log/segment.js";

const BOUNDS: Bounds = { appends: 2, commits: 2, segCap: 1, drops: 0, failedOpen: false };
type Segment = NonNullable<State["logs"][string]>["segments"][number];
const MODEL_LOGS = ["a", "p", "q"] as LogId[];
const hex = (log: LogId): LogId => (MODEL_LOGS.indexOf(log) + 1).toString(16).padStart(16, "0") as LogId;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The model's segment files of `log` as the real writer would leave them; a damaged frame gets a flipped body byte. */
function encode(s: State, log: LogId): ListedSegment[] {
  const pred = s.writers[log]!.pred;
  return s.logs[log]!.segments.map((g) => {
    const nonce = MODEL_LOGS.indexOf(log) * 1000 + g.firstN;
    const seed = frameSeed(nonce);
    const header = encodeHeader(g.firstN === 1 && pred ? { nonce, firstN: 1, pred: { log: hex(pred.log), lastN: pred.lastN } } : { nonce, firstN: g.firstN });
    const frames = g.frames.map((f) => {
      const ops = [{ type: "put" as const, key: Uint8Array.of(f.w) as CheckedKey, value: Uint8Array.of(f.w) as CheckedValue }];
      const bytes = encodeRecords([new Uint8Array(encodeOps(ops))], f.n, seed);
      if (!f.ok) bytes[bytes.length - 1]! ^= 0xff;
      return bytes;
    });
    return { firstN: g.firstN, bytes: concat([header, ...frames, ...(g.sealed ? [encodeSeal(g.firstN + g.frames.length, seed)] : [])]) };
  });
}

/** The model's reader and scanLog on the same disk, as comparable values. */
function bothReads(s: State, log: LogId, from: number, segments: ListedSegment[], as: ReadAs) {
  const { dead, listed, firstUnreadable } = as;
  const model = read(s, log, from, as);
  const shown = segments.map((g): ListedSegment => (firstUnreadable && g.firstN === 1 ? { firstN: 1, bytes: "unreadable" } : g));
  const real = scanLog(hex(log), from, dead, listed ? shown.filter((g) => listed.includes(g.firstN)) : shown);
  return {
    model: { records: model.records, stop: model.stop, pred: model.pred && { log: hex(model.pred.log), lastN: model.pred.lastN } },
    real: { records: real.records.map((r) => [r.n, r.ops[0]!.key[0]]), stop: real.stop, pred: real.pred ?? null },
  };
}

/** A model state whose log p holds `segments`, with its writer live or dead. */
function disk(segments: Segment[], dead: boolean): State {
  const s = initial();
  s.logs.p = { segments };
  s.writers.p!.state = dead ? "dead" : "live";
  return s;
}

const P = "p" as LogId;
const frames = (firstN: number, oks: readonly boolean[]) => oks.map((ok, i) => ({ n: firstN + i, w: firstN + i, ok }));

describe("on directly built logs", () => {
  it("reads a bad frame in the last segment as the end for now while live, and as a hole once dead when a whole frame or a SEAL follows", () => {
    const badThenWhole: Segment = { firstN: 1, frames: frames(1, [true, false, true]), sealed: false };
    const sealedBadLast: Segment = { firstN: 1, frames: frames(1, [true, false]), sealed: true };
    const tornLast: Segment = { firstN: 1, frames: frames(1, [true, false]), sealed: false };
    const hole = { hole: 2, reason: "bad frame" };
    const cases: [string, Segment, boolean, QueueScan["stop"]][] = [
      ["live, bad frame then a whole one", badThenWhole, false, "end"],
      ["dead, bad frame then a whole one", badThenWhole, true, hole],
      ["live, sealed, last record bad", sealedBadLast, false, "end"],
      ["dead, sealed, last record bad", sealedBadLast, true, hole],
      ["dead, unsealed, last record bad", tornLast, true, "end"],
    ];
    for (const [name, seg, dead, stop] of cases) {
      const s = disk([seg], dead);
      const { model, real } = bothReads(s, P, 0, encode(s, P), { dead });
      const want = { records: [[1, 1]], stop, pred: null };
      expect([name, "model", model]).toEqual([name, "model", want]);
      expect([name, "scanLog", real]).toEqual([name, "scanLog", want]);
    }
  });

  it("agrees with the model's reader on every log of up to two segments of up to two whole or bad frames, sealed or not, live or dead", () => {
    const shapes: { oks: boolean[]; sealed: boolean }[] = [];
    for (const oks of [[], [true], [false], [true, true], [true, false], [false, true], [false, false]]) {
      for (const sealed of [false, true]) shapes.push({ oks, sealed });
    }
    const logs: Segment[][] = [];
    for (const firstN of [1, 2]) {
      for (const a of shapes) {
        const head: Segment = { firstN, frames: frames(firstN, a.oks), sealed: a.sealed };
        logs.push([head]);
        for (const gap of a.oks.length === 0 ? [1] : [0, 1]) {
          const next = firstN + a.oks.length + gap;
          for (const b of shapes) logs.push([head, { firstN: next, frames: frames(next, b.oks), sealed: b.sealed }]);
        }
      }
    }
    const differ: string[] = [];
    let compared = 0;
    for (const segments of logs) {
      for (const dead of [false, true]) {
        const s = disk(segments, dead);
        const encoded = encode(s, P);
        const last = Math.max(0, ...segments.flatMap((g) => g.frames.map((f) => f.n)));
        for (let from = 0; from <= last + 1; from++) {
          const { model, real } = bothReads(s, P, from, encoded, { dead });
          if (JSON.stringify(model) !== JSON.stringify(real)) differ.push(`${dead ? "dead" : "live"} from ${from} ${JSON.stringify(segments)}: model ${JSON.stringify(model.stop)}, scanLog ${JSON.stringify(real.stop)}`);
          compared++;
        }
      }
    }
    console.log(`direct agreement: ${logs.length} logs, ${compared} scans compared`);
    expect(differ).toEqual([]);
    expect(compared).toBeGreaterThan(5000);
  });
});

it("agrees with the ingest-plan model's reader on every log disk the model reaches", () => {
  const seenStates = new Set<string>();
  const crashed = new Set<string>();
  const seenDisks = new Set<string>();
  let compared = 0;
  const compare = (s: State): void => {
    for (const log of MODEL_LOGS) {
      const l = s.logs[log];
      if (!l) continue;
      const pred = s.writers[log]!.pred;
      const listing = s.round && "listed" in s.round ? s.round.listed?.[log] : undefined;
      const listings = [undefined, ...(listing ? [listing] : [])];
      const key = JSON.stringify([log, l, pred, listings]);
      if (seenDisks.has(key)) continue;
      seenDisks.add(key);
      const segments = encode(s, log);
      const last = Math.max(0, ...l.segments.flatMap((g) => g.frames.map((f) => f.n)));
      for (const listed of listings) {
        for (const dead of [false, true]) {
          for (const firstUnreadable of l.segments[0]?.firstN === 1 ? [false, true] : [false]) {
            for (let from = 0; from <= last + 1; from++) {
              const { model, real } = bothReads(s, log, from, segments, { dead, listed, firstUnreadable });
              const at = `${dead ? "dead" : "live"} ${log} from ${from}${listed ? ` listed ${listed}` : ""}${firstUnreadable ? " first unreadable" : ""}: ${JSON.stringify(l)}`;
              expect([at, real]).toEqual([at, model]);
              compared++;
            }
          }
        }
      }
    }
  };

  let frontier = [JSON.stringify(initial())];
  seenStates.add(frontier[0]!);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const key of frontier) {
      const s = JSON.parse(key) as State;
      compare(s);
      const disk = diskKey(s);
      for (const a of crashed.has(disk) ? [] : crashes(s, BOUNDS)) {
        const c = clone(s);
        a.apply(c);
        compare(c);
      }
      crashed.add(disk);
      for (const a of actions(s, {}, BOUNDS)) {
        const c = clone(s);
        a.apply(c);
        const k = JSON.stringify(c);
        if (seenStates.has(k)) continue;
        seenStates.add(k);
        next.push(k);
      }
    }
    frontier = next;
  }
  console.log(`model agreement: ${seenStates.size} model states, ${seenDisks.size} log disks, ${compared} scans compared`);
  expect(seenDisks.size).toBeGreaterThan(100);
}, 30_000);
