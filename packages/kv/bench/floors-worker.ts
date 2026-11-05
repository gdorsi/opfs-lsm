import { formatMs, summarize } from "./stats.ts";

type SyncHandle = {
  write(buf: Uint8Array, opts: { at: number }): number;
  flush(): void;
  truncate(size: number): void;
  close(): void;
};
type Request =
  | { readonly op: "open" }
  | { readonly op: "append"; readonly bytes: Uint8Array; readonly flush: boolean }
  | { readonly op: "inner"; readonly n: number; readonly bytes: Uint8Array };

let handle: SyncHandle;
let at = 0;

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  if (data.op === "open") {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle("bench-floors-wal", { create: true });
    handle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
    handle.truncate(0);
    at = 0;
    self.postMessage(true);
  } else if (data.op === "append") {
    at += handle.write(data.bytes, { at });
    if (data.flush) handle.flush();
    self.postMessage(at);
  } else {
    const samples = new Float64Array(data.n);
    for (let i = 0; i < data.n; i++) {
      const t = performance.now();
      at += handle.write(data.bytes, { at });
      handle.flush();
      samples[i] = performance.now() - t;
    }
    self.postMessage(formatMs(summarize("opfs flush in-worker", samples)));
  }
};
