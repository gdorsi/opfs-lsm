import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { BROWSERS } from "./queue-fs.js";
import { hostCmdArb, mulberry32, QueueWorld, segmentBytesArb, settle, tabCmdArb, type HostCmd, type TabCmd } from "./queue-world.js";

/**
 * Random histories of per-tab ingest queues, in each browser's read
 * behavior: up to three tabs append, flush, rotate, fail and die while the
 * SharedWorker ingests in rounds with partial `maxBytes` and reclaims. The
 * scheduler interleaves tab commands, the host's file calls and lock
 * takes, and segment creates. After each host command the files must
 * still serve every manifest; after a drain every acked record is in the
 * runs once, in order (`QueueWorld.checkRuns`).
 *
 *   KV_QUEUE_RUNS=2000 pnpm exec vitest run tests/sim/queue-history.test.ts
 *   KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> pnpm exec vitest run tests/sim/queue-history.test.ts
 */
const env = process.env;
const RUNS = Number(env.KV_QUEUE_RUNS ?? 300);
const replay = env.KV_MODEL_SEED
  ? { seed: Number(env.KV_MODEL_SEED), ...(env.KV_MODEL_PATH ? { path: env.KV_MODEL_PATH } : {}) }
  : {};

type History = {
  readonly seed: number;
  readonly segmentBytes: number;
  readonly chromeRefusal: number;
  readonly tabs: readonly (readonly TabCmd[])[];
  readonly host: readonly HostCmd[];
};

const historyArb: fc.Arbitrary<History> = fc.record({
  seed: fc.integer(),
  segmentBytes: segmentBytesArb,
  chromeRefusal: fc.constantFrom(1, 0.5),
  tabs: fc.array(fc.array(tabCmdArb, { maxLength: 14 }), { minLength: 1, maxLength: 3 }),
  host: fc.array(hostCmdArb, { minLength: 1, maxLength: 10 }),
});

let histories = 0;
afterAll(() => console.info(`queue histories: ${histories}`));

describe("ingest queues under a scheduler", () => {
  it.each(BROWSERS)("%s: every acked record lands once, in order, and reclaim keeps what recovery needs", async (browser) => {
    await expect(
      fc.assert(
        fc.asyncProperty(fc.scheduler(), historyArb, async (s, h) => {
          histories++;
          const world = new QueueWorld(browser, mulberry32(h.seed), h.tabs.length, h.segmentBytes, h.chromeRefusal);
          await world.start();
          world.gate = (label) => s.schedule(Promise.resolve(), label);
          const tabs = h.tabs.map(async (cmds, i) => {
            for (const cmd of cmds) {
              await world.gate(`tab ${i}: ${cmd.t}`);
              await world.run(i, cmd);
            }
          });
          const host = (async () => {
            for (const cmd of h.host) {
              await world.gate(`host: ${cmd.t}`);
              await world.serve(cmd);
              await world.checkFiles();
            }
          })();
          await settle(s, Promise.all([...tabs, host]));
          await world.drain();
          await world.checkFiles();
          await world.checkRuns();
        }),
        { numRuns: RUNS, ...replay },
      ),
    ).resolves.toBeUndefined();
  }, 600_000);
});
