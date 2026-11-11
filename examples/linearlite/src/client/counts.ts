import { STATUSES, type Issue, type StatusCode } from "../domain/model.ts";
import type { IssueFilter } from "./filter.ts";
import type { IssueDocs } from "./store.ts";

type Snap = Parameters<Parameters<IssueDocs["view"]>[0]>[0];

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

/** Live issues under `filter`. A query of one plain word is exact from the text index's entries alone. */
export async function countTotal(issues: IssueDocs, filter: IssueFilter): Promise<number> {
  const words = wordsOf(filter.q);
  const plain = words.length === 1 && words[0] === filter.q.toLowerCase();
  if (plain && filter.status.length === 0 && filter.priority.length === 0) {
    return issues.count({ index: "search", eq: [false], match: words[0]! });
  }
  return (await countByStatus(issues, filter)).reduce((a, b) => a + b, 0);
}
