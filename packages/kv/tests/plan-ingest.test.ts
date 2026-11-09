import { describe, expect, it } from "vitest";
import { planIngest, type LogId, type QueueBase, type QueueScan } from "../src/host/queues.js";

const P = "p" as LogId;
const S = "a" as LogId;
const Q = "q" as LogId;
const EMPTY: QueueBase = { through: 0, queues: [] };
const NO_HINTS = new Map<LogId, number>();

function scan(log: LogId, ns: number[], extra: Partial<QueueScan> = {}): QueueScan {
  return { log, dead: false, records: ns.map((n) => ({ n, ops: [], bytes: 10 })), stop: "end", ...extra };
}

const order = (plan: ReturnType<typeof planIngest>) => plan.records.map((r) => `${r.log}${r.n}@${r.seq}`);

describe("planIngest", () => {
  it("ingests a successor only after its pred through lastN, and nothing of the pred past it", () => {
    const plan = planIngest(
      EMPTY,
      [scan(S, [1], { dead: true, pred: { log: P, lastN: 2 } }), scan(P, [1, 2, 3], { dead: true })],
      NO_HINTS,
      Infinity,
    );
    expect(order(plan)).toEqual(["p1@1", "p2@2", "a1@3"]);
    expect(plan.queues).toEqual([
      { log: S, state: "final", n: 1 },
      { log: P, state: "final", n: 2 },
    ]);
  });

  it("holds a successor while its pred is live below lastN", () => {
    const plan = planIngest(
      EMPTY,
      [scan(S, [1], { pred: { log: P, lastN: 2 } }), scan(P, [1, 2])],
      new Map([[P, 1], [S, 1]]),
      Infinity,
    );
    expect(order(plan)).toEqual(["p1@1"]);
    expect(plan.queues).toEqual([{ log: P, state: "open", n: 1 }]);
  });

  it("finalizes a live pred once it reaches lastN", () => {
    const plan = planIngest(
      EMPTY,
      [scan(S, [1], { pred: { log: P, lastN: 2 } }), scan(P, [1, 2, 3])],
      new Map([[P, 2], [S, 1]]),
      Infinity,
    );
    expect(order(plan)).toEqual(["p1@1", "p2@2", "a1@3"]);
    expect(plan.queues).toContainEqual({ log: P, state: "final", n: 2 });
  });

  it("takes a live log only up to its durable hint", () => {
    const plan = planIngest(EMPTY, [scan(Q, [1, 2, 3])], new Map([[Q, 2]]), Infinity);
    expect(order(plan)).toEqual(["q1@1", "q2@2"]);
    expect(plan.queues).toEqual([{ log: Q, state: "open", n: 2 }]);
  });

  it("takes nothing of a live log with no hint", () => {
    const plan = planIngest(EMPTY, [scan(Q, [1])], NO_HINTS, Infinity);
    expect(plan.records).toEqual([]);
    expect(plan.queues).toEqual([]);
  });

  it("numbers seqs on from the base and resumes each log after its cursor", () => {
    const base: QueueBase = { through: 7, queues: [{ log: Q, state: "open", n: 1 }] };
    const plan = planIngest(base, [scan(Q, [2, 3], { dead: true })], NO_HINTS, Infinity);
    expect(order(plan)).toEqual(["q2@8", "q3@9"]);
    expect(plan.through).toBe(9);
  });

  it("stops at maxBytes and leaves the rest for the next plan", () => {
    const scans = [scan(P, [1, 2], { dead: true }), scan(Q, [1], { dead: true })];
    const first = planIngest(EMPTY, scans, NO_HINTS, 15);
    expect(order(first)).toEqual(["p1@1"]);
    expect(first.queues).toEqual([{ log: P, state: "open", n: 1 }]);

    const second = planIngest(first, [scan(P, [2], { dead: true }), scan(Q, [1], { dead: true })], NO_HINTS, 25);
    expect(order(second)).toEqual(["p2@2", "q1@3"]);
    expect(second.queues).toEqual([
      { log: P, state: "final", n: 2 },
      { log: Q, state: "final", n: 1 },
    ]);
  });

  it("takes one record even when it alone is over maxBytes", () => {
    const plan = planIngest(EMPTY, [scan(Q, [1, 2], { dead: true })], NO_HINTS, 1);
    expect(order(plan)).toEqual(["q1@1"]);
  });

  it("damages a live log at a hole and asks its tab to re-append", () => {
    const plan = planIngest(EMPTY, [scan(Q, [1], { stop: { hole: 2, reason: "bad frame" } })], new Map([[Q, 3]]), Infinity);
    expect(order(plan)).toEqual(["q1@1"]);
    expect(plan.queues).toEqual([{ log: Q, state: "damaged", n: 1, reason: "bad frame" }]);
    expect(plan.damagedLive).toEqual([Q]);
  });

  it("damages a dead log at a hole without asking anyone", () => {
    const plan = planIngest(EMPTY, [scan(Q, [1], { dead: true, stop: { hole: 2, reason: "bad frame" } })], NO_HINTS, Infinity);
    expect(plan.queues).toEqual([{ log: Q, state: "damaged", n: 1, reason: "bad frame" }]);
    expect(plan.damagedLive).toEqual([]);
  });

  it("finalizes a dead log read to its end, and leaves a live one open", () => {
    const plan = planIngest(EMPTY, [scan(P, [1], { dead: true }), scan(Q, [1])], new Map([[Q, 1]]), Infinity);
    expect(plan.queues).toEqual([
      { log: P, state: "final", n: 1 },
      { log: Q, state: "open", n: 1 },
    ]);
  });

  it("never reads a log again once its cursor is terminal", () => {
    const base: QueueBase = { through: 1, queues: [{ log: P, state: "final", n: 1 }] };
    const plan = planIngest(base, [scan(P, [2], { dead: true })], NO_HINTS, Infinity);
    expect(plan.records).toEqual([]);
    expect(plan.queues).toEqual(base.queues);
  });
});
