import { openBrowserFs } from "../opfs/browser-fs.js";
import { EngineHost, attachEngineHostPort } from "./engine-host.js";

/**
 * SharedWorker boot (no webworker lib dependency — works in the main tsc build).
 * Entry: `shared-worker.ts` calls this.
 */
export function bootSharedWorker(): void {
  const scope = globalThis as unknown as {
    onconnect: ((ev: MessageEvent) => void) | null;
  };
  const host = new EngineHost((name) => openBrowserFs(name));

  scope.onconnect = (ev: MessageEvent) => {
    const port = (ev as MessageEvent & { ports: MessagePort[] }).ports[0];
    if (!port) return;
    attachEngineHostPort(port, host);
  };
}
