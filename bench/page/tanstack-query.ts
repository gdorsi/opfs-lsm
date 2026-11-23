/**
 * Everything the TanStack Query workload needs, so both storages run the same
 * client code: the queries an app caches, a server over the tracker dataset
 * that answers them at the model's revision, and the QueryClient with the
 * per-query persister. A contender supplies only the persister over its storage.
 */
import { hashKey, QueryClient, type QueryKey } from "@tanstack/query-core";
import type { PersistedQuery } from "@tanstack/query-persist-client-core";
import type { QueryStore } from "../core/families.ts";
import type { Json } from "../core/goals.ts";
import type { SizeName } from "../core/types.ts";
import { trackerHistory, WORKSPACES } from "../datasets/tracker/history.ts";
import { TrackerOracle } from "../datasets/tracker/oracle.ts";
import { STATUSES, type Comment } from "../datasets/tracker/types.ts";
import type { Model } from "./model.ts";

/**
 * Per size: the tracker workspace and how many issues a user opened, newest
 * update first, one detail query each. `large` adds queries, not projects.
 */
const SIZES: Readonly<Record<SizeName, { readonly workspace: SizeName; readonly details: number }>> = {
  tiny: { workspace: "tiny", details: 100 },
  small: { workspace: "small", details: 500 },
  large: { workspace: "small", details: 4_000 },
};

/** One list query per project and status, then the detail queries. */
export const queryCount = (size: SizeName) => WORKSPACES[SIZES[size].workspace].projects * STATUSES.length + SIZES[size].details;

/** What the server answers for a query: its body, stamped with the revision the model holds for it. */
type Answer = { readonly revision: number; readonly body: Json };

export type QueryCatalog = {
  readonly keys: readonly QueryKey[];
  answer(i: number, revision: number): Answer;
  /** JSON bytes of each query's body: the user bytes of its write or read. */
  readonly bytes: readonly number[];
  readonly totalBytes: number;
};

let built: { readonly size: SizeName; readonly seed: number; readonly catalog: QueryCatalog } | undefined;

/**
 * The tracker workspace after its history, as an app caches it: the first 50
 * issues of every project and status as cards, and each opened issue with its
 * comments. Built once per page, outside the timers.
 */
export function catalogFor(size: SizeName, seed: number): QueryCatalog {
  if (built?.size === size && built.seed === seed) return built.catalog;
  const { workspace, details } = SIZES[size];
  const oracle = new TrackerOracle();
  for (const tx of trackerHistory(workspace, seed).load) oracle.apply(tx);
  const keys: QueryKey[] = [];
  const bodies: Json[] = [];
  for (const project of oracle.projects.values()) {
    for (const status of STATUSES) {
      keys.push(["issues", project.key, status]);
      bodies.push(oracle.goals.statusPage({ projectId: project.id, status }));
    }
  }
  const comments = new Map<string, Comment[]>();
  for (const c of oracle.comments.values()) (comments.get(c.issueId) ?? comments.set(c.issueId, []).get(c.issueId)!).push(c);
  for (const issue of [...oracle.issues.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, details)) {
    keys.push(["issue", issue.id]);
    bodies.push({ issue, comments: comments.get(issue.id) ?? [] });
  }
  if (keys.length !== queryCount(size)) throw new Error(`the workspace gives ${keys.length} queries, want ${queryCount(size)}`);
  const bytes = bodies.map((body) => JSON.stringify(body).length);
  const catalog: QueryCatalog = {
    keys,
    answer: (i, revision) => ({ revision, body: bodies[i]! }),
    bytes,
    totalBytes: bytes.reduce((n, b) => n + b, 0),
  };
  built = { size, seed, catalog };
  return catalog;
}

/**
 * `?recordStorage` (set by bench/probes/tanstack-query-storage.ts) notes when
 * each persister call started and ended, and TanStack's JSON work inside them
 * on its own. `__storageCalls.take()` returns the spans since the last take,
 * grouped by kind, plus the time in which at least one persister call was in
 * flight. Off by default: a wrapper adds a promise per call, so recorded runs
 * are diagnostics, never results.
 */
const probing = typeof location !== "undefined" && new URLSearchParams(location.search).has("recordStorage");

type Span = readonly [start: number, end: number];
let spans: Record<string, Span[]> = {};

async function timed<T>(kind: string, call: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await call();
  } finally {
    (spans[kind] ??= []).push([start, performance.now()]);
  }
}

const busyMs = (all: Span[]) => {
  let total = 0;
  let start = NaN;
  let end = NaN;
  for (const span of all.sort((x, y) => x[0] - y[0])) {
    if (Number.isNaN(end) || span[0] > end) {
      if (!Number.isNaN(end)) total += end - start;
      start = span[0];
      end = span[1];
    } else end = Math.max(end, span[1]);
  }
  return Number.isNaN(end) ? 0 : total + (end - start);
};

if (probing) {
  Object.assign(globalThis, {
    __storageCalls: {
      take() {
        const taken = spans;
        spans = {};
        const kinds = Object.fromEntries(Object.entries(taken).map(([kind, list]) => [kind, { calls: list.length, ms: list.reduce((t, [a, b]) => t + (b - a), 0) }]));
        return { kinds, inStorageMs: busyMs([...(taken.persistQuery ?? []), ...(taken.restoreQueries ?? [])]) };
      },
    },
  });
}

const record = probing ? timed : <T>(_kind: string, call: () => Promise<T>) => call();

const recordedJson = probing
  ? {
      serialize: (query: PersistedQuery) => timed("serialize", async () => JSON.stringify(query)),
      deserialize: (text: string) => timed("deserialize", async () => JSON.parse(text) as PersistedQuery),
    }
  : {};

export type QueryWorld = {
  readonly client: QueryClient;
  /** Fetches each query and persists it once it resolves. Resolves when every query is stored. */
  fetchAndPersist(keys: readonly QueryKey[]): Promise<void>;
  /** Restores every persisted query into the client, as an app does at startup. */
  restore(): Promise<void>;
  /** The model the server answers from. Rebound by each phase, since each phase gets its own model object. */
  model: Model;
};

const worlds = new WeakMap<QueryStore, QueryWorld>();

/**
 * One client per store per page, as an app holds one QueryClient. Every query
 * fetches from the in-memory server. `persisterFn` does not await its write,
 * so the workload persists each fetched query with `persistQueryByKey`, which
 * runs the same `persistQuery` and resolves when the entry is stored. gcTime
 * is the persister's maxAge, as TanStack's docs advise, so no query leaves the
 * cache during a run.
 */
export function worldFor(store: QueryStore, model: Model, catalog: QueryCatalog): QueryWorld {
  let world = worlds.get(store);
  if (!world) {
    const persister = store.persister(recordedJson);
    const index = new Map(catalog.keys.map((key, i) => [hashKey(key), i]));
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: 24 * 60 * 60 * 1000,
          retry: false,
          queryFn: async ({ queryKey }) => {
            const i = index.get(hashKey(queryKey));
            if (i === undefined) throw new Error(`the server has no query ${hashKey(queryKey)}`);
            return catalog.answer(i, world!.model.version(i));
          },
        },
      },
    });
    world = {
      client,
      async fetchAndPersist(keys) {
        await Promise.all(
          keys.map(async (queryKey) => {
            await client.fetchQuery({ queryKey });
            await record("persistQuery", () => persister.persistQueryByKey(queryKey, client));
          }),
        );
      },
      restore: () => record("restoreQueries", () => persister.restoreQueries(client)),
      model,
    };
    worlds.set(store, world);
  }
  world.model = model;
  return world;
}
