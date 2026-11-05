import { bootSharedWorker } from "./shared-worker-boot.js";

/**
 * SharedWorker script entry. `openDb` loads this module via `import.meta.url`.
 * The `@opfs-lsm/kv/shared-worker` export remains for bundlers that need an
 * explicit worker entry.
 */
bootSharedWorker();
