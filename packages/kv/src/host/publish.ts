import type { AsyncFs } from "../opfs/async-fs.js";
import type { Seq } from "../seq.js";
import { encodeRun } from "../store/engine.js";
import { encodeGeneration, manifestHead, manifestPath, type GenerationMeta, type RunMeta } from "../store/generation.js";
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
