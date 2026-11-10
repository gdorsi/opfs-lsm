import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installSeams, multiCommandsArb, onPlan, runWorld, totals } from "./multi.js";

vi.mock("../../src/host/queues.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/host/queues.js")>();
  return {
    ...real,
    planIngest: (...args: Parameters<typeof real.planIngest>) => {
      const plan = real.planIngest(...args);
      onPlan(plan);
      return plan;
    },
  };
});

/**
 * Random histories over three handles that share one host and one
 * MemoryFs. Ops of different handles overlap, the scheduler picks the
 * order of bus deliveries and file calls, and the recorded history is
 * checked against the ingest log (`history.ts`). Every run ends with
 * `checkDatabase`, the oracle, and a reopen.
 *
 * Replay a failure with the seed, path and replayPath it prints:
 *   KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/multi-handle.test.ts
 * Sweep longer:     KV_MODEL_RUNS=2000 pnpm exec vitest run tests/sim/multi-handle.test.ts
 * Add KV_SIM_TRACE=1 to print every scheduled task and op.
 */
const env = process.env;
const RUNS = Number(env.KV_MODEL_RUNS ?? 100);
const replay = env.KV_MODEL_SEED
  ? { seed: Number(env.KV_MODEL_SEED), ...(env.KV_MODEL_PATH ? { path: env.KV_MODEL_PATH } : {}) }
  : {};

let restore: () => void;
beforeAll(() => {
  restore = installSeams();
});
afterAll(() => {
  restore();
  console.info(`multi-handle: ${totals.histories} histories, ${totals.acked} acked records, ${totals.ingested} ingested, ${totals.reads} reads checked`);
});

let runs = 0;

describe("kv model (several handles)", () => {
  it("every handle reads an installed prefix with its own records on top, and the files stay healthy", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(fc.scheduler(), multiCommandsArb(env.KV_MODEL_REPLAY), (s, cmds) =>
          runWorld(`multi-${++runs}`, s, { batchBytes: 1 << 30 }, cmds),
        ),
        { numRuns: RUNS, ...replay },
      ),
    ).resolves.toBeUndefined();
  }, 600_000);

  // Small rounds, a low L0 stop and background rounds started by the
  // flushed bytes: ingest and compaction race every command.
  it("holds with the host ingesting in the background", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(fc.scheduler(), fc.constantFrom(256, 4096), multiCommandsArb(env.KV_MODEL_REPLAY), (s, batchBytes, cmds) =>
          runWorld(`multi-${++runs}`, s, { batchBytes, runBytes: 2048, l0StopRuns: 3 }, cmds),
        ),
        { numRuns: RUNS, ...replay },
      ),
    ).resolves.toBeUndefined();
  }, 600_000);
});
