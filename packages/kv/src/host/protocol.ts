import { checkDbName, type DbName } from "../check.js";
import type { ErrorCode } from "../errors.js";
import { parseLogId } from "../log/segment.js";
import type { LogId, RecordN } from "./queues.js";
import type { IoCounters } from "../opfs/counting-fs.js";

/** What the host counted for one database since it started. Test and bench only. */
export type HostStats = {
  /** Flush (l0), compaction outputs (lN), manifests (m), compaction input reads. */
  fs: IoCounters;
  /** L0 runs ingest published. */
  flushes: number;
  /** Times ingest found L0 full and waited for compaction before it published another run. */
  l0Stops: number;
  /** Compaction steps installed. */
  compactionSteps: number;
  /** Key and value bytes of the records ingest folded. */
  foldedBytes: number;
  generation: number;
  /** From the latest manifest, levels with at least one run. */
  layout: { level: number; runs: number; bytes: number }[];
};

/** The BroadcastChannel where the host announces each manifest it publishes. */
export function layersChannel(name: string): string {
  return `opfs-lsm-layers/${name}`;
}

/**
 * Page to host, over the page's port. Private to `db.ts` and `host.ts`:
 * the host parses it with `parsePageToHost`.
 */
export type PageToHost =
  /** Serve `db` on this port, and answer as `sync` does once recovery passed. */
  | { readonly t: "attach"; readonly id: number; readonly db: DbName }
  /** Records 1..n of `log` are flushed. `bytes` is their body bytes, for the ingest trigger. */
  | { readonly t: "durable"; readonly log: LogId; readonly n: RecordN; readonly bytes: number }
  /** Ask the other pages to flush, ingest what is flushed, and answer with the newest manifest. */
  | { readonly t: "sync"; readonly id: number }
  /** `sync`, then compaction until a pass has nothing to do. */
  | { readonly t: "settle"; readonly id: number }
  /** This page did what `flush` asked. */
  | { readonly t: "flushed"; readonly id: number }
  | { readonly t: "stats"; readonly id: number }
  /** The page closed its log, which the host reads to its end once its lock is free. */
  | { readonly t: "detach" };

/** Host to page, over the page's port. Parsed by `parseHostToPage`. */
export type HostToPage =
  | { readonly t: "done"; readonly id: number; readonly generation: number }
  | { readonly t: "stats"; readonly id: number; readonly stats: HostStats }
  | { readonly t: "failed"; readonly id: number; readonly message: string; readonly code?: ErrorCode }
  /** Rotate the live log when it is in `rotate`, flush it, and answer `flushed`. */
  | { readonly t: "flush"; readonly id: number; readonly rotate: readonly LogId[] };

/** What the host posts on `layersChannel` after each manifest it publishes. */
export type GenerationNote = { readonly generation: number };

const isId = (v: unknown): v is number => Number.isSafeInteger(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isLog = (v: unknown): v is LogId => typeof v === "string" && parseLogId(v) !== undefined;
const ERROR_CODES: readonly ErrorCode[] = ["commit", "closed", "corrupt", "constraint", "unavailable", "indeterminate"];

function fields(data: unknown): Record<string, unknown> | undefined {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

export function parsePageToHost(data: unknown): PageToHost | undefined {
  const m = fields(data);
  if (!m) return undefined;
  switch (m.t) {
    case "attach":
      if (!isId(m.id) || typeof m.db !== "string") return undefined;
      try {
        return { t: "attach", id: m.id, db: checkDbName(m.db) };
      } catch {
        return undefined;
      }
    case "durable":
      return isLog(m.log) && isCount(m.n) && isCount(m.bytes) ? { t: "durable", log: m.log, n: m.n, bytes: m.bytes } : undefined;
    case "sync":
    case "settle":
    case "flushed":
    case "stats":
      return isId(m.id) ? { t: m.t, id: m.id } : undefined;
    case "detach":
      return { t: "detach" };
    default:
      return undefined;
  }
}

export function parseHostToPage(data: unknown): HostToPage | undefined {
  const m = fields(data);
  if (!m || !isId(m.id)) return undefined;
  switch (m.t) {
    case "done":
      return isCount(m.generation) ? { t: "done", id: m.id, generation: m.generation } : undefined;
    case "stats":
      return fields(m.stats) ? { t: "stats", id: m.id, stats: m.stats as HostStats } : undefined;
    case "failed": {
      if (typeof m.message !== "string") return undefined;
      const code = ERROR_CODES.find((c) => c === m.code);
      return code ? { t: "failed", id: m.id, message: m.message, code } : { t: "failed", id: m.id, message: m.message };
    }
    case "flush":
      return Array.isArray(m.rotate) && m.rotate.every(isLog) ? { t: "flush", id: m.id, rotate: m.rotate } : undefined;
    default:
      return undefined;
  }
}

export function parseGenerationNote(data: unknown): GenerationNote | undefined {
  const m = fields(data);
  return m && isCount(m.generation) ? { generation: m.generation } : undefined;
}
