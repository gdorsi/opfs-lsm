export type ClientToHost =
  | { readonly type: "ingest"; readonly id: number; readonly name: string }
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
  ingest(name: string): Promise<{ generation: number }>;
  close(): void;
};
