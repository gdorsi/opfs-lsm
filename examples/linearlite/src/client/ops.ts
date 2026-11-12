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

/**
 * Pulled pages, each asking for the next one as soon as it arrives, so the next page travels while this one merges.
 * `forget` drops the page asked for ahead: after a push, a pull must not bring rows from before it.
 */
export class Pager<P extends { readonly next: number; readonly more: boolean }> {
  private readonly fetchPage: (stream: Stream, after: number) => Promise<P>;
  private ahead: { readonly stream: Stream; readonly after: number; readonly page: Promise<P> } | undefined;

  constructor(fetchPage: (stream: Stream, after: number) => Promise<P>) {
    this.fetchPage = fetchPage;
  }

  async page(stream: Stream, after: number): Promise<P> {
    const ahead = this.ahead;
    this.ahead = undefined;
    const page = await (ahead?.stream === stream && ahead.after === after ? ahead.page : this.fetchPage(stream, after));
    if (page.more) {
      const next = this.fetchPage(stream, page.next);
      next.catch(() => undefined);
      this.ahead = { stream, after: page.next, page: next };
    }
    return page;
  }

  forget(): void {
    this.ahead = undefined;
  }
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
}
