import type { Scalar } from "@opfs-lsm/docstore";
import { STATUSES, type Issue, type StatusCode } from "../domain/model.ts";
import type { IssueFilter, SortField } from "./filter.ts";
import type { IssueDocs } from "./store.ts";

type Snap = Parameters<Parameters<IssueDocs["view"]>[0]>[0];
type IssueQuery = Parameters<IssueDocs["count"]>[0];

const ALL = STATUSES.map((_, code) => code as StatusCode);
const NON_WORD = /[^\p{L}\p{M}\p{N}]+/u;

/** docstore's text words: a `match` keeps the titles holding each of them inside one word. */
const wordsOf = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .split(NON_WORD)
    .filter((w) => w !== "");

/**
 * The live issues under `filter` whose titles contain the query, as the list's `ilike` decides. The text index
 * narrows them to the titles holding every word of the query; the substring test makes it exact.
 */
async function searched(snap: Snap, filter: IssueFilter): Promise<Issue[]> {
  const words = wordsOf(filter.q);
  const { docs } =
    words.length === 0
      ? await snap.query({ index: "byModified", eq: [false] })
      : await snap.query({ index: "search", eq: [false], match: words.join(" ") });
  const needle = filter.q.toLowerCase();
  return docs.filter(
    (i) =>
      (filter.status.length === 0 || filter.status.includes(i.status)) &&
      (filter.priority.length === 0 || filter.priority.includes(i.priority)) &&
      i.title.toLowerCase().includes(needle),
  );
}

/**
 * Live issues under `filter` per status, indexed by status code; a status the filter leaves out counts 0. Without a
 * query it counts index entries and reads no document.
 */
export function countByStatus(issues: IssueDocs, filter: IssueFilter): Promise<number[]> {
  return issues.view(async (snap) => {
    const counts = ALL.map(() => 0);
    const statuses = filter.status.length > 0 ? filter.status : ALL;
    if (filter.q !== "") {
      for (const i of await searched(snap, filter)) counts[i.status]!++;
      return counts;
    }
    await Promise.all(
      statuses.map(async (s) => {
        const parts =
          filter.priority.length === 0
            ? [snap.count({ index: "byStatus", eq: [false, s] })]
            : filter.priority.map((p) => snap.count({ index: "byPriority", eq: [false, p, s] }));
        counts[s] = (await Promise.all(parts)).reduce((a, b) => a + b, 0);
      }),
    );
    return counts;
  });
}

/**
 * Live issues under `filter`. A query of one plain word is counted from the text index's entries alone: the index
 * normalizes titles to NFC and `ilike` does not, so this agrees with the list for titles stored in NFC.
 */
export async function countTotal(issues: IssueDocs, filter: IssueFilter): Promise<number> {
  const words = wordsOf(filter.q);
  const plain = words.length === 1 && words[0] === filter.q.toLowerCase();
  if (plain && filter.status.length === 0 && filter.priority.length === 0) {
    return issues.count({ index: "search", eq: [false], match: words[0]! });
  }
  return (await countByStatus(issues, filter)).reduce((a, b) => a + b, 0);
}

/**
 * The index of each sort: `deleted`, then the sort field, so `eq: [false]` lists every live issue by its sort value.
 * Issues with the same value come in the index's order, not the list's.
 */
const SORT_INDEX = {
  modified: "byModified",
  created: "byCreated",
  title: "byTitle",
  priority: "byPriority",
  status: "byStatus",
} as const satisfies Record<SortField, string>;

/**
 * Whether a deep window of the list under `filter` can start at a sort value: the list shows every live issue, and
 * its sort index orders the values as the list does. Titles do not: the index orders strings by code point and
 * TanStack by UTF-16 unit, and the two disagree between a character past U+FFFF and one from U+E000 to U+FFFF.
 */
export const anchors = (filter: IssueFilter) =>
  filter.status.length === 0 && filter.priority.length === 0 && filter.q === "" && filter.sort !== "title";

/** Every live issue by sort value, or only those whose sort value passes `bound`. */
const inOrder = (filter: IssueFilter, bound: { readonly gt?: Scalar; readonly lt?: Scalar } = {}) =>
  ({ index: SORT_INDEX[filter.sort], eq: [false], ...(filter.dir === "desc" && { reverse: true }), ...bound }) as IssueQuery;

/** Live issues that sort strictly before `value` in a list that `anchors`. Reads index entries only. */
export function countBefore(issues: Pick<Snap, "count">, filter: IssueFilter, value: Scalar): Promise<number> {
  return issues.count(inOrder(filter, filter.dir === "desc" ? { gt: value } : { lt: value }));
}

/** A row's sort value, and how many rows of a list that `anchors` sort strictly before that value. */
export type Anchor = { readonly value: Scalar; readonly base: number };

/** Rows before row `n` whose documents `locate` reads to count the rows tied with it. */
const NEAR = 64;

/**
 * The anchor of row `n` of a list that `anchors`, or undefined if the list is shorter. It walks `n` index entries
 * without their documents, then reads rows `n - 64` to `n`: the rows tied with row `n` among them are the rows
 * between the anchor's `base` and `n`. A tie that runs past them is counted from the index.
 */
export function locate(issues: IssueDocs, filter: IssueFilter, n: number): Promise<Anchor | undefined> {
  return issues.view(async (snap) => {
    const skip = Math.max(0, n - NEAR);
    const { next } = skip > 0 ? await snap.queryIds({ ...inOrder(filter), limit: skip }) : {};
    if (skip > 0 && next === undefined) return undefined;
    const { docs } = await snap.query({ ...inOrder(filter), limit: n - skip + 1, ...(next !== undefined && { after: next }) });
    if (docs.length < n - skip + 1) return undefined;
    const value = docs.at(-1)![filter.sort];
    let ties = 0;
    while (ties < docs.length - 1 && docs[docs.length - 2 - ties]![filter.sort] === value) ties++;
    const base = skip > 0 && ties === docs.length - 1 ? await countBefore(snap, filter, value) : n - ties;
    return { value, base };
  });
}
