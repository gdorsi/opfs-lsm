import type { Stream } from "../domain/stores.ts";
import { commands, type Commands } from "./commands.ts";
import type { Store } from "./store.ts";
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
  readonly store: Store;
  readonly transport: Transport;
  /** Rows per pull page. Default 2,000. */
  readonly pullLimit?: number;
  /** Called the first time a leader in this model finds a stream caught up with the server. */
  readonly onCaughtUp?: (stream: Stream) => void;
  /** Whether the page is hidden, so a recount runs without pausing. Default: never. */
  readonly hidden?: () => boolean;
};

export function openLinearlite({ store, transport, pullLimit, onCaughtUp, hidden = () => false }: OpenOptions): Linearlite {
  const threads = threadFetcher(store, transport);
  return {
    issues: issueViews(store, { fetchThread: (id) => threads.fetch([id]), online: (back) => transport.online(back), hidden }),
    commands: commands(store, transport.user),
    sync: openSync(store, transport, threads, { pullLimit, onCaughtUp }),
  };
}
