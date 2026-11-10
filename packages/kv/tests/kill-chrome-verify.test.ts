import { describe, expect, it } from "vitest";
import { verifyKillState, type KillTail } from "../proof/kill-chrome-verify.ts";
import type { WorkOp } from "../proof/kill-chrome-workload.ts";

const put = (key: string, value: string): WorkOp[] => [{ type: "put", key, value }];

describe("verifyKillState", () => {
  it("pins 14 unseen seqs to the tab whose values were read, instead of searching 3^14", () => {
    const tails: KillTail[] = [0, 1, 2].map((tab) => ({
      lastSeq: 0,
      next: Array.from({ length: 14 }, (_, i) => put(`k${tab}-${i}`, `1.${tab}.${i + 1}.0|x`)),
    }));
    const observed = new Map<string, string>();
    for (const ops of tails[2]!.next) {
      const op = ops[0]!;
      if (op.type === "put") observed.set(op.key, op.value);
    }
    const verdict = verifyKillState(new Map(), 0, 14, [], tails, observed);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.assignments).toBe(1);
  });

  it("rejects a value no attempt wrote", () => {
    const tails: KillTail[] = [{ lastSeq: 0, next: [put("k", "1.0.1.0|x")] }];
    const verdict = verifyKillState(new Map(), 0, 1, [], tails, new Map([["k", "other"]]));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("was not written");
  });

  it("places the last writer after an acked write of the same key", () => {
    const tails: KillTail[] = [
      { lastSeq: 0, next: [put("k", "final")] },
      { lastSeq: 0, next: [put("m", "side")] },
    ];
    const known = [{ seq: 2, ops: put("k", "acked") }];
    const observed = new Map([
      ["k", "final"],
      ["m", "side"],
    ]);
    const verdict = verifyKillState(new Map(), 0, 3, known, tails, observed);
    expect(verdict.ok).toBe(true);
  });

  it("rejects a later forced attempt that overwrites the read value", () => {
    const tails: KillTail[] = [
      {
        lastSeq: 0,
        next: [put("k", "v0"), [...put("k", "v1"), ...put("m", "m1")]],
      },
    ];
    const observed = new Map([
      ["k", "v0"],
      ["m", "m1"],
    ]);
    const verdict = verifyKillState(new Map(), 0, 2, [], tails, observed);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("no assignment");
  });
});
