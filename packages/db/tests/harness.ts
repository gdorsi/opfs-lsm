import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";

let dbs = 0;

export function freshName(): string {
  return `db-${process.pid}-${++dbs}`;
}

/** One handle on `name`, on a memory file system. Handles on one name share the WAL and the run files, like tabs of one origin. */
export function openKv(name: string = freshName()): Promise<Db> {
  return openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 });
}
