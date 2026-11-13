import { readStats } from "@opfs-lsm/kv/testing";
import { generate } from "../scripts/generate.ts";
import { mergeServerRows } from "../src/client/sync.ts";
import { FORMAT, type Store } from "../src/client/store.ts";
import { commentKey, type ServerRow, type SyncState } from "../src/domain/model.ts";
import type { Host } from "./protocol.ts";
import type { SeedMessage } from "./seed-worker.ts";

/** There is no server, so the app runs as LinearLite does offline: edits stay marked "not synced". */
const OFFLINE: SyncState = {
  id: "sync",
  format: FORMAT,
  epoch: "demo",
  cursors: { issues: 0, bodies: 0, comments: 0 },
  head: 0,
  online: false,
  caughtUp: { issues: true, bodies: true, comments: true },
};

export const markOffline = (store: Store) => store.sync.utils.transact(["sync"], ([row]) => [row ? undefined : OFFLINE]);

/** Live issues, counted from index entries, up to `limit`. */
export const countIssues = (store: Store, limit?: number) =>
  store.docs.collection("issues").count({ index: "byCreated", eq: [false], ...(limit !== undefined && { limit }) });

function seedRows(count: number, onChunk: (rows: number) => void): Promise<{ rows: ServerRow<"issues">[]; generateMs: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./seed-worker.ts", import.meta.url), { type: "module" });
    const rows: ServerRow<"issues">[] = [];
    worker.onerror = (e) => reject(new Error(e.message));
    worker.onmessage = (e: MessageEvent<SeedMessage>) => {
      if ("rows" in e.data) {
        for (const row of e.data.rows) rows.push(row);
        onChunk(rows.length);
        return;
      }
      worker.terminate();
      resolve({ rows, generateMs: e.data.generateMs });
    };
    worker.postMessage({ count });
  });
}

/** Rows written per progress report. `mergeServerRows` splits them into kv transactions. */
const STEP = 5000;

/**
 * Generates `count` issues with the server's seed and writes them as a first sync does: through `mergeServerRows`,
 * so each issue is its document plus an entry in every index. `writeMs` ends when the last write is acknowledged.
 */
export async function writeIssues(
  store: Store,
  count: number,
  progress: (phase: "generating" | "writing", written: number) => void,
): Promise<{ generateMs: number; writeMs: number }> {
  progress("generating", 0);
  const { rows, generateMs } = await seedRows(count, (n) => progress("generating", n));
  progress("writing", 0);
  const t0 = performance.now();
  for (let at = 0; at < rows.length; at += STEP) {
    await mergeServerRows(store, "issues", rows.slice(at, at + STEP));
    progress("writing", Math.min(rows.length, at + STEP));
  }
  return { generateMs, writeMs: performance.now() - t0 };
}

const seedOf = (id: string) => Number.parseInt(id.slice(0, 8), 16) || 1;

/**
 * The description and comments of one issue, written when it is first opened. Only the issues are written up front:
 * 100,000 descriptions would triple what the demo stores in the visitor's browser.
 */
export async function ensureDetail(store: Store, id: string): Promise<void> {
  if ((await store.docs.collection("bodies").get(id)) !== undefined) return;
  const { issues, comments } = generate(1, seedOf(id));
  const created = (await store.docs.collection("issues").get(id))?.created ?? Date.now();
  await mergeServerRows(store, "bodies", [{ id, description: issues[0]!.description, version: 1 }]);
  await mergeServerRows(
    store,
    "comments",
    comments.map((c) => ({ key: commentKey(id, c.id), id: c.id, issue_id: id, body: c.body, username: c.username, created, deleted: false, version: 1 })),
  );
}

const FLUSHES = "linearlite-demo:flushes";

export const forgetHost = () => sessionStorage.removeItem(FLUSHES);

/**
 * Whether this page found the database's SharedWorker running. The SharedWorker counts its flushes from the moment it
 * starts, and writing the issues takes many. A count below the one this browser tab last saw means a new
 * SharedWorker; so does a count of zero when a flush has happened and no count was seen.
 */
export async function hostOf(store: Store): Promise<Host> {
  try {
    const { host } = await readStats(store.db);
    const seen = Number(sessionStorage.getItem(FLUSHES) ?? "0");
    sessionStorage.setItem(FLUSHES, String(host.flushes));
    if (host.flushes < seen) return "restarted";
    if (host.flushes > 0) return "alive";
    return host.generation > 0 ? "restarted" : "unknown";
  } catch {
    return "unknown";
  }
}
