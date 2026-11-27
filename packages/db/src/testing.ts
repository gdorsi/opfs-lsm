/*
 * For an app's tests. Nothing here is imported by the core entry.
 */
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { openOn, type Database, type OpenOptions } from "./database.js";
import { wrap } from "./errors.js";
import type { Collections } from "./schema.js";

/**
 * `openDatabase` on memory, for a test that runs without a browser. Two
 * calls with one `name` share the data, as two tabs of one origin do. The
 * process needs an `indexedDB`, such as the one of `fake-indexeddb/auto`.
 */
export async function openMemoryDatabase<C extends Collections>({ name, ...options }: OpenOptions<C>): Promise<Database<C>> {
  let kv: Awaited<ReturnType<typeof openHarnessDb>>;
  try {
    kv = await openHarnessDb({ name, forceMemory: true });
  } catch (err) {
    throw wrap(err);
  }
  return openOn(kv, options);
}
