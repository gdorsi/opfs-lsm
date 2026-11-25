import { findBrowserFs } from "../opfs/browser-fs.js";
import { serveSharedWorker } from "./engine-host.js";
import { MeteredHost } from "./metered-host.js";

/**
 * The SharedWorker `@opfs-lsm/kv/testing` opens: the shipped one with a
 * meter, so `readStats` answers in a browser.
 */
serveSharedWorker((writes) => new MeteredHost((name) => findBrowserFs(name), { writes }));
