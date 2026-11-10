import { expect, it } from "vitest";
import { actions, crashes, initial, read, type Bounds, type State } from "../formal/ingest-plan/model.js";
import type { CheckedKey, CheckedValue } from "../src/check.js";
import type { LogId } from "../src/host/queues.js";
import { encodeOps } from "../src/idb/wal.js";
import { scanLog, type ListedSegment } from "../src/log/queue-scan.js";
import { encodeHeader, encodeRecords, encodeSeal, frameSeed } from "../src/log/segment.js";

const BOUNDS: Bounds = { appends: 2, commits: 2, segCap: 1, drops: 0 };
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

it("agrees with the ingest-plan model's reader on every log disk the model reaches", () => {
  const seenStates = new Set<string>();
  const seenDisks = new Set<string>();
  let compared = 0;
  const compare = (s: State): void => {
    for (const log of MODEL_LOGS) {
      const l = s.logs[log];
      if (!l) continue;
      const w = s.writers[log]!;
      const dead = w.state === "dead";
      const listings = [undefined, ...(!dead && s.pass?.listed[log] ? [s.pass.listed[log]] : [])];
      const key = JSON.stringify([log, l, dead, w.pred, listings]);
      if (seenDisks.has(key)) continue;
      seenDisks.add(key);
      const segments = encode(s, log);
      const last = Math.max(0, ...l.segments.flatMap((g) => g.frames.map((f) => f.n)));
      for (const listed of listings) {
        for (let from = 0; from <= last + 1; from++) {
          const model = read(s, log, from, listed);
          const real = scanLog(hex(log), from, dead, listed ? segments.filter((g) => listed.includes(g.firstN)) : segments);
          const at = `${log} from ${from}${listed ? ` listed ${listed}` : ""}: ${JSON.stringify(l)}`;
          expect({ at, records: real.records.map((r) => [r.n, r.ops[0]!.key[0]]), stop: real.stop, pred: real.pred ?? null }).toEqual({
            at,
            records: model.records,
            stop: model.stop,
            pred: model.pred && { log: hex(model.pred.log), lastN: model.pred.lastN },
          });
          compared++;
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
      for (const a of crashes(s, BOUNDS)) {
        const c = JSON.parse(key) as State;
        a.apply(c);
        compare(c);
      }
      for (const a of actions(s, {}, BOUNDS)) {
        const c = JSON.parse(key) as State;
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
