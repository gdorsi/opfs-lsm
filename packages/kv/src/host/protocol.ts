import { checkDbName, type DbName } from "../check.js";
import type { ErrorCode } from "../errors.js";
import { parseLogId } from "../log/segment.js";
import type { LogId, RecordN } from "./queues.js";
import type { IngestPolicy } from "../ingest-policy.js";
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

/** The BroadcastChannel where tabs share appends and new generations. */
export function layersChannel(name: string): string {
  return `opfs-lsm-layers/${name}`;
}

export type ClientToHost =
  | {
      readonly type: "ingest";
      readonly id: number;
      readonly name: string;
      readonly through: number;
      readonly settle: boolean;
    }
  | {
      readonly type: "watch";
      readonly name: string;
      readonly maxWalBytes: number;
      /** Ask the host to report the background WAL scan. Open does not wait for it. */
      readonly trace?: boolean;
    }
  | { readonly type: "unwatch"; readonly name: string }
  | { readonly type: "stats"; readonly id: number; readonly name: string }
  | { readonly type: "ping"; readonly id: number };

export type HostToClient =
  | {
      readonly type: "ingest-ok";
      readonly id: number;
      readonly generation: number;
    }
  | {
      readonly type: "err";
      readonly id: number;
      readonly message: string;
      /** The `OpfsLsmError` code, so the tab rethrows the same class. */
      readonly code?: ErrorCode;
    }
  | {
      readonly type: "watch-trace";
      readonly ms: number;
      readonly rows: number;
      readonly bytes: number;
    }
  | { readonly type: "stats-ok"; readonly id: number; readonly stats: HostStats }
  | { readonly type: "pong"; readonly id: number };

export type IngestClient = {
  /**
   * Flush every WAL record through `through`. A no-op when they are already
   * in OPFS. With `settle`, resolve once compaction has finished too.
   */
  ingest(
    name: string,
    through: number,
    settle?: boolean,
  ): Promise<{ generation: number }>;
  /**
   * Have the host ingest `name` on its own once the WAL waiting for ingest
   * passes `policy.maxWalBytes`, starting with what is already waiting.
   */
  watch(name: string, policy: IngestPolicy): void;
  /** This tab no longer needs the host to watch `name`. */
  unwatch(name: string): void;
  /** Host counters for `name`. Test and bench only. */
  stats(name: string): Promise<HostStats>;
  close(): void;
};

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
