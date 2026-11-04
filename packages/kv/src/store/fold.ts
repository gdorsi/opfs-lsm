import { compareBytes, keyToString } from "../bytes.js";
import type { SstEntry } from "./sst.js";

function sortEntries(rows: SstEntry[]): SstEntry[] {
  rows.sort((a, b) => compareBytes(a.key, b.key));
  return rows;
}

/**
 * One-shot merge for the TypeScript `mergeSsts` fallback.
 * `groups[0]` is the newest run. Oldest is applied first so newer wins.
 */
export function foldEntries(
  groups: readonly (readonly SstEntry[])[],
): SstEntry[] {
  const map = new Map<string, SstEntry>();
  for (let i = groups.length - 1; i >= 0; i--) {
    for (const e of groups[i]!) {
      map.set(keyToString(e.key), e);
    }
  }
  return sortEntries([...map.values()]);
}
