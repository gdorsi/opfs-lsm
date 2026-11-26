import { findBrowserFs } from "../opfs/browser-fs.js";
import { serveWorker } from "./engine-host.js";
import { MeteredHost } from "./metered-host.js";

/**
 * The worker `@opfs-lsm/kv/testing` opens: the shipped one with a meter, so
 * `readStats` answers in a browser.
 */
serveWorker((writes) => new MeteredHost((name) => findBrowserFs(name), { writes }));
