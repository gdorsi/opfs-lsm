import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Atomic awaits inside the non-empty branch of `ingestChunk`. */
export type IngestStep =
  | "publishL0"
  | "publishGeneration"
  | "advanceIngested";

const STEP_RE =
  /\b(?:await\s+)?(?:wal\.)?advanceIngested\b|\b(?:await\s+)?publishGeneration\b|\b(?:await\s+)?publishL0\b/g;

const NAME_RE = /(publishL0|publishGeneration|advanceIngested)/;

/**
 * Read the call order of the three durability steps from `ingestChunk`.
 * Points at `packages/kv/src/host/ingest.ts`.
 */
function ingestSourcePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../src/host/ingest.ts");
}

function parseIngestOrder(source: string): IngestStep[] {
  const nonEmpty = source.match(
    /\n( *)if\s*\(\s*records\.length\s*===\s*0\s*\)\s*\{[\s\S]*?\}\s*else\s*\{([\s\S]*?)\n\1\}/,
  );
  const body = nonEmpty?.[2] ?? source;
  const steps: IngestStep[] = [];
  for (const hit of body.matchAll(STEP_RE)) {
    const name = hit[0].match(NAME_RE)?.[1] as IngestStep | undefined;
    if (!name) continue;
    if (!steps.includes(name)) steps.push(name);
  }
  const required: IngestStep[] = [
    "publishL0",
    "publishGeneration",
    "advanceIngested",
  ];
  for (const r of required) {
    if (!steps.includes(r)) {
      throw new Error(
        `parseIngestOrder: missing ${r} in ingestChunk non-empty branch`,
      );
    }
  }
  if (steps.length !== 3) {
    throw new Error(
      `parseIngestOrder: expected exactly the three steps, got ${steps.join(",")}`,
    );
  }
  return steps;
}

export function loadIngestOrderFromRepo(): {
  path: string;
  order: IngestStep[];
} {
  const file = ingestSourcePath();
  const source = fs.readFileSync(file, "utf8");
  return { path: file, order: parseIngestOrder(source) };
}
