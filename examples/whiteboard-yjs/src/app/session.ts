/**
 * The page's storage and workspace. Browser only.
 *
 *   ?storage=idb   IndexedDB instead of kv on OPFS
 *   ?db=<name>     the kv database name, or the IndexedDB prefix. Default "whiteboard".
 *   ?fault=1       wraps the storage so `whiteboardFault.on()` in the console makes every flush reject (fault.ts).
 */
import { broadcastSync, openWorkspace, type ChannelConstructor, type Workspace } from "../model/index.ts";
import { openStorage } from "../persistence/open.ts";
import { faultable, type FaultSwitch } from "./fault.ts";

export type StorageKind = "kv" | "idb";

export type Session = {
  readonly ws: Workspace;
  readonly storage: StorageKind;
  readonly name: string;
  readonly fault: FaultSwitch | null;
};

let opening: Promise<Session> | undefined;

/** Opens storage and the workspace once per page. The `_app` layout's loader awaits it. */
export function openSession(): Promise<Session> {
  return (opening ??= open());
}

async function open(): Promise<Session> {
  const params = new URLSearchParams(location.search);
  const storage: StorageKind = params.get("storage") === "idb" ? "idb" : "kv";
  const name = params.get("db") || "whiteboard";
  const backend = await openStorage(storage, name);
  const fault = params.get("fault") === "1" ? faultable(backend.storage) : null;
  const ws = await openWorkspace({
    storage: fault ? fault.storage : backend.storage,
    sync: broadcastSync(scopedChannel(`${storage}:${name}`)),
  });
  if (fault) Object.assign(globalThis, { whiteboardFault: fault.switch });
  onPageHide(ws, backend.close);
  return { ws, storage, name, fault: fault?.switch ?? null };
}

/**
 * The BroadcastChannel constructor with every channel name prefixed by the storage it serves. A kv tab and an
 * idb tab (or two `?db=` names) otherwise share `whiteboard-yjs/<docName>` and copy each other's boards into their
 * own storage. The model injects the constructor, so this needs no model change.
 */
function scopedChannel(scope: string): ChannelConstructor {
  return class extends BroadcastChannel {
    constructor(name: string) {
      super(`${scope}/${name}`);
    }
  };
}

/**
 * pagehide closes the workspace (which closes its boards, each flushing first) and then the storage. Persistence is
 * best effort: the autosave every 400 ms is what normally stores. A page restored from the back-forward cache has a
 * closed workspace, so pageshow with `persisted` reloads it.
 */
function onPageHide(ws: Workspace, closeStorage: () => Promise<void>): void {
  let closed = false;
  addEventListener(
    "pagehide",
    () => {
      closed = true;
      void ws.close().finally(closeStorage);
    },
    { once: true },
  );
  addEventListener("pageshow", (e) => {
    if (e.persisted && closed) location.reload();
  });
}
