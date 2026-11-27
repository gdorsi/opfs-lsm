import type { EngineHost } from "../src/host/engine-host.js";

/**
 * Wait for a fold in flight, reconcile and remove old manifests as a fold
 * that found nothing to fold does, then compact until the levels are in
 * shape. Folds no WAL. Removes no run file here: that needs the compaction
 * lock, and the compaction pass does it under it.
 */
export async function compactHost(host: EngineHost, name: string): Promise<void> {
  await host["db"](name).compactOnly();
}
