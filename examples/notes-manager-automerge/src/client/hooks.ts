import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Page, PageBody, PageId, SaveState, Tree } from "../model/types.ts";
import { useApp } from "./app.ts";

/** Re-renders only when `select` returns another value: the tree keeps the arrays and pages that did not change. */
function useTree<T>(select: (tree: Tree) => T): T {
  const { tree } = useApp().notes;
  return useSyncExternalStore(tree.subscribe, () => select(tree.read()));
}

export function useChildren(parent: PageId | null): readonly PageId[] {
  return useTree((tree) => tree.children(parent));
}

export function usePage(id: PageId): Page | undefined {
  return useTree((tree) => tree.page(id));
}

function expandedStore(key: string) {
  let open: ReadonlySet<string> = new Set();
  try {
    open = new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {}
  const listeners = new Set<() => void>();
  return {
    read: () => open,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(id: PageId, value: boolean) {
      if (open.has(id) === value) return;
      const next = new Set(open);
      if (value) next.add(id);
      else next.delete(id);
      open = next;
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {}
      for (const listener of listeners) listener();
    },
  };
}
const expandedStores = new Map<string, ReturnType<typeof expandedStore>>();

export function useExpanded(): { readonly isOpen: (id: PageId) => boolean; readonly set: (id: PageId, open: boolean) => void } {
  const { kind, db } = useApp();
  const key = `notes:expanded:${kind}:${db}`;
  let store = expandedStores.get(key);
  if (!store) expandedStores.set(key, (store = expandedStore(key)));
  const open = useSyncExternalStore(store.subscribe, store.read);
  return { isOpen: (id) => open.has(id), set: store.set };
}

export function useBody(id: PageId): { readonly body: PageBody | null; readonly error: Error | null } {
  const { leases } = useApp();
  const [state, setState] = useState<{ id: PageId; body: PageBody | null; error: Error | null }>({ id, body: null, error: null });
  useEffect(() => {
    let live = true;
    const lease = leases.lease(id);
    lease.body.then(
      (body) => live && setState({ id, body, error: null }),
      (error: unknown) => live && setState({ id, body: null, error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      live = false;
      lease.release();
    };
  }, [leases, id]);
  return state.id === id ? state : { body: null, error: null };
}

export function useSaveState(body: PageBody): SaveState {
  return useSyncExternalStore(body.save.subscribe, body.save.read);
}

export function useCreatePage(): (parent: PageId | null) => Promise<void> {
  const { notes } = useApp();
  const navigate = useNavigate();
  return useCallback((parent) => navigate({ to: "/p/$pageId", params: { pageId: notes.createPage(parent) } }), [notes, navigate]);
}
