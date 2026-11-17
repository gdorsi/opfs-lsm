/**
 * `@opfs-lsm/spaces/server`: the reference sync server. It runs on any
 * runtime with WebCrypto (SHA-256) and a byte transport, such as Node,
 * Deno, Bun or a Cloudflare Durable Object. It has no kv dependency and
 * never imports yjs.
 *
 *   import { createSpacesServer, MemoryServerStore } from "@opfs-lsm/spaces/server";
 *   const server = createSpacesServer({ store: new MemoryServerStore() });
 *   wss.on("connection", (ws) => server.accept(wsConnection(ws)));
 *
 * Accounts, sign-up and rate limits are out of scope. An operator who needs
 * them puts them in front of `accept`. The protocol authenticates with
 * per-space bearer tokens and stores only their hashes. Run it behind TLS.
 */

import { ServerSession, SubscriptionHub } from "./session.js";
import type { ServerConnection } from "./session.js";
import type { ServerStore } from "./store.js";

export { MemoryServerStore } from "./store.js";
export type { ServerStore, SpaceTxn } from "./store.js";
export type { ServerConnection } from "./session.js";

export interface SpacesServer {
  /**
   * Takes over a connection. The caller feeds raw frames to `receive`, which
   * decodes them with the shared protocol codec. A frame that fails to
   * decode closes the connection. No wire type crosses this boundary.
   */
  accept(connection: ServerConnection): { receive(frame: Uint8Array): void; closed(): void };
}

export function createSpacesServer(options: { readonly store: ServerStore }): SpacesServer {
  const hub = new SubscriptionHub();
  return {
    accept(connection) {
      const session = new ServerSession(options.store, connection, hub);
      return { receive: (frame) => session.receiveFrame(frame), closed: () => session.closed() };
    },
  };
}
