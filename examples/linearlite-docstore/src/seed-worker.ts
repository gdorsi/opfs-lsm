import type { Issue } from "./model.ts";
import { generate } from "./seed.ts";

/** `first` issues come in a batch of their own, so the page has rows to list early. The rest come `batch` at a time. */
export type SeedRequest = { readonly count: number; readonly seed: number; readonly first: number; readonly batch: number };
export type SeedMessage = { readonly issues: Issue[] } | { readonly done: true; readonly generateMs: number };

const post = (message: SeedMessage) => (self as unknown as { postMessage(m: SeedMessage): void }).postMessage(message);

/** Runs in a dedicated WebWorker, so generating the issues does not block the page. Posts each batch as it is ready. */
self.onmessage = (e: MessageEvent<SeedRequest>) => {
  const t0 = performance.now();
  let size = e.data.first;
  let issues: Issue[] = [];
  for (const issue of generate(e.data.count, e.data.seed)) {
    issues.push(issue);
    if (issues.length < size) continue;
    post({ issues });
    issues = [];
    size = e.data.batch;
  }
  if (issues.length > 0) post({ issues });
  post({ done: true, generateMs: performance.now() - t0 });
};
