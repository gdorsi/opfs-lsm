import { bootLogWorker } from "./log-worker-boot.js";

/**
 * Dedicated WebWorker script entry: one per log. `LogClient` loads it via
 * `import.meta.url`; the `@opfs-lsm/kv/log-worker` export is for bundlers
 * that need an explicit entry for it.
 */
bootLogWorker();
