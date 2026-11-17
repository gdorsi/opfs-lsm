/**
 * `@opfs-lsm/spaces/testing`: run devices and a server in one Node process.
 *
 *   import "fake-indexeddb/auto";
 *   import { openHarnessDb } from "@opfs-lsm/kv/testing";
 *   import { openSpaces } from "@opfs-lsm/spaces";
 *   import { testServer } from "@opfs-lsm/spaces/testing";
 *
 *   const server = testServer();
 *   const alice = await openSpaces(schema, {
 *     kv: await openHarnessDb({ name: "alice", forceMemory: true }),
 *     server: server.transport(),
 *     leader: alwaysLeader,
 *   });
 *   // Two opens of one kv name are two tabs of one device. Two names are
 *   // two devices.
 *
 *   server.partition(alice);   // drop frames both ways until heal()
 *   server.heal();
 *   await server.settle();     // every queued frame delivered, every engine idle
 *
 * The transport passes encoded frames, so the codec runs in every test. It
 * never shares objects between the two sides.
 */

import type { SpacesDb } from "./db.js";
import type { AnyCollection } from "./schema.js";
import type { Transport } from "./sync/transport.js";

export interface TestServer {
  transport(): Transport;
  partition(db: SpacesDb<readonly AnyCollection[]>): void;
  heal(): void;
  settle(): Promise<void>;
  /** What the server holds for a space, for assertions about what it can see: member and invite counts, item headers and sizes, blob sizes. Never plaintext. */
  inspect(space: string): Promise<{
    readonly members: number;
    readonly invites: number;
    readonly items: readonly { readonly kind: string; readonly bytes: number }[];
  }>;
}

export declare function testServer(): TestServer;
export { alwaysLeader } from "./sync/engine.js";
