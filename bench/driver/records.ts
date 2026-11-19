import { readFileSync } from "node:fs";
import type { RunRecord } from "../core/types.ts";

/** The parse boundary of a results file: one RunRecord per line. */
export function readRecords(file: string): RunRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord);
}
