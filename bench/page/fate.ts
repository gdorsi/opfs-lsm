/**
 * Everything the two fate workloads share, so both storages run the same
 * client code: the record, its generator, the client declarations, an
 * in-memory transport over the model, and the function that builds a client
 * with persistence over a storage. A contender supplies only the storage.
 */
import { clientRoot, createClient, mutation, view } from "@nkzw/fate";
import { createPersistence, type PersistenceStorage } from "@nkzw/fate/persistence";
import type { Model } from "./model.ts";

/** An issue-like row. About 200 bytes as JSON. */
export type Issue = {
  readonly __typename: "Issue";
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: number;
  readonly modified: number;
};

export type Rename = { readonly id: string; readonly title: string };

export const PAGE = 100;

/**
 * The persistence budget, the same on both sides and large enough that
 * nothing is evicted at any size (100,000 records are about 30 MB encoded).
 */
const MAX_BYTES = 2 ** 30;

const STATUSES = ["backlog", "todo", "in-progress", "in-review", "done", "canceled"] as const;
const VERBS = ["Fix", "Add", "Remove", "Rework", "Document", "Profile", "Split", "Cache"] as const;
const AREAS = ["sync engine", "list virtualization", "keyboard shortcuts", "offline queue", "search index", "comment threads"] as const;

const issueId = (i: number) => `issue-${String(i).padStart(8, "0")}`;

/** A pure function of (index, version): the model holds versions, never rows. */
export function record(i: number, version: number): Issue {
  return {
    __typename: "Issue",
    id: issueId(i),
    title: `${VERBS[i % VERBS.length]} ${AREAS[(i >> 3) % AREAS.length]} so the ${AREAS[(i + version) % AREAS.length]} stays responsive (revision ${version}, number ${i})`,
    status: STATUSES[(i + version) % STATUSES.length]!,
    priority: (i + version) % 5,
    modified: 1_700_000_000_000 + version * 86_400_000 + i,
  };
}

export const renamed = (i: number): Rename => ({ id: issueId(i), title: `Renamed issue ${i} while offline` });

export const jsonBytes = (value: unknown) => JSON.stringify(value).length;

const IssueView = view<Issue>()({ id: true, title: true, status: true, priority: true, modified: true });

const roots = { issues: clientRoot("Issue") };
const mutations = { renameIssue: mutation<Issue, Rename, Issue>("Issue") };

/** The list request for page `k`. Each page has its own args, so each is its own saved request. */
export const pageRequest = (k: number) => ({ issues: { list: IssueView, args: { first: PAGE, page: k } } }) as const;

export type Delivered = { readonly id: string; readonly input: Rename };

export type Source = {
  readonly transport: Record<string, unknown>;
  lists(): number;
  readonly delivered: Delivered[];
  /** The model that decides which version of a record the server holds. Rebound by each phase, since each phase gets its own model object. */
  model: Model;
};

const indexOf = (id: string) => Number(id.slice("issue-".length));

/**
 * Lists serve records `[k * PAGE, (k + 1) * PAGE)` at the model's current
 * version. `mutateDurably` resolves at once with the renamed record and logs
 * what it received. `serve: false` makes every call throw, so a client over it
 * can only get data from storage.
 */
function newSource(model: Model, count: number, serve: boolean): Source {
  const delivered: Delivered[] = [];
  let lists = 0;
  const refuse = async () => {
    throw new Error("the server was called: the data was supposed to come from storage");
  };
  const node = (i: number) => record(i, Math.max(1, source.model.version(i)));
  const source: Source = {
    model,
    delivered,
    lists: () => lists,
    transport: serve
      ? {
          fetchById: async (_type: string, ids: readonly string[]) => ids.map((id) => node(indexOf(id))),
          fetchList: async (_proc: string, _select: unknown, args: { page: number }) => {
            lists++;
            const items = [];
            for (let i = args.page * PAGE; i < Math.min(count, (args.page + 1) * PAGE); i++) items.push({ cursor: `c${i}`, node: node(i) });
            return { items, pagination: { hasNext: false, hasPrevious: false } };
          },
          mutateDurably: async (_proc: string, input: Rename, _select: unknown, identity: { id: string }) => {
            delivered.push({ id: identity.id, input });
            return { ...record(indexOf(input.id), 1), title: input.title };
          },
        }
      : { fetchById: refuse, fetchList: refuse, mutateDurably: refuse },
  };
  return source;
}

export type FateClient = ReturnType<typeof newClient>;

function newClient(storage: PersistenceStorage, transport: Record<string, unknown>, online: boolean) {
  return createClient<[typeof roots, typeof mutations]>({
    persistence: createPersistence({ key: KEY, maxBytes: MAX_BYTES, online: () => online, storage: probing ? recorded(storage) : storage }),
    roots,
    mutations,
    transport: transport as never,
    types: [{ fields: { title: "scalar", status: "scalar", priority: "scalar", modified: "scalar" }, type: "Issue" }],
  });
}

const KEY = "bench";

export type World = { readonly client: FateClient; readonly source: Source };

export type WorldOptions = {
  /** Records on the server. */
  readonly count: number;
  /** False: any call to the server throws. Default true. */
  readonly serve?: boolean;
  /** False: mutations are saved but never sent. Default true. */
  readonly online?: boolean;
};

const worlds = new WeakMap<PersistenceStorage, World>();

/**
 * One client per storage per page. A phase calls this and gets the client an
 * earlier phase built, so two clients never share one storage by accident.
 * `opts` apply to the first call; `model` is rebound on every call.
 */
