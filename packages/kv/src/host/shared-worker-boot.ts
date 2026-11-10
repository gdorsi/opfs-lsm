import { openBrowserFs } from "../opfs/browser-fs.js";
import { Host } from "./host.js";

/**
 * SharedWorker boot (no webworker lib dependency, so it builds in the main
 * tsc build). Entry: `shared-worker.ts` calls this.
 */
export function bootSharedWorker(): void {
  const scope = globalThis as unknown as {
    onconnect: ((ev: MessageEvent) => void) | null;
  };
  const host = new Host((name) => openBrowserFs(name));
  scope.onconnect = (ev: MessageEvent) => {
    const port = (ev as MessageEvent & { ports: MessagePort[] }).ports[0];
    if (port) host.serve(port);
  };
}
