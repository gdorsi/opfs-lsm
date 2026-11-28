import { NotFoundError, openDatabase } from "@opfs-lsm/db";
import { schema, type Detail, type Issue, type Store } from "./model.ts";
import type { SeedMessage, SeedRequest } from "./seed-worker.ts";
import { generateDetail } from "./seed.ts";

export const openStore = (name: string) => openDatabase({ name, ...schema });

/** One write: the issue with `patch` over it and a new `modified`. An issue deleted meanwhile stays deleted. */
export async function editIssue({ issues }: Store, id: string, patch: Partial<Pick<Issue, "title" | "status" | "priority">>): Promise<void> {
  try {
    await issues.update(id, (issue) => {
      Object.assign(issue, patch);
      issue.modified = Date.now();
    });
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
}

/** The issue's description and comments: read, or made from the issue and stored when it is opened for the first time. */
export async function detailOf({ issues, details }: Store, id: string): Promise<Detail | undefined> {
  const stored = await details.get(id);
  if (stored) return stored;
  const issue = await issues.get(id);
  if (!issue) return undefined;
  const made = generateDetail(issue);
  await details.upsert(made);
  return made;
}

/** Issues per `upsert`, which is one kv transaction. kv takes 8 MiB per transaction and counts 256 bytes per key. */
const BATCH = 2000;
/** The first transaction is small, so the list has rows after a few milliseconds of writing. */
const FIRST = 200;

/** Generates `count` issues in a dedicated WebWorker and yields each batch as it arrives. Returns the time generating took. */
async function* seed(count: number, from: number): AsyncGenerator<Issue[], number> {
  const worker = new Worker(new URL("./seed-worker.ts", import.meta.url), { type: "module" });
  const arrived: SeedMessage[] = [];
  let failure: Error | undefined;
  let wake = () => {};
  worker.onerror = (e) => {
    failure = new Error(e.message);
    wake();
  };
  worker.onmessage = (e: MessageEvent<SeedMessage>) => {
    arrived.push(e.data);
    wake();
  };
  worker.postMessage({ count, seed: from, first: FIRST, batch: BATCH } satisfies SeedRequest);
  try {
    for (;;) {
      if (failure) throw failure;
      const message = arrived.shift();
      if (!message) await new Promise<void>((resolve) => (wake = resolve));
      else if ("done" in message) return message.generateMs;
      else yield message.issues;
    }
  } finally {
    worker.terminate();
  }
}

/**
 * Writes `count` generated issues, each batch as the worker hands it over, and calls `written` after each with the
 * number stored so far. Each issue is its document plus an entry in every index. `writeMs` is the time the writes
 * took, from each call to its acknowledgement. The ids follow from `from`, the generator's seed, so two calls with
 * different seeds write different issues.
 */
export async function writeIssues(
  { issues }: Store,
  count: number,
  from: number,
  written: (issues: number) => void,
): Promise<{ generateMs: number; writeMs: number }> {
  const batches = seed(count, from);
  let writeMs = 0;
  let stored = 0;
  try {
    for (;;) {
      const next = await batches.next();
      if (next.done) return { generateMs: next.value, writeMs };
      const t0 = performance.now();
      await issues.upsert(next.value);
      writeMs += performance.now() - t0;
      stored += next.value.length;
      written(stored);
    }
  } finally {
    // Ends the generator, which stops its worker, when a write fails before the last batch.
    await batches.return(0);
  }
}

export type NewIssue = Pick<Issue, "title" | "status" | "priority"> & { readonly description: string };

/** A new issue under `id`, with its description: two writes, the description first. */
export async function createIssue({ issues, details }: Store, id: string, { description, ...fields }: NewIssue): Promise<void> {
  const now = Date.now();
  await details.insert({ id, description, comments: [] });
  await issues.insert({ id, ...fields, username: "you", created: now, modified: now });
}
