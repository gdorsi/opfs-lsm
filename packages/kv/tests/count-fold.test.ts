/**
 * docs/counted-ranges.md, "The fold": every way a short history of one key
 * can be cut into flushes and merged, through the real fold (`foldRecords`),
 * the real encoder and the real merge session. Whenever every version left
 * says what held before it and no mark holds the key, the versions must say
 * plus once more than minus if the key is live, and as often if it is not.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { checkKey, checkValue, type CheckedOp } from "../src/check.js";
import { asSeq } from "../src/seq.js";
import { encodeRun, ensureEngine } from "../src/store/engine.js";
import { foldRecords } from "../src/store/fold.js";
import { retireMarks, throughAt, type Marks } from "../src/store/marks.js";
import { Memtable, type WalRecord } from "../src/store/memtable.js";
import type { KeyRange, SstEntry } from "../src/store/sst.js";
import { decodeSst } from "./oracle/sst-ref.js";
import { mergeRuns } from "./runs.js";

const KEY = checkKey(new TextEncoder().encode("k"));
const VALUE = checkValue(new TextEncoder().encode("v"));
const EVERY_KEY = checkKey(new Uint8Array(0));

/** What a step of a history does. A sparing range delete leaves the write just before it. */
const STEPS = ["put, informed", "delete, informed", "put, blind", "delete, blind", "range delete", "range delete, sparing"] as const;
type Step = (typeof STEPS)[number];

type Run = { readonly body: Uint8Array; readonly range: KeyRange; readonly marksThrough: number };
type State = { readonly runs: readonly Run[]; readonly marks: Marks };

/** The records of `history`, each one op at the next seq, and whether the key is live after each. */
function replay(history: readonly Step[]): { records: WalRecord[]; live: boolean[] } {
  const records: WalRecord[] = [];
  const live: boolean[] = [];
  let now = false;
  history.forEach((step, i) => {
    const seq = asSeq(i + 1);
    const was = now ? ("present" as const) : ("absent" as const);
    let op: CheckedOp;
    switch (step) {
      case "put, informed":
        op = { type: "put", key: KEY, value: VALUE, was };
        now = true;
        break;
      case "delete, informed":
        op = { type: "del", key: KEY, was };
        now = false;
        break;
      case "put, blind":
        op = { type: "put", key: KEY, value: VALUE };
        now = true;
        break;
      case "delete, blind":
        op = { type: "del", key: KEY };
        now = false;
        break;
      case "range delete":
        op = { type: "deleteRange", start: EVERY_KEY, through: asSeq(seq - 1) };
        now = false;
        break;
      case "range delete, sparing":
        op = { type: "deleteRange", start: EVERY_KEY, through: asSeq(Math.max(0, seq - 2)) };
        // Only the write just before it is left, if it was one.
        now = i > 0 && history[i - 1]!.startsWith("put");
        break;
    }
    records.push({ seq, ops: [op] });
    live.push(now);
  });
  return { records, live };
}

const versions = (runs: readonly Run[]): SstEntry[] => runs.flatMap((run) => decodeSst(run.body));

/** The rule under test, and that the runs still read as the log does. */
function check(state: State, rows: readonly { kind: "put" | "del"; was?: "absent" | "present" | undefined; seq: number }[], marks: Marks, live: boolean, context: string): void {
  // Newest first: the memtable's row, then each run.
  const all = [...rows, ...versions(state.runs)];
  const newest = all[0];
  const covered = newest !== undefined && newest.seq <= throughAt(marks, KEY);
  expect(newest !== undefined && newest.kind === "put" && !covered, `${context}: reads`).toBe(live);
  if (all.some((v) => v.was === undefined) || throughAt(marks, KEY) > 0) return;
  const net = all.reduce((n, v) => n + (v.kind === "put" && v.was === "absent" ? 1 : v.kind === "del" && v.was === "present" ? -1 : 0), 0);
  expect(net, `${context}: its versions say ${net}`).toBe(live ? 1 : 0);
}

