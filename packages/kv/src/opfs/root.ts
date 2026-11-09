import type { DbName } from "../check.js";

const PAD_LOCK = "opfs-lsm:pad";
// One create+remove writes about 3 bytes of Chrome's `Paths` log per name
// character, so this name alone writes more than a 32 KiB LevelDB block.
const PAD_NAME = "opfs-lsm-pad-" + "p".repeat(12_000);

let root: Promise<FileSystemDirectoryHandle> | undefined;

/**
 * `opfs-lsm/<name>/` in the origin private file system. Every OPFS access
 * of the engine (page, SharedWorker host) starts here, so the
 * pad below runs before any of them creates or removes an entry.
 */
export async function openDbDir(name: DbName): Promise<FileSystemDirectoryHandle> {
  root ??= paddedRoot().catch((err: unknown) => {
    root = undefined;
    throw err;
  });
  const lsm = await (await root).getDirectoryHandle("opfs-lsm", { create: true });
  return lsm.getDirectoryHandle(name, { create: true });
}

/**
 * A browser crash can leave Chrome's OPFS name database (a LevelDB log) ending
 * in a torn record. Chrome appends after it, and the next launch drops the rest
 * of that 32 KiB block: every OPFS create and remove written there is forgotten.
 * Writing more than a block of throwaway entries first moves the engine's own
 * entries past the poisoned block. See
 * docs/research/chrome-opfs-paths-leveldb-torn-tail.md.
 *
 * Each context pads once, before its first create or remove, under a lock
 * held only while it pads: any context's first entry then follows a pad.
 * Holding a lock for the page's life would keep it out of the
 * back/forward cache (WebLocksContention).
 */
async function paddedRoot(): Promise<FileSystemDirectoryHandle> {
  const dir = await navigator.storage.getDirectory();
  await navigator.locks.request(PAD_LOCK, () => pad(dir));
  return dir;
}

async function pad(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    await dir.getDirectoryHandle(PAD_NAME, { create: true });
    await dir.removeEntry(PAD_NAME);
  } catch {
    // Only Chrome needs the pad; a browser that refuses the long name has no such log.
  }
}
