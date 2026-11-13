import type { ServerRow } from "../domain/model.ts";
import { WireError } from "../domain/parse.ts";
import { MUTABLE_FIELDS, STREAMS, type Stream, streamOf } from "../domain/stores.ts";
import type { DetailResponse, PullResponse, PushOp, PushResponse, PushResult, RowResponse } from "../domain/wire.ts";

/** What the sync rules need from server storage. node:sqlite implements it for the app, Maps for bench and tests. */
export interface Tables {
  head(): number;
  setHead(head: number): void;
  epoch(): string;
  /** Runs `fn` as one transaction: when it throws, none of its writes stay. */
  transaction<T>(fn: () => T): T;
  /** The first `limit` rows of `stream` with a version above `after`, in version order. */
  page<S extends Stream>(stream: S, after: number, limit: number): ServerRow<S>[];
  /** Every row of `stream` at `version`. */
  group<S extends Stream>(stream: S, version: number): ServerRow<S>[];
  /** Whether a row of `stream` has a version above `version`. */
  newer(stream: Stream, version: number): boolean;
  get<S extends Stream>(stream: S, id: string): ServerRow<S> | undefined;
  /** Inserts the row, or replaces the row with its id. */
  put<S extends Stream>(stream: S, row: ServerRow<S>): void;
  commentsOf(issue: string): ServerRow<"comments">[];
}

/** The server's side of the wire protocol, the same over any `Tables`. */
export interface SyncServer {
  pull<S extends Stream>(stream: S, after: number, limit: number): PullResponse<S>;
  /** Applies every op or none. Throws `WireError` for a refused op. */
  push(ops: readonly PushOp[], username: string): PushResponse;
  detail(ids: readonly string[]): DetailResponse;
  /** One row by id, tombstones included; `null` when the server has none. */
  row<S extends Stream>(stream: S, id: string): RowResponse<S>;
  head(): number;
  /** Calls `listener` with the new head after each push that changed a row. */
  onHead(listener: (head: number) => void): () => void;
}

type Ctx = { readonly username: string; readonly version: number; readonly now: number };
type Fields = Record<string, unknown>;

const STAMPS = { author: (c: Ctx) => c.username, created: (c: Ctx) => c.now, modified: (c: Ctx) => c.now };

export function syncServer(tables: Tables): SyncServer {
  const listeners = new Set<(head: number) => void>();
  return {
    pull(stream, after, limit) {
      let rows = tables.page(stream, after, limit);
      let more = false;
      let last = after;
      if (rows.length === limit) {
        // A page ends on a whole version, so a push's rows never straddle two pages.
        last = rows[limit - 1]!.version;
        rows = rows.filter((r) => r.version < last).concat(tables.group(stream, last));
        more = tables.newer(stream, last);
      }
      const head = tables.head();
      return { rows, next: more ? last : head, head, more, epoch: tables.epoch() };
    },

    push(ops, username) {
      const ordered = [...ops].sort((a, b) => STREAMS.indexOf(a.stream) - STREAMS.indexOf(b.stream));
      let changed = false;
      const res = tables.transaction(() => {
        let head = tables.head();
        const ctx: Ctx = { username, version: head + 1, now: Date.now() };
        const results = ordered.map((op) => {
          const old = tables.get(op.stream, op.id) as Fields | undefined;
          if (!old && !op.create) throw new WireError(`${op.stream}/${op.id} does not exist; send it with create`, 409);
          const row = old ? update(op, ctx, old) : create(tables, op, ctx);
          if (row !== old) {
            tables.put(op.stream, row as ServerRow);
            changed = true;
          }
          return { stream: op.stream, id: op.id, clocks: op.clocks, row } as PushResult;
        });
        if (changed) tables.setHead(++head);
        return { results, head, epoch: tables.epoch() };
      });
      if (changed) for (const l of listeners) l(res.head);
      return res;
    },

    detail: (ids) => ({
      bodies: ids.flatMap((id) => tables.get("bodies", id) ?? []),
      comments: ids.flatMap((id) => tables.commentsOf(id)),
    }),

    row: (stream, id) => ({ row: tables.get(stream, id) ?? null, epoch: tables.epoch() }),

    head: () => tables.head(),

    onHead(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

function create(tables: Tables, op: PushOp, ctx: Ctx): Fields {
  const { fields, derive } = streamOf(op.stream);
  const pushed = op.fields as Fields;
  const row: Fields = {};
  for (const [name, f] of Object.entries(fields)) {
    const value = name === "id" ? op.id : name === "version" ? ctx.version : f.stamp ? STAMPS[f.stamp](ctx) : (pushed[name] ?? f.default);
    if (value === undefined) throw new WireError(`creating ${op.stream}/${op.id} needs ${name}`);
    row[name] = value;
  }
  for (const [name, f] of Object.entries(fields)) {
    if (f.ref && !tables.get(f.ref, row[name] as string)) throw new WireError(`issue ${row[name]} does not exist`, 409);
  }
  return { ...derive?.(row as never), ...row };
}

/** The old row itself when the op changes nothing. */
function update(op: PushOp, ctx: Ctx, old: Fields): Fields {
  const { fields } = streamOf(op.stream);
  const pushed = op.fields as Fields;
  for (const [name, f] of Object.entries(fields)) {
    if (!f.mutable && pushed[name] !== undefined && pushed[name] !== old[name]) throw new WireError(`${op.stream}/${op.id}: ${name} cannot change`, 409);
  }
  const merged = { ...old, ...pushed };
  if (MUTABLE_FIELDS[op.stream].every((k) => merged[k] === old[k])) return old;
  for (const [name, f] of Object.entries(fields)) if (f.stamp === "modified") merged[name] = ctx.now;
  return { ...merged, version: ctx.version };
}
