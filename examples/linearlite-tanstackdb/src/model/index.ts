import type { Stream } from "../domain/stores.ts";
import type { Backend } from "./backend.ts";
import { commands, type Commands } from "./commands.ts";
import { openSync, threadFetcher, type Sync } from "./sync.ts";
import type { Transport } from "./transport.ts";
import { issueViews, type Issues } from "./views.ts";

/** LinearLite without React or the browser: the app, bench pages and Node tests drive the same model. */
export interface Linearlite {
  readonly issues: Issues;
  readonly commands: Commands;
  readonly sync: Sync;
}

export type OpenOptions = {
  readonly backend: Backend;
  readonly transport: Transport;
  /** Rows per pull page. Default 2,000. */
  readonly pullLimit?: number;
  /** Called the first time a leader in this model finds a stream caught up with the server. */
  readonly onCaughtUp?: (stream: Stream) => void;
};

export function openLinearlite({ backend, transport, pullLimit, onCaughtUp }: OpenOptions): Linearlite {
  const threads = threadFetcher(backend, transport);
  return {
    issues: issueViews(backend, { fetchThread: (id) => threads.fetch([id]), online: (back) => transport.online(back) }),
    commands: commands(backend, transport.user),
    sync: openSync(backend, transport, threads, { pullLimit, onCaughtUp }),
  };
}
