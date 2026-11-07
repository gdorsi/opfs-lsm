import type { IngestPolicy } from "../ingest-policy.js";
import type { IoCounters } from "../opfs/counting-fs.js";

/** What the host counted for one database since it started. Test and bench only. */
export type HostStats = {
  /** Flush (l0), compaction outputs (lN), manifests (m), compaction input reads. */
  fs: IoCounters;
  /** Ingests that folded at least one WAL record into an L0 run. */
  flushes: number;
  /** Compaction steps installed. */
  compactionSteps: number;
  /** Σ IngestResult.foldedBytes. */
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
