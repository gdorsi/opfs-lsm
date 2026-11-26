import { ClosedError, errorOfCode } from "../errors.js";
import { HOST_CALLS, type ClientToHost, type HostCall, type HostToClient, type IngestClient } from "./protocol.js";

/** What the client talks over: a SharedWorker's port, or a dedicated Worker, which it terminates at `close`. */
type Port = Pick<MessagePort, "addEventListener" | "removeEventListener" | "postMessage"> & {
  start?(): void;
  terminate?(): void;
};

/** Tab-side client over a port: each call of `HOST_CALLS` posts its method name and arguments. */
export function createPortIngestClient(port: Port): IngestClient {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const listener = ((ev: MessageEvent<HostToClient>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if ("message" in msg) p.reject(errorOfCode(msg.code, msg.message));
    else p.resolve(msg.value);
  }) as unknown as EventListener;
  port.addEventListener("message", listener);
  port.start?.();

  const client: Record<string, unknown> = {
    close() {
      closed = true;
      port.removeEventListener("message", listener);
      port.terminate?.();
      for (const [, p] of pending) p.reject(new ClosedError("database is closed"));
      pending.clear();
    },
  };
  for (const method of Object.keys(HOST_CALLS) as HostCall[]) {
    client[method] = HOST_CALLS[method]
      ? (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            // No listener is left to settle it.
            if (closed) return reject(new ClosedError("database is closed"));
            const id = nextId++;
            pending.set(id, { resolve, reject });
            port.postMessage({ id, method, args } as ClientToHost);
          })
      : (...args: unknown[]) => port.postMessage({ method, args } as ClientToHost);
  }
  return client as IngestClient;
}
