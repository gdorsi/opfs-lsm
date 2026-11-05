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
  close(): void;
};
