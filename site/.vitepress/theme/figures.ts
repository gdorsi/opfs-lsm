import type { SceneName } from "../../stageshow/sizes.ts";

/**
 * The text a screen reader reads for each illustration that shows no page data. A page shows one with
 * `<Illustration name="…" />`, and a Markdown source with a `<!-- figure: … -->` line.
 */
export const FIGURES: Partial<Record<SceneName, string>> = {
  features:
    "Six features of opfs-lsm. Live subscriptions: two tabs of one app, where an issue checked off in one tab shows as checked in the other, in the same order, from either tab. Lightweight and fast. Quota management: storage fills to the app's cap, the app evicts its oldest data, and usage falls back under the cap. Use it with your framework: adapters for TanStack DB, Yjs, Automerge and fate. A low-level API for your own adapter: a batch of puts and deletes on keys and bytes. Fault tolerant and consistent: a tab crashes in the middle of a write, and the database reopens with every acknowledged write intact.",
  hood:
    "Two tabs of LinearLite above the engine of kv, shown in seven steps. 1: both tabs open the same database. 2: in tab 1 an issue is marked Done; the change is a batch of 7 operations on the issue and its index entries, and it becomes one row, record 43, in the write-ahead log in IndexedDB. 3: tab 1 tells tab 2 over a BroadcastChannel, and tab 2 shows the issue as Done. 4: the SharedWorker, the only code that writes files, moves records 41 to 43 into a new sorted file in OPFS, and the log is empty. 5: tab 2 reads an older issue; it loads only the one 32 KB page of a file that holds it, into a page cache capped at 256 MiB, and it sends no message to the SharedWorker. 6: tab 1 saves record 44, a second issue set to In Progress, and IndexedDB acknowledges it; the power goes out before the disk has it. 7: after the reboot, the database has every write up to record 43 and none after it; the second issue is back to Todo in both tabs, the first is still Done, and the cache is empty. A power loss can lose the newest writes, never one from the middle.",
  stack:
    "A tab puts a record, which becomes a row of the write-ahead log in IndexedDB: that row is the ack. The SharedWorker flushes the rows of the log into one SST file in OPFS and truncates the log. The tab reads the SST files itself.",
};

/** One chapter of an illustration that plays with a player. */
export type Chapter = {
  /** The chapter's name on the player's timeline. */
  readonly label: string;
  /** What the chapter shows, in a few words, under the figure. */
  readonly title: string;
  /** The chapter told in full, shown with its title while it plays. */
  readonly detail: string;
  /** How long the chapter plays: its beat, then its frame held for reading. */
  readonly ms: number;
};

/**
 * The chapters of an illustration that plays with a player: pause, the chapters on a timeline, and their titles. The
 * page passes the scene the chapter to play from, and the scene's frames and beats line up with these index for
 * index.
 */
export const CHAPTERS: Partial<Record<SceneName, readonly Chapter[]>> = {
  hood: [
    {
      label: "Open",
      title: "Two tabs share one database",
      detail: "Both tabs run LinearLite, the app at the top of this page, on the same kv database.",
      ms: 5000,
    },
    {
      label: "Write",
      title: "One row per batch keeps writes fast",
      detail: "Tab 1 marks an issue Done: 7 operations on the issue and its index entries. kv writes them as one row of the write-ahead log, a list of recent writes kept in IndexedDB.",
      ms: 9000,
    },
    {
      label: "Broadcast",
      title: "The other tab sees it at once",
      detail: "Tab 1 tells tab 2 over a BroadcastChannel, a message channel between tabs, and tab 2 shows the change.",
      ms: 8000,
    },
    {
      label: "Flush",
      title: "One SharedWorker writes every file",
      detail: "The SharedWorker, a background script all tabs share, moves the log into a sorted file in OPFS, the browser's private file system. No other code writes files.",
      ms: 9500,
    },
    {
      label: "Read",
      title: "A read loads one page",
      detail: "Tab 2 reads an older issue. It loads only the 32 KB page of the file that holds it, into a cache with a size cap.",
      ms: 9000,
    },
    {
      label: "Power cut",
      title: "The power goes out",
      detail: "Tab 1 saves another change, record 44, and IndexedDB acks it. The power goes out before the operating system writes it to disk.",
      ms: 10000,
    },
    {
      label: "Reopen",
      title: "kv reopens without gaps",
      detail: "After the reboot, kv opens with every write up to record 43 and none after it. A power loss can lose the newest writes, never one from the middle.",
      ms: 9500,
    },
  ],
};
