import { generate } from "../scripts/generate.ts";
import { PRIORITIES, STATUSES, type PriorityCode, type ServerRow, type StatusCode } from "../src/domain/model.ts";

export type SeedMessage =
  | { readonly rows: ServerRow<"issues">[] }
  | { readonly done: true; readonly generateMs: number };

const CHUNK = 5000;
const post = (message: SeedMessage) => (self as unknown as { postMessage(m: SeedMessage): void }).postMessage(message);

/** The server's seed, in a dedicated WebWorker: the same issues in the same order, newest version first. */
self.onmessage = (e: MessageEvent<{ count: number }>) => {
  const t0 = performance.now();
  const rows = generate(e.data.count)
    .issues.toSorted((a, b) => b.modified - a.modified)
    .map(
      (s, i): ServerRow<"issues"> => ({
        id: s.id,
        title: s.title,
        status: STATUSES.indexOf(s.status) as StatusCode,
        priority: PRIORITIES.indexOf(s.priority) as PriorityCode,
        kanbanorder: s.kanbanorder,
        username: s.username,
        created: s.created,
        modified: s.modified,
        deleted: false,
        version: i + 1,
      }),
    );
  const generateMs = performance.now() - t0;
  for (let at = 0; at < rows.length; at += CHUNK) post({ rows: rows.slice(at, at + CHUNK) });
  post({ done: true, generateMs });
};