/** Flush `records` on top of `state`, as an ingest does. */
async function flush(state: State, records: readonly WalRecord[]): Promise<State> {
  const folded = foldRecords(records);
  const last = records[records.length - 1]!.seq;
  let runs = state.runs;
  if (folded.entries.length > 0) {
    const { body, end } = await encodeRun(folded.entries, "raw");
    runs = [{ body, range: end.range!, marksThrough: last }, ...runs];
  }
  return { runs, marks: retireMarks([...state.marks, ...folded.marks], runs) };
}

/** Merge `runs[from..to]` of `state`, newest first, as a compaction step does. `through` is the manifest's. */
async function merge(state: State, from: number, to: number, through: number): Promise<State> {
  const inputs = state.runs.slice(from, to + 1);
  const out = await mergeRuns(inputs.map((run) => [run.body]), { dropTombstones: to === state.runs.length - 1, marks: state.marks });
  const merged = out.runs.map(({ body, end }) => ({ body, range: end.range!, marksThrough: through }));
  const runs = [...state.runs.slice(0, from), ...merged, ...state.runs.slice(to + 1)];
  return { runs, marks: retireMarks(state.marks, runs) };
}

async function everyLayout(history: readonly Step[]): Promise<number> {
  const { records, live } = replay(history);
  const n = records.length;
  let layouts = 0;
  // Each bit of `cuts` ends a flush after that record. The records after the last cut stay in the memtable.
  for (let cuts = 0; cuts < 1 << n; cuts++) {
    let state: State = { runs: [], marks: [] };
    let from = 0;
    for (let i = 0; i < n; i++) {
      if (!(cuts & (1 << i))) continue;
      state = await flush(state, records.slice(from, i + 1));
      from = i + 1;
    }
    // A tab that applied every record as it was written, then installed the flushes.
    const mem = new Memtable();
    for (const record of records) mem.apply(record);
    mem.advanceTo(asSeq(from));
    const context = `${history.join(" | ")}, flushes ${cuts.toString(2)}`;
    const end = live[n - 1]!;
    check(state, mem.range(), [...state.marks, ...mem.marks], end, context);
    layouts++;
    // Every merge of adjacent runs, the mark step of one run included, then every merge of what that leaves.
    const after = from === 0 ? false : live[from - 1]!;
    for (let a = 0; a < state.runs.length; a++) {
      for (let b = a; b < state.runs.length; b++) {
        const once = await merge(state, a, b, from);
        check(once, [], once.marks, after, `${context}, merged ${a}..${b}`);
        check(once, mem.range(), [...once.marks, ...mem.marks], end, `${context}, merged ${a}..${b}, with the memtable`);
        layouts++;
        for (let c = 0; c < once.runs.length; c++) {
          for (let d = c; d < once.runs.length; d++) {
            const twice = await merge(once, c, d, from);
            check(twice, [], twice.marks, after, `${context}, merged ${a}..${b} then ${c}..${d}`);
            layouts++;
          }
        }
      }
    }
  }
  return layouts;
}

describe("what the versions of a key say adds up to whether it is live", () => {
  beforeAll(async () => {
    await ensureEngine();
  });

  it("for every history of up to three writes and range deletes, however it is flushed and merged", async () => {
    let layouts = 0;
    const histories: Step[][] = [[]];
    for (let length = 1; length <= 3; length++) {
      for (const shorter of histories.filter((h) => h.length === length - 1)) for (const step of STEPS) histories.push([...shorter, step]);
    }
    for (const history of histories) if (history.length > 0) layouts += await everyLayout(history);
    expect(layouts).toBeGreaterThan(5_000);
  }, 120_000);

  it("for random histories of four to six steps", async () => {
    let x = 0x2545f491;
    const pick = (n: number) => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) % n;
    };
    let layouts = 0;
    for (let i = 0; i < 25; i++) {
      layouts += await everyLayout(Array.from({ length: 4 + pick(3) }, () => STEPS[pick(STEPS.length)]!));
    }
    expect(layouts).toBeGreaterThan(1_000);
  }, 120_000);
});
