import type { SceneName } from "../../stageshow/sizes.ts";

/**
 * The text a screen reader reads for each illustration that shows no page data. A page shows one with
 * `<Illustration name="…" />`, and a Markdown source with a `<!-- figure: … -->` line.
 */
export const FIGURES: Partial<Record<SceneName, string>> = {
  features:
    "Six features of opfs-lsm. Live subscriptions: two tabs of one app, where an issue checked off in one tab shows as checked in the other, in the same order, from either tab. Lightweight and fast. Quota management: storage fills up, the app evicts its oldest data, and usage falls back. Use it with your framework: adapters for TanStack DB, Yjs and Automerge. A low-level API for your own adapter: a batch of puts and deletes on keys and bytes. Fault tolerant and consistent: a tab crashes in the middle of a write, and the database reopens with every acknowledged write intact.",
  hood:
    "Two tabs of LinearLite above the engine of kv, shown in six steps. 1: both tabs open the same database. 2: in tab 1 an issue is marked Done; the change is a batch of 7 operations on the issue and its index entries, and it becomes one row, record 43, in the write-ahead log in IndexedDB, which numbers the rows in one order for all tabs. 3: tab 1 sends record 43 and its 7 operations to tab 2 over a BroadcastChannel, and tab 2 shows the issue as Done without reading IndexedDB. 4: the SharedWorker, the only code that writes files, moves records 41 to 43 into a new sorted file in OPFS, and the log is empty. 5: tab 2 reads an older issue straight from OPFS; the key ranges in the manifest, the list of sorted files, lead it to the file that holds the issue, and it loads only one 32 KB page of that file, into a page cache capped at 256 MiB, and it sends no message to the SharedWorker. 6: tab 1 saves record 44, a second issue set to In Progress, and IndexedDB acknowledges it; the power goes out before the disk has it. After the reboot, kv opens the newest manifest whose files are all on disk, with the log records after it, so the database has every write up to record 43 and none after it; the second issue is back to Todo in both tabs, the first is still Done, and the cache is empty. A power loss can lose the newest writes, never one from the middle.",
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
      detail: "Above the line, two tabs of an app. Below it, what kv runs and stores in the browser.",
      ms: 5000,
    },
    {
      label: "Write",
      title: "WAL lives in IndexedDB",
      detail: "The write-ahead log, or WAL, holds recent writes. IndexedDB keeps its rows in one order for all tabs, and each batch is a single row.",
      ms: 9000,
    },
    {
      label: "Broadcast",
      title: "Changes between tabs are synced via BroadcastChannel",
      detail: "A BroadcastChannel carries messages between tabs. The writing tab sends its new log rows, and the others apply them without reading IndexedDB.",
      ms: 8000,
    },
    {
      label: "Flush",
      title: "Only the SharedWorker writes files",
      detail: "The SharedWorker, a background script all tabs share, moves the log into sorted files in OPFS, the browser's private file system.",
      ms: 9500,
    },
    {
      label: "Read",
      title: "Each tab reads from OPFS directly",
      detail: "The manifest lists every file with its range of keys. A read uses it to pick the file, then loads one 32 KB page.",
      ms: 9000,
    },
    {
      label: "Power loss",
      title: "When data loss happens, the DB stays consistent",
      detail: "After a power loss, kv reopens from the newest manifest whose files are all on disk, plus the log after it. Only the newest writes can be lost.",
      ms: 14000,
    },
  ],
};
