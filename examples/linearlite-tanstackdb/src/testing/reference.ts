import type { ServerRow } from "../domain/model.ts";
import type { IssueFilter } from "../model/filter.ts";
import type { ServerRows } from "../server/memory.ts";

/**
 * What the app must show for the rows a server holds, written as plain loops over those rows. It shares no code with
 * the model's queries, the backends or TanStack, so a bug in any of them cannot hide in its own check. Every check
 * returns undefined when the replica agrees, else a sentence saying where it does not.
 */

type Issue = ServerRow<"issues">;
const STATUS_CODES = [0, 1, 2, 3, 4] as const;

const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The values a sort orders by, most significant first. Rows tied on all of them may come in any order. */
function sortKey(i: Issue, sort: IssueFilter["sort"]): readonly (string | number)[] {
  switch (sort) {
    case "modified":
      return [i.modified];
    case "created":
      return [i.created];
    case "title":
      return [i.title];
    case "priority":
      return [i.priority, i.status, i.modified];
    case "status":
      return [i.status, i.kanbanorder];
  }
}

function compareKeys(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let n = 0; n < a.length; n++) {
    const c = compare(a[n]!, b[n]!);
    if (c !== 0) return c;
  }
  return 0;
}

/** The first field of `want` that `got` does not hold, as a sentence. */
function fieldDifference(got: object, want: object): string | undefined {
  for (const [field, value] of Object.entries(want)) {
    const held = (got as Record<string, unknown>)[field];
    if (held !== value) return `${field} is ${JSON.stringify(held)}, the server has ${JSON.stringify(value)}`;
  }
  return undefined;
}

export type ReferenceThread = {
  /** Undefined when the server has no body for the issue. */
  readonly description: string | undefined;
  readonly comments: readonly ServerRow<"comments">[];
};

export interface Reference {
  /** Issues the filter keeps, in list order. */
  list(filter: IssueFilter): readonly Issue[];
  /** Live issues under the filter per status code; a status the filter leaves out counts 0. */
  counts(filter: IssueFilter): readonly number[];
  total(filter: IssueFilter): number;
  /** Issues with `status` under the filter's other terms, in board order. */
  board(filter: IssueFilter, status: number): readonly Issue[];
  /** The rows `got` shows as rows `from` on of the list, or undefined if it is the server's window. */
  window(filter: IssueFilter, from: number, size: number, got: readonly object[]): string | undefined;
  /** As `window`, for a board column: the issues with `status` under the filter's other terms, in board order. */
  column(filter: IssueFilter, status: number, from: number, size: number, got: readonly object[]): string | undefined;
  thread(id: string): ReferenceThread;
  /** Whether `got` is the server's description and live comments of the issue, oldest first. */
  sameThread(id: string, got: { readonly description: string | undefined; readonly comments: readonly object[] }): string | undefined;
  /** Whether `got` is the server's row `id` of `stream`. */
  row(stream: keyof ServerRows, id: string, got: object | undefined): string | undefined;
}

export function reference(rows: ServerRows): Reference {
  const live = [...rows.issues.values()].filter((i) => !i.deleted);
  const kept = (i: Issue, filter: IssueFilter) =>
    (filter.status.length === 0 || filter.status.includes(i.status)) &&
    (filter.priority.length === 0 || filter.priority.includes(i.priority)) &&
    i.title.toLowerCase().includes(filter.q.toLowerCase());

  const sorted = new Map<string, readonly Issue[]>();
  const memo = (key: string, make: () => Issue[]) => {
    let hit = sorted.get(key);
    if (!hit) sorted.set(key, (hit = make()));
    return hit;
  };
  const keyOf = (filter: IssueFilter, scope: string) => JSON.stringify([filter.status, filter.priority, filter.q, filter.sort, filter.dir, scope]);

  const list = (filter: IssueFilter) =>
    memo(keyOf(filter, "list"), () => {
      const sign = filter.dir === "asc" ? 1 : -1;
      return live
        .filter((i) => kept(i, filter))
        .sort((a, b) => sign * compareKeys(sortKey(a, filter.sort), sortKey(b, filter.sort)));
    });
  const column = (filter: IssueFilter, status: number) =>
    memo(keyOf(filter, `column ${status}`), () =>
      live
        .filter((i) => i.status === status && kept(i, { ...filter, status: [] }))
        .sort((a, b) => compare(a.kanbanorder, b.kanbanorder)),
    );

  /** The window is the server's when `got` has the same length, the server's fields, and the sort values at each place. */
  function sameWindow(want: readonly Issue[], from: number, size: number, got: readonly object[], sort: IssueFilter["sort"]): string | undefined {
    const expected = want.slice(from, from + size);
    if (got.length !== expected.length) return `${got.length} rows from row ${from}, the server has ${expected.length}`;
    const seen = new Set<string>();
    for (const [n, row] of got.entries()) {
      const id = (row as { id: string }).id;
      if (seen.has(id)) return `row ${from + n} (${id}) is listed twice`;
      seen.add(id);
      const server = rows.issues.get(id);
      if (!server) return `row ${from + n} (${id}) is not an issue on the server`;
      const different = fieldDifference(row, server);
      if (different) return `row ${from + n} (${id}): ${different}`;
      if (compareKeys(sortKey(server, sort), sortKey(expected[n]!, sort)) !== 0) {
        return `row ${from + n} is ${id}, which sorts away from the server's ${expected[n]!.id}`;
      }
    }
    return undefined;
  }

  const counts = (filter: IssueFilter) => STATUS_CODES.map((s) => list(filter).filter((i) => i.status === s).length);

  const thread = (id: string): ReferenceThread => ({
    description: rows.bodies.get(id)?.description,
    comments: [...rows.comments.values()].filter((c) => c.issue_id === id && !c.deleted).sort((a, b) => compare(a.created, b.created) || compare(a.id, b.id)),
  });

  return {
    list,
    board: column,
    counts,
    total: (filter) => list(filter).length,
    window: (filter, from, size, got) => sameWindow(list(filter), from, size, got, filter.sort),
    column: (filter, status, from, size, got) => sameWindow(column(filter, status), from, size, got, "status"),
    thread,
    sameThread(id, got) {
      const want = thread(id);
      if (got.description !== want.description) return `description of ${id} is ${JSON.stringify(got.description)?.slice(0, 40)}, the server has ${JSON.stringify(want.description)?.slice(0, 40)}`;
      if (got.comments.length !== want.comments.length) return `${got.comments.length} comments on ${id}, the server has ${want.comments.length}`;
      const heard = new Set<string>();
      for (const [n, comment] of got.comments.entries()) {
        const server = rows.comments.get((comment as { id: string }).id);
        if (!server || server.issue_id !== id) return `comment ${n} of ${id} is not one of its comments on the server`;
        if (heard.has(server.id)) return `comment ${server.id} is listed twice`;
        heard.add(server.id);
        const different = fieldDifference(comment, server);
        if (different) return `comment ${server.id}: ${different}`;
        if (server.created !== want.comments[n]!.created) return `comment ${n} of ${id} sorts away from the server's`;
      }
      return undefined;
    },
    row(stream, id, got) {
      const server = rows[stream].get(id) as object | undefined;
      if (!server) return got ? `${stream} ${id} is on the replica, not on the server` : undefined;
      if (!got) return `${stream} ${id} is missing from the replica`;
      const different = fieldDifference(got, server);
      return different && `${stream} ${id}: ${different}`;
    },
  };
}
