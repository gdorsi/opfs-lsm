import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HostLimits } from "../../src/testing.js";
import { commandsArb, expectEntries, expectHealthy, Model, Sut } from "./commands.js";

/**
 * Random command histories on one handle, checked against the oracle after
 * every read and by `checkDatabase` at the end of every run.
 *
 * Replay a failure with the seed, path and replayPath it prints:
 *   KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/model.test.ts
 * Sweep longer:     KV_MODEL_RUNS=2000 pnpm exec vitest run tests/sim/model.test.ts
 */
const env = process.env;
const RUNS = Number(env.KV_MODEL_RUNS ?? 100);
const replay = env.KV_MODEL_SEED
  ? { seed: Number(env.KV_MODEL_SEED), ...(env.KV_MODEL_PATH ? { path: env.KV_MODEL_PATH } : {}) }
  : {};

const cmdsArb = commandsArb(env.KV_MODEL_REPLAY);

let runs = 0;

async function runHistory(limits: Partial<HostLimits>, cmds: Iterable<fc.AsyncCommand<Model, Sut, false>>): Promise<void> {
  const sut = new Sut(`model-${++runs}`, limits);
  await sut.open();
  const model = new Model();
  try {
    await fc.asyncModelRun(() => ({ model, real: sut }), cmds);
    // End of run: quiesce, check the files, then read everything back on the handle `quiet` opened.
    await sut.quiet();
    await expectHealthy(model, sut);
    const all: { key: Uint8Array; value: Uint8Array }[] = [];
    for await (const e of sut.db.range()) all.push(e);
    expectEntries(all, model.oracle.stateAt(), "range after reopen");
  } finally {
    await sut.dispose();
  }
}

describe("kv model (single handle)", () => {
  it("every read is the fold of a log prefix, and the files stay healthy", async () => {
    await expect(
      fc.assert(fc.asyncProperty(cmdsArb, (cmds) => runHistory({ batchBytes: 1 << 30 }, cmds)), { numRuns: RUNS, ...replay }),
    ).resolves.toBeUndefined();
  }, 600_000);

  // The host's own ingest and compaction race every command. Less
  // reproducible: a failing seed may need a few replays.
  it("stays a log prefix with ingest running in the background", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(fc.constantFrom(64, 1024, 16 * 1024), cmdsArb, (batchBytes, cmds) =>
          runHistory({ batchBytes, runBytes: 4096, l0StopRuns: 3 }, cmds),
        ),
        { numRuns: Math.ceil(RUNS / 4), ...replay },
      ),
    ).resolves.toBeUndefined();
  }, 600_000);
});
