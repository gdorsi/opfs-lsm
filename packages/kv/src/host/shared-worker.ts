import { bootSharedWorker } from "./shared-worker-boot.js";

/**
 * SharedWorker script entry. Bundle / serve this file as the worker:
 *   new SharedWorker(new URL("@opfs-lsm/kv/shared-worker", import.meta.url), { type: "module" })
 * or pass `workerUrl` into `openDb`.
 */
bootSharedWorker();
