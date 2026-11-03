import { openBrowserFs } from "../opfs/browser-fs.js";
import { EngineHost, attachEngineHostPort } from "./engine-host.js";
import type { HostToClient } from "./protocol.js";

/**
 * SharedWorker boot (no webworker lib dependency — works in the main tsc build).
 * Entry: `shared-worker.ts` calls this.
 */
export function bootSharedWorker(): void {
  const scope = globalThis as unknown as {
    onconnect: ((ev: MessageEvent) => void) | null;
  };
  const ports = new Set<MessagePort>();
  const host = new EngineHost((name) => openBrowserFs(name));

  const broadcastGeneration = (name: string, generation: number): void => {
    const msg: HostToClient = { type: "generation", name, generation };
    for (const port of ports) {
      try {
        port.postMessage(msg);
      } catch {
        ports.delete(port);
      }
    }
  };

  scope.onconnect = (ev: MessageEvent) => {
    const port = (ev as MessageEvent & { ports: MessagePort[] }).ports[0];
    if (!port) return;
    ports.add(port);
    attachEngineHostPort(port, host, broadcastGeneration);
  };
}
