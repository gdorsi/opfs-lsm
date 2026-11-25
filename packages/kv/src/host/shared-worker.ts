import { findBrowserFs } from "../opfs/browser-fs.js";
import { EngineHost, serveWorker } from "./engine-host.js";

/**
 * SharedWorker script entry, and a dedicated Worker's where there is no
 * SharedWorker. `openDb` loads this module via `import.meta.url`.
 * The `@opfs-lsm/kv/shared-worker` export remains for bundlers that need an
 * explicit worker entry.
 */
serveWorker((writes) => new EngineHost((name) => findBrowserFs(name), { writes }));
