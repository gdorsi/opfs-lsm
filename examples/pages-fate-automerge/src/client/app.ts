import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { createContext, useContext } from "react";
import { createHTTPTransport } from "react-fate";
import type { MountedEditor } from "../editor/view.ts";
import { openBodies, type Bodies } from "../model/bodies.ts";
import { createTreeClient, reclaimBodies, type Fate } from "../model/tree.ts";
import type { PagesStorage } from "../model/types.ts";
import { openPagesStorage, type StorageKind } from "../storage/open.ts";
import { bodyLeases, type Leases } from "./lease.ts";

export type App = {
  readonly fate: Fate;
  readonly bodies: Bodies;
  readonly leases: Leases;
  /** Shown in the footer, and part of the tab channel's name, so kv tabs and idb tabs never mix bodies. */
  readonly kind: StorageKind;
  readonly db: string;
  readonly storage: PagesStorage;
};

declare global {
  /** Dev builds only: the browser proofs read and drive the app through it. */
  var __pages: (App & { editor?: MountedEditor }) | undefined;
}

let opening: Promise<App> | undefined;

/** Opens once per tab, in the `_app` loader (browser only), from `?storage=` and `?db=`. Resolves once fate restored its cache. */
export function openApp(): Promise<App> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    const kind: StorageKind = params.get("storage") === "idb" ? "idb" : "kv";
    const db = params.get("db") || "pages";
    const storage = await openPagesStorage(kind, db);
    const fate = createTreeClient({ transport: createHTTPTransport({ url: "/api/fate", live: false }), storage: storage.fate });
    const bodies = openBodies({
      storage: storage.bodies,
      network: [new BroadcastChannelNetworkAdapter({ channelName: `pages:${kind}:${db}` })],
    });
    const leases = bodyLeases(bodies);
    reclaimBodies(fate, bodies);
    addEventListener("pagehide", () => void leases.flush());
    await fate.persistence!.ready;
    const app: App = { fate, bodies, leases, kind, db, storage };
    if (import.meta.env.DEV) globalThis.__pages = app;
    return app;
  })());
}

export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp() outside the app shell");
  return app;
}
