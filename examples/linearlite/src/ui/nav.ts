import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { IssueFilter } from "../client/filter.ts";

/** The list and board filter, in the URL. Stable between renders while its content is the same. */
export function useIssueFilter(): IssueFilter {
  const { status, priority, q, sort, dir } = useSearch({ from: "/_app" });
  const key = JSON.stringify([status, priority, q, sort, dir]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ status, priority, q, sort, dir }), [key]);
}

/** `stripSearchParams` makes `prev` partial while the route's search type wants every key, so the patch is cast once here. */
const patchSearch = (patch: object) => ((prev: object) => ({ ...prev, ...patch })) as never;

export const keepSearch = ((prev: object) => prev) as never;

/** Filter changes push a history entry, so Back undoes them; `replace` is for typing. */
export function useSetFilter() {
  const navigate = useNavigate();
  return useCallback(
    (patch: Partial<IssueFilter>, replace = false) => void navigate({ to: ".", search: patchSearch(patch), replace }),
    [navigate],
  );
}

/** True once the app has pushed the create modal itself, so closing it can go Back instead of rewriting the URL. */
let modalPushed = false;

export function useCreateModal() {
  const navigate = useNavigate();
  const router = useRouter();
  const open = useCallback(() => {
    modalPushed = true;
    void navigate({ to: ".", search: patchSearch({ new: 1 }) });
  }, [navigate]);
  const close = useCallback(() => {
    if (modalPushed && router.history.canGoBack()) router.history.back();
    else void navigate({ to: ".", search: patchSearch({ new: undefined }), replace: true });
    modalPushed = false;
  }, [navigate, router]);
  return { open, close };
}

/** Back to wherever the user came from in this app, else to the list with the current filter. */
export function useGoBack() {
  const router = useRouter();
  const navigate = useNavigate();
  return useCallback(() => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/", search: keepSearch });
  }, [router, navigate]);
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** A window key handler that always calls the latest closure. */
export function useKeys(handler: (e: KeyboardEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const on = (e: KeyboardEvent) => latest.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
}
