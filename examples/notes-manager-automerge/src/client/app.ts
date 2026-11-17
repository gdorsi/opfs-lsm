import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { createContext, useContext } from "react";
import type { MountedEditor } from "../editor/view.ts";
import { openNotes, type Notes } from "../model/notes.ts";
import { openStorage } from "../storage/open.ts";
import { bodyLeases, type Leases } from "./lease.ts";

export type App = {
  readonly notes: Notes;
  readonly leases: Leases;
  readonly db: string;
  readonly storage: StorageAdapterInterface;
};

declare global {
  var __notes: (App & { editor?: MountedEditor }) | undefined;
}

let opening: Promise<App> | undefined;

export function openApp(): Promise<App> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    const db = params.get("db") || "notes";
    const storage = await openStorage(db);
    const notes = await openNotes({ storage, network: [new BroadcastChannelNetworkAdapter({ channelName: `notes:${db}` })] });
    const leases = bodyLeases(notes.bodies);
    addEventListener("pagehide", () => {
      notes.flush().catch((error: unknown) => console.warn("notes: the page list was not saved", error));
      void leases.flush();
    });
    const app: App = { notes, leases, db, storage };
    if (import.meta.env.DEV) globalThis.__notes = app;
    return app;
  })());
}

export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp() outside the app shell");
  return app;
}
