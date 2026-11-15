import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { createContext } from "react";
import { openBodies, type Bodies } from "../model/bodies.ts";
import type { PagesStorage } from "../model/types.ts";
import { openPagesStorage, type StorageKind } from "../storage/open.ts";

export type App = {
  readonly bodies: Bodies;
  /** Shown in the footer, and part of the tab channel's name, so kv tabs and idb tabs never mix bodies. */
  readonly kind: StorageKind;
  readonly db: string;
  readonly storage: PagesStorage;
};

declare global {
  /** Dev builds only: the browser proofs read and drive the app through it. */
  var __pages: App | undefined;
}

let opening: Promise<App> | undefined;

/** Opens once per tab, in the `_app` loader (browser only), from `?storage=` and `?db=`. */
export function openApp(): Promise<App> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    const kind: StorageKind = params.get("storage") === "idb" ? "idb" : "kv";
    const db = params.get("db") || "pages";
    const storage = await openPagesStorage(kind, db);
    const bodies = openBodies({
      storage: storage.bodies,
      // At the default wait, opening a page no tab holds yet would stall about a second for a peer that never answers.
      network: [new BroadcastChannelNetworkAdapter({ channelName: `pages:${kind}:${db}`, peerWaitMs: 50 })],
    });
    const app: App = { bodies, kind, db, storage };
    if (import.meta.env.DEV) globalThis.__pages = app;
    return app;
  })());
}

export const AppContext = createContext<App | null>(null);

