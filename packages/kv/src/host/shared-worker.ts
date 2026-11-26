import { findBrowserFs } from "../opfs/browser-fs.js";
import { EngineHost, serveSharedWorker } from "./engine-host.js";

/**
 * SharedWorker script entry. `openDb` loads this module via `import.meta.url`.
 * The `@opfs-lsm/kv/shared-worker` export remains for bundlers that need an
 * explicit worker entry.
 */
serveSharedWorker(new EngineHost((name) => findBrowserFs(name)));
