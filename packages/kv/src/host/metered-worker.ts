import { findBrowserFs } from "../opfs/browser-fs.js";
import { serveWorker } from "./engine-host.js";
import { MeteredHost } from "./metered-host.js";

/**
 * The worker `@opfs-lsm/kv/testing` opens: the shipped one with a meter, so
 * `readStats` answers in a browser. A proof asks two more things of it in
 * the fragment of its URL, which the worker an app loads never reads:
 * `staged` hides `createWritable()`, as a browser without it, and `writes`
 * has a dedicated Worker's host write run files too.
 */
const asked = (flag: string) => location.hash.includes(flag);
if (asked("staged")) delete (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable;
serveWorker((writes) => new MeteredHost((name) => findBrowserFs(name, writes), { writes: !!writes }, writes), asked("writes"));
