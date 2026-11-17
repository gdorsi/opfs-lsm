import {
  broadcastSync,
  digestShapes,
  openWorkspace,
  type Board,
  type BoardId,
  type Workspace,
} from "../model/index.ts";
import { openStorage } from "../persistence/open.ts";
import { faultable } from "./fault.ts";

export type Session = {
  readonly ws: Workspace;
};

let opening: Promise<Session> | undefined;

export function openSession(): Promise<Session> {
  return (opening ??= open());
}

async function open(): Promise<Session> {
  const params = new URLSearchParams(location.search);
  const name = params.get("db") || "whiteboard";
  const backend = await openStorage(name);
  const fault = params.get("fault") === "1" ? faultable(backend.storage) : null;
  const ws = await openWorkspace({
    storage: fault ? fault.storage : backend.storage,
    sync: broadcastSync(BroadcastChannel, `whiteboard-yjs/${name}`),
  });
  if (fault) Object.assign(globalThis, { whiteboardFault: fault.switch });
  Object.assign(globalThis, { whiteboard: proof(ws) });
  onPageHide(ws, backend.close);
  return { ws };
}

/** A page restored from the back-forward cache has a closed workspace, so pageshow with `persisted` reloads it. */
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

let slot: { readonly id: BoardId; readonly board: Promise<Board> } | undefined;
let leaving: Promise<void> = Promise.resolve();

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

export function hideBoard(): Promise<void> {
  if (!slot) return leaving;
  const { board } = slot;
  slot = undefined;
  const closing = leaving.then(() => board).then((b) => b.close(), () => undefined);
  leaving = closing.catch(() => {});
  return closing;
}

function proof(ws: Workspace) {
  const shown = async () => (await slot?.board)?.view();
  return {
    ws,
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
