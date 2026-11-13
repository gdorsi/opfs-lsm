import type { Issue } from "./model.ts";
import { generate } from "./seed.ts";

export type SeedMessage = { readonly issues: Issue[] } | { readonly done: true; readonly generateMs: number };

const CHUNK = 5000;
const post = (message: SeedMessage) => (self as unknown as { postMessage(m: SeedMessage): void }).postMessage(message);

/** Runs in a dedicated WebWorker, so generating the issues does not block the page. */
self.onmessage = (e: MessageEvent<{ count: number }>) => {
  const t0 = performance.now();
  const issues = generate(e.data.count);
  const generateMs = performance.now() - t0;
  for (let at = 0; at < issues.length; at += CHUNK) post({ issues: issues.slice(at, at + CHUNK) });
  post({ done: true, generateMs });
};
