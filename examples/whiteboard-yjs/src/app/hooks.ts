import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Board, BoardMeta, BoardView, SaveState, Workspace } from "../model/index.ts";
import type { Controller, UiState } from "./core/input.ts";
import type { Session } from "./session.ts";

const app = getRouteApi("/_app");

export function useSession(): Session {
  return app.useLoaderData();
}

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
