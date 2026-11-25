import type { IdBWal } from "../idb/wal.js";
import { raiseGeneration } from "../idb/wal.js";
import type { AsyncFs, FileWriter, OpenFile } from "../opfs/async-fs.js";
import { reconcile, type Trusted } from "../recover.js";
import { nextGeneration, type Generation } from "../seq.js";
import { openMerge, type Demand, type MergeCore } from "../store/engine.js";
import {
  loadRecorded,
  manifestNumbers,
  publishGeneration,
  type GenerationMeta,
  type RunMeta,
} from "../store/generation.js";
import {
  levelRunPath,
  planCompaction,
  replaceRuns,
  TARGET_RUN_BYTES,
  type CompactionPlan,
} from "../store/levels.js";
import { retireMarks } from "../store/marks.js";
import type { HostBudget } from "./budget.js";
import { inMergeSlot } from "./merge-slot.js";

/** A run the merge wrote, before it is given a `marksThrough`. */
type MergedRun = Omit<RunMeta, "marksThrough">;

/** Merged runs written to OPFS and not yet in any generation. */
type CompactionOutput = {
  readonly inputs: readonly string[];
  readonly outputs: readonly RunMeta[];
};

/**
 * Plan one step on `base`, the recorded generation, merge its inputs, and
 * write the output runs. Needs no ingest lock: a flush meanwhile only adds
 * L0 runs in front of the inputs, which stay contiguous and keep their
 * bottom status. Outputs are named
 * past every manifest number in use (`knownTop`, IndexedDB's
 * `topGeneration`, and `m/`), so they never overwrite a run one may list.
 * The merge waits for its turn in the context's one merge slot, so another
 * database's step already running finishes first. `awaited` says whether a
 * flush waits for this step now (see `pumpMerge`).
 */
export async function mergeNextStep(
  fs: AsyncFs,
  budget: HostBudget,
  base: GenerationMeta,
  knownTop: Generation,
  awaited: () => boolean,
): Promise<CompactionOutput | undefined> {
  const top = Math.max(base.generation, knownTop, (await manifestNumbers(fs))[0] ?? 0);
  const plan = planCompaction(base, { maxSources: budget.maxSources });
  if (!plan) return undefined;
  const name = (i: number) => levelRunPath(plan.outputLevel, `c${top + 1}.${i}`);
  // Only an L0 step has more than two sources. One that starts with half the runs of the stop ends after L0 is full.
  const ahead = () => (plan.sources.length > budget.maxSources / 2 || awaited() ? budget.chunkBytes : 0);
  const merged = await inMergeSlot(() => writeStep(fs, plan, name, budget, base, ahead));
  return {
    inputs: plan.inputs.map((r) => r.path),
    // The merge applied every mark of `base`. One the manifest gains before
    // the install is past `base.through`, so the output claims none of it.
    outputs: merged.map((run) => ({ ...run, marksThrough: base.through })),
  };
}

async function writeStep(
  fs: AsyncFs,
  plan: CompactionPlan,
  name: (i: number) => string,
  budget: HostBudget,
  base: GenerationMeta,
  ahead: () => number,
): Promise<MergedRun[]> {
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
      marks: base.marks,
      targetBytes: TARGET_RUN_BYTES,
      chunkBytes: budget.chunkBytes,
      tailBytes: budget.tailBytes,
      yieldBytes: budget.yieldBytes,
    });
    return await pumpMerge(fs, merge, inputs, name, ahead);
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
 *
 * A step waits on files longer than it computes. While `ahead()` is above 0,
 * two of those waits overlap the session's work: one output write stays in
 * flight while the session fills the next, and that many bytes are read
 * ahead after each read of the last source. That is the level the step
 * merges into when any of its runs overlap, which then holds most of the
 * step's bytes and is read front to back. So up to two windows more are in
 * flight. The overlap takes file time from the tabs, so the host asks for it
 * only when a flush waits for the step or soon will.
 */
export async function pumpMerge(
  fs: AsyncFs,
  merge: MergeCore,
  inputs: readonly (readonly OpenFile[])[],
  name: (i: number) => string,
  ahead: () => number,
): Promise<MergedRun[]> {
  const outputs: MergedRun[] = [];
  const created: string[] = [];
  let open: { readonly path: string; readonly writer: FileWriter } | undefined;
  let writing: Promise<void> | undefined;
  // The bytes read ahead: `size` of them at `at` in `from`.
  let from: OpenFile | undefined;
  let at = 0;
  let size = 0;
  let bytes: Promise<Uint8Array>;
  const read = (d: Demand): Promise<Uint8Array> => {
    const file = inputs[d.source]![d.run]!;
    if (d.source < inputs.length - 1) return file.read(d.offset, d.length);
    const got = from === file && at === d.offset && size >= d.length ? bytes.then((b) => b.subarray(0, d.length)) : file.read(d.offset, d.length);
    from = file;
    at = d.offset + d.length;
    size = Math.min(ahead(), file.size - at);
    // A read ahead that fails throws only if the session asks for it.
    if (size > 0) (bytes = file.read(at, size)).catch(() => undefined);
    return got;
  };
  try {
    for (;;) {
      const stop = merge.pump();
      switch (stop.kind) {
        case "need": {
          const got = await Promise.all(stop.demands.map(read));
          stop.demands.forEach((d, i) => merge.feed(d.source, got[i]!));
          break;
        }
        case "write":
          if (!open) {
            const path = name(outputs.length);
            created.push(path);
            open = { path, writer: await fs.create(path) };
          }
          await writing;
          // It throws at the next write or at the end of the run.
          (writing = open.writer.write(stop.bytes)).catch(() => undefined);
          if (!ahead()) await writing;
          break;
        case "run-end":
          if (!open) throw new Error("merge ended an output run it never wrote");
          await writing;
          await open.writer.finish();
          outputs.push({ path: open.path, ...stop.end });
          open = undefined;
          break;
        case "yield":
          await new Promise((resolve) => setTimeout(resolve, 0));
          break;
        case "done":
          return outputs;
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
): Promise<Generation> {
  const base = await reconcile(wal, fs, trusted);
  const meta = await loadRecorded(fs, base.generation);
  const live = new Set(meta.runs.map((r) => r.path));
  if (!step.inputs.every((p) => live.has(p))) {
    throw new Error("compaction inputs left the recorded generation");
  }
  const runs = replaceRuns(meta.runs, step.inputs, step.outputs);
  const generation = nextGeneration(base.top);
  const manifest = await publishGeneration(fs, {
    generation,
    runs,
    through: meta.through,
    marks: retireMarks(meta.marks, runs),
  });
  await raiseGeneration(wal, generation, manifest);
  return generation;
}
