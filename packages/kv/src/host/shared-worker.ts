import { openBrowserFs } from "../opfs/browser-fs.js";
import { EngineHost, attachEngineHostPort } from "./engine-host.js";

/**
 * SharedWorker script entry. `openDb` loads this module via `import.meta.url`.
 * The `@opfs-lsm/kv/shared-worker` export remains for bundlers that need an
 * explicit worker entry. It reads `onconnect` off `globalThis` so the main
 * tsc build needs no webworker lib.
 */
const scope = globalThis as unknown as {
  onconnect: ((ev: MessageEvent) => void) | null;
};
const host = new EngineHost((name) => openBrowserFs(name));

scope.onconnect = (ev: MessageEvent) => {
  const port = (ev as MessageEvent & { ports: MessagePort[] }).ports[0];
  if (!port) return;
  attachEngineHostPort(port, host);
};
