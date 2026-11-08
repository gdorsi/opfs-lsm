/**
 * The editing trace both CRDT families replay: Martin Kleppmann's LaTeX
 * paper trace (about 260k keystrokes), as `[pos, deleteCount, ...insert]`.
 * Downloaded once from a pinned automerge commit into bench/.data/.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BENCH_DIR } from "./build.ts";

export const DATA_DIR = path.join(BENCH_DIR, ".data");
const COMMIT = "5994c3967077976ad79656a6bb933f0a6c24be96";
const TRACE_URL = `https://raw.githubusercontent.com/automerge/automerge/${COMMIT}/rust/benchmark-battery/data/edits.json`;

export async function ensureTrace(): Promise<void> {
  const file = path.join(DATA_DIR, "edits.json");
  if (existsSync(file)) return;
  mkdirSync(DATA_DIR, { recursive: true });
  const res = await fetch(TRACE_URL);
  if (!res.ok) throw new Error(`download ${TRACE_URL}: ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
