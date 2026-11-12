import { errorOfCode } from "../errors.js";
import type { ClientToHost, HostToClient, IngestClient } from "./protocol.js";

/** Tab-side client over a MessagePort. */
export function createPortIngestClient(port: MessagePort): IngestClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: HostToClient) => void; reject: (e: Error) => void }
  >();

  const onMessage = (ev: MessageEvent<HostToClient>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "err") p.reject(errorOfCode(msg.code, msg.message));
    else p.resolve(msg);
  };
  const listener = onMessage as unknown as EventListener;
  port.addEventListener("message", listener);
  port.start?.();

  const request = (msg: ClientToHost & { id: number }) =>
    new Promise<HostToClient>((resolve, reject) => {
      pending.set(msg.id, { resolve, reject });
      port.postMessage(msg);
    });

  return {
    async ingest(name: string, waitForCompaction = false) {
      const res = await request({ type: "ingest", id: nextId++, name, waitForCompaction });
      return { generation: (res as Extract<HostToClient, { type: "ingest-ok" }>).generation };
    },
    watch(name, policy) {
      const msg: ClientToHost = {
        type: "watch",
        name,
        maxWalBytes: policy.maxWalBytes,
        compactionMemoryBytes: policy.compactionMemoryBytes,
        maxBytes: policy.maxBytes,
      };
      port.postMessage(msg);
    },
    unwatch(name) {
      const msg: ClientToHost = { type: "unwatch", name };
      port.postMessage(msg);
    },
    async destroy(name) {
      await request({ type: "destroy", id: nextId++, name });
    },
    async stats(name) {
      const res = await request({ type: "stats", id: nextId++, name });
      return (res as Extract<HostToClient, { type: "stats-ok" }>).stats;
    },
    close() {
      port.removeEventListener("message", listener);
      for (const [, p] of pending) p.reject(new Error("ingest client closed"));
      pending.clear();
    },
  };
}
