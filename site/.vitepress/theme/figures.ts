import type { SceneName } from "../../stageshow/sizes.ts";

/**
 * The text a screen reader reads for each illustration that shows no page data. A page shows one with
 * `<Illustration name="…" />`, and a Markdown source with a `<!-- figure: … -->` line.
 */
export const FIGURES: Partial<Record<SceneName, string>> = {
  stack:
    "A tab puts a record, which becomes a row of the write-ahead log in IndexedDB: that row is the ack. The SharedWorker flushes the rows of the log into one SST file in OPFS and truncates the log. The tab reads the SST files itself.",
};
