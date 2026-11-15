import type { SceneName } from "../../stageshow/sizes.ts";

/**
 * The text a screen reader reads for each illustration that shows no page data. A page shows one with
 * `<Illustration name="…" />`, and a Markdown source with a `<!-- figure: … -->` line.
 */
export const FIGURES: Partial<Record<SceneName, string>> = {
  features:
    "Six features of opfs-lsm. Live subscriptions: two tabs of one app, where an issue checked off in one tab shows as checked in the other, in the same order, from either tab. Lightweight and fast. Quota management: storage fills to the app's cap, the app evicts its oldest data, and usage falls back under the cap. Use it with your framework: adapters for TanStack DB, Yjs, Automerge and fate. A low-level API for your own adapter: a batch of puts and deletes on keys and bytes. Fault tolerant and consistent: a tab crashes in the middle of a write, and the database reopens with every acknowledged write intact.",
  stack:
    "A tab puts a record, which becomes a row of the write-ahead log in IndexedDB: that row is the ack. The SharedWorker flushes the rows of the log into one SST file in OPFS and truncates the log. The tab reads the SST files itself.",
};
