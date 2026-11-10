import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallStep, Order, RoundStep } from "./model.js";

const src = (file: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src", file);

/** The text of the function or method whose header matches `head`, through its closing brace. */
function body(source: string, head: RegExp, where: string): string {
  const m = head.exec(source);
  if (!m) throw new Error(`parse: no ${head} in ${where}`);
  let depth = 0;
  for (let i = source.indexOf("{", m.index + m[0].length - 1); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(m.index, i + 1);
  }
  throw new Error(`parse: unbalanced braces after ${head} in ${where}`);
}

function order<T extends string>(text: string, steps: Record<T, RegExp>, where: string): T[] {
  const found = (Object.keys(steps) as T[]).map((name) => {
    const at = text.search(steps[name]);
    if (at < 0) throw new Error(`parse: no ${name} in ${where}`);
    return { name, at };
  });
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

/**
 * The step order of the source: the round's two publishes in
 * `ingestQueues` (src/host/queue-host.ts), and the page's `install` in
 * src/db.ts, which must swap the runs and drop its own records in one task.
 */
export function loadOrder(): Order & { readonly files: readonly string[] } {
  const hostFile = src("host/queue-host.ts");
  const dbFile = src("db.ts");
  const ingest = body(fs.readFileSync(hostFile, "utf8"), /export async function ingestQueues\(/, hostFile);
  const install = body(fs.readFileSync(dbFile, "utf8"), /\n\s*(?:private\s+)?(async\s+)?install\(layers: Layers\)[^{]*\{/, dbFile);
  const round = order<RoundStep>(ingest, { publishL0: /\bpublishL0\(/, publishGeneration: /\bpublishGeneration\(/ }, hostFile);
  const steps = order<InstallStep>(install, { swapRuns: /this\.installed = layers/, dropOwn: /this\.own\.install\(/ }, dbFile);
  const installAtomic = !/\bawait\b|\basync\b|\.then\(/.test(install);
  return { round, install: steps, installAtomic, files: [hostFile, dbFile] };
}
