/**
 * React reads of the model and the controller. Each hook subscribes to one store and returns a slice that keeps its
 * identity while it is unchanged, so a drag (a new BoardView per frame) re-renders no React component: the canvas is
 * painted by the stage's frame loop, not by React.
 *
 * The model's Board and Workspace are classes: `board.subscribe` and `board.view` read `this`, so they are bound
 * here. `useSyncExternalStore(board.subscribe, board.view)` as written would throw.
 */
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Board, BoardMeta, BoardView, SaveState, Workspace } from "../model/index.ts";
import type { Controller, UiState } from "./core/input.ts";
import type { Session } from "./session.ts";

const app = getRouteApi("/_app");

/** The page's session, opened by the `_app` layout's loader. */
export function useSession(): Session {
  return app.useLoaderData();
}

/** A slice of the board's view. `select` runs once per published view; `equal` decides whether the slice changed. */
export function useBoardSlice<T>(board: Board, select: (view: BoardView) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ readonly view: BoardView; readonly value: T } | null>(null);
  const subscribe = useCallback((listener: () => void) => board.subscribe(listener), [board]);
  const get = (): T => {
    const view = board.view();
    if (last.current?.view === view) return last.current.value;
    let value = select(view);
    if (last.current && equal(last.current.value, value)) value = last.current.value;
    last.current = { view, value };
    return value;
  };
  return useSyncExternalStore(subscribe, get);
}

/** The board list and the index doc's save state. Both are stable values in the model until they change. */
export function useWorkspace(ws: Workspace): { readonly boards: readonly BoardMeta[]; readonly save: SaveState } {
  const subscribe = useCallback((listener: () => void) => ws.subscribe(listener), [ws]);
  const boards = useSyncExternalStore(subscribe, () => ws.boards());
  const save = useSyncExternalStore(subscribe, () => ws.save());
  return { boards, save };
}

export function useUi(controller: Controller): UiState {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  return useSyncExternalStore(subscribe, () => controller.ui());
}
