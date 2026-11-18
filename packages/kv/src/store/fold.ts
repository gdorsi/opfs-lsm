import { compareBytes } from "../bytes.js";
import { throughAt, type Mark, type Marks } from "./marks.js";
import type { WalRecord } from "./memtable.js";
import type { SstEntry } from "./sst.js";

export type Folded = {
  /** The last op per key, in key order, with nothing the chunk's marks cover. */
  readonly entries: SstEntry[];
  /** The chunk's range deletes, joined. */
  readonly marks: Marks;
};

/** Longest run `String.fromCharCode.apply` takes, well under the engines' argument limits. */
const CHARS_PER_CALL = 4096;

/** One char per byte, so equal keys give equal strings and no other keys do. */
function keyString(key: Uint8Array): string {
  if (key.length <= CHARS_PER_CALL) return String.fromCharCode.apply(null, key as unknown as number[]);
  let s = "";
  for (let i = 0; i < key.length; i += CHARS_PER_CALL) {
    s += String.fromCharCode.apply(null, key.subarray(i, i + CHARS_PER_CALL) as unknown as number[]);
  }
  return s;
}

/**
 * Fold a WAL chunk to the last op per key, in key order, under the chunk's
 * own range deletes. Filtering the final entries is exact: an entry is
 * covered only by a mark whose `through` reaches its seq, which sits in a
 * later record, and a later write of the key is what the fold kept instead.
 */
export function foldRecords(records: readonly WalRecord[]): Folded {
  const map = new Map<string, SstEntry>();
  const marks: Mark[] = [];
  for (const rec of records) {
    for (const op of rec.ops) {
      if (op.type === "deleteRange") {
        if (op.through > 0) marks.push({ ...op, at: rec.seq });
        continue;
      }
      map.set(
        keyString(op.key),
        op.type === "put"
          ? { kind: "put", key: op.key, value: op.value, seq: rec.seq }
          : { kind: "del", key: op.key, seq: rec.seq },
      );
    }
  }
  const entries = [...map.values()].sort((a, b) => compareBytes(a.key, b.key));
  return { entries: entries.filter((e) => e.seq > throughAt(marks, e.key)), marks };
}
