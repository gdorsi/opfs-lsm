import { CorruptDatabaseError } from "../errors.js";
import type { AsyncFs, ReadFs } from "../opfs/async-fs.js";
import type { Generation, Seq } from "../seq.js";
import { encodeRun } from "../store/engine.js";
import { encodeGeneration, loadGeneration, manifestHead, manifestPath, type GenerationMeta, type RunMeta } from "../store/generation.js";
import { levelRunPath } from "../store/levels.js";
import type { SstEntry } from "../store/sst.js";

/** Write the manifest of `meta`, and return its head for the transaction that records it. */
export async function publishGeneration(
  fs: AsyncFs,
  meta: GenerationMeta,
): Promise<Uint8Array> {
  const body = encodeGeneration(meta);
  const w = await fs.create(manifestPath(meta.generation));
  await w.write(body);
  await w.finish();
  return manifestHead(body);
}

/** Write a non-empty L0 run that applied the range deletes through `marksThrough`. */
export async function publishL0(
  fs: AsyncFs,
  name: string,
  entries: readonly SstEntry[],
  marksThrough: Seq,
): Promise<RunMeta> {
  const path = levelRunPath(0, name);
  const { body, end } = await encodeRun(entries);
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
  return { path, level: 0, ...end, marksThrough };
}

/** `loadGeneration` of a recorded generation, which nothing may remove: a manifest that is gone throws. */
export async function loadRecorded(fs: ReadFs, recorded: Generation): Promise<GenerationMeta> {
  const meta = await loadGeneration(fs, recorded);
  if (!meta) throw new CorruptDatabaseError(`manifest ${recorded} is gone`);
  return meta;
}
