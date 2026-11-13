import type { ServerRow } from "../domain/model.ts";
import { WireError } from "../domain/parse.ts";
import { STREAMS, type Stream } from "../domain/stores.ts";
import { parsePushRequest } from "../domain/wire.ts";
import { type Transport, TransportError } from "../model/transport.ts";
import { generate, type Generated } from "./generate.ts";
import { syncServer, type SyncServer, type Tables } from "./protocol.ts";

/**
 * `log` holds every row put, in version order, so a page is a binary search. An entry is current while `byId` holds
 * that same object; a row that changes is appended again, and its old entry is skipped.
 */
type Table<R extends ServerRow> = { readonly byId: Map<string, R>; readonly log: R[] };

/** The index of the first entry of `log` with a version above `version`. */
function above(log: readonly ServerRow[], version: number): number {
  let lo = 0;
  let hi = log.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (log[mid]!.version > version) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function mapTables({ rows, head: seeded }: Generated): Tables {
  const tables = Object.fromEntries(STREAMS.map((s) => [s, { byId: new Map(rows[s].map((r) => [r.id, r])), log: [...rows[s]] }])) as {
    [S in Stream]: Table<ServerRow<S>>;
  };
  const commentIds = new Map<string, string[]>();
  const indexComment = (c: ServerRow<"comments">) => {
    const ids = commentIds.get(c.issue_id);
    if (ids) ids.push(c.id);
    else commentIds.set(c.issue_id, [c.id]);
  };
  rows.comments.forEach(indexComment);
  const epoch = crypto.randomUUID();
  let head = seeded;
  let undo: (() => void)[] | undefined;
  const current = <S extends Stream>(t: Table<ServerRow<S>>, r: ServerRow<S>) => t.byId.get(r.id) === r;
  return {
    head: () => head,
    setHead(next) {
      const prev = head;
      undo?.push(() => (head = prev));
      head = next;
    },
    epoch: () => epoch,
    transaction(fn) {
      const steps: (() => void)[] = [];
      undo = steps;
      try {
        return fn();
      } catch (e) {
        for (const step of steps.reverse()) step();
        throw e;
      } finally {
        undo = undefined;
      }
    },
    page(stream, after, limit) {
      const t = tables[stream];
      const out: ServerRow<typeof stream>[] = [];
      for (let i = above(t.log, after); i < t.log.length && out.length < limit; i++) if (current(t, t.log[i]!)) out.push(t.log[i]!);
      return out;
    },
    group(stream, version) {
      const t = tables[stream];
      const out: ServerRow<typeof stream>[] = [];
      for (let i = above(t.log, version - 1); t.log[i]?.version === version; i++) if (current(t, t.log[i]!)) out.push(t.log[i]!);
      return out;
    },
    newer: (stream, version) => (tables[stream].log.at(-1)?.version ?? 0) > version,
    get: (stream, id) => tables[stream].byId.get(id),
    put(stream, row) {
      const t = tables[stream] as Table<ServerRow>;
      const prev = t.byId.get(row.id);
      const length = t.log.length;
      t.byId.set(row.id, row);
      t.log.push(row);
      if (!prev && stream === "comments") indexComment(row as ServerRow<"comments">);
      undo?.push(() => {
        if (prev) t.byId.set(row.id, prev);
        else t.byId.delete(row.id);
        t.log.length = length;
        if (!prev && stream === "comments") commentIds.get((row as ServerRow<"comments">).issue_id)!.pop();
      });
    },
    commentsOf: (issue) => (commentIds.get(issue) ?? []).map((id) => tables.comments.byId.get(id)!),
  };
}

export type ServerRows = { readonly [S in Stream]: ReadonlyMap<string, ServerRow<S>> };

/** A server in memory, for bench pages and Node tests. Another user's edits are a `push` under their name. */
export interface MemoryServer extends SyncServer {
  /** The rows the server holds now, by stream and id. */
  rows(): ServerRows;
  /**
   * While false, every transport call fails as a fetch does with the network down, and `onHead` is silent. Setting
   * it back to true calls the `onReconnect` listeners, then sends the current head to `onHead` listeners, as the app's
   * event stream does when it reconnects.
   */
  online: boolean;
  onReconnect(listener: () => void): () => void;
}

/** Seeded with `generate(issues, seed)`, the rows `pnpm seed` writes. */
export function memoryServer({ issues, seed = 1 }: { readonly issues: number; readonly seed?: number }): MemoryServer {
  const tables = mapTables(generate(issues, seed));
  const server = syncServer(tables);
  const listeners = new Set<(head: number) => void>();
  const reconnects = new Set<() => void>();
  let online = true;
  server.onHead((head) => {
    if (online) for (const l of listeners) l(head);
  });
  return {
    ...server,
    rows: () => Object.fromEntries(STREAMS.map((s) => [s, new Map(tables.page(s, 0, Infinity).map((r) => [r.id, r]))])) as unknown as ServerRows,
    onHead(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onReconnect(listener) {
      reconnects.add(listener);
      return () => void reconnects.delete(listener);
    },
    get online() {
      return online;
    },
    set online(next) {
      const reconnected = next && !online;
      online = next;
      if (!reconnected) return;
      for (const l of reconnects) l();
      for (const l of listeners) l(server.head());
    },
  };
}

/** A copy, as the wire would deliver it: nothing the caller holds aliases the server's rows. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The app's HTTP routes, called in process: the same request parsing, refusals as `TransportError`, replies copied. */
export function memoryTransport(server: MemoryServer, user: string): Transport {
  const call = async <T>(handle: () => T): Promise<T> => {
    if (!server.online) throw new TypeError("the memory server is offline");
    try {
      return wire(handle());
    } catch (e) {
      throw e instanceof WireError ? new TransportError(e.status, e.message) : e;
    }
  };
  return {
    user,
    pull: (stream, after, limit) => call(() => server.pull(stream, after, limit)),
    push: (ops) => call(() => server.push(parsePushRequest(wire({ ops })).ops, user)),
    detail: (ids) => call(() => server.detail(ids)),
    row: (stream, id) => call(() => server.row(stream, id)),
    watch(hint) {
      if (server.online) queueMicrotask(() => hint(server.head()));
      return server.onHead(hint);
    },
    online: (back) => server.onReconnect(back),
  };
}