export function worldFor(storage: PersistenceStorage, model: Model, opts: WorldOptions): World {
  let world = worlds.get(storage);
  if (!world) {
    const source = newSource(model, opts.count, opts.serve ?? true);
    world = { client: newClient(storage, source.transport, opts.online ?? true), source };
    worlds.set(storage, world);
  }
  world.source.model = model;
  return world;
}

/** Stops the page's client: timers cleared, pending optimistic work rolled back. Storage is untouched. */
export function disposeWorld(storage: PersistenceStorage): void {
  worlds.get(storage)?.client.persistence?.dispose();
  worlds.delete(storage);
}

const inMemory = (client: FateClient, i: number) => client.store.read(`Issue:${issueId(i)}`) as Partial<Issue> | undefined;

/**
 * Compare the records of page `k` in the client's memory with `want(i)`. Call
 * it right after the request for the page resolves: fate frees the records of
 * requests it released.
 */
export function checkPage(client: FateClient, k: number, count: number, want: (i: number) => Issue, check: (ok: boolean, what: string) => void): void {
  for (let i = k * PAGE; i < Math.min(count, (k + 1) * PAGE); i++) {
    const got = inMemory(client, i);
    const expected = want(i);
    check(
      got?.id === expected.id && got.title === expected.title && got.status === expected.status && got.priority === expected.priority && got.modified === expected.modified,
      `record ${i}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`,
    );
  }
}

/**
 * Check every record against `want(i)` by disposing the page's client and
 * loading each page through a new one whose server throws: the only source
 * left is storage. A missing or stale record fails the run.
 * Leaves no client, so the next phase builds its own.
 */
export async function verifyFromStorage(
  storage: PersistenceStorage,
  model: Model,
  count: number,
  want: (i: number) => Issue,
  check: (ok: boolean, what: string) => void,
): Promise<void> {
  disposeWorld(storage);
  const { client } = worldFor(storage, model, { count, serve: false, online: false });
  try {
    for (let k = 0; k * PAGE < count; k++) {
      await client.request(pageRequest(k) as never);
      checkPage(client, k, count, want, check);
    }
  } finally {
    disposeWorld(storage);
  }
}

/** The mutation entries saved in storage, counted by paging through `scan` under the prefix fate gives its journal. */
export async function journalEntries(storage: PersistenceStorage): Promise<number> {
  const prefix = `${JSON.stringify([KEY, "journal"])}:`;
  let n = 0;
  let after: string | undefined;
  for (;;) {
    const page = await storage.scan(prefix, after, 256);
    n += page.length;
    if (page.length < 256) return n;
    after = page.at(-1)!.key;
  }
}

/**
 * `?recordStorage` (set by bench/probes/fate-storage.ts) wraps the storage the
 * client sees, kv's `db.sync()` and `setTimeout(0)`, and notes when each call
 * started and ended. `take()` returns the spans since the last call, grouped by
 * kind, plus the time any storage call (not a wait for a lock) was in flight. Off by default: a wrapper
 * adds a promise per call, so recorded runs are diagnostics, never results.
 */
const probing = typeof location !== "undefined" && new URLSearchParams(location.search).has("recordStorage");

type Span = readonly [start: number, end: number];
let spans: Record<string, Span[]> = {};

function note(kind: string, start: number): void {
  (spans[kind] ??= []).push([start, performance.now()]);
}

async function timed<T>(kind: string, call: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await call();
  } finally {
    note(kind, start);
  }
}

function recorded(storage: PersistenceStorage): PersistenceStorage {
  return {
    read: (key) => timed("read", () => storage.read(key)),
    scan: (prefix, after, limit) => timed("scan", () => storage.scan(prefix, after, limit)),
    writeBatch: (entries) => timed("writeBatch", () => storage.writeBatch(entries)),
    exclusive: (name, run) => {
      const asked = performance.now();
      return storage.exclusive(name, () => {
        note("wait", asked);
        return timed("held", run);
      });
    },
    ...(storage.subscribe ? { subscribe: storage.subscribe.bind(storage) } : {}),
  };
}

/** kv's `exclusive` calls `db.sync()` inside the grant; time it as its own kind. */
export function recordSync(db: { sync(): Promise<void> }): void {
  if (!probing) return;
  const sync = db.sync.bind(db);
  db.sync = () => timed("sync", sync);
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
  const native = globalThis.setTimeout.bind(globalThis);
  // Timers of at most 1 ms are fate's yields to the event loop (and the browser clamps them); time from schedule to run.
  globalThis.setTimeout = ((handler: unknown, delay?: number, ...args: unknown[]) => {
    if (typeof handler !== "function" || (delay ?? 0) > 1) return native(handler as never, delay, ...args);
    const start = performance.now();
    return native(() => {
      note("yield", start);
      handler(...args);
    }, delay);
  }) as typeof setTimeout;
  // fate's IndexedDB storage closes its connection whenever no call or lock is using it, so count the opens.
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args: Parameters<IDBFactory["open"]>) => {
    note("idbOpen", performance.now());
    return open(...args);
  };
  Object.assign(globalThis, {
    __fateStorage: {
      take() {
        const taken = spans;
        spans = {};
        const kinds = Object.fromEntries(Object.entries(taken).map(([kind, list]) => [kind, { calls: list.length, ms: list.reduce((t, [a, b]) => t + (b - a), 0) }]));
        const inStorage = busyMs(["read", "scan", "writeBatch", "sync"].flatMap((kind) => taken[kind] ?? []));
        return { kinds, inStorageMs: inStorage };
      },
    },
  });
}
