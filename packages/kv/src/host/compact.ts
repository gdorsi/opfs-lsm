import { CorruptDatabaseError } from "../errors.js";
import type { IdBWal } from "../idb/wal.js";
import type { AsyncFs, FileWriter, OpenFile } from "../opfs/async-fs.js";
import { reconcile, type Trusted } from "../recover.js";
import { openMerge, type MergeCore } from "../store/engine.js";
import {
  loadGeneration,
  loadLatestGeneration,
  manifestNumbers,
  publishGeneration,
  type GenerationMeta,
  type RunMeta,
} from "../store/generation.js";
import {
  codecForLevel,
  levelRunPath,
  planCompaction,
  replaceRuns,
  TARGET_RUN_BYTES,
  type CompactionPlan,
} from "../store/levels.js";
import type { HostBudget } from "./budget.js";
import { inMergeSlot } from "./merge-slot.js";

/** Merged runs written to OPFS and not yet in any generation. */
type CompactionOutput = {
  readonly inputs: readonly string[];
  readonly outputs: readonly RunMeta[];
  readonly droppedSeq: number;
};

type Merged = Pick<CompactionOutput, "outputs" | "droppedSeq">;

/**
 * Plan one step on `base` (the recorded generation; the newest manifest
 * file when omitted), merge its inputs, and write the output runs. Needs no
 * ingest lock: a flush meanwhile only adds L0 runs in front of the inputs,
 * which stay contiguous and keep their bottom status. Outputs are named
 * past every manifest number in use (`knownTop`, IndexedDB's
 * `topGeneration`, and `m/`), so they never overwrite a run one may list.
 * The merge waits for its turn in the context's one merge slot, so another
 * database's step already running finishes first.
 */
export async function mergeNextStep(
  fs: AsyncFs,
  budget: HostBudget,
  base?: GenerationMeta,
  knownTop = 0,
): Promise<CompactionOutput | undefined> {
  const meta = base ?? (await loadLatestGeneration(fs));
  if (!meta) return undefined;
  const top = Math.max(meta.generation, knownTop, (await manifestNumbers(fs))[0] ?? 0);
  const plan = planCompaction(meta.runs, { maxSources: budget.maxSources });
  if (!plan) return undefined;
  const name = (i: number) => levelRunPath(plan.outputLevel, `c${top + 1}.${i}`);
  const merged = await inMergeSlot(() => writeStep(fs, plan, name, budget));
  return { inputs: plan.inputs.map((r) => r.path), ...merged };
}

async function writeStep(
  fs: AsyncFs,
  plan: CompactionPlan,
  name: (i: number) => string,
  budget: HostBudget,
): Promise<Merged> {
  const inputs: OpenFile[][] = [];
  let merge: MergeCore | undefined;
  try {
    for (const source of plan.sources) {
      const files: OpenFile[] = [];
      inputs.push(files);
      for (const { path } of source) {
        const file = await fs.open(path);
        if (!file) throw new Error(`compaction missing input ${path}`);
        files.push(file);
      }
    }
    merge = await openMerge({
      sources: inputs.map((files) => files.map((f) => f.size)),
      dropTombstones: plan.bottom,
      targetBytes: TARGET_RUN_BYTES,
      codec: codecForLevel(plan.outputLevel),
      chunkBytes: budget.chunkBytes,
      tailBytes: budget.tailBytes,
      yieldBytes: budget.yieldBytes,
    });
    return await pumpMerge(fs, merge, inputs, name);
  } finally {
    merge?.close();
    for (const file of inputs.flat()) file.close();
  }
}

/**
 * Pump `merge` until it is done. Answers each `need` with parallel reads of
 * `inputs` (by source, then run), streams each output run to `name(i)` as
 * its bytes come, and gives the event loop a turn at each `yield`. Returns
 * only after `done`, so only outputs whose inputs all checked out reach a
 * manifest. On any failure, removes every output it created and throws.
 */
export async function pumpMerge(
  fs: AsyncFs,
  merge: MergeCore,
  inputs: readonly (readonly OpenFile[])[],
  name: (i: number) => string,
): Promise<Merged> {
  const outputs: RunMeta[] = [];
  const created: string[] = [];
  let open: { readonly path: string; readonly writer: FileWriter } | undefined;
  try {
    for (;;) {
      const stop = merge.pump();
      switch (stop.kind) {
        case "need": {
          const got = await Promise.all(stop.demands.map((d) => inputs[d.source]![d.run]!.read(d.offset, d.length)));
          stop.demands.forEach((d, i) => merge.feed(d.source, got[i]!));
          break;
        }
        case "write":
          if (!open) {
            const path = name(outputs.length);
            created.push(path);
            open = { path, writer: await fs.create(path) };
          }
          await open.writer.write(stop.bytes);
          break;
        case "run-end":
          if (!open) throw new Error("merge ended an output run it never wrote");
          await open.writer.finish();
          outputs.push({ path: open.path, ...stop.end });
          open = undefined;
          break;
        case "yield":
          await new Promise((resolve) => setTimeout(resolve, 0));
          break;
        case "done":
          return { outputs, droppedSeq: stop.droppedSeq };
      }
    }
  } catch (err) {
    await open?.writer.abort().catch(() => undefined);
    for (const path of created) await fs.remove(path).catch(() => undefined);
    throw err;
  }
}

/**
 * Swap the step's inputs for its output in the recorded generation and
 * record the result in IDB. The inputs and the old manifests stay on
 * disk: tabs may still read them, so the host retires them (see
 * `HostedDb.reclaim`). Run under the ingest lock.
 */
export async function installStep(
  fs: AsyncFs,
  wal: IdBWal,
  step: CompactionOutput,
  trusted: Trusted,
): Promise<number> {
  const base = await reconcile(wal, fs, trusted);
  const meta = await loadGeneration(fs, base.generation);
  if (!meta) throw new CorruptDatabaseError(`manifest ${base.generation} is gone`);
  const live = new Set(meta.runs.map((r) => r.path));
  if (!step.inputs.every((p) => live.has(p))) {
    throw new Error("compaction inputs left the recorded generation");
  }
  const runs = replaceRuns(meta.runs, step.inputs, step.outputs);
  const generation = base.top + 1;
  await publishGeneration(fs, {
    generation,
    runs,
    tombstoneSeq: Math.max(meta.tombstoneSeq, step.droppedSeq),
    through: meta.through,
  });
  await wal.raiseGeneration(generation);
  return generation;
}
