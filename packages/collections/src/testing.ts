/**
 * Test and bench harness. Apps should import from `@opfs-lsm/collections` only.
 */
import {
  openHarnessDb,
  type HarnessOpenOptions,
} from "@opfs-lsm/kv/testing";
import { CollectionDb, type CollectionSchema } from "./database.js";

export type HarnessOpenCollectionOptions = HarnessOpenOptions & {
  readonly schema: CollectionSchema;
};

export async function openHarnessCollectionDb(
  options: HarnessOpenCollectionOptions,
): Promise<CollectionDb> {
  const { schema, ...open } = options;
  const kv = await openHarnessDb(open);
  return new CollectionDb(kv, schema);
}
