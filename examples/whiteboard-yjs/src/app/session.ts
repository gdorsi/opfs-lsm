/**
 * The page's storage and workspace. Browser only.
 *
 *   ?storage=idb   IndexedDB instead of kv on OPFS
 *   ?db=<name>     the kv database name, or the IndexedDB prefix. Default "whiteboard".
 *   ?fault=1       wraps the storage so `whiteboardFault.on()` in the console makes every flush reject (fault.ts).
 *
 * The page opens one Workspace and shows at most one Board. `showBoard` and `hideBoard` are the only callers of
 * `ws.openBoard` and `board.close` in the app: the slot closes the board it held before it opens another, and waits
 * for that close, so a quick list -> board -> list -> board never gets back a board that is still closing.
 */
import {
  broadcastSync,
  digestShapes,
  openWorkspace,
  type Board,
  type BoardId,
  type Workspace,
} from "../model/index.ts";
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
    sync: broadcastSync(BroadcastChannel, `whiteboard-yjs/${storage}:${name}`),
  });
  if (fault) Object.assign(globalThis, { whiteboardFault: fault.switch });
  Object.assign(globalThis, { whiteboard: proof(storage, ws) });
  onPageHide(ws, backend.close);
  return { ws, storage, name, fault: fault?.switch ?? null };
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

/** The board on screen. `id` is set when the open starts, so a second showBoard(id) joins it. */
let slot: { readonly id: BoardId; readonly board: Promise<Board> } | undefined;
/** The close of the board that left the slot. The next open waits for it. It never rejects. */
let leaving: Promise<void> = Promise.resolve();

/** The board route's loader. Idempotent for the id on screen; for any other id, closes the current board first. */
export function showBoard(id: BoardId): Promise<Board> {
  if (slot?.id === id) return slot.board;
  const previous = hideBoard();
  const board = (async () => {
    await previous.catch(() => {});
    return (await openSession()).ws.openBoard(id);
  })();
  const entry = { id, board };
  slot = entry;
  board.catch(() => {
    if (slot === entry) slot = undefined;
  });
  return board;
}

/**
 * The board list's loader. Closes the board on screen. Rejects with the storage error if that board's last flush
 * failed, so the list route shows it instead of losing it with the board.
 */
export function hideBoard(): Promise<void> {
  if (!slot) return leaving;
  const { board } = slot;
  slot = undefined;
  const closing = leaving.then(() => board).then((b) => b.close(), () => undefined);
  leaving = closing.catch(() => {});
  return closing;
}

/**
 * `globalThis.whiteboard`: what the browser proofs read from the console or agent-browser eval. `digest()` is the
 * model's digestShapes of the board on screen, the same value the bench checks after a reload.
 */
function proof(storage: StorageKind, ws: Workspace) {
  const shown = async () => (await slot?.board)?.view();
  return {
    ws,
    storage,
    count: async () => (await shown())?.shapes.size ?? 0,
    viewport: async () => (await shown())?.viewport,
    selected: async () => [...((await shown())?.selection ?? [])],
    shapes: async () => {
      const view = await shown();
      return view?.order.map((id) => view.shapes.get(id)!) ?? [];
    },
    digest: async () => {
      const view = await shown();
      return view ? digestShapes(view.shapes) : "";
    },
  };
}
