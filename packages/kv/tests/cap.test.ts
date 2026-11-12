import { describe, expect, it } from "vitest";
import { answerOffer, decideCap, IDLE, type Measurement, type OfferState } from "../src/host/cap.js";
import type { RunMeta } from "../src/store/generation.js";
import { NO_MARKS } from "../src/store/marks.js";
import { encodeRun, type SstEntry } from "../src/store/sst.js";

const enc = new TextEncoder();

/** An L1 run of `rows` puts of 100 entry bytes, at seqs `from..from + rows - 1`. */
function run(from: number, rows: number): RunMeta {
  const entries: SstEntry[] = Array.from({ length: rows }, (_, i) => ({
    kind: "put",
    key: enc.encode(`k${String(from + i).padStart(5, "0")}`),
    value: new Uint8Array(94),
    seq: from + i,
  }));
  const { end } = encodeRun(entries, 4096);
  return { path: `l1/r${from}.sst`, bytes: end.bytes, range: end.range!, stats: end.stats!, marksThrough: from + rows - 1 };
}

const runs = [run(1, 100), run(101, 100)];
const over = (pass: number, through = 200, id = `o${pass}`): Measurement => ({
  meta: { runs, marks: NO_MARKS, through },
  now: 0,
  maxBytes: 10_000,
  pass,
  id,
});
const under = (pass: number, through = 200): Measurement => ({ ...over(pass, through), maxBytes: 100_000 });

describe("decideCap", () => {
  it("offers once over the cap, with need down to 7/8 of it and a seq that frees it", () => {
    const { next, post } = decideCap(IDLE, over(1));
    expect(post).toEqual({ id: "o1", pressure: { liveBytes: 20_000, maxBytes: 10_000, need: 11_250, through: expect.any(Number) } });
    expect(next).toEqual({ kind: "offered", ...post });
    expect(post!.pressure.through).toBeGreaterThan(100);
    expect(post!.pressure.through).toBeLessThan(200);
  });

  it("keeps one offer open: a later measurement updates its numbers and posts nothing", () => {
    const { next: offered } = decideCap(IDLE, over(1));
    const { next, post } = decideCap(offered, over(2, 200, "o2"));
    expect(post).toBeUndefined();
    expect(next).toMatchObject({ kind: "offered", id: "o1" });
  });

  it("withdraws an offer once the database is under the cap", () => {
    const { next: offered } = decideCap(IDLE, over(1));
    expect(decideCap(offered, under(2))).toEqual({ next: IDLE });
    expect(decideCap(IDLE, under(1))).toEqual({ next: IDLE });
  });

  it("takes the answer to the open offer only", () => {
    const { next: offered } = decideCap(IDLE, over(1));
    expect(answerOffer(offered, "other", 250, 1)).toBe(offered);
    expect(answerOffer(IDLE, "o1", 250, 1)).toBe(IDLE);
    expect(answerOffer(offered, "o1", 250, 1)).toEqual({ kind: "answered", head: 250, pass: 1 });
  });

  it("judges an answer only from a pass that began after it, on a manifest that holds its writes", () => {
    const answered: OfferState = { kind: "answered", head: 250, pass: 3 };
    expect(decideCap(answered, over(3, 250)).next).toBe(answered);
    expect(decideCap(answered, over(4, 249)).next).toBe(answered);
    expect(decideCap(answered, under(3)).next).toBe(answered);
    expect(decideCap(answered, over(4, 250, "o4")).post?.id).toBe("o4");
    expect(decideCap(answered, under(4, 250)).next).toBe(IDLE);
  });
});
