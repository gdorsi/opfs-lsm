import { advanceIngested, type IdBWal } from "../src/idb/wal.js";
import { asGeneration, asSeq } from "../src/seq.js";
import { encodeGeneration } from "../src/store/generation.js";
import { NO_MARKS } from "../src/store/marks.js";

/** `advanceIngested` as a flush that published no run calls it: with the bytes of that manifest. */
export function advance(wal: IdBWal, folded: { readonly through: number; readonly generation: number }): Promise<void> {
  const through = asSeq(folded.through);
  const generation = asGeneration(folded.generation);
  return advanceIngested(wal, { through, generation, manifest: encodeGeneration({ generation, runs: [], through, marks: NO_MARKS }) });
}
