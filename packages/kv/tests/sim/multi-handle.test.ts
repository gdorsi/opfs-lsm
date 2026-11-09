import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installSeams, multiCommandsArb, runWorld } from "./multi.js";

/**
 * Random histories over three handles that share one host and one
 * MemoryFs. Ops of different handles overlap, the scheduler picks the
 * order of bus deliveries, file calls and log writes, and the recorded
 * history is checked against the log (`history.ts`). Every run ends with
 * `checkDatabase`, the oracle, and a reopen.
 *
 * Replay a failure with the seed, path and replayPath it prints:
 *   KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/multi-handle.test.ts
 * Sweep longer:     KV_MODEL_RUNS=2000 pnpm exec vitest run tests/sim/multi-handle.test.ts
 * Add KV_SIM_TRACE=1 to print every scheduled task and op.
 */
const env = process.env;
const RUNS = Number(env.KV_MODEL_RUNS ?? 100);
/** A history that runs longer than this hangs: fast-check fails it and shrinks it like any other. */
const RUN_MS = Number(env.KV_MODEL_RUN_MS ?? 20_000);
const replay = env.KV_MODEL_SEED
  ? { seed: Number(env.KV_MODEL_SEED), ...(env.KV_MODEL_PATH ? { path: env.KV_MODEL_PATH } : {}) }
  : {};

let restore: () => void;
beforeAll(() => {
  restore = installSeams();
});
afterAll(() => restore());

let runs = 0;

describe("kv model (several handles)", () => {
  it("every handle reads log prefixes, updates lose nothing, and the files stay healthy", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(fc.scheduler(), multiCommandsArb(env.KV_MODEL_REPLAY), (s, cmds) =>
          runWorld(`multi-${++runs}`, s, 1 << 30, cmds),
        ),
        { numRuns: RUNS, timeout: RUN_MS, ...replay },
      ),
    ).resolves.toBeUndefined();
  }, 600_000);

  it("holds with the host ingesting in the background", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(fc.scheduler(), fc.constantFrom(256, 4096), multiCommandsArb(env.KV_MODEL_REPLAY), (s, maxWalBytes, cmds) =>
          runWorld(`multi-${++runs}`, s, maxWalBytes, cmds),
        ),
        { numRuns: RUNS, timeout: RUN_MS, ...replay },
      ),
    ).resolves.toBeUndefined();
  }, 600_000);
});
