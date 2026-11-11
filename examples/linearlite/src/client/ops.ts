import { MUTABLE_FIELDS, type Rows, type Stream } from "../domain/model.ts";
import type { PushOp } from "../domain/wire.ts";

export function pushOp<S extends Stream>(stream: S, row: Rows[S]): PushOp | undefined {
  const dirty = row.dirty;
  if (dirty === undefined || Object.keys(dirty).length === 0) return undefined;
  const values = row as unknown as Record<string, unknown>;
  const create = row.version === 0;
  const names: readonly string[] = create ? MUTABLE_FIELDS[stream] : Object.keys(dirty);
  const fields: Record<string, unknown> = {};
  for (const f of names) if (values[f] !== undefined) fields[f] = values[f];
  if (create && stream === "comments") fields.issue_id = values.issue_id;
  return { stream, id: values.id as string, fields, clocks: dirty, ...(create && { create: true }) } as PushOp;
}

export function rowKey<S extends Stream>(stream: S, row: Omit<Rows[S], "dirty">): string {
  return stream === "comments" ? (row as unknown as Rows["comments"]).key : row.id;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
}
