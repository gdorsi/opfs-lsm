import type { AsyncFs, ReadFs } from "../opfs/async-fs.js";
import type { Generation } from "../seq.js";
import { manifestNumbers, readManifest, type RunMeta } from "../store/generation.js";
import { levelOfDir } from "../store/levels.js";
import { loadRecorded } from "./publish.js";

/**
 * Delete manifests older than `keepFrom`, and swap files (`<n>.mft.crswap`,
 * left by a write killed mid-flight) numbered up to `keepFrom`. Call after
 * IDB records `keepFrom`. A write in progress always numbers past the
 * recorded generation, so its swap file is above `keepFrom` and stays.
 */
export async function reclaimManifests(
  fs: AsyncFs,
  keepFrom: Generation,
): Promise<void> {
  for (const name of await fs.list("m")) {
    const m = /^(\d+)\.mft(\.crswap)?$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (m[2] ? n > keepFrom : n >= keepFrom) continue;
    try {
      await fs.remove(`m/${name}`);
    } catch {
      // best-effort
    }
  }
}

/**
 * Remove each path in `drop` that `keep` does not retain and no tab holds
 * open. A file that stays, held or failing, goes at a later call.
 */
export async function reclaimRuns(
  fs: AsyncFs,
  drop: readonly string[],
  keep: readonly string[],
): Promise<void> {
  const retained = new Set(keep);
  for (const path of drop) {
    if (retained.has(path)) continue;
    await fs.removeUnlessOpen(path).catch(() => undefined);
  }
}

/**
 * The runs of the recorded generation, and of every manifest numbered past
 * it and past `destroyedTop`. Such a manifest is left by a publish whose
 * IndexedDB commit failed or never ran. Its runs stay while it does: once
 * they are gone, a power loss that takes the appends back lets a flush
 * write the same path with other rows, and recovery would adopt the
 * manifest over them. A manifest up to `destroyedTop` predates a destroy,
 * which moved the head past its seqs for good. A read that fails throws,
 * and a recorded manifest that is gone throws too: nothing may be swept
 * against it. A newer manifest that is missing or does not decode keeps
 * nothing.
 */
export async function liveRuns(fs: ReadFs, recorded: Generation, destroyedTop: Generation): Promise<string[]> {
  const runs = (await loadRecorded(fs, recorded)).runs;
  const newer: RunMeta[] = [];
  for (const n of await manifestNumbers(fs)) {
    if (n <= recorded || n <= destroyedTop) break;
    const m = await readManifest(fs, n);
    if (typeof m === "object") newer.push(...m.runs);
  }
  return [...runs, ...newer].map((run) => run.path);
}

/** Every run file on disk, from the `l<n>/` directories. */
export async function listRuns(fs: ReadFs): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await fs.list("")) {
    if (levelOfDir(dir) === undefined) continue;
    for (const name of await fs.list(dir)) out.push(`${dir}/${name}`);
  }
  return out;
}
