/**
 * What the linearlite workloads share: the in-memory server and its oracle, the headless model over the contender's
 * backend, and the ways a phase waits for a view to show what the oracle says. A contender supplies only the backend.
 */
import { CorrectnessError } from "./model.ts";
import type { LinearliteStore } from "../core/families.ts";
import type { BackendPath } from "../../examples/linearlite-tanstackdb/src/model/backend.ts";
import { openLinearlite, type Linearlite } from "../../examples/linearlite-tanstackdb/src/model/index.ts";
import { hold, type Held, type Live } from "../../examples/linearlite-tanstackdb/src/model/live.ts";
import { memoryServer, memoryTransport, type MemoryServer } from "../../examples/linearlite-tanstackdb/src/server/memory.ts";
import { reference, type Reference } from "../../examples/linearlite-tanstackdb/src/testing/reference.ts";

/** One line of the report: how the backend serves each concern. */
export function describePath(p: BackendPath): string {
  return `loads: ${p.loads}; writes: ${p.writes}; counts: ${p.counts}; deep windows: ${p.deep}; pressure: ${p.pressure}; tabs: ${p.tabs}`;
}

/** A view that does not show what the oracle says within this long has a bug, not a slow backend. */
const SHOW_TIMEOUT_MS = 30_000;

/** The server a replica on disk synced from has the epoch it kept, so a page that rebuilds the server names it. */
const epochOf = (issues: number) => `bench-linearlite-${issues}`;

export type Server = {
  readonly issues: number;
  readonly server: MemoryServer;
  readonly reference: Reference;
  /** JSON bytes of every issue row: what a first sync pulls. */
  readonly issueBytes: number;
};

let built: Server | undefined;

/** The server of this page, built once. Building takes seconds at 100,000 issues, so a phase that is timed must not do it. */
export function buildServer(issues: number): Server {
  if (built?.issues === issues) return built;
  const server = memoryServer({ issues, seed: 1, epoch: epochOf(issues) });
  const rows = server.rows();
  let issueBytes = 0;
  for (const row of rows.issues.values()) issueBytes += JSON.stringify(row).length;
  return (built = { issues, server, reference: reference(rows), issueBytes });
}

/** A held set of views, replaced as a user moves to the next screen: the old views are released once the new ones show. */
export type Screen = {
  /** Subscribes to `live` as part of the next screen. */
  hold<T>(live: Live<T>): Held<T>;
  /** The held views so far are the screen; the earlier screen's are released. */
  commit(): void;
  release(): void;
};

function screen(): Screen {
  let current: Held<unknown>[] = [];
  let next: Held<unknown>[] = [];
  const release = (held: Held<unknown>[]) => {
    for (const h of held.splice(0)) h.release();
  };
  return {
    hold(live) {
      const held = hold(live);
      next.push(held as Held<unknown>);
      return held;
    },
    commit() {
      release(current);
      current = next;
      next = [];
    },
    release() {
      release(current);
      release(next);
    },
  };
}

export type World = {
  readonly server: Server;
  readonly model: Linearlite;
  readonly screen: Screen;
  /** Checks that run after the timed phases: each returns what is wrong, or undefined. */
  readonly later: (what: string, check: () => string | undefined) => void;
  readonly verify: (check: (ok: boolean, what: string) => void) => void;
  /** Starts sync as the app's leader tab does. */
  lead(): void;
  /** Resolves once the outbox is empty and every stream has reached the server's head. */
  settled(): Promise<void>;
  stop(): Promise<void>;
};

let world: World | undefined;

/** The headless model over the store's backend and this page's server. The page keeps it for the "same" phases that follow. */
export function openWorld(store: LinearliteStore, issues: number): World {
  if (world) throw new Error("this page already has a linearlite model");
  const server = buildServer(issues);
  const model = openLinearlite({ backend: store.backend, transport: memoryTransport(server.server, "bench") });
  const abort = new AbortController();
  let leading: Promise<void> | undefined;
  const checks: { what: string; check: () => string | undefined }[] = [];
  const shown = screen();
  return (world = {
    server,
    model,
    screen: shown,
    later: (what, check) => void checks.push({ what, check }),
    verify(check) {
      for (const { what, check: run } of checks.splice(0)) {
        const wrong = run();
        check(wrong === undefined, `${what}: ${wrong}`);
      }
    },
    lead() {
      leading = model.sync.lead(abort.signal);
    },
    settled: () => model.sync.settled(),
    async stop() {
      shown.release();
      abort.abort();
      await leading;
      world = undefined;
    },
  });
}

export function currentWorld(): World {
  if (!world) throw new Error("no linearlite model on this page: the phase that opens it did not run here");
  return world;
}

/**
 * Waits until `test` passes for the held view's value, and returns that value. A view that never passes fails the run
 * with `why`, which says what the oracle expected.
 */
export async function shows<T>(held: Held<T>, test: (value: T) => boolean, why: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), SHOW_TIMEOUT_MS)));
  try {
    const got = await Promise.race([held.until(test), timeout]);
    if (got === "timeout") throw new CorrectnessError(`the view did not show what the oracle expects within ${SHOW_TIMEOUT_MS} ms: ${why()}`);
    return got;
  } finally {
    clearTimeout(timer);
  }
}
