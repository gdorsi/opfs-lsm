import type { AsyncFs } from "../src/opfs/async-fs.js";
import { manifestNumbers, readManifest, type GenerationMeta } from "../src/store/generation.js";

/** The newest manifest that decodes, or undefined when none does. */
export async function loadLatestGeneration(fs: AsyncFs): Promise<GenerationMeta | undefined> {
  for (const generation of await manifestNumbers(fs)) {
    const meta = await readManifest(fs, generation);
    if (meta) return meta;
  }
  return undefined;
}
